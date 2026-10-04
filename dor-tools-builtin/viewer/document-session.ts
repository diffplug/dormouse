import { connectToolFrame } from 'dor-tools-lib/frame';

/** What the page shows: whether a document is loaded, has unsaved edits, or is saving. */
export interface DocumentState { loaded: boolean; dirty: boolean; saving: boolean }

/** One editor's view of the opened document, whose contents are `Content`
 * (the file's text, or an image's bytes). */
export interface DocumentEditor<Mark, Content = string> {
  /** The contents to save and a mark naming the revision they came from. */
  snapshot(): { content: Content | Promise<Content>; mark: Mark };
  /** The current revision's mark, when naming it is cheaper than a snapshot. */
  mark?(): Mark;
  /** Whether the editor still holds the revision `mark` names. */
  holds(mark: Mark): boolean;
  /** Replaces the editor's contents with the file's. */
  apply(content: Content, name: string): void | Promise<void>;
}

/** How a page reads and writes its document's contents. */
export interface DocumentSource<Content> {
  load(): Promise<{ content: Content; version: string; name: string }>;
  /** Writes `content` over revision `version`; resolves to the new revision. */
  save(content: Content, version: string): Promise<{ version: string }>;
}

export async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
  return response.json();
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

/** The status both pages show beside Save. */
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

/** A second document a page edits in front of its own, as the Markdown page's
 * image overlay. While it is in front, Cmd/Ctrl+S saves it instead, the Tool
 * is dirty while either document is, and the host's close-prompt save writes both. */
export interface FrontDocument {
  dirty(): boolean;
  /** Rejects when the document could not be saved. */
  save(): Promise<void>;
}

/** Loads, saves, and reports one document for a built-in editor page
 * (docs/specs/dor-tools-builtin.md -> Editing files): revision-checked saves on
 * Save or Cmd/Ctrl+S, dirty state reported to the containing iframe at once
 * and to the Tool's OSC 367 stream in order. */
export function documentSession<Mark, Content = string>(editor: DocumentEditor<Mark, Content>, view: {
  report(state: DocumentState): void;
  /** Shows `text` as the page's error, or clears it when null. */
  fail(text: string | null): void;
}, source: DocumentSource<Content> = textSource as unknown as DocumentSource<Content>) {
  let version = '';
  let saved: { mark: Mark } | undefined;
  let saving: Promise<void> | null = null;
  let lastDirty: boolean | undefined;
  let stateQueue = Promise.resolve();
  let front: FrontDocument | null = null;
  const fail = (reason: unknown) => view.fail(message(reason));
  const dirty = () => !!saved && !editor.holds(saved.mark);
  /** What the Tool reports: this document or the one in front has unsaved edits. */
  const toolDirty = () => dirty() || !!front?.dirty();
  const current = () => editor.mark ? editor.mark() : editor.snapshot().mark;
  // The host's close prompt saves through this channel (docs/specs/dor-tool.md -> Closing unsaved Tools).
  const host = connectToolFrame({
    dirty: () => saved ? toolDirty() : undefined,
    async save() {
      // In turn: the viewer takes one save at a time.
      const errors: unknown[] = [];
      await save().catch(reason => { fail(reason); errors.push(reason); });
      await front?.save().catch(reason => { errors.push(reason); });
      if (errors.length) throw errors[0];
    },
  });

  function report() {
    view.report({ loaded: !!saved, dirty: dirty(), saving: saving !== null });
    // Post immediately so the preview is pinned before a second selection can
    // replace it. The ordered OSC reports also cover automated browser renders.
    host.report();
    const changed = toolDirty();
    if (changed !== lastDirty) {
      lastDirty = changed;
      stateQueue = stateQueue.then(() => request('state', { dirty: changed })).then(() => {}, fail);
    }
  }
  async function save() {
    if (saving) return saving;
    if (!dirty()) return;
    const { content, mark } = editor.snapshot();
    view.fail(null);
    saving = Promise.resolve(content).then(body => source.save(body, version)).then(result => {
      version = result.version;
      saved = { mark }; // Undo restores this revision; newer edits stay dirty.
    }).finally(() => { saving = null; report(); });
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

  // Capture phase: runs before the editor, and outside it too.
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (front) void front.save().catch(() => {}); // the front document shows its own errors
      else void save().catch(fail);
    }
  }, true);
  window.addEventListener('beforeunload', event => {
    if (window.parent === window && toolDirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  return {
    load: () => load().catch(fail),
    save: () => save().catch(fail),
    /** Reads the file again, after the user agrees to discard unsaved edits. */
    async reload() {
      if (saving || (dirty() && !await confirmDiscard())) return;
      view.fail(null);
      await load().catch(fail);
    },
    /** Call after every edit, and when the front document's dirty state changes. */
    changed: report,
    /** Puts `document` in front of this one, or takes it away (null). */
    front(document: FrontDocument | null) {
      front = document;
      if (saved) report();
    },
    /** Takes the editor's contents as the saved revision: for an editor's own
     * normalization of the text it loaded, before any edit. */
    rebase() {
      if (!saved || saving) return;
      saved = { mark: current() };
      report();
    },
    fail,
  };
}
