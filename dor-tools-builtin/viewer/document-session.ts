import { connectToolFrame } from 'dor-tools-lib/frame';

/** What the page shows: whether a document is loaded, has unsaved edits, or is saving. */
export interface DocumentState { loaded: boolean; dirty: boolean; saving: boolean }

/** One editor's view of the opened document. */
export interface DocumentEditor<Mark> {
  /** The text to save and a mark naming the revision it came from. */
  snapshot(): { text: string; mark: Mark };
  /** Whether the editor still holds the revision `mark` names. */
  holds(mark: Mark): boolean;
  /** Replaces the editor's contents with the file's `text`. */
  apply(text: string, name: string): void | Promise<void>;
}

export async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
  return response.json();
}

export const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** The status both pages show beside Save. */
export const stateLabel = ({ loaded, dirty, saving }: DocumentState) =>
  !loaded ? 'Loading…' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';

/** Asks through the page's `#confirm` dialog before a reload discards edits. */
export function confirmDiscard(): Promise<boolean> {
  const dialog = document.getElementById('confirm') as HTMLDialogElement;
  dialog.returnValue = 'cancel';
  const answer = new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true }));
  dialog.showModal();
  return answer;
}

/** Loads, saves, and reports one document for a built-in editor page
 * (docs/specs/dor-tools-builtin.md -> Editing files): revision-checked saves on
 * Save or Cmd/Ctrl+S, dirty state reported to the containing iframe at once
 * and to the Tool's OSC 367 stream in order. */
export function documentSession<Mark>(editor: DocumentEditor<Mark>, view: {
  report(state: DocumentState): void;
  /** Shows `text` as the page's error, or clears it when null. */
  fail(text: string | null): void;
}) {
  let version = '';
  let saved: { mark: Mark } | undefined;
  let saving: Promise<void> | null = null;
  let lastDirty: boolean | undefined;
  let stateQueue = Promise.resolve();
  const fail = (reason: unknown) => view.fail(message(reason));
  const dirty = () => !!saved && !editor.holds(saved.mark);
  // The host's close prompt saves through this channel (docs/specs/dor-tool.md -> Closing unsaved Tools).
  const host = connectToolFrame({
    dirty: () => saved ? dirty() : undefined,
    save: () => save().catch(reason => { fail(reason); throw reason; }),
  });

  function report() {
    const changed = dirty();
    view.report({ loaded: !!saved, dirty: changed, saving: saving !== null });
    // Post immediately so the preview is pinned before a second selection can
    // replace it. The ordered OSC reports also cover automated browser renders.
    host.report();
    if (changed !== lastDirty) {
      lastDirty = changed;
      stateQueue = stateQueue.then(() => request('state', { dirty: changed })).then(() => {}, fail);
    }
  }
  async function save() {
    if (saving) return saving;
    if (!dirty()) return;
    const { text, mark } = editor.snapshot();
    view.fail(null);
    saving = request('save', { text, version }).then(result => {
      version = result.version;
      saved = { mark }; // Undo restores this revision; newer edits stay dirty.
    }).finally(() => { saving = null; report(); });
    report();
    return saving;
  }
  async function load() {
    const source = await request('source');
    version = source.version;
    await editor.apply(source.text, source.name);
    saved = { mark: editor.snapshot().mark };
    report();
  }

  // Capture phase: runs before the editor, and outside it too.
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); void save().catch(fail);
    }
  }, true);
  window.addEventListener('beforeunload', event => {
    if (window.parent === window && dirty()) { event.preventDefault(); event.returnValue = ''; }
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
    /** Call after every edit. */
    changed: report,
    /** Takes the editor's contents as the saved revision: for an editor's own
     * normalization of the text it loaded, before any edit. */
    rebase() {
      if (!saved || saving) return;
      saved = { mark: editor.snapshot().mark };
      report();
    },
    fail,
  };
}
