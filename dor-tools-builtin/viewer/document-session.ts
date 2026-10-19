import { connectToolFrame } from 'dor-tools-lib/frame';
import type { ToolViewAccess } from 'dor-tools-lib/protocol';

/** What the page shows: whether a document is loaded, has unsaved edits, or is saving. */
export interface DocumentState { loaded: boolean; dirty: boolean; saving: boolean }
/** A document's state before its first load lands. */
export const loadingState: DocumentState = { loaded: false, dirty: false, saving: false };

/** One editor's view of an opened document, whose contents are `Content`
 * (the file's text, or an image's bytes) and arrive as `Loaded`. */
export interface DocumentEditor<Mark, Content = string, Loaded = Content> {
  /** The contents to save and a mark naming the revision they came from. */
  snapshot(): { content: Content | Promise<Content>; mark: Mark };
  /** The current revision's mark, when naming it is cheaper than a snapshot. */
  mark?(): Mark;
  /** Whether the editor still holds the revision `mark` names. */
  holds(mark: Mark): boolean;
  /** Replaces the editor's contents with the file's. */
  apply(content: Loaded, name: string): void | Promise<void>;
}

/** How a page reads a document's contents (as `Loaded`) and writes them. */
export interface DocumentSource<Content, Loaded = Content> {
  load(): Promise<{ content: Loaded; version: string; name: string }>;
  /** Writes `content` over revision `version`; resolves to the new revision. */
  save(content: Content, version: string): Promise<{ version: string }>;
}

/** Where a page shows one document's state and errors. */
export interface DocumentView {
  /** Shows the document's state, each time it changes. */
  report(state: DocumentState): void;
  /** Shows `text` as the document's error, or clears it when null. */
  fail(text: string | null): void;
}

/** `response` when it succeeded; else rejects with its text (or status). */
export async function checked(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
  return response;
}

export async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return (await checked(response)).json();
}

/** A text document: `source` and `save` carry it as JSON. */
export const textSource: DocumentSource<string> = {
  async load() {
    const { text, version, name } = await request('source');
    return { content: text, version, name };
  },
  save: (text, version) => request('save', { text, version }),
};

export const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** The status the pages show beside Save. */
export const stateLabel = ({ loaded, dirty, saving }: DocumentState) =>
  !loaded ? 'Loading…' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';

/** Asks through the page's `#confirm` dialog, before a reload, whether to
 * discard edits: true when its form closes it with the value `discard`. */
function confirmDiscard(): Promise<boolean> {
  const dialog = document.getElementById('confirm') as HTMLDialogElement;
  dialog.returnValue = 'cancel';
  const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
  dialog.showModal();
  return answer;
}

/** One document a page has open: its revision on disk, the editor's mark for
 * it, and one revision-checked save at a time. */
export interface OpenDocument {
  /** Whether the editor had moved off the saved revision when it last reported. */
  dirty(): boolean;
  /** Reads the file into the editor; shows a failure. */
  load(): Promise<void>;
  /** Saves unsaved edits; shows a failure. */
  save(): Promise<void>;
  /** `save`, also rejecting with the failure. */
  write(): Promise<void>;
  /** Reads the file again, after the user agrees to discard unsaved edits. */
  reload(): Promise<void>;
  /** Call after every edit. */
  changed(): void;
  /** Takes the editor's contents as the saved revision: for an editor's own
   * normalization of the text it loaded, before any edit. */
  rebase(): void;
  /** Shows `reason` as this document's error. */
  fail(reason: unknown): void;
}

/** One built-in editor per page. Keyboard saves and the host's close prompt
 * write the same document; navigation owns replacing the page. */
export function documentSession<Mark, Content = string, Loaded = Content>(editor: DocumentEditor<Mark, Content, Loaded>,
  view: DocumentView, source: DocumentSource<Content, Loaded>, position?: ToolViewAccess): OpenDocument {
  let version = '';
  let saved: { mark: Mark } | undefined;
  let saving: Promise<void> | null = null;
  /** As last reported; undefined before the first report. */
  let shown: DocumentState | undefined;
  let stateQueue = Promise.resolve();
  const fail = (reason: unknown) => view.fail(message(reason));
  const dirty = () => !!saved && !editor.holds(saved.mark);
  const current = () => editor.mark ? editor.mark() : editor.snapshot().mark;
  // The host's close prompt saves through this channel (docs/specs/dor-tool.md -> Closing unsaved Tools).
  const host = connectToolFrame({ view: position, dirty: () => saved ? !!shown?.dirty : undefined, save: write });

  function report() {
    const state = { loaded: !!saved, dirty: dirty(), saving: saving !== null };
    const dirtyChanged = state.dirty !== shown?.dirty;
    if (!shown || state.loaded !== shown.loaded || dirtyChanged || state.saving !== shown.saving) view.report(shown = state);
    // Post immediately so a dirty preview is pinned before another selection.
    // Ordered OSC reports also cover automated browser renderers.
    host.report();
    if (dirtyChanged) stateQueue = stateQueue.then(() => request('state', { dirty: state.dirty })).then(() => {}, fail);
  }
  function write(): Promise<void> {
    if (saving) return saving;
    if (!dirty()) return Promise.resolve();
    view.fail(null);
    saving = (async () => {
      const { content, mark } = editor.snapshot();
      version = (await source.save(await content, version)).version;
      saved = { mark }; // Undo restores this revision; newer edits stay dirty.
    })().catch(reason => { fail(reason); throw reason; }).finally(() => { saving = null; report(); });
    report();
    return saving;
  }
  async function load() {
    const file = await source.load();
    await editor.apply(file.content, file.name);
    // After applying: a file the editor cannot take leaves the revision its contents came from.
    version = file.version;
    saved = { mark: current() };
    report();
  }
  const save = () => write().catch(() => {});

  // Capture phase: runs before the editor, and outside it too.
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }, true);
  window.addEventListener('beforeunload', event => {
    if (window.parent === window && shown?.dirty) { event.preventDefault(); event.returnValue = ''; }
  });

  return {
    dirty: () => !!shown?.dirty,
    load: () => load().catch(fail),
    save,
    write,
    async reload() {
      if (saving || (dirty() && !await confirmDiscard())) return;
      view.fail(null);
      await load().catch(fail);
    },
    changed: report,
    rebase() {
      if (!saved || saving) return;
      saved = { mark: current() };
      report();
    },
    fail,
  };
}
