import { useRef, useSyncExternalStore } from 'react';
import { ModalFrame, modalActionButton } from './design';
import { useDialogKeyboardOwner } from './wall/wall-context';
import { decideEditorClose, getEditorClosePrompt, subscribeEditorClosePrompt } from '../lib/tool-editor';

export function ToolEditorCloseModalHost() {
  const pending = useSyncExternalStore(subscribeEditorClosePrompt, getEditorClosePrompt);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogKeyboardOwner(pending !== null);
  if (!pending) return null;
  return <ModalFrame titleId="save-tool-title" layer="critical" initialFocusRef={cancel}
    onEscape={() => { void decideEditorClose('cancel'); }} padding="spacious">
    <h2 id="save-tool-title" className="text-sm font-semibold">Save changes before closing?</h2>
    <ul className="my-3 max-w-lg break-words text-sm">
      {pending.items.map(({ id, label }) => <li key={id}>{label}</li>)}
    </ul>
    {pending.error && <p role="alert" className="mb-3 text-sm">{pending.error}</p>}
    <div className="flex justify-end gap-2">
      <button ref={cancel} disabled={pending.saving} className={modalActionButton()} onClick={() => void decideEditorClose('cancel')}>Cancel</button>
      <button disabled={pending.saving} className={modalActionButton()} onClick={() => void decideEditorClose('discard')}>Discard</button>
      <button disabled={pending.saving} className={modalActionButton()} onClick={() => void decideEditorClose('save')}>{pending.saving ? 'Saving…' : 'Save'}</button>
    </div>
  </ModalFrame>;
}
