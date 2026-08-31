/**
 * Dormouse Pocket — the phone-side app (docs/specs/pocket-app.md).
 *
 * Auth screens over {@link PocketClient} — sign in (or first-time passkey setup)
 * → pick a host (pair once, which continues straight into connect) — then, on
 * a successful connect, the real mobile experience: a {@link RemotePtyAdapter}
 * over the session drives `MobileTerminalUi`/`MobileWall` (the same composition
 * the website playground proves out with `FakePtyAdapter`). No bespoke terminal
 * UI.
 *
 * The whole shell — auth screens included — renders on the shared `--vscode-*`
 * design tokens, restored to <body> before first paint by restorePocketTheme()
 * in main.tsx. Chrome draws only on the three list pairs — see the vocabulary
 * below and docs/specs/theme.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { tv } from 'tailwind-variants';
import {
  PocketClient,
  SessionExpiredError,
  type ConnectDecision,
  type PocketSocket,
} from '../client/pocket-client';
import { browserWebAuthn } from '../client/webauthn';
import { pairingFingerprint } from 'server-lib-common';
import { getOrCreateDeviceKey } from '../client/device-key';
import {
  getPushAvailability,
  hasCurrentPushSubscription,
  isInstalledWebApp,
  needsHomeScreenInstall,
  subscribeToPushInBrowser,
  type PushAvailability,
} from '../client/push-subscribe';
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

/**
 * What a Hosts row knows about this Client's standing with one Host.
 *
 * `stale` is `unpaired` the user has already been bitten by — a connect the
 * Host denied for an ACL miss — and differs only in saying "Pair again", so the
 * row explains itself instead of re-offering the tap that just failed.
 */
export type HostPairState = 'paired' | 'unpaired' | 'stale';

/**
 * One-way refinement: because `stale` refines `unpaired`, a sweep's plain
 * `unpaired` must not erase what a denial taught the row — only a pairing
 * clears it. Lives next to the state so no writer has to know the rule.
 */
export function refinePairState(
  prev: HostPairState | undefined,
  next: HostPairState,
): HostPairState {
  return next === 'unpaired' && prev === 'stale' ? 'stale' : next;
}

export type PushConfigStatus = 'loading' | 'ready' | 'disabled' | 'error';

type PushConfigState =
  | { status: 'loading' }
  | { status: 'ready'; key: string }
  | { status: 'disabled' }
  | { status: 'error' };

/**
 * The label this Client suggests at pairing.
 *
 * One phone can hold two Client identities — a Safari tab and a Home Screen
 * install have separate storage and therefore separate device keys — and they
 * are genuinely separate delivery targets that cannot be merged. Naming the
 * mode is what lets the person approving on the laptop, and the alarm dialog
 * afterwards, tell them apart.
 */
function deviceLabel(): string {
  return isInstalledWebApp() ? 'Dormouse Pocket (Home Screen)' : 'Dormouse Pocket (browser)';
}

// --- Pocket chrome vocabulary ------------------------------------------------
//
// Everything below is one of the three list pairs (app / header-active /
// header-inactive) plus alpha-on-fg for secondary text. See theme.md.

/**
 * Buttons.
 *  - primary  = the active header pair (caramel): the one strong action.
 *  - secondary = recessed to the page bg; reads as a button when it sits on an
 *    inactive-header row via the guaranteed app↔inactive delta.
 *  - outline = the subordinate action *on* the page, where secondary would be
 *    bg-on-bg: an alpha-on-fg hairline, because panel-border is transparent in
 *    many themes. Drawn as an inset shadow rather than a border (DESIGN.md,
 *    the Inset-Over-Border Rule), and at /25 rather than `PK.divided`'s /15 —
 *    a tappable affordance has to hold its edge, where a divider only has to
 *    separate.
 *  - ghost = transparent, inherits the surrounding band fg (header actions).
 */
const pkButton = tv({
  base: 'inline-flex items-center justify-center rounded-lg font-medium transition-colors active:brightness-110 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
  variants: {
    tone: {
      primary: 'bg-header-active-bg text-header-active-fg',
      secondary: 'bg-app-bg text-app-fg',
      outline: 'shadow-[inset_0_0_0_1px] shadow-app-fg/25 text-app-fg',
      ghost: 'text-inherit hover:bg-current/10',
    },
    size: {
      lg: 'min-h-[44px] px-4 text-[13px]',
      sm: 'min-h-9 px-3 text-[12px]',
    },
    block: { true: 'w-full', false: '' },
  },
  defaultVariants: { tone: 'primary', size: 'lg', block: false },
});

const PK = {
  app: 'flex h-full min-h-0 flex-col bg-app-bg text-app-fg',
  // Header band = the ACTIVE header pair (the "titlebar").
  header:
    'flex shrink-0 items-center gap-2 bg-header-active-bg px-4 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-header-active-fg',
  headerTitle: 'm-0 min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[0.01em]',
  body:
    'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
  // Safe centering: the first-run screen (install notice + setup + the sign-in
  // alternative) can outgrow a small phone, and plain `justify-center` in a
  // scroll container puts the overflow above the scrollable area, unreachable.
  // WebKit before Safari/iOS 17.6 does not parse the `safe` keyword and drops
  // the declaration, so those devices render top-aligned — usable and
  // scrollable, and accepted, because a plain `justify-center` fallback would
  // reintroduce the unreachable overflow on exactly the devices that lack it.
  bodyCenter: 'justify-center-safe',
  wallHost: 'flex min-h-0 flex-1 flex-col',
  // Host row = the INACTIVE header pair (a list item lifted off the page).
  row: 'flex w-full items-center gap-3 rounded-lg bg-header-inactive-bg px-3.5 py-3 text-left text-header-inactive-fg',
  rowOffline: 'opacity-55', // presence = intensity, no extra color
  rowMain: 'min-w-0 flex-1',
  rowTitle: 'truncate text-[13px] font-semibold',
  rowSecondary: 'mt-0.5 truncate text-[11px] text-header-inactive-fg/70',
  rowActions: 'flex shrink-0 items-center gap-2',
  // Push sits under its host row as secondary chrome: page bg, alpha-on-fg.
  pushRow: 'flex items-center gap-3 px-3.5 text-[11px] text-app-fg/70',
  // An actionable notice: the inactive-header pair, so it reads as a raised
  // block like a host row rather than as an error (which owns `text-error`).
  notice: 'flex flex-col gap-2 rounded-lg bg-header-inactive-bg px-3.5 py-3 text-header-inactive-fg',
  noticeTitle: 'text-[13px] font-semibold',
  noticeBody: 'm-0 text-[12px] leading-relaxed text-header-inactive-fg/70',
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
  deviceLine: 'px-4 pt-1 text-[11px] text-app-fg/60',
  disclosure:
    'w-fit cursor-pointer text-[12px] text-app-fg/70 underline underline-offset-2 transition-colors hover:text-app-fg',
  // A group of form controls; `divided` sets one off from the action above it.
  setup: 'flex flex-col gap-3',
  divided: 'border-t border-app-fg/15 pt-4',
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

  // This browser's own device-key fingerprint, shown on the Hosts screen so
  // the laptop's approval modal can actually be checked against something. The
  // pairing ceremony verifies no assertion — the human at the modal is the
  // control, and until both ends showed the same 8 characters that human was
  // being asked to approve a key they had no way to recognize.
  const [deviceFingerprint, setDeviceFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getOrCreateDeviceKey()
      .then(({ devicePublicKey }) => {
        if (!cancelled) setDeviceFingerprint(pairingFingerprint(devicePublicKey));
      })
      // A device key this browser cannot create is a failure the pair/connect
      // paths already report; this display is not the place to raise it again.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * iOS in a browser tab. Probed once at mount — installing means relaunching
   * from the Home Screen, which is a different app instance (and a different
   * storage partition) than the one asking, so the answer cannot change under
   * this run.
   */
  const [needsInstall] = useState(needsHomeScreenInstall);

  const [phase, setPhase] = useState<Phase>('auth');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostView[]>([]);
  const [pairStates, setPairStates] = useState<ReadonlyMap<string, HostPairState>>(
    () => new Map(),
  );
  const [activeHost, setActiveHost] = useState<HostView | null>(null);
  const [pushState, setPushState] = useState<PushAvailability | null>(null);
  const [pushSubscribedHostIds, setPushSubscribedHostIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pushSubscriptionCurrent, setPushSubscriptionCurrent] = useState(false);
  const [pushConfig, setPushConfig] = useState<PushConfigState>({ status: 'loading' });
  /**
   * Advances on every completed registration. Both the subscribe response and
   * the subscriptions read answer with this device's whole Host set, so the
   * only question between them is which is newer: a read that this counter
   * overtook is stale and gets dropped rather than merged.
   */
  const pushRegistrationVersionRef = useRef(0);
  const adapterRef = useRef<RemotePtyAdapter | null>(null);

  /**
   * Which auth screen leads. A browser with no stored passkey material has
   * never completed anything here, so "Welcome back" would be a lie and the
   * setup it needs would sit behind a disclosure.
   *
   * Derived, never latched, because both directions of staleness are bugs a
   * user hits: a setup that registers the passkey but then fails before
   * leaving `auth` (a cancelled second WebAuthn prompt, a socket error) must
   * flip the screen to "Welcome back", so the retry signs in rather than
   * minting a second server-side passkey; and a session expiry that drops back
   * to `auth` must paint the returning screen on the first commit, not one
   * effect tick later.
   */
  const firstRun = phase === 'auth' && !client.hasPriorUse();

  const setPairStateFor = useCallback((hostId: string, state: HostPairState) => {
    setPairStates((prev) => {
      const settled = refinePairState(prev.get(hostId), state);
      if (prev.get(hostId) === settled) return prev;
      const next = new Map(prev);
      next.set(hostId, settled);
      return next;
    });
  }, []);

  // Availability depends on browser state the app cannot change (permission,
  // whether it was launched from the Home Screen), so it is read once the hosts
  // list is on screen rather than tracked as a store. The VAPID key is fetched
  // here too, so the Enable tap has no network round trip in front of the
  // permission prompt — iOS drops transient activation across one.
  useEffect(() => {
    if (phase !== 'hosts') return;
    let live = true;
    setPushConfig({ status: 'loading' });
    setPushSubscriptionCurrent(false);
    void getPushAvailability().then((state) => {
      if (live) setPushState(state);
    });
    void client
      .getPushConfig()
      .then(async (key) => {
        const subscriptionCurrent =
          key !== null ? await hasCurrentPushSubscription(key, client.registeredPushEndpoint()).catch(() => false) : false;
        if (live) {
          setPushConfig(key === null ? { status: 'disabled' } : { status: 'ready', key });
          setPushSubscriptionCurrent(subscriptionCurrent);
        }
      })
      .catch(() => {
        if (live) setPushConfig({ status: 'error' });
      });
    // Which Hosts this device already registered with. Without it a reload
    // re-offers Enable alerts for every Host, including ones the Server already
    // holds a row for. Authoritative rather than merged, so a row pruned after
    // a 410 stops claiming alerts are on.
    setPushSubscribedHostIds(new Set());
    const registrationVersionAtStart = pushRegistrationVersionRef.current;
    void client
      .listPushSubscribedHosts()
      .then((hostIds) => {
        // A registration that landed while this was in flight already answered
        // the same question about the same device, and did so later. Nothing to
        // merge — the newer complete answer simply stands.
        if (!live || pushRegistrationVersionRef.current !== registrationVersionAtStart) return;
        setPushSubscribedHostIds(new Set(hostIds));
      })
      .catch(() => {
        // Best-effort: the previous snapshot was cleared before this request,
        // while any Enable that completed since then set its own. That re-offers
        // an idempotent action instead of preserving a stale claim.
      });
    return () => {
      live = false;
    };
  }, [phase, client]);

  // The client nulls its socket on any close, so an action taken after a
  // server restart / network drop must reopen it rather than reuse a dead
  // socket (which would throw 'relay socket is not open'). Every user action
  // that sends a frame funnels through here so it self-heals.
  const ensureSocket = useCallback(async () => {
    if (!client.socketOpen) await client.openSocket();
  }, [client]);

  /** Tear down the live session and return to the hosts list. */
  const teardownAdapter = useCallback(() => {
    void adapterRef.current?.dispose();
    adapterRef.current = null;
    disposeAllSessions();
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setError(null);
      setBusy(label);
      try {
        await fn();
      } catch (err) {
        // A dead session is not reportable, it is actionable: the token is
        // already discarded, so every view above sign-in would fail the same
        // way, and an installed Pocket has no reload affordance to escape with.
        // Drop to sign-in, where one passkey prompt restores everything —
        // pairing and push registration both outlive the session.
        if (err instanceof SessionExpiredError) {
          teardownAdapter();
          client.close();
          setActiveHost(null);
          setPhase('auth');
          setError(err.message);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [client, teardownAdapter],
  );

  const loadHosts = useCallback(async () => {
    await ensureSocket();
    const list = await client.listHosts();
    setHosts(list);
    // The cached marker, as the opening guess only — the effect below replaces
    // it with what each online Host says about its own ACL. Reseeded through
    // the refinement so a Refresh cannot decay "Pair again" either.
    setPairStates(
      (prev) =>
        new Map(
          list.map((h) => {
            const guess: HostPairState = client.isPaired(h.hostId) ? 'paired' : 'unpaired';
            return [h.hostId, refinePairState(prev.get(h.hostId), guess)];
          }),
        ),
    );
    setPhase('hosts');
  }, [client, ensureSocket]);

  // Ask each online Host whether it holds an ACL record for this Client, so a
  // row offers Pair or Connect but never a Connect that can only fail. The
  // marker is a local guess that a Host ACL reset, a hand-edited record, or a
  // pairing done from another browser profile all falsify; the Host is the
  // party that knows. Offline and unanswered rows keep the marker — it is the
  // only thing there is.
  //
  // Serially, because the relay answers a frame naming a Host that went offline
  // with an `error` that fails every waiter in flight: one at a time, that costs
  // the row that asked rather than every row. The same fail-all blast radius is
  // why the sweep yields to user actions — `busy` in the deps stops new asks
  // the moment a pair/connect ceremony starts (one already in flight is the
  // residual risk until error frames carry correlation) and restarts the sweep
  // when the action ends.
  useEffect(() => {
    if (phase !== 'hosts' || busy !== null) return;
    let live = true;
    void (async () => {
      try {
        // Reopen after leaveWall's close — otherwise every ask on this pass
        // throws into the catch below and the sweep silently learns nothing.
        await ensureSocket();
      } catch {
        return; // No socket, no truth; the cached markers stand.
      }
      for (const host of hosts) {
        if (!live) return;
        if (!host.online) continue;
        try {
          const paired = await client.queryPaired(host.hostId);
          if (live) setPairStateFor(host.hostId, paired ? 'paired' : 'unpaired');
        } catch {
          // Display truth is best-effort: a Host that cannot be asked keeps the
          // cached marker, and pair/connect still report the real failure.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [phase, busy, hosts, client, ensureSocket, setPairStateFor]);

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

  /** The connect half, shared so a fresh pairing can continue straight into it. */
  const connectTo = useCallback(
    async (host: HostView) => {
      await ensureSocket();
      const decision: ConnectDecision = await client.connect(host.hostId);
      if (!decision.allowed) {
        // The Host does not recognize this credential/device pair, whatever the
        // marker claimed. The client has already dropped the marker; the row
        // says Pair again rather than re-offering the tap that just failed.
        if (decision.pairingStale) setPairStateFor(host.hostId, 'stale');
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
    },
    [client, ensureSocket, setPairStateFor],
  );

  const onConnect = (host: HostView) => run('connect', () => connectTo(host));

  const onPair = (host: HostView) =>
    run('pair', async () => {
      await ensureSocket();
      const result = await client.pair(host.hostId, deviceLabel());
      if (!result.approved) throw new Error(result.error ?? 'Pairing was denied.');
      // Recorded before connecting, so a connect that then fails leaves a row
      // offering Connect rather than one asking to pair all over again.
      setPairStateFor(host.hostId, 'paired');
      // Approving on the laptop should land the phone in a terminal, not back
      // on this list. Re-labelling busy is what keeps the row it swapped to
      // showing progress instead of an idle-looking disabled Connect.
      setBusy('connect');
      await connectTo(host);
    });

  // Must stay free of network round trips before the permission prompt — see
  // the prefetch effect above.
  const onEnablePush = (host: HostView) =>
    run('push', async () => {
      if (pushConfig.status !== 'ready') {
        throw new Error('Check the server configuration before enabling alerts.');
      }
      const subscription = await subscribeToPushInBrowser(pushConfig.key, () => {
        // The scope no longer holds an address the Server can reach, so no Host
        // may keep claiming alerts through it. Stated the moment it becomes
        // true, which is what re-offers Enable if minting the replacement then
        // throws and there is no response to correct the UI with.
        setPushSubscriptionCurrent(false);
      });
      const { hostIds } = await client.subscribeToPush(host.hostId, subscription);
      pushRegistrationVersionRef.current += 1;
      setPushSubscriptionCurrent(true);
      // Authoritative and complete for this device — including after a retry
      // whose first attempt committed but lost its response — so it replaces
      // the set rather than adding to it.
      setPushSubscribedHostIds(new Set(hostIds));
    });

  // A config retry deliberately stops after caching the key. The next tap on
  // Enable alerts is the fresh user gesture the iOS permission prompt requires.
  const onRetryPushConfig = () =>
    run('push-config', async () => {
      setPushConfig({ status: 'loading' });
      try {
        const key = await client.getPushConfig();
        const subscriptionCurrent =
          key !== null ? await hasCurrentPushSubscription(key, client.registeredPushEndpoint()).catch(() => false) : false;
        setPushConfig(key === null ? { status: 'disabled' } : { status: 'ready', key });
        setPushSubscriptionCurrent(subscriptionCurrent);
      } catch (err) {
        setPushConfig({ status: 'error' });
        throw err;
      }
    });

  const onSetup = useCallback(
    (password: string, label: string) =>
      run('setup', async () => {
        await client.setup(password, label);
        await client.signin();
        await loadHosts();
      }),
    [client, loadHosts, run],
  );

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
        firstRun={firstRun}
        needsInstall={needsInstall}
        onSignin={() =>
          run('signin', async () => {
            await client.signin();
            await loadHosts();
          })}
        onSetup={onSetup}
      />
    );
  }

  if (phase === 'hosts') {
    return (
      <HostsView
        hosts={hosts}
        busy={busy}
        error={error}
        pairState={(id) => pairStates.get(id) ?? 'unpaired'}
        isPushSubscribed={(id) => pushSubscriptionCurrent && pushSubscribedHostIds.has(id)}
        pushState={pushState}
        pushConfigStatus={pushConfig.status}
        onRefresh={() => run('refresh', loadHosts)}
        deviceFingerprint={deviceFingerprint}
        onPair={onPair}
        onConnect={onConnect}
        onEnablePush={onEnablePush}
        onRetryPushConfig={onRetryPushConfig}
      />
    );
  }

  if (phase === 'wall' && activeHost && adapterRef.current) {
    return (
      <ConnectedView host={activeHost} adapter={adapterRef.current} onLeave={leaveWall} />
    );
  }

  return (
    <div className={PK.app}>
      <div className={clsx(PK.body, PK.bodyCenter)}>…</div>
    </div>
  );
}

// --- ConnectedView ---------------------------------------------------------

/** The connected Pocket shell: host navigation chrome over the remote wall. */
export function ConnectedView({
  host,
  adapter,
  onLeave,
}: {
  host: HostView;
  adapter: RemotePtyAdapter;
  onLeave: () => void;
}): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <button type="button" className={pkButton({ tone: 'ghost', size: 'sm' })} onClick={onLeave}>
          ‹ Hosts
        </button>
        <h1 className={PK.headerTitle}>{host.label || host.hostId}</h1>
      </header>
      <div className={PK.wallHost}>
        <PocketWall adapter={adapter} />
      </div>
    </div>
  );
}

// --- SetupOrSignin ---------------------------------------------------------

/**
 * The auth screen, in two layouts on one question: has this browser been used
 * here before?
 *
 * **First run** leads with setup — the only thing a browser holding nothing can
 * actually complete — with sign-in kept as a plain secondary action, since a
 * passkey syncs and a fresh browser may already have one. **Returning** keeps
 * sign-in primary and folds setup back behind the disclosure.
 *
 * The install guidance goes here rather than after sign-in because this is the
 * screen that mints the partition-bound *passkey* it warns about — the last
 * point at which the advice is still free to take. Not the device key: `App`'s
 * fingerprint effect already minted that at boot, a gap staged in
 * `docs/specs/remote-security-model.md` -> Future.
 */
export function SetupOrSignin({
  busy,
  error,
  firstRun,
  needsInstall,
  onSignin,
  onSetup,
}: {
  busy: string | null;
  error: string | null;
  /** No stored passkey material — no evidence this browser was ever set up. */
  firstRun: boolean;
  /** iOS in a browser tab; see {@link InstallFirstNotice}. */
  needsInstall: boolean;
  onSignin: () => void;
  onSetup: (password: string, label: string) => void;
}): React.ReactElement {
  const [showSetup, setShowSetup] = useState(false);
  const signinLabel = busy === 'signin' ? 'Signing in…' : 'Sign in with passkey';
  const setupFields = (
    <PasskeySetupFields
      idPrefix="pocket-setup"
      busy={busy}
      submitLabel="Create passkey & sign in"
      onSubmit={onSetup}
    />
  );
  // Shared by both layouts; only its prominence differs.
  const signinButton = (tone: 'primary' | 'outline') => (
    <button
      type="button"
      className={pkButton({ tone, block: true })}
      disabled={busy !== null}
      onClick={onSignin}
    >
      {signinLabel}
    </button>
  );

  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>Dormouse Pocket</h1>
      </header>
      <div className={clsx(PK.body, PK.bodyCenter)}>
        <div>
          <p className={PK.title}>{firstRun ? 'Set up this phone' : 'Welcome back'}</p>
          <p className={clsx(PK.lead, 'mt-1')}>
            {firstRun
              ? "Register this browser's passkey with the server's setup password, then approve it from your laptop."
              : 'Sign in with your passkey to reach your enrolled hosts and pick up a terminal session.'}
          </p>
        </div>
        {/* Above the actions, never below: the passkey this screen mints
            belongs to whichever partition creates it, so guidance that arrives
            after setup arrives after the trap. The returning layout carries
            the same notice inside its disclosure instead — see below. */}
        {firstRun && needsInstall ? <InstallFirstNotice /> : null}
        {/* Announced, because a failed sign-in changes nothing else on screen. */}
        {error ? (
          <div className={PK.error} role="alert">
            {error}
          </div>
        ) : null}

        {firstRun ? (
          <>
            <div className={PK.setup}>{setupFields}</div>
            {/* Not a disclosure: a synced passkey makes sign-in a real path out
                of a browser that has never stored anything. */}
            <div className={clsx(PK.setup, PK.divided)}>
              <p className={PK.lead}>Already made a passkey? It syncs — sign in with it instead.</p>
              {signinButton('outline')}
            </div>
          </>
        ) : (
          <>
            {signinButton('primary')}

            <button
              type="button"
              className={PK.disclosure}
              onClick={() => setShowSetup((v) => !v)}
            >
              {showSetup ? '− First-time setup' : '+ First-time setup'}
            </button>

            {showSetup ? (
              <div className={clsx(PK.setup, PK.divided)}>
                <p className={PK.lead}>
                  Create the account and register this device's passkey. Requires the server's setup
                  password.
                </p>
                {/* The notice is written for someone about to make a passkey,
                    so under "Welcome back" it rides with the fields rather
                    than the screen — this is the other place setup can happen
                    before an install. */}
                {needsInstall ? <InstallFirstNotice /> : null}
                {setupFields}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The one iOS install gesture, written once so the two notices cannot drift on
 * it — everything else in them differs on purpose (identity vs alerts framing).
 */
const INSTALL_RITUAL = (
  <>
    Tap Share, then <strong>Add to Home Screen</strong>
  </>
);

/**
 * iOS, in a browser tab, on the screen about to mint this Client's identity.
 * The installed app is a separate storage partition, so a passkey and device
 * key created in the tab are not the ones it will hold — setting up here means
 * doing all of it, the laptop's pairing approval included, a second time.
 *
 * Guidance, not a gate: iOS offers no install prompt to fire, and someone who
 * does not want alerts and never installs is still entitled to a terminal.
 *
 * The second line is not optional. A tab cannot see whether the app is *also*
 * installed (separate storage, no shared signal), so this shows to someone who
 * installed it already and simply opened the wrong window.
 *
 * Alerts are deliberately not mentioned: whether they work at all depends on
 * the Server's push config, which {@link InstallNotice} and the Hosts view's
 * push rows gate on. Identity is true regardless, and carries the notice.
 */
function InstallFirstNotice(): React.ReactElement {
  return (
    <div className={PK.notice}>
      <div className={PK.noticeTitle}>Add Dormouse to your Home Screen first</div>
      <p className={PK.noticeBody}>
        {INSTALL_RITUAL}, and set up from there. iOS keeps the
        installed app&rsquo;s data separate from this tab, so a passkey made here has to be made and
        approved all over again.
      </p>
      <p className={PK.noticeBody}>
        Already added it? Set up from the Home Screen app rather than this tab.
      </p>
    </div>
  );
}

// --- HostsView -------------------------------------------------------------

/**
 * The same advice on the surface that offers alerts, for a tab that set up
 * anyway ({@link InstallFirstNotice} is where it is first given, before there
 * is anything to regret). Web Push is granted only to a Home Screen web app,
 * and there is no API to prompt for that install — it can only be described,
 * which is why the push rows below point up here.
 *
 * The second line matters: a tab cannot see whether the app is *also* installed
 * (separate storage, no shared signal), so this notice shows even to someone
 * who already installed it and simply opened the wrong window.
 */
function InstallNotice(): React.ReactElement {
  return (
    <div className={PK.notice}>
      <div className={PK.noticeTitle}>Add Dormouse to your Home Screen</div>
      <p className={PK.noticeBody}>
        Alerts only reach you from the installed app — iOS does not deliver them to a Safari
        tab. {INSTALL_RITUAL}, and open Dormouse from there.
      </p>
      <p className={PK.noticeBody}>Already added it? Open it from your Home Screen instead of this tab.</p>
    </div>
  );
}

/**
 * The setup-password + label pair and its submit button. Kept separate from its
 * caller so the credential form's ids, autocomplete rules, and disabled logic
 * have one definition; `idPrefix` keeps those ids unique if it is ever rendered
 * more than once on a screen.
 *
 * A real `<form>`, so the phone keyboard's Go key submits — on the first-run
 * screen these fields are the primary path, and a Go that does nothing reads as
 * a broken app. `display: contents` keeps the caller's flex column owning the
 * layout, and one `blocked` condition drives both the button's disabled state
 * (which is what the HTML spec makes suppress implicit submission) and the
 * handler, so no submit path can outrun a busy ceremony or an empty password.
 */
function PasskeySetupFields({
  idPrefix,
  busy,
  submitLabel,
  onSubmit,
}: {
  idPrefix: string;
  busy: string | null;
  submitLabel: string;
  onSubmit: (password: string, label: string) => void;
}): React.ReactElement {
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('My Phone');
  const blocked = busy !== null || password.length === 0;

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        onSubmit(password, label);
      }}
    >
      <div className={PK.field}>
        <label className={PK.fieldLabel} htmlFor={`${idPrefix}-password`}>Setup password</label>
        <input
          id={`${idPrefix}-password`}
          className={PK.input}
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className={PK.field}>
        <label className={PK.fieldLabel} htmlFor={`${idPrefix}-label`}>Passkey label</label>
        <input
          id={`${idPrefix}-label`}
          className={PK.input}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <button
        type="submit"
        className={pkButton({ tone: 'primary', block: true })}
        disabled={blocked}
      >
        {busy === 'setup' ? 'Creating…' : submitLabel}
      </button>
    </form>
  );
}

/**
 * The push row's copy. Only `ready` is actionable; the rest explain why not, so
 * "my phone never buzzes" always has a visible cause. `needs-install` is the
 * iOS rule — Web Push is granted only to a Home Screen web app — and is the one
 * state the user resolves outside the app entirely.
 */
type HostPushState = PushAvailability | 'subscribed';

const PUSH_COPY: Record<HostPushState, string> = {
  ready: 'Get an alert when a terminal needs attention.',
  subscribed: 'Alerts on.',
  denied: 'Notifications are blocked for this site in your browser settings.',
  unsupported: 'This browser cannot receive push notifications.',
  'no-worker': 'Background worker unavailable — the server must be served over https.',
  'needs-install': 'Alerts need the installed app — see above.',
};

export function HostsView({
  hosts,
  busy,
  error,
  pairState,
  isPushSubscribed,
  pushState,
  pushConfigStatus = 'ready',
  deviceFingerprint,
  onRefresh,
  onPair,
  onConnect,
  onEnablePush,
  onRetryPushConfig,
}: {
  hosts: HostView[];
  busy: string | null;
  error: string | null;
  /** The Host's own answer where it could be asked; the cached marker otherwise. */
  pairState: (hostId: string) => HostPairState;
  /** True only after this Host's server registration succeeds in this session. */
  isPushSubscribed: (hostId: string) => boolean;
  /** Null until the browser has been asked; see the effect in `App`. */
  pushState: PushAvailability | null;
  /** Whether the Server's VAPID public key is already cached for a permission tap. */
  pushConfigStatus?: PushConfigStatus;
  /** This browser's device-key fingerprint; null until the key is loaded. */
  deviceFingerprint: string | null;
  onRefresh: () => void;
  onPair: (host: HostView) => void;
  onConnect: (host: HostView) => void;
  onEnablePush: (host: HostView) => void;
  onRetryPushConfig: () => void;
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
        {deviceFingerprint ? (
          // Compare this against the Key line in the approval dialog on the
          // laptop before approving. Rendered even when nothing is pairable,
          // so it reads as a property of this browser rather than a step in a
          // flow.
          <div className={PK.deviceLine}>
            This device&rsquo;s key: <span className="font-mono">{deviceFingerprint}…</span>
          </div>
        ) : null}
        {error ? <div className={PK.error}>{error}</div> : null}
        {/* Install advice is moot when the server cannot push at all — the
            rows below already say push is disabled, and the ritual the notice
            describes would end at that same message. */}
        {pushConfigStatus !== 'disabled' && pushState === 'needs-install' ? (
          <InstallNotice />
        ) : null}
        {hosts.length === 0 ? (
          <div className={PK.empty}>No hosts enrolled yet. Enroll one from your laptop.</div>
        ) : (
          hosts.map((host) => {
            const pairing = pairState(host.hostId);
            const paired = pairing === 'paired';
            const hostPushState: HostPushState = isPushSubscribed(host.hostId)
              ? 'subscribed'
              : pushState ?? 'ready';
            const pushCopy =
              pushConfigStatus === 'disabled'
                ? 'This server has push notifications disabled.'
                : hostPushState !== 'ready'
                  ? PUSH_COPY[hostPushState]
                  : pushConfigStatus === 'loading'
                    ? 'Checking whether this server can send alerts…'
                    : pushConfigStatus === 'error'
                      ? 'Could not check whether this server can send alerts.'
                      : PUSH_COPY.ready;
            const status = !host.online ? 'Offline' : paired ? 'Paired' : 'Not paired';
            // The one-action invariant, stated once: which verb this row
            // offers and what its button says, on a single paired split.
            const action = paired
              ? { label: busy === 'connect' ? '…' : 'Connect', run: onConnect }
              : {
                  label: busy === 'pair' ? '…' : pairing === 'stale' ? 'Pair again' : 'Pair',
                  run: onPair,
                };
            return (
              <div key={host.hostId} className="flex flex-col gap-1.5">
                <div className={clsx(PK.row, !host.online && PK.rowOffline)}>
                  <div className={PK.rowMain}>
                    <div className={PK.rowTitle}>{host.label || host.hostId}</div>
                    <div className={PK.rowSecondary}>{status}</div>
                  </div>
                  {/* One action, never both. The Host's ACL is what picks it,
                      so Connect is offered only where it can succeed and Pair
                      only where it is the actual next step. */}
                  <div className={PK.rowActions}>
                    <button
                      type="button"
                      className={pkButton({ tone: 'primary', size: 'sm' })}
                      disabled={busy !== null || !host.online}
                      onClick={() => action.run(host)}
                    >
                      {action.label}
                    </button>
                  </div>
                </div>
                {/* Push is per (host, device), so it belongs to the host row —
                    and only once paired, since an unpaired Host would have no
                    reason to address this device. */}
                {paired && pushState ? (
                  <div className={PK.pushRow}>
                    <span className="min-w-0 flex-1">
                      {pushCopy}
                    </span>
                    {hostPushState === 'ready' && pushConfigStatus === 'ready' ? (
                      <button
                        type="button"
                        className={pkButton({ tone: 'secondary', size: 'sm' })}
                        disabled={busy !== null}
                        onClick={() => onEnablePush(host)}
                      >
                        {busy === 'push' ? '…' : 'Enable alerts'}
                      </button>
                    ) : hostPushState === 'ready' && pushConfigStatus === 'error' ? (
                      <button
                        type="button"
                        className={pkButton({ tone: 'secondary', size: 'sm' })}
                        disabled={busy !== null}
                        onClick={onRetryPushConfig}
                      >
                        {busy === 'push-config' ? '…' : 'Retry'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
