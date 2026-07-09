/**
 * Dormouse Pocket — the phone-side app (docs/specs/pocket-app.md).
 *
 * Auth screens over {@link PocketClient} — sign in (or first-time passkey setup)
 * → pick a host (pair once, then connect) — then, on a successful connect, the
 * real mobile experience: a {@link RemotePtyAdapter} over the session drives
 * `MobileTerminalUi`/`MobileWall` (the same composition the website playground
 * proves out with `FakePtyAdapter`). No bespoke terminal UI.
 *
 * Chrome is built from the same three VSCode list pairs as the rest of the app
 * (docs/specs/theme.md): the page is `app-bg/fg`, the header band is the
 * *active* pair `header-active-bg/fg`, and host rows are the *inactive* pair
 * `header-inactive-bg/fg`. Hierarchy is background swaps between those pairs —
 * never `surface-raised` or `panel-border`, which are near-black / transparent
 * in themes like Kimbie. Secondary emphasis is foreground *intensity* (alpha on
 * the pair's own fg), so no fourth color is introduced. The theme is applied to
 * <body> by `restorePocketTheme()` in `main.tsx` before first paint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { tv } from 'tailwind-variants';
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
import { PocketWall } from './PocketWall';
import '../../index.css';

type Phase = 'auth' | 'hosts' | 'wall';

export interface HostView {
  hostId: string;
  label: string;
  online: boolean;
}

/** A phone-friendly default pairing label. */
const DEVICE_LABEL = 'Dormouse Pocket';

// --- Pocket chrome vocabulary ------------------------------------------------
//
// Everything below is one of the three list pairs (app / header-active /
// header-inactive) plus alpha-on-fg for secondary text. See theme.md.

/**
 * Buttons.
 *  - primary  = the active header pair (caramel): the one strong action.
 *  - secondary = recessed to the page bg; reads as a button when it sits on an
 *    inactive-header row via the guaranteed app↔inactive delta.
 *  - ghost = transparent, inherits the surrounding band fg (header actions).
 */
const pkButton = tv({
  base: 'inline-flex items-center justify-center rounded-lg font-medium transition-colors active:brightness-110 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
  variants: {
    tone: {
      primary: 'bg-header-active-bg text-header-active-fg',
      secondary: 'bg-app-bg text-app-fg',
      ghost: 'text-inherit hover:bg-current/10',
    },
    size: {
      lg: 'min-h-[44px] px-4 text-[13px]',
      sm: 'min-h-9 px-3 text-[12px]',
    },
    block: { true: 'w-full' },
  },
  defaultVariants: { tone: 'primary', size: 'lg' },
});

const PK = {
  app: 'flex h-full min-h-0 flex-col bg-app-bg text-app-fg',
  // Header band = the ACTIVE header pair (the "titlebar").
  header:
    'flex shrink-0 items-center gap-2 bg-header-active-bg px-4 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-header-active-fg',
  headerTitle: 'm-0 min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[0.01em]',
  body:
    'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
  bodyCenter: 'justify-center',
  wallHost: 'flex min-h-0 flex-1 flex-col',
  // Host row = the INACTIVE header pair (a list item lifted off the page).
  row: 'flex w-full items-center gap-3 rounded-lg bg-header-inactive-bg px-3.5 py-3 text-left text-header-inactive-fg',
  rowOffline: 'opacity-55', // presence = intensity, no extra color
  rowMain: 'min-w-0 flex-1',
  rowTitle: 'truncate text-[13px] font-semibold',
  rowSecondary: 'mt-0.5 truncate text-[11px] text-header-inactive-fg/70',
  rowActions: 'flex shrink-0 items-center gap-2',
  field: 'flex flex-col gap-1.5',
  fieldLabel: 'text-[11px] text-app-fg/60',
  input:
    'w-full rounded-lg bg-input-bg px-3.5 py-3 text-[16px] text-app-fg outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-focus-ring',
  title: 'm-0 text-[20px] font-semibold',
  lead: 'm-0 text-[13px] leading-relaxed text-app-fg/70',
  // Error sits on the darker page bg (best red contrast) and is delineated by a
  // reliable red inset hairline — panel-border is transparent in many themes.
  error: 'rounded-lg px-3.5 py-2.5 text-[13px] text-error shadow-[inset_0_0_0_1px_var(--color-error)]',
  empty: 'px-4 py-10 text-center text-[13px] text-app-fg/70',
  disclosure:
    'w-fit cursor-pointer text-[12px] text-app-fg/70 underline underline-offset-2 transition-colors hover:text-app-fg',
  setup: 'flex flex-col gap-3 border-t border-app-fg/15 pt-4',
} as const;

export default function App(): React.ReactElement {
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
      <div className={PK.app}>
        <header className={PK.header}>
          <button type="button" className={pkButton({ tone: 'ghost', size: 'sm' })} onClick={leaveWall}>
            ‹ Hosts
          </button>
          <h1 className={PK.headerTitle}>{activeHost.label || activeHost.hostId}</h1>
        </header>
        <div className={PK.wallHost}>
          <PocketWall adapter={adapterRef.current} />
        </div>
      </div>
    );
  }

  return (
    <div className={PK.app}>
      <div className={clsx(PK.body, PK.bodyCenter)}>…</div>
    </div>
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
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>Dormouse Pocket</h1>
      </header>
      <div className={clsx(PK.body, PK.bodyCenter)}>
        <div>
          <p className={PK.title}>Welcome back</p>
          <p className={clsx(PK.lead, 'mt-1')}>
            Sign in with your passkey to reach your enrolled hosts and pick up a terminal session.
          </p>
        </div>
        {error ? <div className={PK.error}>{error}</div> : null}
        <button
          type="button"
          className={pkButton({ tone: 'primary', block: true })}
          disabled={busy !== null}
          onClick={onSignin}
        >
          {busy === 'signin' ? 'Signing in…' : 'Sign in with passkey'}
        </button>

        <button
          type="button"
          className={PK.disclosure}
          onClick={() => setShowSetup((v) => !v)}
        >
          {showSetup ? '− First-time setup' : '+ First-time setup'}
        </button>

        {showSetup ? (
          <div className={PK.setup}>
            <p className={PK.lead}>
              Create the account and register this device's passkey. Requires the server's setup
              password.
            </p>
            <div className={PK.field}>
              <label className={PK.fieldLabel} htmlFor="pk-pw">Setup password</label>
              <input
                id="pk-pw"
                className={PK.input}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className={PK.field}>
              <label className={PK.fieldLabel} htmlFor="pk-label">Passkey label</label>
              <input
                id="pk-label"
                className={PK.input}
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={pkButton({ tone: 'primary', block: true })}
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
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>Hosts</h1>
        <button
          type="button"
          className={pkButton({ tone: 'ghost', size: 'sm' })}
          disabled={busy !== null}
          onClick={onRefresh}
        >
          {busy === 'refresh' ? '…' : 'Refresh'}
        </button>
      </header>
      <div className={PK.body}>
        {error ? <div className={PK.error}>{error}</div> : null}
        {hosts.length === 0 ? (
          <div className={PK.empty}>No hosts enrolled yet. Enroll one from your laptop.</div>
        ) : (
          hosts.map((host) => {
            const paired = isPaired(host.hostId);
            const status = !host.online ? 'Offline' : paired ? 'Paired' : 'Not paired';
            return (
              <div className={clsx(PK.row, !host.online && PK.rowOffline)} key={host.hostId}>
                <div className={PK.rowMain}>
                  <div className={PK.rowTitle}>{host.label || host.hostId}</div>
                  <div className={PK.rowSecondary}>{status}</div>
                </div>
                <div className={PK.rowActions}>
                  {host.online && !paired ? (
                    <button
                      type="button"
                      className={pkButton({ tone: 'secondary', size: 'sm' })}
                      disabled={busy !== null}
                      onClick={() => onPair(host)}
                    >
                      {busy === 'pair' ? '…' : 'Pair'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={pkButton({ tone: 'primary', size: 'sm' })}
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
