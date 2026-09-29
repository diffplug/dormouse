import { getToolDirty, recordToolDirty } from './tool-dirty-store';

/** The live connection per Tool; `ready` once its frame has answered. */
type Editor = { label: string; ready: boolean; save(): Promise<void> };
const editors = new Map<string, Editor>();
const listeners = new Set<() => void>();
export type EditorClosePrompt = { items: readonly { id: string; label: string }[]; saving: boolean; error?: string };
let prompt: EditorClosePrompt | null = null;
let settle: ((answer: boolean) => void) | null = null;
const emit = () => { for (const listener of listeners) listener(); };
export const getEditorClosePrompt = () => prompt;
export const subscribeEditorClosePrompt = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** A close that did not ask, or was cancelled, keeps a dirty Tool open. */
export const UNSAVED_TOOL_REFUSAL = 'Tool has unsaved changes. Save or discard them, then close it again.';
export const UNSAVED_TOOL_MOVE_REFUSAL = 'Tool has unsaved changes. Save or discard them before moving this Workspace.';

function finish(answer: boolean): void {
  const resolve = settle;
  settle = null; prompt = null; emit(); resolve?.(answer);
}

export function withToolEditorConsent(id: string, action: () => void): void {
  if (getToolDirty(id) !== true) { action(); return; }
  void confirmToolEditorsClose([id]).then(allowed => { if (allowed) action(); });
}

/** False cancels the destructive action. Discard is permission for that action
 * only: it never declares an unsaved document clean. */
export function confirmToolEditorsClose(ids: readonly string[]): Promise<boolean> {
  const dirty = ids.filter(id => getToolDirty(id) === true);
  if (!dirty.length) return Promise.resolve(true);
  if (prompt) return Promise.resolve(false);
  prompt = { items: dirty.map(id => ({ id, label: editors.get(id)?.label ?? 'Unsaved Tool' })), saving: false };
  const result = new Promise<boolean>(resolve => { settle = resolve; });
  emit();
  return result;
}
/** Native teardown cancellation can arrive while a save is in flight. Stop
 * waiting for consent without cancelling the already requested disk write. */
export const cancelEditorClose = (): void => finish(false);
export async function decideEditorClose(choice: 'save' | 'discard' | 'cancel'): Promise<void> {
  const current = prompt;
  if (!current || current.saving) return;
  if (choice === 'save') {
    // Only a cancel or a newer prompt replaces this one while it saves.
    const busy = { ...current, saving: true, error: undefined };
    prompt = busy; emit();
    try {
      for (const { id } of current.items) {
        if (getToolDirty(id) !== true) continue;
        const editor = editors.get(id);
        if (!editor?.ready) throw new Error('Save this Tool in its own view, then try closing again.');
        await editor.save();
        if (prompt !== busy) return;
      }
      if (current.items.some(({ id }) => getToolDirty(id) === true)) throw new Error('New edits arrived while saving. Save again or cancel.');
    } catch (error) {
      if (prompt !== busy) return;
      prompt = { ...current, saving: false, error: error instanceof Error ? error.message : String(error) }; emit(); return;
    }
  }
  finish(choice !== 'cancel');
}

/** Connect only the built-in editor's own frame and origin. A per-mount nonce
 * rejects late reports after navigation or a preview retarget. */
export function connectToolEditor(id: string, label: string, frame: HTMLIFrameElement, origin: string): () => void {
  const connection = crypto.randomUUID();
  let nextRequest = 0;
  const pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const send = (data: Record<string, unknown>) => frame.contentWindow?.postMessage({ __dormouse: 'editor-command', connection, ...data }, origin);
  const connect = () => send({ kind: 'connect' });
  const editor: Editor = { label, ready: false, save: () => new Promise<void>((resolve, reject) => {
    const request = String(++nextRequest);
    const timer = setTimeout(() => { pending.delete(request); reject(new Error('The editor did not finish saving. Your file remains open.')); }, 15000);
    pending.set(request, { resolve, reject, timer });
    send({ kind: 'save', request });
  }) };
  editors.set(id, editor);
  const receive = (event: MessageEvent) => {
    const data = event.data;
    if (editors.get(id) !== editor || event.source !== frame.contentWindow || event.origin !== origin || data?.__dormouse !== 'editor'
      || data.connection !== connection || typeof data.dirty !== 'boolean') return;
    if (!['ready', 'state', 'saved'].includes(data.kind)) return;
    editor.ready = true;
    recordToolDirty(id, data.dirty);
    if (data.kind === 'saved' && typeof data.request === 'string') {
      const waiting = pending.get(data.request);
      if (waiting) {
        pending.delete(data.request); clearTimeout(waiting.timer);
        if (typeof data.error === 'string') waiting.reject(new Error(data.error)); else waiting.resolve();
      }
    }
  };
  window.addEventListener('message', receive);
  frame.addEventListener('load', connect);
  connect();
  return () => {
    if (editors.get(id) === editor) editors.delete(id);
    window.removeEventListener('message', receive);
    frame.removeEventListener('load', connect);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The editor disconnected while saving.')); }
  };
}
