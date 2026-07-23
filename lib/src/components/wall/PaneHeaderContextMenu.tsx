import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { CircleNotchIcon, XIcon } from '@phosphor-icons/react';
import { POPUP_SURFACE_CLASS } from '../design';
import { clampOverlayPosition } from '../../lib/ui-geometry';
import { getPlatform } from '../../lib/platform';
import type { OpenPort } from '../../lib/platform/types';
import { titleSourceLabel, type TerminalTitle } from '../../lib/terminal-state';
import { listenerUrlsByPort, type PortUrlEntry } from './port-url';
import { useDismissOverlay } from './use-dismiss-overlay';
import { WallActionsContext } from './wall-context';

type ScanState =
  | { status: 'scanning' }
  | { status: 'loaded'; entries: PortUrlEntry[] }
  | { status: 'failed' };

// One recipe for the interactive port-entry rows.
const MENU_ROW_CLASS = 'flex w-full items-baseline gap-2 px-2.5 py-1 text-left hover:bg-foreground/10';

/**
 * The right-click menu on a terminal pane header (`docs/specs/layout.md` → Pane
 * header): a header row with the current display title, the pane's `surface:N`
 * handle, and a close button; then the diagnostic title-candidates table (latest
 * entry per channel); then the TCP ports the pane's process tree binds. Clicking a
 * port fires `dor ab open <url>` via `WallActions.onConnectPort`
 * (`docs/specs/dor-browser.md` → Pane Context Menu Connect) and closes the menu
 * immediately — the new pane's own "Connecting…" placeholder is the loading
 * feedback, and a failure is logged, not shown here. Port rows are only clickable
 * when the host can run agent-browser; otherwise the list is an inert label (the
 * host-gated-affordance convention).
 */
export function PaneHeaderContextMenu({
  id,
  anchor,
  onClose,
  candidates,
  currentTitle,
}: {
  id: string;
  anchor: { x: number; y: number };
  onClose: () => void;
  candidates: TerminalTitle[];
  currentTitle: string;
}) {
  const actions = useContext(WallActionsContext);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: anchor.x, top: anchor.y });
  const [scan, setScan] = useState<ScanState>({ status: 'scanning' });

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
  // changes (scanning → loaded).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setStyle(clampOverlayPosition({ left: anchor.x, top: anchor.y, width: rect.width, height: rect.height }));
  }, [anchor.x, anchor.y, scan]);

  useDismissOverlay(onClose);

  // Fire-and-forget: the pane appears immediately and reports its own progress, so
  // the menu closes at once rather than waiting on the daemon boot.
  const connect = (entry: PortUrlEntry) => {
    actions.onConnectPort(id, entry.url);
    onClose();
  };

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
      <div className="flex items-center gap-2 border-b border-border px-2.5 pb-1.5">
        <span className="min-w-0 flex-1 truncate font-medium">{currentTitle}</span>
        <span className="shrink-0 text-muted">{actions.resolveSurfaceRef(id)}</span>
        <button
          type="button"
          className="shrink-0 rounded px-1 text-muted transition-colors hover:bg-current/10 hover:text-foreground"
          aria-label="Close menu"
          onClick={onClose}
        >
          <XIcon size={12} />
        </button>
      </div>
      <div className="px-2.5 py-1.5">
        {candidates.length === 0 ? (
          <div className="text-muted">No title candidates</div>
        ) : (
          <div className="space-y-1.5">
            {candidates.map((candidate) => (
              <div key={candidate.source} className="grid grid-cols-[4.75rem_minmax(0,1fr)_auto] items-baseline gap-2">
                <span className="text-muted">{titleSourceLabel(candidate.source)}</span>
                <span className="min-w-0 truncate" title={candidate.title}>{candidate.title}</span>
                <time className="text-xs text-muted" dateTime={formatTitleCandidateDateTime(candidate.updatedAt)}>
                  {formatTitleCandidateTime(candidate.updatedAt)}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>
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
            className={MENU_ROW_CLASS}
            onClick={() => connect(entry)}
          >
            {label}
          </button>
        ) : (
          <div key={entry.port} data-port-entry={entry.port} className="flex items-baseline gap-2 px-2.5 py-1">
            {label}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

function formatTitleCandidateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'unknown';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTitleCandidateDateTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}
