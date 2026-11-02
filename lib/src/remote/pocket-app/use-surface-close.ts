/**
 * A close from this phone (`docs/specs/remote-api.md` -> "Closing a surface"):
 * the phone's own copy of a Tool first, since the computer cannot see its edits,
 * then whatever consent the computer says the close needs.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { REMOTE_METHODS, type SurfaceCloseParams, type SurfaceCloseResult } from 'remote-lib-common';
import type { MobileCloseDialogState } from '../../components/MobileCloseDialog';
import { randomKillChar } from '../../components/KillConfirm';
import { messageOf } from '../../lib/errors';
import {
  cancelEditorClose,
  confirmToolEditorsClose,
  decideEditorClose,
  getEditorClosePrompt,
  subscribeEditorClosePrompt,
} from '../../lib/tool-editor';

export interface SurfaceCloseSession {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** Consent is given at most once per kind, so this many answers always end it. */
const MAX_ANSWERS = 3;

export function useSurfaceClose(session: SurfaceCloseSession | null): {
  close: (surfaceId: string) => void;
  dialog: MobileCloseDialogState | null;
} {
  const [asked, setAsked] = useState<MobileCloseDialogState | null>(null);
  const closing = useRef(false);
  // The one prompt that outlives this hook, being module-wide. Answered later, it
  // would send the close down `session`, to whichever Burrow that reaches by then.
  const askingOwnEdits = useRef(false);
  useEffect(() => () => { if (askingOwnEdits.current) cancelEditorClose(); }, []);
  const ownPrompt = useSyncExternalStore(subscribeEditorClosePrompt, getEditorClosePrompt);

  const close = useCallback((surfaceId: string) => {
    if (!session || closing.current) return;
    closing.current = true;
    /** Show a dialog until its answer; gone with the hook, whose dialogs no one can answer. */
    const ask = <T,>(build: (answer: (value: T) => void) => MobileCloseDialogState) => new Promise<T>((resolve) => {
      setAsked(build((value) => { setAsked(null); resolve(value); }));
    });
    const refused = (message: string) => ask<void>((answer) => ({ kind: 'refused', message, onDismiss: () => answer() }));
    const confirm = () => ask<boolean>((answer) => ({
      kind: 'confirm', char: randomKillChar(), onConfirm: () => answer(true), onCancel: () => answer(false),
    }));
    const unsaved = (label: string) => ask<'save' | 'discard' | null>((answer) => ({
      kind: 'unsaved', labels: [label], onSave: () => answer('save'), onDiscard: () => answer('discard'), onCancel: () => answer(null),
    }));
    void (async () => {
      try {
        askingOwnEdits.current = true;
        const own = await confirmToolEditorsClose([surfaceId]);
        askingOwnEdits.current = false;
        if (!own) return;
        const params: SurfaceCloseParams = { surfaceId };
        for (let answers = 0; answers < MAX_ANSWERS; answers += 1) {
          const result = await session.request<SurfaceCloseResult>(REMOTE_METHODS.surfaceClose, params);
          if (result.outcome === 'closed') return;
          if (result.outcome === 'refused') {
            await refused(result.message);
            return;
          }
          if (result.outcome === 'confirm') {
            if (!(await confirm())) return;
            params.confirmed = true;
          } else {
            const choice = await unsaved(result.label);
            if (!choice) return;
            params.unsaved = choice;
          }
        }
      } catch (error) {
        await refused(messageOf(error));
      } finally {
        closing.current = false;
      }
    })();
  }, [session]);

  const dialog: MobileCloseDialogState | null = ownPrompt
    ? {
        kind: 'unsaved',
        labels: ownPrompt.items.map(({ label }) => label),
        saving: ownPrompt.saving,
        error: ownPrompt.error,
        onSave: () => void decideEditorClose('save'),
        onDiscard: () => void decideEditorClose('discard'),
        onCancel: () => void decideEditorClose('cancel'),
      }
    : asked;
  return { close, dialog };
}
