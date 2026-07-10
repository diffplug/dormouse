import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { CircleNotchIcon } from '@phosphor-icons/react';
import { POPUP_SURFACE_CLASS } from '../design';
import { clampOverlayPosition } from '../../lib/ui-geometry';
import { getPlatform } from '../../lib/platform';
import type { OpenPort } from '../../lib/platform/types';
import { listenerUrlsByPort, type PortUrlEntry } from './port-url';
import { useDismissOverlay } from './use-dismiss-overlay';
import { WallActionsContext } from './wall-context';

type ScanState =
  | { status: 'scanning' }
  | { status: 'loaded'; entries: PortUrlEntry[] }
  | { status: 'failed' };

/**
 * The right-click menu on a terminal pane header (`docs/specs/layout.md` → Pane
 * header): the pane's `surface:N` handle, then the TCP ports its process tree
 * binds. Clicking a port reproduces `dor ab open <url>` via
 * `WallActions.onConnectPort` (`docs/specs/dor-browser.md` → Pane Context Menu
 * Connect). Port rows are only clickable when the host can run agent-browser;
 * otherwise the list is an inert label (the host-gated-affordance convention).
 */
export function PaneHeaderContextMenu({
  id,
  anchor,
  onClose,
}: {
  id: string;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const actions = useContext(WallActionsContext);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: anchor.x, top: anchor.y });
  const [scan, setScan] = useState<ScanState>({ status: 'scanning' });
  const [connectingPort, setConnectingPort] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Absent ⇒ opening a browser surface isn't supported here; port rows render as
  // plain labels rather than buttons (the list stays informative).
  const canConnect = !!getPlatform().agentBrowserCommand;

  // Scan once when the menu opens — no polling, no rescan while open (right-click
  // again to rescan). The scan may reject on timeout (`OPEN_PORT_TIMEOUT_MS`).
  useEffect(() => {
    let cancelled = false;
    getPlatform().getOpenPorts(id).then(
      (ports: OpenPort[]) => { if (!cancelled) setScan({ status: 'loaded', entries: listenerUrlsByPort(ports) }); },
      () => { if (!cancelled) setScan({ status: 'failed' }); },
    );
    return () => { cancelled = true; };
  }, [id]);

  // Clamp inside the viewport once measured; re-run when the content height
  // changes (scanning → loaded, or an error line appears).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setStyle(clampOverlayPosition({ left: anchor.x, top: anchor.y, width: rect.width, height: rect.height }));
  }, [anchor.x, anchor.y, scan, connectError]);

  useDismissOverlay(onClose);

  const connect = async (entry: PortUrlEntry) => {
    setConnectError(null);
    setConnectingPort(entry.port);
    const result = await actions.onConnectPort(id, entry.url);
    if (result.ok) {
      onClose();
    } else {
      setConnectError(result.message);
      setConnectingPort(null);
    }
  };

  const connecting = connectingPort !== null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Pane actions"
      data-pane-context-menu-for={id}
      className={`${POPUP_SURFACE_CLASS} max-h-[70vh] w-fit min-w-52 max-w-96 overflow-auto py-1 text-sm`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-2.5 py-0.5 text-muted">{actions.resolveSurfaceRef(id)}</div>
      <div className="my-1 border-t border-border" />
      {scan.status === 'scanning' && (
        <div className="flex items-center gap-2 px-2.5 py-1 text-muted">
          <CircleNotchIcon className="shrink-0 animate-spin" size={13} weight="bold" />
          scanning ports…
        </div>
      )}
      {scan.status === 'failed' && (
        <div className="px-2.5 py-1 text-muted">port scan failed</div>
      )}
      {scan.status === 'loaded' && scan.entries.length === 0 && (
        <div className="px-2.5 py-1 text-muted">no listening ports</div>
      )}
      {scan.status === 'loaded' && scan.entries.map((entry) => {
        const label = (
          <>
            <span className="min-w-0 truncate">{entry.host}:{entry.port}</span>
            {entry.processName && <span className="min-w-0 truncate text-muted">{entry.processName}</span>}
          </>
        );
        return canConnect ? (
          <button
            key={entry.port}
            type="button"
            role="menuitem"
            data-port-entry={entry.port}
            disabled={connecting}
            className="flex w-full items-baseline gap-2 px-2.5 py-1 text-left hover:bg-foreground/10 disabled:cursor-default disabled:opacity-60"
            onClick={() => connect(entry)}
          >
            {label}
            {connectingPort === entry.port && (
              <CircleNotchIcon className="ml-auto shrink-0 animate-spin" size={13} weight="bold" />
            )}
          </button>
        ) : (
          <div key={entry.port} data-port-entry={entry.port} className="flex items-baseline gap-2 px-2.5 py-1">
            {label}
          </div>
        );
      })}
      {connectError && (
        <>
          <div className="my-1 border-t border-border" />
          <div className="truncate px-2.5 py-0.5 text-muted" title={connectError}>{connectError}</div>
        </>
      )}
    </div>,
    document.body,
  );
}
