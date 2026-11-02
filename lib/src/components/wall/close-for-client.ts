import type { SurfaceCloseResult } from 'remote-lib-common';
import type { ClientCloseConsent } from '../../remote/burrow/client-close';

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
  /** Close, unsaved edits consented to; why it did not, or `null`. */
  close(): Promise<string | null>;
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
  if (deps.isTerminal) return { outcome: 'refused', message: 'A terminal closes only on the computer.' };
  const transferring = deps.transferRefusal();
  if (transferring) return { outcome: 'refused', message: transferring };
  const helper = await deps.helperRefusal();
  if (helper) return { outcome: 'refused', message: helper };
  if (!confirmed && deps.needsConfirm()) return { outcome: 'confirm' };
  if (deps.isDirty()) {
    if (!unsaved) return { outcome: 'unsaved', label: deps.label() };
    if (unsaved === 'save') {
      const failed = await deps.save();
      if (failed) return { outcome: 'refused', message: failed };
    }
  }
  const refused = await deps.close();
  return refused ? { outcome: 'refused', message: refused } : { outcome: 'closed' };
}
