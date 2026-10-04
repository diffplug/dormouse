import { createRef, useMemo, useSyncExternalStore, type ComponentType, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { $getNearestNodeFromDOMNode, $getNodeByKey, type LexicalEditor } from 'lexical';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import {
  $isImageNode, editImageToolbarComponent$, iconComponentFor$, ImageNode, imagePreviewHandler$, useCellValue,
  BlockTypeSelect, BoldItalicUnderlineToggles, codeBlockPlugin, codeMirrorPlugin, CodeToggle, CreateLink, diffSourcePlugin,
  DiffSourceToggleWrapper, frontmatterPlugin, headingsPlugin, imagePlugin, InsertCodeBlock, InsertTable, InsertThematicBreak,
  linkDialogPlugin, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, quotePlugin, realmPlugin,
  rootEditor$, Separator, viewMode$, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo, type MDXEditorMethods, type Realm,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { documentSession, stateLabel, type DocumentState } from './document-session';
import { editableImage, imageSaved, imageSources, imageUrl, ImagesPanel, localImagePath } from './images-panel';
import { ImageOverlay } from './image-overlay';
import { commentsPlugin } from './markdown-comments';
import { markdownSafetyPlugin } from './markdown-safety';
import { pageTheme, subscribeTheme } from './page-theme';
import { mermaidDescriptor } from './mermaid-block';
import './markdown.css';

// Page state outside React, replaced whole on each change: the session reports
// into it, the editor's image nodes feed it, and components subscribe.
// `editing` is the image open in the editor overlay; `saves` counts its saves.
let store: { doc: DocumentState; error: string | null; images: string[]; panel: boolean; editor: LexicalEditor | null; editing: string | null; saves: number } =
  { doc: { loaded: false, dirty: false, saving: false }, error: null, images: [], panel: false, editor: null, editing: null, saves: 0 };
const listeners = new Set<() => void>();
const update = (change: Partial<typeof store>) => { store = { ...store, ...change }; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const usePage = () => useSyncExternalStore(subscribe, () => store);
const editorRef = createRef<MDXEditorMethods>();
let realm: Realm | undefined;
let loads = 0;

// The editor trims the document; saves end it with one newline, and the server
// restores the file's line endings.
const session = documentSession<string>({
  snapshot() {
    const markdown = editorRef.current!.getMarkdown();
    return { content: markdown ? `${markdown}\n` : '', mark: markdown };
  },
  holds: mark => editorRef.current?.getMarkdown() === mark,
  async apply(text) {
    // A reload mounts a fresh editor: its own normalization is then not an edit, and undo starts over.
    flushSync(() => root.render(<Page key={++loads} markdown={text.replace(/\r\n?/g, '\n')} />));
    await new Promise(resolve => setTimeout(resolve));
  },
}, {
  report(doc) {
    if (doc.loaded !== store.doc.loaded || doc.dirty !== store.doc.dirty || doc.saving !== store.doc.saving) update({ doc });
  },
  fail(error) { update({ error }); },
});

/** The document's source for the image node `key`, when the image editor can open it. */
function editablePath(editor: LexicalEditor, key: string): string | null {
  const path = editor.getEditorState().read(() => { const node = $getNodeByKey(key); return $isImageNode(node) ? localImagePath(node.getSrc()) : null; });
  return editableImage(path) ? path : null;
}

/** Opens a PNG or JPEG under the document's folder in the image editor overlay. */
const editImage = (path: string) => update({ editing: path });

/** After an image save: every display of it loads the new file, and the document's source stays as it is. */
function refreshImage(path: string) {
  imageSaved(path);
  // A new handler makes each image node resolve its URL again.
  realm?.pub(imagePreviewHandler$, async (src: string) => imageUrl(src));
  update({ saves: store.saves + 1 });
}

/** MDXEditor's own image toolbar (delete, settings), which it does not export; read before `imagePlugin` replaces it. */
let DefaultImageToolbar: ComponentType<EditImageToolbarProps> = () => null;
type EditImageToolbarProps = { nodeKey: string; imageSource: string; initialImagePath: string | null; title: string; alt: string; width?: number | 'inherit'; height?: number | 'inherit' };

function ImageToolbar(props: EditImageToolbarProps) {
  const iconFor = useCellValue(iconComponentFor$);
  const editor = useCellValue(rootEditor$);
  const path = editor && editablePath(editor, props.nodeKey);
  return (
    <div className="md-image-toolbar">
      {path && <button type="button" className="md-image-edit" title="Open in the image editor [double-click]" onClick={() => editImage(path)}>{iconFor('edit')}</button>}
      <DefaultImageToolbar {...props} />
    </div>
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
    const response = await fetch('image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
    return (await response.json()).name;
  } catch (reason) { session.fail(reason); throw reason; }
}

function Controls() {
  const { doc, panel, images } = usePage();
  return (
    <div className="controls">
      <span className="state" role="status">{stateLabel(doc)}</span>
      <button type="button" aria-pressed={panel} title="List and rename this document's images" onClick={() => update({ panel: !panel })}>Images{images.length ? ` (${images.length})` : ''}</button>
      <button type="button" title="Reload from disk" onClick={() => void session.reload()}>Reload</button>
      <button type="button" className="save" disabled={!doc.loaded || !doc.dirty || doc.saving} title="Save [Cmd/Ctrl+S]" onClick={() => void session.save()}>Save</button>
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
const plugins = [
  capture(), markdownSafetyPlugin(), commentsPlugin(),
  headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(), linkPlugin(), linkDialogPlugin(),
  tablePlugin(), frontmatterPlugin(), markdownShortcutPlugin(),
  imagePlugin({ imageUploadHandler: upload, imagePreviewHandler: async src => imageUrl(src), disableImageResize: true, EditImageToolbar: ImageToolbar as FC }),
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

function Page({ markdown }: { markdown: string }) {
  const theme = useSyncExternalStore(subscribeTheme, pageTheme);
  const { error, images, panel, editor, editing } = usePage();
  const style = useMemo(() => markdownStyle(markdown), [markdown]);
  return (
    <>
      {error && <div className="error" role="alert">{error}</div>}
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        plugins={plugins}
        toMarkdownOptions={style}
        className={theme.dark ? 'dark-theme' : 'light-theme'}
        contentEditableClassName="prose"
        spellCheck
        onChange={(_, normalize) => {
          // The editor's own reformatting of loaded text is not an edit.
          if (normalize) session.rebase(); else session.changed();
        }}
        onError={({ error: reason }) => {
          realm?.pub(viewMode$, 'source');
          session.fail(`Showing source: the rich editor cannot parse this file (${reason}).`);
        }}
      />
      {panel && editor && <ImagesPanel editor={editor} sources={images} onEdit={editImage} />}
      {editing && <ImageOverlay key={editing} path={editing} session={session} onSaved={refreshImage}
        onClose={() => { update({ editing: null }); editorRef.current?.focus(); }} />}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
void session.load();
