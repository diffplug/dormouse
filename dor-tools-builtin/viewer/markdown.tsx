import { createRef, useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { LexicalEditor } from 'lexical';
import {
  BlockTypeSelect, BoldItalicUnderlineToggles, codeBlockPlugin, codeMirrorPlugin, CodeToggle, CreateLink, diffSourcePlugin,
  DiffSourceToggleWrapper, frontmatterPlugin, headingsPlugin, imagePlugin, InsertCodeBlock, InsertTable, InsertThematicBreak,
  linkDialogPlugin, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, quotePlugin, realmPlugin,
  rootEditor$, Separator, viewMode$, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo, type MDXEditorMethods, type Realm,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { documentSession, request, type DocumentState } from './document-session';
import { imageSources, imageUrl, ImagesPanel } from './images-panel';
import { commentsPlugin } from './markdown-comments';
import { markdownSafetyPlugin } from './markdown-safety';
import { pageTheme, subscribeTheme } from './markdown-theme';
import { mermaidDescriptor } from './mermaid-block';
import './markdown.css';

// Page state outside React: the session reports into it, components subscribe.
let docState: DocumentState = { loaded: false, dirty: false, saving: false };
let error: string | null = null;
let images: string[] = [];
let panelOpen = false;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const editorRef = createRef<MDXEditorMethods>();
let realm: Realm | undefined;
const lexical = () => realm?.getValue(rootEditor$) ?? null;

/** Line endings the file had: saves restore CRLF when it was the majority. */
let crlf = false;
let loads = 0;

// The editor trims the document; saves end it with one newline.
const session = documentSession<string>({
  snapshot() {
    const markdown = editorRef.current!.getMarkdown();
    const text = markdown ? `${markdown}\n` : '';
    return { text: crlf ? text.replace(/\n/g, '\r\n') : text, mark: markdown };
  },
  holds: mark => editorRef.current?.getMarkdown() === mark,
  async apply(text) {
    const newlines = text.match(/\n/g)?.length ?? 0;
    crlf = (text.match(/\r\n/g)?.length ?? 0) * 2 > newlines;
    // A reload mounts a fresh editor: its own normalization is then not an edit, and undo starts over.
    flushSync(() => root.render(<Page key={++loads} markdown={text.replace(/\r\n?/g, '\n')} />));
    await new Promise(resolve => setTimeout(resolve));
  },
}, {
  report(state) { docState = state; emit(); },
  fail(text) { error = text; emit(); },
});

const capture = realmPlugin({
  init(r) { realm = r; },
  postInit(r) {
    const editor = r.getValue(rootEditor$);
    editor?.registerUpdateListener(() => refreshImages(editor));
    refreshImages(editor);
  },
});

async function upload(file: File): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  try { return (await request('image', { type: file.type, data })).name; }
  catch (reason) { session.fail(reason); throw reason; }
}

function Controls() {
  const state = useSyncExternalStore(subscribe, () => docState);
  const panel = useSyncExternalStore(subscribe, () => panelOpen);
  const count = useSyncExternalStore(subscribe, () => images.length);
  return (
    <div className="controls">
      <span className="state" role="status">{!state.loaded ? 'Loading…' : state.saving ? 'Saving…' : state.dirty ? 'Unsaved' : 'Saved'}</span>
      <button type="button" aria-pressed={panel} title="List and rename this document's images" onClick={() => { panelOpen = !panelOpen; emit(); }}>Images{count ? ` (${count})` : ''}</button>
      <button type="button" title="Reload from disk" onClick={() => void session.reload(confirmDiscard)}>Reload</button>
      <button type="button" className="save" disabled={!state.loaded || !state.dirty || state.saving} title="Save [Cmd/Ctrl+S]" onClick={() => void session.save()}>Save</button>
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
  } }),
  diffSourcePlugin({ viewMode: 'rich-text' }),
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

function refreshImages(editor: LexicalEditor | null) {
  const next = editor ? imageSources(editor) : [];
  if (next.join('\n') !== images.join('\n')) { images = next; emit(); }
}

function Page({ markdown }: { markdown: string }) {
  const theme = useSyncExternalStore(subscribeTheme, pageTheme);
  const message = useSyncExternalStore(subscribe, () => error);
  const sources = useSyncExternalStore(subscribe, () => images);
  const open = useSyncExternalStore(subscribe, () => panelOpen);
  const style = useMemo(() => markdownStyle(markdown), [markdown]);
  const editor = lexical();
  return (
    <>
      {message && <div className="error" role="alert">{message}</div>}
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
      {open && editor && <ImagesPanel editor={editor} sources={sources} />}
    </>
  );
}

function confirmDiscard(): Promise<boolean> {
  const dialog = document.getElementById('confirm') as HTMLDialogElement;
  dialog.returnValue = 'cancel';
  const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
  dialog.showModal();
  return answer;
}

const root = createRoot(document.getElementById('root')!);
void session.load();
