/**
 * A close from this phone (`docs/specs/remote-api.md` -> "Closing a surface"):
 * the phone's own copy of a Tool first, since the computer cannot see its edits,
 * then whatever consent the computer says the close needs.
 */

import { useCallback, useRef, useState } from 'react';
import { REMOTE_METHODS, type SurfaceCloseParams, type SurfaceCloseResult } from 'remote-lib-common';
import type { MobileCloseDialogState } from '../../components/MobileCloseDialog';
import { randomKillChar } from '../../components/KillConfirm';
import { messageOf } from '../../lib/errors';
import { getToolDirty } from '../../lib/tool-dirty-store';
import { saveToolEditor, toolEditorLabel } from '../../lib/tool-editor';

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

  const close = useCallback((surfaceId: string) => {
    if (!session || closing.current) return;
    closing.current = true;
    /**
     * Show a dialog until its answer. It goes with this hook and so with the
     * session, leaving nothing to answer: `session` forwards to whichever Burrow
     * comes next, where an answer would close whatever has this id.
     */
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
    /** The phone's copy of a Tool: its own save, which keeps asking until it holds. */
    const ownEdits = () => ask<boolean>((answer) => {
      const dialog = (saving: boolean, error?: string): MobileCloseDialogState => ({
        kind: 'unsaved',
        labels: [toolEditorLabel(surfaceId)],
        saving,
        error,
        onSave: () => {
          setAsked(dialog(true));
          void saveToolEditor(surfaceId).then((failed) => {
            if (failed) setAsked(dialog(false, failed));
            else answer(true);
          });
        },
        onDiscard: () => answer(true),
        // Escape reaches here whatever the buttons say.
        onCancel: () => { if (!saving) answer(false); },
      });
      return dialog(false);
    });
    // A discard never declares the document clean, so it is remembered here.
    let discarded = false;
    void (async () => {
      try {
        const params: SurfaceCloseParams = { surfaceId };
        for (let answers = 0; answers < MAX_ANSWERS; answers += 1) {
          // Before every ask: the page stays editable while the computer answers.
          if (getToolDirty(surfaceId) === true) {
            if (!discarded && !(await ownEdits())) return;
            discarded = getToolDirty(surfaceId) === true;
          }
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

  return { close, dialog: asked };
}
