import { useEffect, useRef } from 'react';
import { handleDualTap } from './keyboard/handle-dual-tap';
import { handleMouseSelectionKeys } from './keyboard/handle-mouse-selection-keys';
import { handleKillConfirm } from './keyboard/handle-kill-confirm';
import { handlePaneShortcuts } from './keyboard/handle-pane-shortcuts';
import { handlePaneNavigation } from './keyboard/handle-pane-navigation';
import { isProxyOrigin } from '../../lib/iframe-proxy-registry';
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

      if (handleDualTap(e, c, dualTapState)) return;
      if (handleMouseSelectionKeys(e, c)) return;
      if (c.modeRef.current === 'passthrough') return;
      if (!c.apiRef.current) return;
      if (c.renamingRef.current) return;
      if (handleKillConfirm(e, c)) return;
      if (c.dialogKeyboardActiveRef.current) return;
      if (handlePaneShortcuts(e, c, navHistory)) return;
      handlePaneNavigation(e, c, navHistory);
    };

    // A focused cross-origin iframe owns the keyboard, so its keystrokes never
    // reach the capturing window listener above. The proxy shim posts our
    // reserved leader chord back out (docs/specs/dor-iframe.md → "The keyboard
    // side-channel"); feed it into the same dispatch the in-document dual-tap
    // would, after validating the message came from a live proxy origin.
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { __dormouse?: unknown } | null;
      if (!data || data.__dormouse !== 'leader') return;
      if (!isProxyOrigin(e.origin)) return;
      const c = ctxRef.current;
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
