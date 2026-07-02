/**
 * Dormouse Pocket — the phone-side app (docs/specs/server.md "Pocket side").
 *
 * A tiny four-view flow over {@link PocketClient}: sign in (or first-time
 * passkey setup) → pick a host (pair once, then connect) → pick a pane from the
 * live directory → drive it in the terminal view. All protocol work lives in
 * the client; this file is just state + buttons.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryEntry } from 'server-lib-common';
import {
  PocketClient,
  type ConnectDecision,
  type PocketSocket,
} from '../remote/client/pocket-client';
import { browserWebAuthn } from '../remote/client/webauthn';
import { getOrCreateDeviceKey } from '../remote/client/device-key';
import { PocketTerminal } from './PocketTerminal';
import './pocket.css';

type Phase = 'auth' | 'hosts' | 'picker' | 'terminal';

interface HostView {
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
  const [activeHost, setActiveHost] = useState<HostView | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [surface, setSurface] = useState<{ surfaceId: string; title: string } | null>(null);
  const socketOpened = useRef(false);

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
    if (!socketOpened.current) {
      await client.openSocket();
      socketOpened.current = true;
    }
    setHosts(await client.listHosts());
    setPhase('hosts');
  }, [client]);

  useEffect(() => {
    client.setOnHostGone(() => {
      setError('The host disconnected.');
      setSurface(null);
      setEntries([]);
      setPhase('hosts');
    });
    return () => client.setOnHostGone(null);
  }, [client]);

  const onConnect = (host: HostView) =>
    run('connect', async () => {
      const decision: ConnectDecision = await client.connect(host.hostId);
      if (!decision.allowed) {
        throw new Error(`Connection denied${decision.failures ? `: ${decision.failures.join(', ')}` : ''}`);
      }
      await client.hello();
      await client.watchDirectory(setEntries);
      setActiveHost(host);
      setPhase('picker');
    });

  const onPair = (host: HostView) =>
    run('pair', async () => {
      const result = await client.pair(host.hostId, DEVICE_LABEL);
      if (!result.approved) throw new Error(result.error ?? 'Pairing was denied.');
      setHosts((prev) => [...prev]); // reflect the new paired state
    });

  // --- Views ---------------------------------------------------------------

  if (phase === 'auth') {
    return (
      <SetupOrSignin
        busy={busy}
        error={error}
        onSignin={() => run('signin', async () => {
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
        isPaired={(id) => client.isPaired(id)}
        onRefresh={() => run('refresh', loadHosts)}
        onPair={onPair}
        onConnect={onConnect}
      />
    );
  }

  if (phase === 'picker' && activeHost) {
    return (
      <PickerView
        host={activeHost}
        entries={entries}
        error={error}
        onBack={() => {
          setEntries([]);
          setActiveHost(null);
          setPhase('hosts');
        }}
        onPick={(entry) => {
          setSurface({ surfaceId: entry.surfaceId, title: entry.title });
          setPhase('terminal');
        }}
      />
    );
  }

  if (phase === 'terminal' && surface) {
    return (
      <div className="pk-app">
        <header className="pk-header">
          <button
            type="button"
            className="pk-btn ghost small"
            onClick={() => {
              setSurface(null);
              setPhase('picker');
            }}
          >
            ‹ Panes
          </button>
          <h1>{surface.title || 'Terminal'}</h1>
        </header>
        <PocketTerminal
          client={client}
          surfaceId={surface.surfaceId}
          onBack={() => {
            setSurface(null);
            setPhase('picker');
          }}
        />
      </div>
    );
  }

  return <div className="pk-body pk-center">…</div>;
}

// --- SetupOrSignin ---------------------------------------------------------

function SetupOrSignin({
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

function HostsView({
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

// --- PickerView ------------------------------------------------------------

function PickerView({
  host,
  entries,
  error,
  onBack,
  onPick,
}: {
  host: HostView;
  entries: DirectoryEntry[];
  error: string | null;
  onBack: () => void;
  onPick: (entry: DirectoryEntry) => void;
}): React.ReactElement {
  return (
    <div className="pk-app">
      <header className="pk-header">
        <button type="button" className="pk-btn ghost small" onClick={onBack}>
          ‹ Hosts
        </button>
        <h1>
          {host.label || host.hostId} <span className="pk-sub">panes</span>
        </h1>
      </header>
      <div className="pk-body">
        {error ? <div className="pk-error">{error}</div> : null}
        {entries.length === 0 ? (
          <div className="pk-empty">Waiting for panes…</div>
        ) : (
          entries.map((entry) => (
            <button
              type="button"
              className="pk-row"
              key={entry.surfaceId}
              onClick={() => onPick(entry)}
            >
              <div className="pk-row-main">
                <div className="pk-row-title">{entry.title || 'Terminal'}</div>
                {entry.cwd ? <div className="pk-row-secondary">{entry.cwd}</div> : null}
              </div>
              {entry.activity ? (
                <span className="pk-badge activity">{entry.activity}</span>
              ) : null}
              {entry.hasTODO ? <span className="pk-badge todo">TODO</span> : null}
              {entry.ringing ? <span className="pk-badge ringing">●</span> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
