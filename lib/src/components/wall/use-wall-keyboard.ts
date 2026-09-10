import { useEffect, useRef } from 'react';
import { handleDualTap } from './keyboard/handle-dual-tap';
import { handleEditableClipboard } from './keyboard/handle-editable-clipboard';
import { handleMouseSelectionKeys } from './keyboard/handle-mouse-selection-keys';
import { handleKillConfirm } from './keyboard/handle-kill-confirm';
import { handlePaneShortcuts } from './keyboard/handle-pane-shortcuts';
import { handlePaneNavigation } from './keyboard/handle-pane-navigation';
import { isProxyOrigin } from '../../lib/iframe-proxy-registry';
import { chromeKeyboardHeld } from '../../lib/chrome-keyboard-lease';
import type { NavHistoryRef, WallKeyboardCtx } from './keyboard/types';

export function useWallKeyboard(ctx: WallKeyboardCtx): void {
  const lastCmdSide = useRef<'left' | 'right' | null>(null);
  const lastCmdTime = useRef(0);
  const lastShiftSide = useRef<'left' | 'right' | null>(null);
  const lastShiftTime = useRef(0);
  const navHistory = useRef<NavHistoryRef['current']>(null);

  // Refs are stable across renders, so the handler can close over `ctx` once
  // and never re-subscribe. Stuffing every prop into deps would re-bind the
  // listener on every Wall render and break dual-tap timing.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    const dualTapState = { lastCmdSide, lastCmdTime, lastShiftSide, lastShiftTime };

    const handler = (e: KeyboardEvent) => {
      const c = ctxRef.current;
      // A hidden Workspace's Wall keeps its listeners but dispatches nothing:
      // exactly one Wall answers window input (docs/specs/layout.md →
      // "Workspaces").
      if (!c.activeRef.current) return;

      const context = (e.target as HTMLElement | null)?.closest?.('[data-terminal-context]');
      if (context) {
        if (handleEditableClipboard(e)) return;
        const helperId = (e.target as HTMLElement).closest<HTMLElement>('[data-helper-terminal]')?.dataset.helperTerminal;
        if (helperId) handleMouseSelectionKeys(e, { ...c, selectedIdRef: { current: helperId } });
        return;
      }
      if (handleDualTap(e, c, dualTapState)) return;
      // Before every mode/renaming gate below: a focused text field owns its
      // clipboard chords no matter what the wall is doing.
      if (handleEditableClipboard(e)) return;
      if (handleMouseSelectionKeys(e, c)) return;
      if (c.modeRef.current === 'passthrough') return;
      // A pane rename, or chrome outside every Wall holding the lease (the
      // Workspace strip's rename editor / close confirmation).
      if (c.renamingRef.current || chromeKeyboardHeld()) return;
      if (handleKillConfirm(e, c)) return;
      if (c.dialogKeyboardActiveRef.current) return;
      if (handlePaneShortcuts(e, c, navHistory)) return;
      handlePaneNavigation(e, c, navHistory);
    };

    // A focused cross-origin iframe owns the keyboard, so its keystrokes never
    // reach the capturing window listener above. The proxy shim posts our
    // reserved leader chord back out (docs/specs/dor-browser.md → "Iframe
    // Shim"); feed it into the same dispatch the in-document dual-tap would,
    // after validating the message came from a live proxy origin.
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { __dormouse?: unknown } | null;
      if (!data || data.__dormouse !== 'leader') return;
      if (!isProxyOrigin(e.origin)) return;
      const c = ctxRef.current;
      if (!c.activeRef.current) return;
      if (c.modeRef.current === 'passthrough') c.exitTerminalMode();
    };

    window.addEventListener('keydown', handler, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('message', onMessage);
    };
  }, []);
}
