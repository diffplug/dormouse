/**
 * Dormouse Pocket — the phone-side app (docs/specs/pocket-app.md).
 *
 * Auth screens over {@link PocketClient} — sign in (or first-time passkey setup)
 * → pick a host (pair once, then connect) — then, on a successful connect, the
 * real mobile experience: a {@link RemotePtyAdapter} over the session drives
 * `MobileTerminalUi`/`MobileWall` (the same composition the website playground
 * proves out with `FakePtyAdapter`). No bespoke terminal UI.
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
import { PocketWall } from './PocketWall';
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
      <div className="pk-app">
        <header className="pk-header">
          <button type="button" className="pk-btn ghost small" onClick={leaveWall}>
            ‹ Hosts
          </button>
          <h1>{activeHost.label || activeHost.hostId}</h1>
        </header>
        <div className="pk-wall-host">
          <PocketWall adapter={adapterRef.current} />
        </div>
      </div>
    );
  }

  return <div className="pk-body pk-center">…</div>;
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
    <div className="pk-app">
      <header className="pk-header">
        <h1>Dormouse Pocket</h1>
      </header>
      <div className="pk-body pk-center">
        <div>
          <p className="pk-title">Welcome back</p>
          <p className="pk-lead">
            Sign in with your passkey to reach your enrolled hosts and pick up a terminal session.
          </p>
        </div>
        {error ? <div className="pk-error">{error}</div> : null}
        <button
          type="button"
          className="pk-btn primary block"
          disabled={busy !== null}
          onClick={onSignin}
        >
          {busy === 'signin' ? 'Signing in…' : 'Sign in with passkey'}
        </button>

        <button
          type="button"
          className="pk-disclosure"
          onClick={() => setShowSetup((v) => !v)}
        >
          {showSetup ? '− First-time setup' : '+ First-time setup'}
        </button>

        {showSetup ? (
          <div className="pk-card">
            <p className="pk-lead" style={{ marginBottom: 12 }}>
              Create the account and register this device's passkey. Requires the server's setup
              password.
            </p>
            <div className="pk-field">
              <label htmlFor="pk-pw">Setup password</label>
              <input
                id="pk-pw"
                className="pk-input"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="pk-field">
              <label htmlFor="pk-label">Passkey label</label>
              <input
                id="pk-label"
                className="pk-input"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="pk-btn primary block"
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
    <div className="pk-app">
      <header className="pk-header">
        <h1>Hosts</h1>
        <button type="button" className="pk-btn ghost small" disabled={busy !== null} onClick={onRefresh}>
          {busy === 'refresh' ? '…' : 'Refresh'}
        </button>
      </header>
      <div className="pk-body">
        {error ? <div className="pk-error">{error}</div> : null}
        {hosts.length === 0 ? (
          <div className="pk-empty">No hosts enrolled yet. Enroll one from your laptop.</div>
        ) : (
          hosts.map((host) => {
            const paired = isPaired(host.hostId);
            return (
              <div className="pk-row" key={host.hostId}>
                <div className="pk-row-main">
                  <div className="pk-row-title">{host.label || host.hostId}</div>
                  <div className="pk-row-secondary">{paired ? 'Paired' : 'Not paired'}</div>
                </div>
                <span className={`pk-badge ${host.online ? 'online' : 'offline'}`}>
                  {host.online ? 'online' : 'offline'}
                </span>
                <div className="pk-row-actions">
                  {!paired ? (
                    <button
                      type="button"
                      className="pk-btn small"
                      disabled={busy !== null || !host.online}
                      onClick={() => onPair(host)}
                    >
                      {busy === 'pair' ? '…' : 'Pair'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="pk-btn small primary"
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
