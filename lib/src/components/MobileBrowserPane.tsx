import type { ReactNode } from 'react';
import { modalActionButton } from './design';

/**
 * Where a Session's browser stands (`docs/specs/mobile-terminal-ui.md` ->
 * "Browser"): `connecting` waits on the direct path, and `relayed` will not get
 * one on this session. `gone` is a page the computer no longer shows.
 */
export type MobileBrowserStatus =
  | { kind: 'connecting' }
  | { kind: 'relayed' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'gone' }
  | { kind: 'failed'; message: string };

export function MobileBrowserPane({
  status,
  view,
  onReconnect,
  onRetry,
  onShowSessions,
}: {
  status: MobileBrowserStatus;
  /** What shows the browser, an iframe today; kept mounted while it loads so it can finish. */
  view?: ReactNode;
  onReconnect?: () => void;
  onRetry?: () => void;
  onShowSessions?: () => void;
}) {
  const viewing = status.kind === 'loading' || status.kind === 'ready';
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-app-bg text-app-fg">
      {viewing ? <div className="h-full w-full">{view}</div> : null}
      {status.kind === 'ready' ? null : (
        <div className="absolute inset-0 grid place-items-center overflow-auto bg-app-bg p-6 text-center font-mono text-sm">
          <BrowserNotice status={status} onReconnect={onReconnect} onRetry={onRetry} onShowSessions={onShowSessions} />
        </div>
      )}
    </div>
  );
}

function BrowserNotice({
  status,
  onReconnect,
  onRetry,
  onShowSessions,
}: {
  status: Exclude<MobileBrowserStatus, { kind: 'ready' }>;
  onReconnect?: () => void;
  onRetry?: () => void;
  onShowSessions?: () => void;
}) {
  switch (status.kind) {
    case 'connecting':
      return <p role="status" className="text-muted">Connecting directly…</p>;
    case 'loading':
      return <p role="status" className="text-muted">Loading page…</p>;
    case 'relayed':
      return (
        <div className="grid max-w-xs gap-3">
          <p className="font-medium">This page needs a direct connection to your computer.</p>
          <p className="text-xs text-muted">A VPN such as Tailscale, on both this phone and your computer, can make one possible. Turn it on, then reconnect.</p>
          <BrowserAction label="Reconnect" onClick={onReconnect} />
        </div>
      );
    case 'gone':
      return (
        <div className="grid max-w-xs gap-3">
          <p className="font-medium">This page is no longer open on your computer.</p>
          <BrowserAction label="Show sessions" onClick={onShowSessions} />
        </div>
      );
    case 'failed':
      return (
        <div className="grid max-w-xs gap-3">
          <p className="font-medium">This page could not open.</p>
          <p className="break-words text-xs text-muted">{status.message}</p>
          <BrowserAction label="Try again" onClick={onRetry} />
        </div>
      );
  }
}

function BrowserAction({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={modalActionButton({ tone: 'primary', class: 'min-h-10 justify-self-center px-4' })}>
      {label}
    </button>
  );
}
