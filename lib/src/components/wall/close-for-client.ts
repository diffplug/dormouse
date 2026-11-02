import type { SurfaceCloseResult } from 'remote-lib-common';
import type { ClientCloseConsent } from '../../remote/burrow/client-close';

export const TERMINAL_CLOSE_REFUSAL = 'A terminal closes only on the computer.';

/** What a Wall knows of one Surface, for a close a Client asked for. */
export interface CloseForClientDeps {
  isTerminal: boolean;
  transferRefusal(): string | null;
  /** Running helper work, which also shows at the computer. */
  helperRefusal(): Promise<string | null>;
  /** The state the close leaves behind, read after the helper's answer. */
  needsConfirm(): boolean;
  isDirty(): boolean;
  label(): string;
  /** Why saving did not leave it clean, or `null`. */
  save(): Promise<string | null>;
  /**
   * Close, discarding unsaved edits only if told to, so edits made since a save
   * or a clean read still refuse; why it did not, or `null`.
   */
  close(discard: boolean): Promise<string | null>;
}

/**
 * The kill gesture's decisions, in its order, with the consent the person gave
 * at the Client in place of this window's prompts (`docs/specs/remote-api.md` ->
 * "Closing a surface").
 */
export async function closeForClient(
  { confirmed, unsaved }: ClientCloseConsent,
  deps: CloseForClientDeps,
): Promise<SurfaceCloseResult> {
  if (deps.isTerminal) return { outcome: 'refused', message: TERMINAL_CLOSE_REFUSAL };
  const transferring = deps.transferRefusal();
  if (transferring) return { outcome: 'refused', message: transferring };
  const helper = await deps.helperRefusal();
  if (helper) return { outcome: 'refused', message: helper };
  if (!confirmed && deps.needsConfirm()) return { outcome: 'confirm' };
  const dirty = deps.isDirty();
  if (dirty) {
    if (!unsaved) return { outcome: 'unsaved', label: deps.label() };
    if (unsaved === 'save') {
      const failed = await deps.save();
      if (failed) return { outcome: 'refused', message: failed };
    }
  }
  const refused = await deps.close(dirty && unsaved === 'discard');
  return refused ? { outcome: 'refused', message: refused } : { outcome: 'closed' };
}
