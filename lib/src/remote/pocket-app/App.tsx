/**
 * Dormouse Pocket — the phone-side app (docs/specs/pocket-app.md).
 *
 * Auth screens over {@link PocketClient} — sign in (or first-time passkey setup)
 * → pick a host (pair once, then connect) — then, on a successful connect, the
 * real mobile experience: a {@link RemotePtyAdapter} over the session drives
 * `MobileTerminalUi`/`MobileWall` (the same composition the website playground
 * proves out with `FakePtyAdapter`). No bespoke terminal UI.
 *
 * The whole shell — auth screens included — is styled on the shared `--vscode-*`
 * design tokens (DESIGN.md; docs/specs/theme.md), restored before first paint by
 * {@link usePocketTheme}. `pocket.css` carries only document-level structure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PocketClient,
  type ConnectDecision,
  type PocketSocket,
} from '../client/pocket-client';
import { browserWebAuthn } from '../client/webauthn';
import { getOrCreateDeviceKey } from '../client/device-key';
import { RemotePtyAdapter } from '../client/remote-adapter';
import { setPlatform } from '../../lib/platform';
import { disposeAllSessions, initAlertStateReceiver } from '../../lib/terminal-registry';
import { TODO_PILL_TRACKING_CLASS } from '../../components/design';
import { PocketWall } from './PocketWall';
import { usePocketTheme } from './pocket-theme';
import '../../index.css';
import './pocket.css';

type Phase = 'auth' | 'hosts' | 'wall';

export interface HostView {
  hostId: string;
  label: string;
  online: boolean;
}

/** A phone-friendly default pairing label. */
const DEVICE_LABEL = 'Dormouse Pocket';

// Shared shell vocabulary — the auth phases and the wall phase all sit in the
// same app-bg column under a bg-shifted header (Bg-Only Chrome Rule: no border-b).
const APP_SHELL_CLASS = 'flex h-full min-h-0 flex-col bg-app-bg font-mono text-app-fg';
const HEADER_CLASS =
  'flex shrink-0 items-center gap-2 bg-header-inactive-bg px-3 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-header-inactive-fg';
const HEADER_TITLE_CLASS = 'min-w-0 flex-1 truncate text-sm font-semibold';
// Labeled chrome-button treatment at a touch-friendly height.
const HEADER_BUTTON_CLASS =
  'flex h-7 shrink-0 items-center gap-1 rounded px-2 text-sm text-inherit transition-colors hover:bg-current/10 active:bg-current/10 disabled:pointer-events-none disabled:opacity-45';
const BODY_CLASS =
  'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]';
// The block passkey buttons: the modalActionButton primary tone at a 44px touch height.
const PRIMARY_BLOCK_BUTTON_CLASS =
  'flex min-h-11 w-full items-center justify-center rounded bg-header-active-bg px-3 text-sm font-medium text-header-active-fg transition-colors active:opacity-90 focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45';
const FIELD_CLASS = 'flex flex-col gap-1.5';
// text-base (16px) is deliberate: it blocks iOS zoom-on-focus (phone-legibility exception).
const INPUT_CLASS =
  'w-full rounded border border-input-border bg-input-bg px-3 py-2.5 font-mono text-base text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring';

export default function App(): React.ReactElement {
  usePocketTheme();
  const client = useMemo(
    () =>
      new PocketClient({
        wsBase: location.origin.replace(/^http/, 'ws'),
        fetch: window.fetch.bind(window),
        webauthn: browserWebAuthn,
        createWebSocket: (url) => new WebSocket(url) as unknown as PocketSocket,
        deviceKey: () => getOrCreateDeviceKey(),
      }),
    [],
  );

  const [phase, setPhase] = useState<Phase>('auth');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostView[]>([]);
  const [pairedIds, setPairedIds] = useState<Set<string>>(() => new Set());
  const [activeHost, setActiveHost] = useState<HostView | null>(null);
  const adapterRef = useRef<RemotePtyAdapter | null>(null);

  // The client nulls its socket on any close, so an action taken after a
  // server restart / network drop must reopen it rather than reuse a dead
  // socket (which would throw 'relay socket is not open'). Every user action
  // that sends a frame funnels through here so it self-heals.
  const ensureSocket = useCallback(async () => {
    if (!client.socketOpen) await client.openSocket();
  }, [client]);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const loadHosts = useCallback(async () => {
    await ensureSocket();
    const list = await client.listHosts();
    setHosts(list);
    setPairedIds(new Set(list.filter((h) => client.isPaired(h.hostId)).map((h) => h.hostId)));
    setPhase('hosts');
  }, [client, ensureSocket]);

  /** Tear down the live session and return to the hosts list. */
  const teardownAdapter = useCallback(() => {
    void adapterRef.current?.dispose();
    adapterRef.current = null;
    disposeAllSessions();
  }, []);

  // Socket drop / host-gone: dispose the adapter and fall back to Hosts.
  useEffect(() => {
    client.setOnHostGone(() => {
      teardownAdapter();
      setError('The host disconnected.');
      setActiveHost(null);
      setPhase('hosts');
    });
    return () => client.setOnHostGone(null);
  }, [client, teardownAdapter]);

  const onConnect = (host: HostView) =>
    run('connect', async () => {
      await ensureSocket();
      const decision: ConnectDecision = await client.connect(host.hostId);
      if (!decision.allowed) {
        if (decision.pairingStale) {
          setPairedIds((prev) => {
            if (!prev.has(host.hostId)) return prev;
            const next = new Set(prev);
            next.delete(host.hostId);
            return next;
          });
        }
        throw new Error(`Connection denied${decision.failures ? `: ${decision.failures.join(', ')}` : ''}`);
      }
      await client.hello();

      // Stand up the remote adapter as the platform, prep a clean registry,
      // then start watching the directory before the wall renders.
      const adapter = new RemotePtyAdapter(client);
      adapterRef.current = adapter;
      setPlatform(adapter);
      disposeAllSessions();
      initAlertStateReceiver();
      await adapter.init();

      setActiveHost(host);
      setPhase('wall');
    });

  const onPair = (host: HostView) =>
    run('pair', async () => {
      await ensureSocket();
      const result = await client.pair(host.hostId, DEVICE_LABEL);
      if (!result.approved) throw new Error(result.error ?? 'Pairing was denied.');
      setPairedIds((prev) => new Set(prev).add(host.hostId));
    });

  const leaveWall = () => {
    teardownAdapter();
    client.close();
    setActiveHost(null);
    setPhase('hosts');
  };

  // --- Views ---------------------------------------------------------------

  if (phase === 'auth') {
    return (
      <SetupOrSignin
        busy={busy}
        error={error}
        onSignin={() =>
          run('signin', async () => {
            await client.signin();
            await loadHosts();
          })}
        onSetup={(password, label) =>
          run('setup', async () => {
            await client.setup(password, label);
            await client.signin();
            await loadHosts();
          })}
      />
    );
  }

  if (phase === 'hosts') {
    return (
      <HostsView
        hosts={hosts}
        busy={busy}
        error={error}
        isPaired={(id) => pairedIds.has(id)}
        onRefresh={() => run('refresh', loadHosts)}
        onPair={onPair}
        onConnect={onConnect}
      />
    );
  }

  if (phase === 'wall' && activeHost && adapterRef.current) {
    return (
      <div className={APP_SHELL_CLASS}>
        <header className={HEADER_CLASS}>
          <button type="button" className={HEADER_BUTTON_CLASS} onClick={leaveWall}>
            ‹ Hosts
          </button>
          <h1 className={HEADER_TITLE_CLASS}>{activeHost.label || activeHost.hostId}</h1>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <PocketWall adapter={adapterRef.current} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-app-bg font-mono text-sm text-muted">…</div>
  );
}

// --- SetupOrSignin ---------------------------------------------------------

export function SetupOrSignin({
  busy,
  error,
  onSignin,
  onSetup,
}: {
  busy: string | null;
  error: string | null;
  onSignin: () => void;
  onSetup: (password: string, label: string) => void;
}): React.ReactElement {
  const [showSetup, setShowSetup] = useState(false);
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('My Phone');

  return (
    <div className={APP_SHELL_CLASS}>
      <header className={HEADER_CLASS}>
        <h1 className={HEADER_TITLE_CLASS}>Dormouse Pocket</h1>
      </header>
      <div className={`${BODY_CLASS} justify-center`}>
        <div>
          <p className="mb-1 text-base font-bold text-foreground">Welcome back</p>
          <p className="text-sm leading-relaxed text-muted">
            Sign in with your passkey to reach your enrolled hosts and pick up a terminal session.
          </p>
        </div>
        {error ? <p className="text-sm text-error">{error}</p> : null}
        <button
          type="button"
          className={PRIMARY_BLOCK_BUTTON_CLASS}
          disabled={busy !== null}
          onClick={onSignin}
        >
          {busy === 'signin' ? 'Signing in…' : 'Sign in with passkey'}
        </button>

        <button
          type="button"
          className="self-start rounded px-1 py-2 text-sm text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
          onClick={() => setShowSetup((v) => !v)}
        >
          {showSetup ? '− First-time setup' : '+ First-time setup'}
        </button>

        {showSetup ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted">
              Create the account and register this device's passkey. Requires the server's setup
              password.
            </p>
            <div className={FIELD_CLASS}>
              <label htmlFor="pocket-setup-password" className="text-sm text-muted">Setup password</label>
              <input
                id="pocket-setup-password"
                className={INPUT_CLASS}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className={FIELD_CLASS}>
              <label htmlFor="pocket-passkey-label" className="text-sm text-muted">Passkey label</label>
              <input
                id="pocket-passkey-label"
                className={INPUT_CLASS}
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={PRIMARY_BLOCK_BUTTON_CLASS}
              disabled={busy !== null || password.length === 0}
              onClick={() => onSetup(password, label)}
            >
              {busy === 'setup' ? 'Creating…' : 'Create passkey & sign in'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- HostsView -------------------------------------------------------------

export function HostsView({
  hosts,
  busy,
  error,
  isPaired,
  onRefresh,
  onPair,
  onConnect,
}: {
  hosts: HostView[];
  busy: string | null;
  error: string | null;
  isPaired: (hostId: string) => boolean;
  onRefresh: () => void;
  onPair: (host: HostView) => void;
  onConnect: (host: HostView) => void;
}): React.ReactElement {
  return (
    <div className={APP_SHELL_CLASS}>
      <header className={HEADER_CLASS}>
        <h1 className={HEADER_TITLE_CLASS}>Hosts</h1>
        <button type="button" className={HEADER_BUTTON_CLASS} disabled={busy !== null} onClick={onRefresh}>
          {busy === 'refresh' ? '…' : 'Refresh'}
        </button>
      </header>
      <div className={BODY_CLASS}>
        {error ? <p className="text-sm text-error">{error}</p> : null}
        {hosts.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted">
            No hosts enrolled yet. Enroll one from your laptop.
          </div>
        ) : (
          hosts.map((host) => {
            const paired = isPaired(host.hostId);
            return (
              <div
                className="flex min-h-12 items-center gap-2 rounded bg-surface-raised px-3 py-2 text-left"
                key={host.hostId}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {host.label || host.hostId}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {paired ? 'Paired' : 'Not paired'}
                  </div>
                </div>
                <span
                  className={`shrink-0 text-xs font-semibold ${TODO_PILL_TRACKING_CLASS} ${host.online ? 'text-success' : 'text-muted'}`}
                >
                  {host.online ? 'online' : 'offline'}
                </span>
                <div className="flex shrink-0 gap-2">
                  {!paired ? (
                    <button
                      type="button"
                      className="flex min-h-9 items-center justify-center rounded border border-border px-3 text-sm text-muted transition-colors hover:bg-header-inactive-bg hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={busy !== null || !host.online}
                      onClick={() => onPair(host)}
                    >
                      {busy === 'pair' ? '…' : 'Pair'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex min-h-9 items-center justify-center rounded bg-header-active-bg px-3 text-sm text-header-active-fg transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={busy !== null || !host.online}
                    onClick={() => onConnect(host)}
                  >
                    {busy === 'connect' ? '…' : 'Connect'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
