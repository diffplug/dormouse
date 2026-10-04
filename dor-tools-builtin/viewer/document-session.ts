import { connectToolFrame } from 'dor-tools-lib/frame';

/** What the page shows: whether a document is loaded, has unsaved edits, or is saving. */
export interface DocumentState { loaded: boolean; dirty: boolean; saving: boolean }

/** One editor's view of an opened document. It saves `Content` (the file's
 * text, or an image's bytes) and is given `Loaded` (the same, or decoded pixels). */
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

/** How a page reads and writes a document's contents. */
export interface DocumentSource<Content, Loaded = Content> {
  load(): Promise<{ content: Loaded; version: string; name: string }>;
  /** Writes `content` over revision `version`; resolves to the new revision. */
  save(content: Content, version: string): Promise<{ version: string }>;
}

/** Where a page shows one document's state and errors. */
export interface DocumentView {
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

export const sameState = (a: DocumentState, b: DocumentState) => a.loaded === b.loaded && a.dirty === b.dirty && a.saving === b.saving;

/** The status the pages show beside Save. */
export const stateLabel = ({ loaded, dirty, saving }: DocumentState) =>
  !loaded ? 'Loading…' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';

/** Asks through `dialog` (the page's `#confirm`, before a reload) whether to
 * discard edits: true when its form closes it with the value `discard`. */
export function confirmDiscard(dialog = document.getElementById('confirm') as HTMLDialogElement): Promise<boolean> {
  dialog.returnValue = 'cancel';
  const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
  dialog.showModal();
  return answer;
}

/** One document a page has open: its revision on disk, the editor's mark for
 * it, and one revision-checked save at a time. */
export interface OpenDocument {
  /** Whether the first load has landed. */
  loaded(): boolean;
  /** Whether the editor moved off the saved revision. */
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
  /** Takes the document off the page. */
  close(): void;
}

export interface DocumentPage {
  /** Opens a document in front of the page's others. */
  open<Mark, Content = string, Loaded = Content>(editor: DocumentEditor<Mark, Content, Loaded>, view: DocumentView,
    source: DocumentSource<Content, Loaded>): OpenDocument;
}

/** A built-in editor page (docs/specs/dor-tools-builtin.md -> Editing files)
 * over a stack of open documents: its own, and any it edits in front, as the
 * Markdown page's image overlay. Cmd/Ctrl+S saves the front document; the
 * Tool is dirty while any document is, which the page reports to the
 * containing iframe at once and to the Tool's OSC 367 stream in order; the
 * host's close-prompt save writes them all. */
export function documentPage(): DocumentPage {
  /** The page's own document first; the last is in front. */
  const documents: OpenDocument[] = [];
  let lastDirty: boolean | undefined;
  let stateQueue = Promise.resolve();
  const toolDirty = () => documents.some(doc => doc.dirty());
  // The host's close prompt saves through this channel (docs/specs/dor-tool.md -> Closing unsaved Tools).
  const host = connectToolFrame({
    dirty: () => documents[0]?.loaded() ? toolDirty() : undefined,
    async save() {
      // In turn: the viewer takes one save at a time.
      let failure: { reason: unknown } | undefined;
      for (const doc of [...documents]) {
        try { await doc.write(); } catch (reason) { failure ??= { reason }; }
      }
      if (failure) throw failure.reason;
    },
  });

  function report() {
    // Post immediately so the preview is pinned before a second selection can
    // replace it. The ordered OSC reports also cover automated browser renders.
    host.report();
    const dirty = toolDirty();
    if (dirty !== lastDirty) {
      lastDirty = dirty;
      stateQueue = stateQueue.then(() => request('state', { dirty })).then(() => {}, reason => documents[0]?.fail(reason));
    }
  }

  // Capture phase: runs before the editors, and outside them too.
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void documents.at(-1)?.save();
    }
  }, true);
  window.addEventListener('beforeunload', event => {
    if (window.parent === window && toolDirty()) { event.preventDefault(); event.returnValue = ''; }
  });

  return {
    open(editor, view, source) {
      const doc = openDocument(editor, view, source, report, () => {
        const at = documents.indexOf(doc);
        if (at < 0) return;
        documents.splice(at, 1);
        report();
      });
      documents.push(doc);
      return doc;
    },
  };
}

function openDocument<Mark, Content, Loaded>(editor: DocumentEditor<Mark, Content, Loaded>, view: DocumentView,
  source: DocumentSource<Content, Loaded>, onReport: () => void, onClose: () => void): OpenDocument {
  let version = '';
  let saved: { mark: Mark } | undefined;
  let saving: Promise<void> | null = null;
  const fail = (reason: unknown) => view.fail(message(reason));
  const dirty = () => !!saved && !editor.holds(saved.mark);
  const current = () => editor.mark ? editor.mark() : editor.snapshot().mark;

  function report() {
    view.report({ loaded: !!saved, dirty: dirty(), saving: saving !== null });
    onReport();
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
    version = file.version;
    await editor.apply(file.content, file.name);
    saved = { mark: current() };
    report();
  }

  return {
    loaded: () => !!saved,
    dirty,
    load: () => load().catch(fail),
    save: () => write().catch(() => {}),
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
    close: onClose,
  };
}
