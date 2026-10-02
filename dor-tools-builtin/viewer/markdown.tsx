import { createRef, useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { LexicalEditor } from 'lexical';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import {
  ImageNode,
  BlockTypeSelect, BoldItalicUnderlineToggles, codeBlockPlugin, codeMirrorPlugin, CodeToggle, CreateLink, diffSourcePlugin,
  DiffSourceToggleWrapper, frontmatterPlugin, headingsPlugin, imagePlugin, InsertCodeBlock, InsertTable, InsertThematicBreak,
  linkDialogPlugin, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, quotePlugin, realmPlugin,
  rootEditor$, Separator, viewMode$, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo, type MDXEditorMethods, type Realm,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { documentSession, stateLabel, type DocumentState } from './document-session';
import { imageSources, imageUrl, ImagesPanel } from './images-panel';
import { commentsPlugin } from './markdown-comments';
import { markdownSafetyPlugin } from './markdown-safety';
import { pageTheme, subscribeTheme } from './page-theme';
import { mermaidDescriptor } from './mermaid-block';
import './markdown.css';

// Page state outside React, replaced whole on each change: the session reports
// into it, the editor's image nodes feed it, and components subscribe.
let store: { doc: DocumentState; error: string | null; images: string[]; panel: boolean; editor: LexicalEditor | null } =
  { doc: { loaded: false, dirty: false, saving: false }, error: null, images: [], panel: false, editor: null };
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
    return { text: markdown ? `${markdown}\n` : '', mark: markdown };
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

const capture = realmPlugin({
  init(r) { realm = r; },
  postInit(r) {
    const editor = r.getValue(rootEditor$);
    if (!editor) return;
    const refresh = () => update({ images: imageSources(editor), editor });
    // Only image nodes change the list, so typing does not walk the document.
    editor.registerMutationListener(ImageNode, refresh, { skipInitialization: true });
    refresh();
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

const plugins = [
  capture(), markdownSafetyPlugin(), commentsPlugin(),
  headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(), linkPlugin(), linkDialogPlugin(),
  tablePlugin(), frontmatterPlugin(), markdownShortcutPlugin(),
  imagePlugin({ imageUploadHandler: upload, imagePreviewHandler: async src => imageUrl(src), disableImageResize: true }),
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
  const { error, images, panel, editor } = usePage();
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
      {panel && editor && <ImagesPanel editor={editor} sources={images} />}
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
void session.load();
