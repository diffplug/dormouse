import { createRef, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentType, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { $getNearestNodeFromDOMNode, $getNodeByKey, getNearestEditorFromDOMNode, type LexicalEditor } from 'lexical';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import {
  $isImageNode, editImageToolbarComponent$, iconComponentFor$, ImageNode, imagePreviewHandler$, useCellValue,
  BlockTypeSelect, BoldItalicUnderlineToggles, codeBlockPlugin, codeMirrorPlugin, CodeToggle, CreateLink, diffSourcePlugin,
  DiffSourceToggleWrapper, frontmatterPlugin, headingsPlugin, imagePlugin, InsertCodeBlock, InsertTable, InsertThematicBreak,
  linkDialogPlugin, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, quotePlugin, realmPlugin,
  rootEditor$, Separator, viewMode$, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo, type MDXEditorMethods, type MDXEditorProps, type Realm,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { checked, documentPage, loadingState, stateLabel, textSource, type DocumentState } from './document-session';
import { editableImage, imageSources, imageUrl, ImagesPanel, localImagePath, type SavedImages } from './images-panel';
import { ImageOverlay } from './image-overlay';
import { ImageResizeHandles } from './image-resize';
import { defaultWidth, forgetImageWidths, sizeImages } from './image-size';
import { commentsPlugin } from './markdown-comments';
import { markdownSafetyPlugin } from './markdown-safety';
import { pageTheme, subscribeTheme } from './page-theme';
import { mermaidDescriptor } from './mermaid-block';
import { SaveButton } from './save-button';
import { Signal } from './signal';
import { installTooltips } from './tooltip';
import './markdown.css';

// Page state outside React, replaced whole on each change: the session reports
// into it, the editor's image nodes feed it, and components subscribe.
// `editing` is the image open in the editor overlay; `saved` holds the
// revision of each image saved from it.
let store: { doc: DocumentState; error: string | null; images: string[]; panel: boolean; editor: LexicalEditor | null; editing: string | null; saved: SavedImages } =
  { doc: loadingState, error: null, images: [], panel: false, editor: null, editing: null, saved: {} };
const changes = new Signal();
const update = (change: Partial<typeof store>) => { store = { ...store, ...change }; changes.emit(); };
const usePage = () => useSyncExternalStore(changes.subscribe, () => store);
const editorRef = createRef<MDXEditorMethods>();
let realm: Realm | undefined;
let sizing: ReturnType<typeof sizeImages> | undefined;
let loads = 0;

const page = documentPage();
// The editor trims the document; saves end it with one newline, and the server
// restores the file's line endings.
const session = page.open<string>({
  snapshot() {
    const markdown = editorRef.current!.getMarkdown();
    return { content: markdown ? `${markdown}\n` : '', mark: markdown };
  },
  holds: mark => editorRef.current?.getMarkdown() === mark,
  async apply(text) {
    // A reload mounts a fresh editor: its own normalization is then not an edit, and undo starts over.
    forgetImageWidths();
    flushSync(() => root.render(<Page key={++loads} markdown={text.replace(/\r\n?/g, '\n')} />));
    await new Promise(resolve => setTimeout(resolve));
  },
}, {
  report(doc) { update({ doc }); },
  fail(error) { update({ error }); },
}, textSource);

/** The document's source for the image node `key`, when the image editor can open it. */
function editablePath(editor: LexicalEditor, key: string): string | null {
  const path = editor.getEditorState().read(() => { const node = $getNodeByKey(key); return $isImageNode(node) ? localImagePath(node.getSrc()) : null; });
  return editableImage(path) ? path : null;
}

/** Opens a PNG or JPEG under the document's folder in the image editor overlay. */
const editImage = (path: string) => update({ editing: path });

/** The URL whose head sizes an image: a PNG or JPEG under the document's folder may record its scale. */
const sizedUrl = (src: string) => editableImage(localImagePath(src)) ? imageUrl(src, store.saved) : null;

/** How long an image that may show at a default width waits for it, in ms;
 * one read later applies when it arrives (`sizeImages`). */
const SIZE_WAIT = 300;

/** An image's URL, given once its default width is known, or `SIZE_WAIT`
 * passes, so it first shows at that width; at once when its document sizes it. */
async function previewUrl(src: string) {
  const sized = sizedUrl(src);
  if (sized && (sizing?.mayDefault(src) ?? true)) await Promise.race([defaultWidth(sized), new Promise(resolve => setTimeout(resolve, SIZE_WAIT))]);
  return imageUrl(src, store.saved);
}

/** After an image save: every display of it loads the new file, and the document's source stays as it is. */
function refreshImage(path: string, version: string) {
  update({ saved: { ...store.saved, [path]: version } });
  // A new handler makes each image node resolve its URL again.
  realm?.pub(imagePreviewHandler$, (src: string) => previewUrl(src));
  sizing?.refresh();
}

/** MDXEditor's own image toolbar (delete, settings), which it does not export; read before `imagePlugin` replaces it. */
let DefaultImageToolbar: ComponentType<EditImageToolbarProps> = () => null;
type EditImageToolbarProps = { nodeKey: string; imageSource: string; initialImagePath: string | null; title: string; alt: string; width?: number | 'inherit'; height?: number | 'inherit' };

function ImageToolbar(props: EditImageToolbarProps) {
  const iconFor = useCellValue(iconComponentFor$);
  const editor = useCellValue(rootEditor$);
  const path = editor && editablePath(editor, props.nodeKey);
  const ref = useRef<HTMLDivElement>(null);
  // A table cell's images are in an editor of its own, which sizing learns of here, before the image paints.
  useLayoutEffect(() => {
    const own = getNearestEditorFromDOMNode(ref.current);
    if (own) sizing?.track(own);
  }, []);
  return (
    <>
      <ImageResizeHandles nodeKey={props.nodeKey} keepHeight={typeof props.height === 'number'} />
      <div ref={ref} className="md-image-toolbar">
        {path && <button type="button" className="md-image-edit" data-tip="Open in the image editor [double-click]" onClick={() => editImage(path)}>{iconFor('edit')}</button>}
        <DefaultImageToolbar {...props} />
      </div>
    </>
  );
}

const capture = realmPlugin({
  init(r) {
    realm = r;
    const toolbar = r.getValue(editImageToolbarComponent$) as ComponentType<EditImageToolbarProps>;
    if (toolbar !== ImageToolbar) DefaultImageToolbar = toolbar;
  },
  postInit(r) {
    const editor = r.getValue(rootEditor$);
    if (!editor) return;
    const refresh = () => update({ images: imageSources(editor), editor });
    // Only image nodes change the list, so typing does not walk the document.
    editor.registerMutationListener(ImageNode, refresh, { skipInitialization: true });
    refresh();
    sizing = sizeImages(editor, sizedUrl);
    const open = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      const key = editor.read(() => $getNearestNodeFromDOMNode(event.target as Node)?.getKey());
      const path = key && editablePath(editor, key);
      if (path) { event.preventDefault(); editImage(path); }
    };
    editor.registerRootListener((element, previous) => {
      previous?.removeEventListener('dblclick', open);
      element?.addEventListener('dblclick', open);
    });
  },
});

/** Sends a pasted or dropped image's bytes; the server names the new file. */
async function upload(file: File): Promise<string> {
  try {
    const response = await checked(await fetch('image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file }));
    return (await response.json()).name;
  } catch (reason) { session.fail(reason); throw reason; }
}

function Controls() {
  const { doc, panel, images } = usePage();
  return (
    <div className="controls">
      <span className="state" role="status">{stateLabel(doc)}</span>
      <button type="button" aria-pressed={panel} data-tip="List and rename this document's images" onClick={() => update({ panel: !panel })}>Images{images.length ? ` (${images.length})` : ''}</button>
      <button type="button" data-tip="Reload from disk" onClick={() => void session.reload()}>Reload</button>
      <SaveButton className="save" state={doc} onSave={() => void session.save()} />
    </div>
  );
}

function Toolbar() {
  return (
    <>
      <DiffSourceToggleWrapper options={['rich-text', 'source']}>
        <UndoRedo /><Separator />
        <BlockTypeSelect /><BoldItalicUnderlineToggles options={['Bold', 'Italic']} /><CodeToggle /><Separator />
        <ListsToggle /><CreateLink /><InsertTable /><InsertCodeBlock /><InsertThematicBreak />
      </DiffSourceToggleWrapper>
      <Controls />
    </>
  );
}

// Stable `tok-*` classes on code tokens, colored per theme in markdown.css.
const tokenClasses = [syntaxHighlighting(classHighlighter)];

// `imagePlugin` types `EditImageToolbar` without the props it passes.
// `capture()` comes before `imagePlugin()`, so it reads MDXEditor's own image toolbar first.
const plugins = [
  capture(), markdownSafetyPlugin(), commentsPlugin(),
  headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(), linkPlugin(), linkDialogPlugin(),
  // Unpadded tables: padding to aligned columns rewrites every row of a table when one cell changes.
  tablePlugin({ tablePipeAlign: false }), frontmatterPlugin(), markdownShortcutPlugin(),
  imagePlugin({ imageUploadHandler: upload, imagePreviewHandler: previewUrl, disableImageResize: true, allowSetImageDimensions: true, EditImageToolbar: ImageToolbar as FC }),
  codeBlockPlugin({ defaultCodeBlockLanguage: '', codeBlockEditorDescriptors: [mermaidDescriptor] }),
  codeMirrorPlugin({ codeBlockLanguages: {
    '': 'Plain text', sh: 'Shell', bash: 'Bash', js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', json: 'JSON',
    css: 'CSS', html: 'HTML', py: 'Python', rust: 'Rust', go: 'Go', java: 'Java', c: 'C', cpp: 'C++', sql: 'SQL', yaml: 'YAML',
    toml: 'TOML', diff: 'Diff', md: 'Markdown', mermaid: 'Mermaid',
  }, codeMirrorExtensions: tokenClasses }),
  diffSourcePlugin({ viewMode: 'rich-text', codeMirrorExtensions: tokenClasses }),
  toolbarPlugin({ toolbarContents: Toolbar }),
];

/** The list bullet and thematic break the file uses most, so a save keeps its style. */
function markdownStyle(markdown: string) {
  const prose = markdown.replace(/^(```|~~~)[^]*?^\1/gm, '');
  const count = (pattern: RegExp) => prose.match(pattern)?.length ?? 0;
  const bullets = (['-', '*', '+'] as const).map(b => [b, count(new RegExp(`^[ \\t]*\\${b}[ \\t]+\\S`, 'gm'))] as const);
  const bullet = bullets.reduce((best, next) => next[1] > best[1] ? next : best)[0];
  return { bullet, rule: count(/^\*{3,}[ \t]*$/gm) > count(/^-{3,}[ \t]*$/gm) ? '*' as const : '-' as const };
}

// The editor's own reformatting of loaded text is not an edit.
const onEditorChange: MDXEditorProps['onChange'] = (_, normalize) => { if (normalize) session.rebase(); else session.changed(); };
const onEditorError: MDXEditorProps['onError'] = ({ error: reason }) => {
  realm?.pub(viewMode$, 'source');
  session.fail(`Showing source: the rich editor cannot parse this file (${reason}).`);
};
const closeImage = () => { update({ editing: null }); editorRef.current?.focus(); };

/** The rich editor; it follows only the theme, so page state changes leave it be. */
function Editor({ markdown }: { markdown: string }) {
  const theme = useSyncExternalStore(subscribeTheme, pageTheme);
  const style = useMemo(() => markdownStyle(markdown), [markdown]);
  return (
    <MDXEditor ref={editorRef} markdown={markdown} plugins={plugins} toMarkdownOptions={style}
      className={theme.dark ? 'dark-theme' : 'light-theme'} contentEditableClassName="prose" spellCheck
      onChange={onEditorChange} onError={onEditorError} />
  );
}

function ErrorBanner() {
  const { error } = usePage();
  return error ? <div className="error" role="alert">{error}</div> : null;
}

/** The images panel, hung in the editor's content box: under the toolbar
 * however it wraps, and under an error. */
function Panel({ editor }: { editor: LexicalEditor }) {
  const { images, saved } = usePage();
  const content = editor.getRootElement()?.closest('.mdxeditor-diff-source-wrapper');
  return content ? createPortal(<ImagesPanel editor={editor} sources={images} saved={saved} onEdit={editImage} />, content) : null;
}

/** The images panel and the image editor overlay, above the editor. */
function Overlays() {
  const { panel, editor, editing } = usePage();
  return (
    <>
      {panel && editor && <Panel editor={editor} />}
      {editing && <ImageOverlay key={editing} path={editing} page={page} onSaved={refreshImage} onClose={closeImage} />}
    </>
  );
}

function Page({ markdown }: { markdown: string }) {
  return <><ErrorBanner /><Editor markdown={markdown} /><Overlays /></>;
}

installTooltips();
const root = createRoot(document.getElementById('root')!);
void session.load();
