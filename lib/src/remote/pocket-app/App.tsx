/**
 * Dormouse Pocket — the phone-side app (docs/specs/pocket-app.md).
 *
 * Auth screens over {@link PocketClient} — scan a computer's code (or sign in,
 * on a browser that has been here) → pick a paired computer → connect — then,
 * on a successful connect, the real mobile experience: a {@link RemotePtyAdapter}
 * over the session drives `MobileTerminalUi`/`MobileWall` (the same composition
 * the website playground proves out with `FakePtyAdapter`). No bespoke terminal
 * UI.
 *
 * The whole shell — auth screens included — renders on the shared `--vscode-*`
 * design tokens, restored to <body> before first paint by restorePocketTheme()
 * in main.tsx. Chrome draws only on the three list pairs — see
 * `pocket-chrome.tsx` and docs/specs/theme.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  PocketClient,
  ServerRefusalError,
  SessionExpiredError,
  type ConnectResult,
  type PocketSocket,
} from '../client/pocket-client';
import { PasskeyAlreadyRegisteredError, browserWebAuthn } from '../client/webauthn';
import { SCAN_LABEL } from '../setup-copy';
import { probeNoiseSupport, type PairingInvitation } from 'server-lib-common';
import {
  indexedDbKnownHostStore,
  indexedDbPendingDeletionStore,
  type KnownHostV1,
} from '../client/pocket-db';
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
import { ScanInvitation, type StartScan } from './ScanInvitation';
import { ErrorRow, PK, pkButton } from './pocket-chrome';

/**
 * Which screen is up, carrying whatever only that screen has. The two pieces
 * that used to sit beside it — the pairing digits and the connected Host — are
 * in here because they are meaningless anywhere else, and keeping them in
 * lockstep with a separate `phase` string was four places to get it wrong.
 */
type Phase =
  | { readonly at: 'auth' }
  | { readonly at: 'scan' }
  /** `code` is null for the moment between the handshake and the sampled code. */
  | { readonly at: 'pairing'; readonly code: string | null }
  | { readonly at: 'hosts' }
  | { readonly at: 'wall'; readonly host: HostView };

/** One row of the Hosts view: a pinned record, plus what the Server knows. */
export interface HostView {
  hostId: string;
  label: string;
  online: boolean;
  /**
   * The pinned record has lost its authorization — an authenticated
   * `pairing-required`, or a local removal that has not finished. The row
   * offers *Pair again* rather than a Connect that can only fail.
   */
  needsPairing: boolean;
}

type PushConfigState =
  | { status: 'loading' }
  | { status: 'ready'; key: string }
  | { status: 'disabled' }
  | { status: 'error' };

export type PushConfigStatus = PushConfigState['status'];

/**
 * The label this Client suggests at pairing.
 *
 * One phone can hold two Client identities — a Safari tab and a Home Screen
 * install have separate storage and therefore separate per-Host statics — and
 * they are genuinely separate delivery targets that cannot be merged. Naming
 * the mode is what lets the person approving on the laptop, and the alarm
 * dialog afterwards, tell them apart.
 */
function deviceLabel(): string {
  return isInstalledWebApp() ? 'Dormouse Pocket (Home Screen)' : 'Dormouse Pocket (browser)';
}

/** What a browser that cannot run the protocol is told, and the whole of it. */
export const UNSUPPORTED_BROWSER_TITLE = 'This browser cannot run Dormouse Pocket';
export const UNSUPPORTED_BROWSER_BODY =
  'Dormouse Pocket needs X25519 in the Web Crypto API, which this browser does not have. ' +
  'Update it, or open Dormouse Pocket in a newer browser.';

/** The copy a run that arrived from the phone's own camera leads with. */
export const CAMERA_BOOTSTRAP_MESSAGE = 'Scan again from inside Dormouse Pocket';

export default function App({
  arrivedByCamera = false,
  startScan,
}: {
  /** This run was opened from a `#pair?` link the native camera followed. */
  arrivedByCamera?: boolean;
  /** Test/story seam for the camera; see {@link ScanInvitation}. */
  startScan?: StartScan;
}): React.ReactElement {
  const client = useMemo(
    () =>
      new PocketClient({
        wsBase: location.origin.replace(/^http/, 'ws'),
        fetch: window.fetch.bind(window),
        webauthn: browserWebAuthn,
        createWebSocket: (url) => new WebSocket(url) as unknown as PocketSocket,
        knownHosts: indexedDbKnownHostStore(),
        pendingDeletions: indexedDbPendingDeletionStore(),
      }),
    [],
  );

  /**
   * Whether this runtime can run the protocol at all. **Null until the probe
   * settles, and no remote operation happens before it does**: a runtime
   * without X25519 is gated, never degraded
   * (`docs/specs/remote-security-model.md` → Runtime gating).
   */
  const [noiseSupported, setNoiseSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    // The probe never throws — every rejection, a missing WebCrypto included,
    // is `false`.
    void probeNoiseSupport().then((ok) => {
      if (live) setNoiseSupported(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * iOS in a browser tab. Probed once at mount — installing means relaunching
   * from the Home Screen, which is a different app instance (and a different
   * storage partition) than the one asking, so the answer cannot change under
   * this run.
   */
  const [needsInstall] = useState(needsHomeScreenInstall);

  /**
   * The authenticator refused to register because it already holds a passkey
   * the Server has. Not stored: we learn that one exists, never its id or its
   * key, and {@link PocketClient.hasPriorUse} answers from material this
   * browser can actually use. So it lives here, for this screen, until the
   * sign-in it steers to caches the real thing.
   */
  const [passkeyAlreadyRegistered, setPasskeyAlreadyRegistered] = useState(false);

  const [phase, setPhase] = useState<Phase>({ at: 'auth' });
  /**
   * The last failure. Unkeyed, because every screen that reports one owns its
   * whole viewport: whatever failed last is the only thing there is to say.
   */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostView[]>([]);
  /** Set by Cancel on the waiting screen, so the abort is not reported as a failure. */
  const cancelledPairingRef = useRef(false);
  const [pushState, setPushState] = useState<PushAvailability | null>(null);
  /** Null while the Server's answer is unknown — see the effect below. */
  const [pushSubscribedHostIds, setPushSubscribedHostIds] = useState<Set<string> | null>(null);
  const [pushSubscriptionCurrent, setPushSubscriptionCurrent] = useState(false);
  const [pushConfig, setPushConfig] = useState<PushConfigState>({ status: 'loading' });
  /**
   * A monotonic token: every push read commits only while it is still the
   * current one, so anything newer — a later load, or a completed registration
   * — supersedes a load whole rather than each continuation carrying a guard.
   * Cheaper than a cleanup, and it survives the hop onto the wall.
   */
  const pushLoadRunRef = useRef(0);
  const adapterRef = useRef<RemotePtyAdapter | null>(null);

  /**
   * The Server's VAPID key, and whether this browser's subscription still
   * matches it. One operation, two callers: the Hosts-entry load below (which
   * commits only while its run token is current) and the Retry action.
   */
  const loadPushConfig = useCallback(
    async (commit: () => boolean) => {
      setPushConfig({ status: 'loading' });
      try {
        const key = await client.getPushConfig();
        const subscriptionCurrent =
          key !== null &&
          (await hasCurrentPushSubscription(key, client.registeredPushEndpoint()).catch(
            () => false,
          ));
        if (!commit()) return;
        setPushConfig(key === null ? { status: 'disabled' } : { status: 'ready', key });
        setPushSubscriptionCurrent(subscriptionCurrent);
      } catch (err) {
        if (commit()) setPushConfig({ status: 'error' });
        throw err;
      }
    },
    [client],
  );

  // Availability depends on browser state the app cannot change (permission,
  // whether it was launched from the Home Screen), so it is read on entering the
  // Hosts list rather than tracked as a store — that per-visit probe is the
  // authoritative one.
  //
  // Keyed to the `hosts` phase alone, so the hop onto the wall neither refetches
  // it nor throws it away; the run token (above) is what supersedes an in-flight
  // read instead of a cleanup. (`App` never unmounts between phases, so there is
  // nothing to tear down on the way out.)
  //
  // The VAPID key is fetched here too, so the Enable tap has no network round
  // trip in front of the permission prompt — iOS drops transient activation
  // across one.
  const at = phase.at;
  useEffect(() => {
    if (at !== 'hosts') return;
    const run = ++pushLoadRunRef.current;
    const current = () => pushLoadRunRef.current === run;
    setPushSubscriptionCurrent(false);
    void getPushAvailability().then((state) => {
      if (current()) setPushState(state);
    });
    void loadPushConfig(current).catch(() => {
      // Reported by the card's Retry state; a failed prefetch is not an alert.
    });
    // Which Hosts this device already registered with, asked by presenting this
    // browser's own delivery ids. Without it a reload re-offers Enable for every
    // Host, including ones the Server already holds a row for. Authoritative
    // rather than merged, so a row pruned after a 410 stops claiming push is on.
    // Null means unanswered, which `isPushOn` below reads as not-on rather than
    // settling it at empty.
    setPushSubscribedHostIds(null);
    void client
      .listPushSubscribedHosts()
      .then((hostIds) => {
        if (current()) setPushSubscribedHostIds(new Set(hostIds));
      })
      .catch(() => {
        // Stay unanswered. A read that failed learned nothing, so the card
        // re-offers its idempotent Enable rather than claiming push is on; the
        // next Hosts entry re-reads.
      });
  }, [at, client, loadPushConfig]);

  /**
   * Whether this device is registered for push notifications with one Host.
   *
   * Demands both a Server row and a browser subscription that still matches it,
   * since either half missing means the repair path has to stay offered — and
   * an unanswered read (in flight, or failed) is not a row.
   */
  const isPushOn = (hostId: string): boolean =>
    pushSubscriptionCurrent && (pushSubscribedHostIds?.has(hostId) ?? false);

  /** Tear down the live session and return to the hosts list. */
  const teardownAdapter = useCallback(() => {
    void adapterRef.current?.dispose();
    adapterRef.current = null;
    disposeAllSessions();
  }, []);

  /**
   * End the session outright: **no adapter without a socket, and no socket
   * without an adapter.** Every way out of a live wall lands here — leaving it,
   * an expired session, an adapter that could not stand up — so the three
   * cannot drift into different ideas of what "ended" means. The two paths that
   * deliberately do only half are `setOnHostGone` (the socket is already gone)
   * and `onCancelPairing` (there is no adapter yet).
   */
  const endSession = useCallback(() => {
    teardownAdapter();
    client.close();
  }, [client, teardownAdapter]);

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
        // the pinned Hosts and push registration both outlive the session.
        if (err instanceof SessionExpiredError) {
          endSession();
          setPhase({ at: 'auth' });
          setError(err.message);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [endSession],
  );

  /**
   * The Hosts list: the pinned records, with online state stamped on from the
   * Server. **A Host with no record is not shown** — the Server's list is
   * discovery, and a row for a computer this phone holds no key for would offer
   * an action that cannot exist.
   */
  const loadHosts = useCallback(async () => {
    const [records, enrolled] = await Promise.all([client.listKnownHosts(), client.listHosts()]);
    const online = new Map(enrolled.map((host) => [host.hostId, host.online]));
    setHosts(records.map((record) => toHostView(record, online.get(record.hostId) ?? false)));
    setPhase({ at: 'hosts' });
    // Owed deletions retry here: this runs after every sign-in and on every
    // return to the list, and a tombstone clears only on the Server's answer.
    // Never awaited: it is best-effort, never throws, and nothing on the list
    // it just painted depends on it — a backlog is N serial DELETEs.
    void client.retirePendingDeletions();
  }, [client]);

  // Socket drop / host-gone: dispose the adapter and fall back to Hosts.
  useEffect(() => {
    client.setOnHostGone(() => {
      teardownAdapter();
      setError('The connection to the computer ended.');
      setPhase({ at: 'hosts' });
    });
    return () => client.setOnHostGone(null);
  }, [client, teardownAdapter]);

  /** The connect half, shared so a fresh pairing can continue straight into it. */
  const connectTo = useCallback(
    async (host: HostView) => {
      const decision: ConnectResult = await client.connect(host.hostId);
      if (!decision.ok) {
        // The record has already been rewritten where the Host said
        // `pairing-required`; re-reading is what puts *Pair again* on the row.
        if (decision.pairingRequired) await loadHosts();
        throw new Error(decision.message);
      }
      await client.hello();

      // Stand up the remote adapter as the platform, prep a clean registry,
      // then start watching the directory before the wall renders.
      const adapter = new RemotePtyAdapter(client);
      adapterRef.current = adapter;
      setPlatform(adapter);
      disposeAllSessions();
      initAlertStateReceiver();
      try {
        await adapter.init();
      } catch (err) {
        // The session is already established, and the throw sends the user back
        // to the Hosts list — where nothing can end it. Leaving it up keeps
        // this phone keepaliving a Host it is not attached to and holding one
        // of the Host's session slots, while the next Connect handshakes over
        // the top of it.
        endSession();
        throw err;
      }

      setPhase({ at: 'wall', host });
    },
    [client, endSession, loadHosts],
  );

  const onConnect = (host: HostView) => run('connect', () => connectTo(host));

  /**
   * A scanned or pasted invitation, from the moment it parses to the moment the
   * ceremony ends. The invitation itself never leaves this call: it is a live
   * credential, and the only place it is allowed to exist is the argument list
   * of the pairing it starts.
   */
  const onScanned = useCallback(
    (invitation: PairingInvitation) =>
      run('pair', async () => {
        cancelledPairingRef.current = false;
        const label = deviceLabel();
        let spentOnSetup = false;
        if (client.sessionToken === null) {
          // A browser with no usable passkey registers one with the scanned
          // token; anything else signs in with what it already holds.
          let mustRegister = !hasPriorUseNow(client, passkeyAlreadyRegistered);
          if (!mustRegister) {
            try {
              await client.signin();
            } catch (err) {
              // **A Server that says it has never heard of this credential
              // outranks this browser's own record of prior use.** `setup`
              // caches the passkey before `setupFinish`, so a first run whose
              // `finish` never reached the Server leaves a browser that reads
              // as returning while holding a credential the account never got.
              // Without this, every later scan signs in, fails, and clearing
              // site data is the only way out.
              //
              // **Only the 404.** Every other refusal — a challenge that
              // expired while the user sat at the Face ID prompt, a rejected
              // assertion, a restarting server's 502 — refuses *this attempt*
              // and proves nothing; registering on one would spend the
              // single-use setup token and mint a redundant second passkey. A
              // dismissed prompt or a dead radio propagates as before.
              if (!(err instanceof ServerRefusalError) || err.status !== 404) throw err;
              mustRegister = true;
            }
          }
          if (mustRegister) {
            try {
              await client.setup({ setupToken: invitation.setupToken }, label);
            } catch (err) {
              // Registration can never succeed on this device, so the scan is
              // over: sign-in leads, and is now known to work.
              if (err instanceof PasskeyAlreadyRegisteredError) setPasskeyAlreadyRegistered(true);
              throw err;
            }
            spentOnSetup = true;
            await client.signin();
          }
        }
        // A signed-in phone has no passkey to create, so it spends the code
        // rather than leaving a photographed QR redeemable. A refusal aborts:
        // the code is dead, and pairing with it would fail at the Host anyway.
        if (!spentOnSetup) await client.retireSetupToken(invitation.setupToken);
        await client.retirePendingDeletions();

        setPhase({ at: 'pairing', code: null });
        // **Nothing may throw out of here while the pairing screen is up.** It
        // shows two digits and a Cancel button and renders no error, so a throw
        // left standing hides the one sentence the path exists to deliver —
        // `HostIdentityMismatchError` above all, but equally a dismissed
        // authenticator prompt or a connect the Host refused after approving the
        // pair. `pair` and `connect` report denials as results and throw for the
        // rest, so the whole span is covered rather than either call.
        try {
          // The digits land on the screen already showing them, and only while it
          // is still up — a code arriving after Cancel has nowhere to go.
          const result = await client.pair(invitation, label, (code) =>
            setPhase((current) => (current.at === 'pairing' ? { at: 'pairing', code } : current)),
          );
          if (cancelledPairingRef.current) {
            // The user stopped waiting; whatever the ceremony answered afterwards
            // is not a failure to report at them.
            await loadHosts();
            return;
          }
          if (!result.ok) {
            await loadHosts();
            throw new Error(result.message);
          }
          // Approving on the laptop should land the phone in a terminal, not back
          // on a list. Re-labelling busy keeps the screen showing progress.
          setBusy('connect');
          setHosts((prev) => withRecord(prev, result.record));
          await connectTo(toHostView(result.record, true));
        } catch (err) {
          // Leave first, then re-read, so a failed re-read cannot strand them
          // either. Both are no-ops once a successful connect has moved on.
          setPhase((current) => (current.at === 'pairing' ? { at: 'hosts' } : current));
          await loadHosts().catch(() => undefined);
          throw err;
        }
      }),
    [client, connectTo, loadHosts, passkeyAlreadyRegistered, run],
  );

  const onCancelPairing = () => {
    cancelledPairingRef.current = true;
    // Closing the socket is what ends a ceremony there is no other way out of:
    // the Host's own invitation is spent by the outcome or by its TTL, and the
    // waiter this drops is the only thing still holding the screen.
    client.close();
    setPhase({ at: 'hosts' });
  };

  const onForget = (host: HostView) =>
    run('forget', async () => {
      await client.forgetHost(host.hostId);
      await loadHosts();
    });

  // Must stay free of network round trips before the permission prompt — see
  // the prefetch effect above.
  const onEnablePush = () =>
    run(PUSH_OP, async () => {
      if (pushConfig.status !== 'ready') {
        throw new Error('Could not read this server’s push settings. Try again.');
      }
      try {
        const subscription = await subscribeToPushInBrowser(pushConfig.key, () => {
          // The scope no longer holds an address the Server can reach, so no Host
          // may keep claiming push notifications through it. The moment it becomes
          // true, which is what re-offers Enable if minting the replacement then
          // throws and there is no response to correct the UI with.
          setPushSubscriptionCurrent(false);
        });
        // Owed deletions first: a replacement registered while a superseded
        // delivery row is still on the Server would leave that row reachable.
        await client.retirePendingDeletions();
        // Every paired Host, not only the unregistered ones, so one tap also
        // repairs a rotated endpoint everywhere. Each response commits as it
        // lands rather than after the loop: a registration that fails on the
        // third Host must not throw away the first two.
        for (const host of hosts.filter((h) => !h.needsPairing)) {
          const { hostIds } = await client.subscribeToPush(host.hostId, subscription);
          // Newer than any load still in flight — it answered the same question
          // about the same device, later — so it takes the token from the load
          // whole, dropping every continuation at once rather than each carrying
          // its own guard. The response is authoritative and complete for this
          // device, so it replaces the set rather than adding to it.
          pushLoadRunRef.current++;
          setPushSubscriptionCurrent(true);
          setPushSubscribedHostIds(new Set(hostIds));
        }
      } catch (err) {
        // A denied permission prompt is a failure that changes availability, and
        // availability is only probed on entering Hosts — so without this the
        // card stays up offering an Enable that can only throw again. Re-probed
        // before rethrowing, so the error still gets its one showing.
        void getPushAvailability().then(setPushState);
        throw err;
      }
    });

  // A config retry deliberately stops after caching the key. The next Enable
  // tap is the fresh user gesture the iOS permission prompt requires.
  const onRetryPushConfig = () => run('push-config', () => loadPushConfig(() => true));

  const leaveWall = () => {
    endSession();
    setPhase({ at: 'hosts' });
  };

  // --- Views ---------------------------------------------------------------

  // Gated, not degraded: nothing above has performed a remote operation, and
  // nothing below is reachable until the probe answers.
  if (noiseSupported === false) return <UnsupportedBrowser />;
  if (noiseSupported === null) return <Waiting />;

  const openScanner = () => {
    setError(null);
    setPhase({ at: 'scan' });
  };

  switch (phase.at) {
    case 'scan':
      return (
        <ScanInvitation
          busy={busy}
          error={error}
          appOrigin={location.origin}
          startScan={startScan}
          onScanned={onScanned}
          onCancel={() => {
            // A scan that signed in but failed afterwards has a session and no
            // list: `onScanned` only reads one on a path that reaches pairing.
            // So the way back is the read, not a bare phase change — otherwise
            // the Hosts view claims nothing is paired until Refresh.
            if (client.sessionToken === null) {
              setError(null);
              setPhase({ at: 'auth' });
              return;
            }
            void run('refresh', loadHosts);
          }}
        />
      );
    case 'pairing':
      return <PairingCodeView code={phase.code} onCancel={onCancelPairing} />;
    case 'auth':
      return (
        <SetupOrSignin
          busy={busy}
          error={error}
          // Read here, never latched: a scan that registers a passkey has to
          // flip this screen on the next commit, so a later drop back to auth
          // offers sign-in rather than a second registration.
          hasPriorUse={client.hasPriorUse()}
          arrivedByCamera={arrivedByCamera}
          passkeyAlreadyRegistered={passkeyAlreadyRegistered}
          needsInstall={needsInstall}
          onScan={openScanner}
          onSignin={() =>
            run('signin', async () => {
              await client.signin();
              await loadHosts();
            })
          }
        />
      );
    case 'wall':
      // The adapter is stood up before the phase moves, so the ref is set
      // whenever this branch is reachable.
      return adapterRef.current ? (
        <ConnectedView host={phase.host} adapter={adapterRef.current} onLeave={leaveWall} />
      ) : (
        <Waiting />
      );
    case 'hosts':
      return (
        <HostsView
          hosts={hosts}
          busy={busy}
          error={error}
          isPushSubscribed={isPushOn}
          pushState={pushState}
          pushConfigStatus={pushConfig.status}
          onRefresh={() => run('refresh', loadHosts)}
          onScan={openScanner}
          onConnect={onConnect}
          onForget={onForget}
          onEnablePush={onEnablePush}
          onRetryPushConfig={onRetryPushConfig}
        />
      );
  }
}

/** The whole shell with nothing in it yet; the capability probe's screen too. */
function Waiting(): React.ReactElement {
  return (
    <div className={PK.app}>
      <div className={clsx(PK.body, PK.bodyCenter)}>…</div>
    </div>
  );
}

/** One pinned record as the list renders it. */
function toHostView(record: KnownHostV1, online: boolean): HostView {
  return {
    hostId: record.hostId,
    label: record.label || record.hostId,
    online,
    needsPairing: record.authorization.state !== 'paired',
  };
}

/** Splice a freshly paired record into the list without waiting for a re-read. */
function withRecord(hosts: HostView[], record: KnownHostV1): HostView[] {
  const view = toHostView(record, true);
  const index = hosts.findIndex((host) => host.hostId === record.hostId);
  if (index < 0) return [...hosts, view];
  return hosts.map((host, at) => (at === index ? view : host));
}

/**
 * Whether a sign-in from this browser is a real path. `hasPriorUse` is stored
 * passkey material; the authenticator's own refusal to duplicate a registered
 * credential is the stronger evidence, and outranks it.
 */
function hasPriorUseNow(client: PocketClient, passkeyAlreadyRegistered: boolean): boolean {
  return passkeyAlreadyRegistered || client.hasPriorUse();
}

// --- The capability gate ----------------------------------------------------

/**
 * The whole of what a runtime without X25519 gets. **No action, and no remote
 * operation behind it**: every ceremony this app has needs the primitive this
 * browser lacks, so an offer here would be one that cannot work
 * (`docs/specs/remote-security-model.md` → Runtime gating).
 */
export function UnsupportedBrowser(): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>Dormouse Pocket</h1>
      </header>
      <div className={clsx(PK.body, PK.bodyCenter)}>
        <p className={PK.title}>{UNSUPPORTED_BROWSER_TITLE}</p>
        <p className={PK.lead}>{UNSUPPORTED_BROWSER_BODY}</p>
      </div>
    </div>
  );
}

// --- The two-digit waiting screen -------------------------------------------

/** The accessible name of the digits; see {@link PairingCodeView}. */
export const PAIRING_CODE_LABEL = 'Pairing code';

/**
 * The digits the person has to type on the computer, and nothing else.
 *
 * **The code is on screen before the outcome is known, and stays until it
 * lands.** The laptop's modal tells the user to cancel if the phone shows no
 * code, so a screen that waited for anything before painting the digits would
 * teach exactly the reflex the ceremony is built to punish
 * (`docs/specs/remote-security-model.md` → Pairing).
 */
export function PairingCodeView({
  code,
  onCancel,
}: {
  /** Null for the moment between the handshake and the sampled code. */
  code: string | null;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>Pairing</h1>
      </header>
      <div className={clsx(PK.body, PK.bodyCenter)}>
        {/* Named and announced structurally, so what identifies this screen — to
            a screen reader, to the tests, and to the walkthrough harness — is
            not a sentence the next copy pass is free to rewrite. */}
        <p className={PK.code} role="status" aria-label={PAIRING_CODE_LABEL} aria-live="polite">
          {code ?? '··'}
        </p>
        <p className={clsx(PK.lead, 'text-center')}>
          Type these digits on the computer to approve.
        </p>
        <button
          type="button"
          className={pkButton({ tone: 'outline', block: true })}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- ConnectedView ---------------------------------------------------------

/**
 * What the list of paired machines is called, on its own header and on the back
 * button that returns to it, so the two cannot drift
 * (`docs/specs/pocket-app.md` → The seam: the remote session is a platform
 * adapter).
 */
export const HOSTS_TITLE = 'Computers';

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
          ‹ {HOSTS_TITLE}
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

// This screen owns the button the laptop's panel names, so the label lives in
// the leaf both bundles import. Re-exported because the tests press it here.
export { SCAN_LABEL };

/**
 * The auth screen, in two layouts on one question: does this browser hold a
 * passkey it could sign in with?
 *
 * **Scanning is the only way in.** There is no setup password and no typed
 * credential: a first run leads with the scanner, because pointing this phone
 * at the computer is both the account setup and the pairing, and a browser that
 * holds a passkey leads with sign-in and keeps the scan beside it — a signed-in
 * phone still scans to pair a *new* computer.
 *
 * The install guidance goes here rather than after sign-in because this is the
 * screen that mints the partition-bound *passkey* it warns about — the last
 * point at which the advice is still free to take.
 */
export function SetupOrSignin({
  busy,
  error,
  hasPriorUse,
  arrivedByCamera = false,
  passkeyAlreadyRegistered = false,
  needsInstall,
  onScan,
  onSignin,
}: {
  busy: string | null;
  error: string | null;
  /** Stored passkey material — evidence a sign-in from here can work. */
  hasPriorUse: boolean;
  /**
   * This run was opened by the phone's own camera. The fragment is already
   * gone and nothing was kept from it, so the only thing left to do is say
   * where the scan actually has to happen.
   */
  arrivedByCamera?: boolean;
  /**
   * The authenticator holds a passkey the Server already registered. The only
   * evidence that outranks everything else on this screen: it is proof a
   * sign-in from this device succeeds, where `hasPriorUse` is merely stored
   * material, so sign-in leads even on a browser that stored nothing.
   */
  passkeyAlreadyRegistered?: boolean;
  /** iOS in a browser tab; see {@link InstallFirstNotice}. */
  needsInstall: boolean;
  onScan: () => void;
  onSignin: () => void;
}): React.ReactElement {
  const signinLeads = hasPriorUse || passkeyAlreadyRegistered;
  const signinLabel = busy === 'signin' ? 'Signing in…' : 'Sign in with passkey';
  const scanButton = (tone: 'primary' | 'outline') => (
    <button
      type="button"
      className={pkButton({ tone, block: true })}
      disabled={busy !== null}
      onClick={onScan}
    >
      {busy === 'pair' ? '…' : SCAN_LABEL}
    </button>
  );
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
          <p className={PK.title}>{signinLeads ? 'Welcome back' : 'Set up this phone'}</p>
          <p className={clsx(PK.lead, 'mt-1')}>
            {signinLeads
              ? 'Sign in with your passkey to reach the computers this phone is paired with, or scan a code to pair a new one.'
              : 'On the computer: Settings → Remote control → Set up a phone. Scan the code it shows.'}
          </p>
        </div>
        {/* The one thing a native-camera arrival is for: saying where the scan
            has to happen. The code it carried is already gone and unspent. */}
        {arrivedByCamera ? (
          <div className={PK.notice}>
            <div className={PK.noticeTitle}>{CAMERA_BOOTSTRAP_MESSAGE}</div>
            <p className={PK.noticeBody}>
              The code your camera opened was not used, so nothing has been set up yet. Scanning
              from inside Pocket is what creates the keys this phone will keep.
            </p>
          </div>
        ) : null}
        {/* Above the actions, never below: the passkey this screen mints
            belongs to whichever partition creates it, so guidance that arrives
            after setup arrives after the trap. */}
        {!signinLeads && needsInstall ? <InstallFirstNotice /> : null}
        {error ? <ErrorRow message={error} /> : null}

        {signinLeads ? (
          <>
            {signinButton('primary')}
            <div className={clsx(PK.setup, PK.divided)}>
              <p className={PK.lead}>Pairing a new computer? Scan the code it is showing.</p>
              {scanButton('outline')}
            </div>
          </>
        ) : (
          <>
            {scanButton('primary')}
            {/* Not a disclosure: a synced passkey makes sign-in a real path out
                of a browser that has never stored anything. */}
            <div className={clsx(PK.setup, PK.divided)}>
              <p className={PK.lead}>Set this phone up before? Passkeys sync — sign in instead.</p>
              {signinButton('outline')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The one iOS install gesture, written once so the two notices cannot drift on
 * it — everything else in them differs on purpose (identity vs push-notification
 * framing).
 *
 * Both notices close with a line for someone who installed the app already and
 * opened the wrong window. It is not optional: storage partitions share no
 * signal, so a tab cannot detect the install and the copy has to allow for it.
 */
const INSTALL_RITUAL = (
  <>
    Tap Share, then <strong>Add to Home Screen</strong>
  </>
);

/**
 * iOS, in a browser tab, on the screen about to mint this Client's identity.
 * The installed app is a separate storage partition, so a passkey and per-Host
 * key created in the tab are not the ones it will hold — setting up here means
 * doing all of it, the laptop's pairing approval included, a second time.
 *
 * Guidance, not a gate: iOS offers no install prompt to fire, and someone who
 * does not want push notifications and never installs is still entitled to a
 * terminal.
 *
 * Push notifications are deliberately not mentioned: whether they work at all
 * depends on the Server's push config, which {@link InstallNotice} and the Hosts
 * view's push rows gate on. Identity is true regardless, and carries the notice.
 */
function InstallFirstNotice(): React.ReactElement {
  return (
    <div className={PK.notice}>
      <div className={PK.noticeTitle}>Add Dormouse to your Home Screen first</div>
      <p className={PK.noticeBody}>
        {INSTALL_RITUAL}, and set up from there. iOS keeps the installed app&rsquo;s data separate
        from this tab, so a passkey made here has to be made and approved all over again.
      </p>
      <p className={PK.noticeBody}>
        Already added it? Set up from the Home Screen app rather than this tab.
      </p>
    </div>
  );
}

// --- HostsView -------------------------------------------------------------

/**
 * The same advice on the surface that offers push notifications, for a tab that
 * set up anyway ({@link InstallFirstNotice} is where it is first given, before
 * there is anything to regret). Web Push is granted only to a Home Screen web app,
 * and there is no API to prompt for that install — it can only be described,
 * which is why the push rows below point up here.
 */
function InstallNotice(): React.ReactElement {
  return (
    <div className={PK.notice}>
      <div className={PK.noticeTitle}>Add Dormouse to your Home Screen</div>
      <p className={PK.noticeBody}>
        Push notifications only reach you from the installed app — iOS does not deliver them to a
        Safari tab. {INSTALL_RITUAL}, and open Dormouse from there.
      </p>
      <p className={PK.noticeBody}>Already added it? Open it from your Home Screen instead of this tab.</p>
    </div>
  );
}

/** The `run` label the registration owns; the card selects its spinner on it. */
const PUSH_OP = 'push';

const PUSH_ENABLE_LABEL = 'Enable push notifications';

/** The one pitch, on the one card. */
const PUSH_PITCH =
  'Get a push notification when a terminal needs attention. This phone can be reached while Pocket is closed.';

/**
 * Why push cannot be turned on. Every unavailable state is named, so "my phone
 * never buzzes" always has a visible cause. `needs-install` is absent because
 * {@link InstallNotice} says it at length — see {@link pushNoticeState}.
 */
const PUSH_BLOCKED: Record<Exclude<PushAvailability, 'ready' | 'needs-install'>, string> = {
  denied: 'Notifications are blocked for this site in your browser settings.',
  unsupported: 'This browser cannot receive push notifications.',
  'no-worker': 'Push needs the server to be reached over https.',
};

/**
 * The fourth blocked reason, and the only one with nothing behind it for the
 * person holding the phone: it is the Server's config, so say so rather than
 * leave them hunting through iOS settings for a switch that would not help.
 * Not in {@link PUSH_BLOCKED}, which is keyed by browser availability.
 */
export const PUSH_SERVER_DISABLED =
  'This server has push notifications turned off. Nothing on this phone can turn them on.';

/** What the one push card says; `on` is the settled state and carries no action. */
export type PushNoticeState =
  | { kind: 'offer' }
  | { kind: 'checking' }
  | { kind: 'retry' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'on' };

/**
 * What the push card says, or `null` for nothing to say.
 *
 * **Push is asked for once per device, never once per Host.** The permission
 * prompt and the `PushSubscription` belong to the whole service-worker scope;
 * only the Server row is per (Host, device), and that is bookkeeping the user
 * has no reason to perform once per Host. So the paired Hosts are read as a set:
 * one card offering Enable while any of them lacks a row, one quiet line once
 * they all have one.
 *
 * Pure, and exported, because which of these a given browser/server pair lands
 * on is the whole feature; the rendering half only reads it.
 */
export function pushNoticeState({
  pairedHostIds,
  isPushSubscribed,
  availability,
  configStatus,
}: {
  pairedHostIds: readonly string[];
  isPushSubscribed: (hostId: string) => boolean;
  /** Null until the browser has been asked; see the effect in `App`. */
  availability: PushAvailability | null;
  configStatus: PushConfigStatus;
}): PushNoticeState | null {
  // Nothing to register against, and pairing is the step that comes first.
  if (pairedHostIds.length === 0) return null;
  // An unprobed browser is not a claim about anything, in either direction.
  if (availability === null) return null;
  // Outranks every browser state, a settled `on` included: a Server that no
  // longer holds VAPID keys cannot deliver through the rows it still stores.
  if (configStatus === 'disabled') return { kind: 'blocked', reason: PUSH_SERVER_DISABLED };
  if (pairedHostIds.every(isPushSubscribed)) return { kind: 'on' };
  // `InstallNotice` is the push card for this state, and it is on screen
  // exactly when this branch is reached — a second card saying "see above"
  // would be the whole of its contribution.
  if (availability === 'needs-install') return null;
  if (availability !== 'ready') return { kind: 'blocked', reason: PUSH_BLOCKED[availability] };
  if (configStatus === 'loading') return { kind: 'checking' };
  if (configStatus === 'error') return { kind: 'retry' };
  return { kind: 'offer' };
}

/**
 * The one place Pocket asks for push. Full-width and titled, because turning
 * notifications on is a step of setting the phone up rather than a line on a
 * list.
 *
 * Enable calls the subscribe path directly. Nothing may be fetched in front of
 * it: iOS drops the transient activation across a network round trip, and the
 * permission prompt would then never appear (the VAPID key is prefetched for
 * exactly this reason — see the push effect in `App`). Retry is the exception
 * and stops after caching the key; the next tap is the fresh gesture iOS wants.
 *
 * `secondary`, not `primary`: Connect is the reason the user opened this screen,
 * and the card sits above it.
 */
function PushNotice({
  state,
  busy,
  onEnable,
  onRetryConfig,
}: {
  state: PushNoticeState;
  busy: string | null;
  onEnable: () => void;
  onRetryConfig: () => void;
}): React.ReactElement {
  if (state.kind === 'on') return <div className={PK.deviceLine}>Push notifications on.</div>;

  const action =
    state.kind === 'offer'
      ? { label: busy === PUSH_OP ? '…' : PUSH_ENABLE_LABEL, run: onEnable }
      : state.kind === 'retry'
        ? { label: busy === 'push-config' ? '…' : 'Retry', run: onRetryConfig }
        : null;
  const body =
    state.kind === 'blocked'
      ? state.reason
      : state.kind === 'checking'
        ? 'Checking whether this server can send push notifications…'
        : state.kind === 'retry'
          ? 'Could not check whether this server can send push notifications.'
          : PUSH_PITCH;
  return (
    <div className={PK.notice}>
      <div className={PK.noticeTitle}>
        {state.kind === 'blocked' ? 'Push notifications are off' : 'Turn on push notifications'}
      </div>
      <p className={PK.noticeBody}>{body}</p>
      {action ? (
        <button
          type="button"
          className={pkButton({ tone: 'secondary', block: true })}
          disabled={busy !== null}
          onClick={() => action.run()}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function HostsView({
  hosts,
  busy,
  error,
  isPushSubscribed,
  pushState,
  pushConfigStatus = 'ready',
  onRefresh,
  onScan,
  onConnect,
  onForget,
  onEnablePush,
  onRetryPushConfig,
}: {
  /** The pinned records; a Host with no record is not one of these. */
  hosts: HostView[];
  busy: string | null;
  error: string | null;
  /** True only where this device holds a Server push row for that Host. */
  isPushSubscribed: (hostId: string) => boolean;
  /** Null until the browser has been asked; see the effect in `App`. */
  pushState: PushAvailability | null;
  /** Whether the Server's VAPID public key is already cached for a permission tap. */
  pushConfigStatus?: PushConfigStatus;
  onRefresh: () => void;
  onScan: () => void;
  onConnect: (host: HostView) => void;
  /** Remove this phone's record for one computer, tombstoning its delivery id. */
  onForget: (host: HostView) => void;
  /** Registers every paired Host at once — see {@link pushNoticeState}. */
  onEnablePush: () => void;
  onRetryPushConfig: () => void;
}): React.ReactElement {
  const pushNotice = pushNoticeState({
    pairedHostIds: hosts.filter((h) => !h.needsPairing).map((h) => h.hostId),
    isPushSubscribed,
    availability: pushState,
    configStatus: pushConfigStatus,
  });
  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <h1 className={PK.headerTitle}>{HOSTS_TITLE}</h1>
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
        {error ? <ErrorRow message={error} /> : null}
        {/* Install advice is moot when the server cannot push at all — the
            rows below already say push is disabled, and the ritual the notice
            describes would end at that same message. */}
        {pushConfigStatus !== 'disabled' && pushState === 'needs-install' ? (
          <InstallNotice />
        ) : null}
        {pushNotice ? (
          <PushNotice
            state={pushNotice}
            busy={busy}
            onEnable={onEnablePush}
            onRetryConfig={onRetryPushConfig}
          />
        ) : null}
        {hosts.length === 0 ? (
          <div className={PK.empty}>
            No computers paired yet. On a computer, open Settings → Remote control → Set up a
            phone, then scan the code.
          </div>
        ) : (
          hosts.map((host) => {
            // Push is device-wide to turn on but per-Host to hold, so the row
            // carries the marker: it is the only thing that says *which* Host
            // the card above is still offering to register.
            const status = [
              !host.online ? 'Offline' : host.needsPairing ? 'Pairing needed' : 'Paired',
              ...(!host.needsPairing && isPushSubscribed(host.hostId) ? ['Push on'] : []),
            ].join(' · ');
            // The one-action invariant, stated once: which verb this row offers
            // and what its button says, on a single split. The local record is
            // what picks it — the Host is never asked, because an authenticated
            // `pairing-required` is the only thing that can move a row here.
            const action = host.needsPairing
              ? { label: busy === 'pair' ? '…' : 'Pair again', run: () => onScan() }
              : { label: busy === 'connect' ? '…' : 'Connect', run: () => onConnect(host) };
            return (
              <div key={host.hostId} className={clsx(PK.row, !host.online && PK.rowOffline)}>
                <div className={PK.rowMain}>
                  <div className={PK.rowTitle}>{host.label || host.hostId}</div>
                  <div className={PK.rowSecondary}>{status}</div>
                </div>
                <div className={PK.rowActions}>
                  <button
                    type="button"
                    className={pkButton({ tone: 'primary', size: 'sm' })}
                    // Pairing again starts at the scanner, which needs no relay
                    // socket and no online Host — the code on the computer's
                    // screen is what says whether it is there.
                    disabled={busy !== null || (!host.online && !host.needsPairing)}
                    onClick={action.run}
                  >
                    {action.label}
                  </button>
                  {/* Removal is local and always available: it is how a phone
                      forgets a computer it will not see again, and it is what
                      queues the delivery row's deletion. */}
                  <button
                    type="button"
                    className={pkButton({ tone: 'outline', size: 'sm' })}
                    disabled={busy !== null}
                    aria-label={`Remove ${host.label || host.hostId}`}
                    onClick={() => onForget(host)}
                  >
                    {busy === 'forget' ? '…' : 'Remove'}
                  </button>
                </div>
              </div>
            );
          })
        )}
        <button
          type="button"
          className={pkButton({ tone: 'outline', block: true })}
          disabled={busy !== null}
          onClick={onScan}
        >
          {SCAN_LABEL}
        </button>
      </div>
    </div>
  );
}
