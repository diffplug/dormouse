import { useState, useEffect, useSyncExternalStore } from 'react';
import { MinusIcon, CornersOutIcon, CornersInIcon, XIcon } from '@phosphor-icons/react';
import { PopupButtonRow, chromeButton } from '../../lib/src/components/design';
import { WorkspaceStrip } from '../../lib/src/components/WorkspaceStrip';
import { IS_MAC } from '../../lib/src/lib/platform';
import { onDragBackInsideStrip, onDragCancelled, onDragOutsideWindow, onDropOnOtherWindow } from './workspace-drag';
import { getDropCaretX, subscribeDropCaret } from './workspace-drop-caret';

type AppWindow = {
  isFocused(): Promise<boolean>;
  onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<() => void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
};

/** The browser-dev harness has no windows at all, so it gets no window ops and
 *  no cross-window drag (docs/specs/transport.md → "Standalone browser-dev
 *  harness"). */
const BROWSER_DEV = !!import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST;

let appWindowPromise: Promise<AppWindow | null> | null = null;

function getAppWindow(): Promise<AppWindow | null> {
  if (BROWSER_DEV) {
    return Promise.resolve(null);
  }
  appWindowPromise ??= import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow() as AppWindow);
  return appWindowPromise;
}

function useAppWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    getAppWindow().then((appWindow) => {
      if (cancelled || !appWindow) return;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      appWindow.isFocused().then((next) => {
        if (!cancelled) setFocused(next);
      });
      const unlisten = appWindow.onFocusChanged(({ payload }) => setFocused(payload));
      cleanup = () => { unlisten.then(fn => fn()); };
    });

    return () => {
      cancelled = true;
      cleanup?.();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return focused;
}

// ── Tooltip wrapper ────────────────────────────────────────────────────────

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="group relative flex items-stretch">
      {children}
      <PopupButtonRow
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100"
      >
        {label}
      </PopupButtonRow>
    </div>
  );
}

// ── Windows/Linux window buttons ───────────────────────────────────────────

function WinControls() {
  const [appWindow, setAppWindow] = useState<AppWindow | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAppWindow().then((win) => {
      if (!cancelled) setAppWindow(win);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!appWindow) return;
    appWindow.isMaximized().then(setMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized);
    });
    return () => { unlisten.then(fn => fn()); };
  }, [appWindow]);

  if (!appWindow) return null;

  return (
    <div className="flex items-stretch self-stretch">
      <Tip label="Minimize">
        <button
          className={chromeButton({ kind: 'window' })}
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          <MinusIcon size={12} weight="bold" />
        </button>
      </Tip>
      <Tip label={maximized ? 'Restore' : 'Maximize'}>
        <button
          className={chromeButton({ kind: 'window' })}
          onClick={() => { appWindow.toggleMaximize(); }}
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized
            ? <CornersInIcon size={12} weight="bold" />
            : <CornersOutIcon size={12} weight="bold" />}
        </button>
      </Tip>
      <Tip label="Close">
        <button
          className={chromeButton({ kind: 'windowClose' })}
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          <XIcon size={12} weight="bold" />
        </button>
      </Tip>
    </div>
  );
}

// ── AppBar ─────────────────────────────────────────────────────────────────

export function AppBar() {
  const windowFocused = useAppWindowFocused();

  return (
    <div
      data-tauri-drag-region
      className={`flex h-[30px] shrink-0 select-none items-center text-xs ${
        windowFocused
          ? 'bg-header-active-bg text-header-active-fg'
          : 'bg-header-inactive-bg text-header-inactive-fg'
      } ${
        IS_MAC ? 'pl-[78px]' : ''
      }`}
    >
      {/* On macOS, native traffic lights are shown by titleBarStyle "Overlay" —
          we just leave padding on the left (pl-[78px]) to avoid overlapping them. */}

      {/* The Workspace strip: after the traffic lights on macOS, at the start of
          the bar on Windows/Linux. The spacer after it is the drag target, with
          a floor so it survives any tab count — the strip scrolls into what is
          left rather than growing over it. Tauri matches `data-tauri-drag-region`
          on the event target alone, so no tab or tab button may carry it — that
          is what leaves a press on a tab free to activate, rename, or reorder. */}
      <div className="flex min-w-0 items-center self-stretch pl-2">
        <WorkspaceStrip
          className="min-w-0"
          onDragOutsideWindow={BROWSER_DEV ? undefined : onDragOutsideWindow}
          onDragBackInsideStrip={BROWSER_DEV ? undefined : onDragBackInsideStrip}
          onDropOnOtherWindow={BROWSER_DEV ? undefined : onDropOnOtherWindow}
          onDragCancelled={BROWSER_DEV ? undefined : onDragCancelled}
        />
      </div>
      <div data-tauri-drag-region className="min-w-8 flex-1 self-stretch" />
      <DropCaret />

      {/* Theme and shell selection live in the Settings dialog at the
          bottom-right of the window (docs/specs/theme.md,
          docs/specs/standalone.md), so the titlebar carries only the
          native-style window controls on Windows/Linux. */}
      {!IS_MAC && <WinControls />}
    </div>
  );
}

/**
 * Where a Workspace dragged from another window would land. Fixed-positioned
 * because the caret's x arrives in viewport coordinates
 * (`standalone/src/workspace-drop-caret.ts`).
 */
function DropCaret() {
  const x = useSyncExternalStore(subscribeDropCaret, getDropCaretX);
  if (x === null) return null;
  return (
    <div
      data-workspace-drop-caret
      aria-hidden="true"
      className="pointer-events-none fixed top-0 z-50 h-[30px] w-0.5 bg-current"
      style={{ left: x }}
    />
  );
}
