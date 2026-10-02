/**
 * Environment-free Burrow service shared by both Node burrows; see
 * `docs/specs/burrow-service.md` → "Burrow side", `docs/specs/one-time.md` → "Service
 * and hosts" for the one-time connection it also holds, and
 * `docs/specs/remote-network.md` → "Policy" for the network policy it holds
 * and enforces. Surface ownership is injected through
 * {@link BurrowSurfaceProvider}.
 */

import { hostname } from 'node:os';
import {
  API_ROUTES,
  ENROLL_PAGE_PATH,
  MAX_ENROLL_POLL_INTERVAL_S,
  MAX_PENDING_PAIRINGS,
  deriveNoiseStaticPublicKey,
  formatPairingInvitationUrl,
  isSetupTokenResponse,
  mintNoiseStaticKeyPair,
  parseLinkFragment,
  randomBase64Url,
  type BurrowEnrollBeginResponse,
  type EnrollmentOffer,
} from 'remote-lib-common';
import {
  beginHostedEnrollment,
  originMismatchMessage,
  performEnrollment,
  pollHostedEnrollment,
  type BurrowEnrollCredential,
  type BurrowEnrollment,
  type EnrollmentStatic,
} from '../../remote/burrow/enrollment';
import type { BurrowSurfaceProvider } from '../../remote/burrow/burrow-surface-provider';
import { burrowFetch, describingFetchFailures, probeBurrowStanding } from '../../remote/burrow/burrow-fetch';
import type { PendingPairing } from '../../remote/burrow/pairing-approval';
import {
  loadPushDevices,
  sendPush,
  PUSH_TEST_TAG,
  PUSH_TEST_TITLE,
  type AlertPushDeps,
} from '../../remote/burrow/push-delivery';
import type { RemoteApiSessionContext } from '../../remote/burrow/established-session';
import type { PathRefusal } from '../../remote/direct/path-refusal';
import { RemoteApiSession } from '../../remote/burrow/remote-api';
import {
  BurrowRuntime,
  type InvitationState,
  type PairingOutcome,
  type WebSocketLike,
} from '../../remote/burrow/burrow-runtime';
import {
  OneTimeRuntime,
  type OneTimeApprovalRequest,
  type OneTimeState,
} from '../../remote/burrow/one-time-runtime';
import {
  MAX_ALLOWED_NETWORKS,
  levelsFor,
  networkPolicyResult,
  nothingPolicy,
  opensOneTimeLinks,
  parseNetworkPolicy,
  runsBurrow,
  type NetworkInterfaceInfo,
  type NetworkLevel,
  type NetworkPolicy,
  type NetworkPolicyResult,
} from '../../remote/network-policy';
import {
  ACCOUNT_PAGE_PATH,
  HOSTED_ACCOUNT_ORIGIN,
  hostedAccountOrigin,
  hostedOrigin,
  isDevHostedBuild,
  isRelayOrigin,
  type RelayBuild,
} from '../relay-origin';
import { readEnrollmentOffer } from './enroll-offer';
import type { BurrowStateStore } from './burrow-state-store';
import { directPeeringFor, samePaths } from './direct-peering';
import type { BurrowDirectPeerFactory } from './native-direct-peer';
import { canonicalCidr, listNetworkInterfaces } from './network-interfaces';
import { createSerialQueue } from './serial-queue';
import {
  BURROW_EVENT_EVENT,
  BURROW_RESULT_EVENT,
  approvalKind,
  idleOneTimeState,
  isBurrowCommand,
  relayRefuses,
  type ApproveParams,
  type BurrowUiEvent,
  type DenyParams,
  type EnrollOfferParams,
  type EnrollParams,
  type EnrollResult,
  type HostedEnrollParams,
  type HostedEnrollmentEnded,
  type HostedEnrollmentState,
  type BurrowStatusEvent,
  type InvitationEvent,
  type OneTimeEvent,
  type PairingQueueEvent,
  type PairingQueueItem,
  type PushDevicesResult,
  type PushSendSummary,
  type BurrowConsoleStatus,
  type SetNetworkPolicyParams,
  type SetupQrResult,
  type TakeBackParams,
  type TakeBackResult,
} from './service-protocol';

export interface BurrowServiceOptions {
  store: BurrowStateStore;
  provider: BurrowSurfaceProvider;
  /**
   * Which app this Burrow is. A closed set rather than a display string, so
   * nothing can pass a name that names neither; read only by
   * {@link suggestedBurrowLabel} today.
   */
  kind: BurrowKind;
  /** Emit one of the `burrow:*` events to the webview. */
  sendToUi: (event: string, data: unknown) => void;
  /**
   * This build's `bakedRelay()` (`docs/specs/burrow-service.md` → "Relay origin"): the
   * only Relay this Burrow enrolls with or connects to, and in a Hosted build
   * the one-time rendezvous too. **Never webview input**: no command carries
   * an origin.
   */
  relay: RelayBuild;
  /**
   * Opens the relay socket and the one-time rendezvous alike. **Must send no
   * `Origin` header** — the rendezvous refuses one, so that no browser page can
   * mint a room — which Node's global `WebSocket` (the default) and `ws` both
   * already do. Reached only through the service's transport guard, as is
   * {@link BurrowServiceOptions.fetch}.
   */
  createWebSocket?: (url: string) => WebSocketLike;
  /**
   * How this host builds a peer connection for the direct path
   * (`docs/specs/remote-api.md` → Transport → "Direct path"). Threaded rather
   * than defaulted: the runtimes that have one differ per host, and a Burrow
   * without it declines every offer and stays relayed. Each runtime takes it
   * through {@link directPeeringFor}.
   */
  createDirectPeer?: BurrowDirectPeerFactory;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * The installer's enrollment offer on this machine, if any. Defaults to the
   * real well-known path (`enroll-offer.ts`); injected by the tests, which must
   * not depend on whether the machine running them has a Relay installed.
   *
   * **Must never reject** — a failed read is `null`, like a file that is not
   * there. That contract is what lets the status path await it bare, so the
   * spent-offer error in `#enrollOffer` stays the one thing a caller can see go
   * wrong here.
   */
  readOffer?: () => Promise<EnrollmentOffer | null>;
  /** This machine's interfaces, for `networkPolicy`; injected by the tests. */
  listInterfaces?: () => NetworkInterfaceInfo[];
}

/**
 * The hostname, or `''` where the platform will not name itself. `os.hostname`
 * throws on a machine whose name cannot be resolved, and a status read is the
 * last place that may fail — it is what the webview's enrolled gate seeds from.
 */
function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return '';
  }
}

/** What every command the `nothing` level refuses answers, before any request. */
const NETWORK_OFF_REFUSAL =
  'Settings → Network is set to Nothing, so this computer opens no connections on its own.';

/** What `oneTimeOpen` answers under `local` with no network allowed. */
const NO_NETWORK_ALLOWED_REFUSAL =
  'No network is allowed under Local networks, so no phone can connect. Allow one in Settings → Network.';

/**
 * The policy this build reads (`docs/specs/remote-network.md` → "Policy"): the
 * stored one, or — where none was ever saved, `stored: false` — the default:
 * `relay` for an enrollment this build may reach and a build that offers it,
 * else `nothing`. **A stored level this build does not offer reads as
 * `nothing`** and stays on disk, as an enrollment for another origin does.
 * Writes nothing: the service saves the default, VS Code's idle answers never do.
 */
export async function peekNetworkPolicyFor(
  store: Pick<BurrowStateStore, 'loadEnrollment' | 'loadNetworkPolicy'>,
  relay: RelayBuild,
): Promise<{ policy: NetworkPolicy; stored: boolean }> {
  const levels = levelsFor(relay.mode);
  const stored = await store.loadNetworkPolicy();
  if (stored) {
    return { policy: levels.includes(stored.level) ? stored : { ...stored, level: 'nothing' }, stored: true };
  }
  const enrolled = (await loadEnrollmentFor(store, relay.origin)) !== null;
  const level = enrolled && levels.includes('relay') ? 'relay' : 'nothing';
  return { policy: { ...nothingPolicy(), level }, stored: false };
}

/**
 * The policy a `setNetworkPolicy` names, taken only exactly: a level this build
 * offers, and every allowed network a CIDR, saved in its canonical form and
 * listed once in that form. Throws what the webview shows.
 */
function requestedNetworkPolicy(value: unknown, relay: RelayBuild): NetworkPolicy {
  const policy = parseNetworkPolicy(value);
  if (!policy) {
    throw new Error(
      `A network policy is { level, allowed (at most ${MAX_ALLOWED_NETWORKS} CIDRs), autoUpdate }, and nothing else.`,
    );
  }
  if (!levelsFor(relay.mode).includes(policy.level)) {
    throw new Error(`This build does not offer the ${policy.level} level.`);
  }
  const allowed: string[] = [];
  for (const cidr of policy.allowed) {
    const canonical = canonicalCidr(cidr);
    if (canonical === null) {
      throw new Error(`${cidr} is not an address range, such as 192.168.1.0/24.`);
    }
    if (allowed.includes(canonical)) {
      throw new Error(`${canonical} is already allowed.`);
    }
    allowed.push(canonical);
  }
  return { ...policy, allowed };
}

/** What `enroll` and `enrollOffer` answer in a Hosted build, naming where its codes are approved. */
function hostedEnrollmentRefusal(accountOrigin: string): string {
  return (
    `This Dormouse enrolls with Dormouse Hosted by approving a code at ${new URL(accountOrigin).host}, not with ` +
    'a setup password. A Relay you run takes a Dormouse built with its origin (DORMOUSE_RELAY_ORIGIN).'
  );
}

/** What `beginHostedEnrollment` answers in a self-host build. */
const SELF_HOST_DEVICE_CODE_REFUSAL =
  'This Dormouse enrolls with its own Relay’s setup password; enrollment codes are for Dormouse Hosted.';

/**
 * How long a Hosted enrollment waits for approval, by this machine's clock:
 * the Relay's `expiresAt`, held to these bounds, since that is the Relay's
 * clock and this one may be minutes off it. The Relay's `expired` ends it too.
 */
const HOSTED_ENROLLMENT_MIN_WAIT_MS = 60_000;
const HOSTED_ENROLLMENT_MAX_WAIT_MS = 15 * 60_000;

/** How much a 429 lengthens the poll interval, up to `MAX_ENROLL_POLL_INTERVAL_S`. */
const HOSTED_ENROLLMENT_SLOW_DOWN_MS = 5_000;

/**
 * The account page that approves `begin.userCode`, composed here
 * (`docs/specs/hosted.md` -> "Burrow enrollment"): **never the Relay's
 * `verificationUrl` in a release build**, which opens
 * `HOSTED_ACCOUNT_ORIGIN/enroll#<userCode>`. A dev Hosted build
 * (`isDevHostedBuild`) takes the origin of the Relay's `verificationUrl`,
 * holding it to a link's checks — https or loopback http, no credentials, path
 * `/enroll`, no query, fragment exactly the code — and throws without one.
 */
export function enrollVerificationUrl(
  relay: RelayBuild,
  begin: Pick<BurrowEnrollBeginResponse, 'userCode' | 'verificationUrl'>,
): string {
  const account = hostedAccountOrigin(relay);
  if (account === null) throw new Error(SELF_HOST_DEVICE_CODE_REFUSAL);
  const origin = isDevHostedBuild(relay) ? namedAccountOrigin(begin) : account;
  if (origin === null) {
    throw new Error(
      `The Relay at ${relay.origin} named no account page to approve ${begin.userCode} at.`,
    );
  }
  return `${origin}${ENROLL_PAGE_PATH}#${begin.userCode}`;
}

/**
 * The account origin `status` names: `HOSTED_ACCOUNT_ORIGIN` in a release
 * Hosted build; in a dev one, `resolved` — the origin the last begin took from
 * the Relay — or `null` before any; `null` in a self-host build.
 */
export function accountOriginFor(relay: RelayBuild, resolved: string | null = null): string | null {
  return isDevHostedBuild(relay) ? resolved : hostedAccountOrigin(relay);
}

/** The origin of a `verificationUrl` that is exactly `<origin>/enroll#<userCode>`, or `null`. */
function namedAccountOrigin(
  begin: Pick<BurrowEnrollBeginResponse, 'userCode' | 'verificationUrl'>,
): string | null {
  const named = begin.verificationUrl;
  if (typeof named !== 'string') return null;
  let origin: string;
  try {
    origin = new URL(named).origin;
  } catch {
    return null;
  }
  const fragment = parseLinkFragment(named, origin, {
    maxLength: 512,
    pathname: ENROLL_PAGE_PATH,
    hashPrefix: '#',
  });
  return fragment === begin.userCode ? origin : null;
}

/**
 * The installer's offer this build could spend: read only in a self-host
 * build, and `null` unless it names the baked origin. One reader for the
 * service and the VS Code glue, which both answer `status`.
 */
export async function readUsableOffer(
  relay: RelayBuild,
  read: () => Promise<EnrollmentOffer | null>,
): Promise<EnrollmentOffer | null> {
  if (relay.mode !== 'self-host') return null;
  const offer = await read();
  return offer && isRelayOrigin(offer.origin, relay.origin) ? offer : null;
}

/**
 * The stored enrollment, or `null` — including for one whose Relay URL or
 * phone-facing `origin` names another origin, which **reads as none** and stays
 * on disk (`docs/specs/burrow-service.md` → "Relay origin"). Both are checked because an
 * enrollment from before the one baked origin could carry an `origin` apart from
 * its Relay URL. One reader for the service's start and VS Code's contention.
 */
export async function loadEnrollmentFor(
  store: Pick<BurrowStateStore, 'loadEnrollment'>,
  origin: string,
): Promise<BurrowEnrollment | null> {
  const enrollment = await store.loadEnrollment();
  if (
    !enrollment ||
    (isRelayOrigin(enrollment.relayUrl, origin) && isRelayOrigin(enrollment.origin, origin))
  ) {
    return enrollment;
  }
  console.warn(
    `[burrow] enrolled Relay ${enrollment.relayUrl} (origin ${enrollment.origin}) is not this ` +
      `build's relay origin (${origin}); reading it as un-enrolled`,
  );
  return null;
}

/**
 * What a Burrow with no enrollment reports, given what {@link readUsableOffer}
 * found. One builder, because two processes answer this: the service's own
 * `status`, and the VS Code glue for a window that has no service at all
 * (`vscode-ext/src/burrow.ts` → `idleStatus`). The offer crosses as a boolean
 * — its one-time token is a bearer credential and never enters a webview
 * (`service-protocol.ts` → `BurrowConsoleStatus.offer`) — so the two must not
 * drift.
 */
export function unenrolledStatus(
  offer: EnrollmentOffer | null,
  kind: BurrowKind,
  relay: RelayBuild,
  serving = false,
  hostedEnrollment: HostedEnrollmentState | null = null,
  accountOrigin: string | null = accountOriginFor(relay),
): BurrowConsoleStatus {
  return {
    enrolled: false,
    serving,
    relayOrigin: relay.origin,
    relayMode: relay.mode,
    burrowId: null,
    connection: 'stopped',
    pairedClients: 0,
    suggestedLabel: suggestedBurrowLabel(kind),
    offer: offer !== null,
    hostedEnrollment,
    accountOrigin,
  };
}

/** The one-time states that hold a socket or a session, which make a Burrow `serving`. */
const ONE_TIME_SERVING: ReadonlySet<OneTimeState['status']> = new Set<OneTimeState['status']>([
  'opening',
  'waiting',
  'confirming',
  'connecting',
  'connected',
]);

/**
 * Whether a one-time connection in `state` can reach this machine's terminals,
 * or is about to: what `serving` adds to `enrolled`
 * (`service-protocol.ts` → `BurrowStatusEvent.serving`).
 */
export function oneTimeServing(state: OneTimeState): boolean {
  return ONE_TIME_SERVING.has(state.status);
}


/** Bytes of the random ticket a one-time request is answered by, as `pairingId`. */
const ONE_TIME_TICKET_BYTES = 16;

/** Bytes of the random id a remote session holds a pane's size under. */
const HOLDER_ID_BYTES = 16;

/** Bytes of the random id that names one service instance to the webviews. */
const SERVICE_ID_BYTES = 16;

/** Which app a Burrow is. Standalone and VS Code enroll separately. */
export type BurrowKind = 'standalone' | 'vscode';

/** The one place a {@link BurrowKind} becomes words a person reads. */
const KIND_NAMES: Record<BurrowKind, string> = {
  standalone: 'Dormouse',
  vscode: 'VS Code',
};

/**
 * The label the enrollment form starts with. Names the app as well as the
 * machine, because standalone and VS Code on one laptop are two Burrows and
 * Pocket lists them as two rows — a hostname alone would label both the same.
 *
 * It is only a *suggestion*: the field is editable, so this makes the two rows
 * distinguishable by default rather than guaranteeing they stay that way.
 */
export function suggestedBurrowLabel(kind: BurrowKind): string {
  const machine = safeHostname();
  return machine ? `${machine} (${KIND_NAMES[kind]})` : KIND_NAMES[kind];
}

/**
 * A Hosted enrollment awaiting approval. The device code and the Noise static
 * stay here, in this process; `status` carries the rest
 * ({@link HostedEnrollmentState}).
 */
interface HostedEnrollmentRun {
  readonly deviceCode: string;
  readonly noiseStatic: EnrollmentStatic;
  readonly label: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  /** This machine's deadline (`HOSTED_ENROLLMENT_MAX_WAIT_MS`). */
  readonly expiresAt: number;
  intervalMs: number;
  /** The last poll found the approving account full. */
  accountFull: boolean;
  /** A poll redeemed it, and its enrollment is being saved and started. */
  redeeming: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BurrowService {
  readonly #store: BurrowStateStore;
  readonly #provider: BurrowSurfaceProvider;
  readonly #sendToUi: (event: string, data: unknown) => void;
  readonly #relay: RelayBuild;
  /** `hostedOrigin(#relay)`: where one-time links are made, or `null` for none. */
  readonly #hostedOrigin: string | null;
  readonly #kind: BurrowKind;
  /** The injected socket factory behind the transport guard (constructor). */
  readonly #createWebSocket: (url: string) => WebSocketLike;
  /** The injected peer factory behind the transport guard, bound per runtime by {@link directPeeringFor}. */
  readonly #createDirectPeer?: BurrowDirectPeerFactory;
  /** The injected fetch, or the global one, behind the transport guard. */
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #readOffer: () => Promise<EnrollmentOffer | null>;
  readonly #listInterfaces: () => NetworkInterfaceInfo[];

  #burrow: BurrowRuntime | null = null;
  /**
   * The enrollment this service reports: the running Burrow's, or — under a
   * level that runs none — the one it holds without running (`#startBurrow`).
   */
  #enrollment: BurrowEnrollment | null = null;
  /**
   * The network policy as last read or set; this service is its only writer.
   * **`null` until read, and read as `nothing` until then** (`#level`).
   */
  #policy: NetworkPolicy | null = null;
  /** The first read in flight, which every reader joins. */
  #policyRead: Promise<NetworkPolicy> | null = null;
  /**
   * The last session either runtime ended for its path, until dismissed or
   * replaced (`docs/specs/remote-network.md` -> "Local networks"). Memory
   * only: a restart forgets it.
   */
  #pathRefusal: PathRefusal | null = null;
  /**
   * Lifecycle changes and pairing approvals run one at a time on this chain.
   *
   * Each of those reads `#burrow`, awaits a store round trip, and then acts on
   * what it read — so overlapping them (an activation `start` and a reconnect
   * during an enroll) lets two of them both see no Burrow and both build one.
   * The second `BurrowRuntime` would hold a relay socket nothing has a
   * reference to and could not be stopped, and the two would displace each
   * other on the Relay forever.
   * Approval holds the same lease through persistence, so a replacement cannot
   * load an ACL snapshot before the previous runtime's approved write finishes.
   */
  readonly #serialize = createSerialQueue();
  /** Disposal is terminal: no in-flight store read may resurrect the Burrow. */
  #disposed = false;
  /**
   * Pairings awaiting local approval, service-side. The webview mirrors a
   * serializable projection of this and answers with its immutable pairing id;
   * the approve/deny closures the `BurrowRuntime` handed us never leave this
   * process.
   */
  readonly #pairings = new Map<string, PendingPairing>();

  /** The Hosted enrollment awaiting approval, polled by its own timer. */
  #enrollRun: HostedEnrollmentRun | null = null;
  /** How the last one ended short of enrolling, until the next begin or a cancel. */
  #enrollEnded: HostedEnrollmentEnded | null = null;
  /** Bumped by every begin and cancel, so a begin still in flight that was superseded keeps nothing. */
  #enrollSeq = 0;
  /** The begin in flight, which every other begin joins. */
  #enrollBegin: Promise<HostedEnrollmentState> | null = null;
  /** The account origin the last begin resolved: what a dev Hosted build's `status` names. */
  #accountOrigin: string | null = null;

  /**
   * The one-time connection, as `oneTimeStatus` answers it and the `one-time`
   * event carries it. Independent of the enrollment: it needs none, and
   * enrolling, clearing, and reconnecting leave it alone.
   */
  #oneTimeState: OneTimeState;
  /** The runtime behind that state while it is live; `null` once it ended. */
  #oneTime: OneTimeRuntime | null = null;
  /** The open in flight, which a second `oneTimeOpen` joins rather than replaces. */
  #oneTimeOpening: Promise<OneTimeState> | null = null;
  /**
   * The one-time request awaiting the modal, in a slot of its own — never in
   * `#pairings`, so it is neither capped nor coalesced with a pairing, and its
   * answer never waits behind an enrollment. Tagged with the runtime that
   * asked, so only that runtime's dismissal clears it.
   */
  #oneTimeApproval: { runtime: OneTimeRuntime; pending: PendingPairing } | null = null;
  /**
   * Every live remote-api session of either runtime, by the holder id its
   * attachments hold panes under, to the `end` that runtime handed it — what
   * Take back runs. Entered at creation, left at disposal.
   */
  readonly #holders = new Map<string, () => void>();
  /**
   * This instance, as every `status` event names it and every hold its
   * sessions take carries it: a webview drops a hold another instance took, which no
   * release will ever reach (`docs/specs/remote-api.md` → "Size authority").
   */
  readonly #serviceId = randomBase64Url(SERVICE_ID_BYTES);

  constructor(options: BurrowServiceOptions) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#sendToUi = options.sendToUi;
    this.#relay = options.relay;
    this.#hostedOrigin = hostedOrigin(options.relay);
    this.#oneTimeState = idleOneTimeState(this.#hostedOrigin, this.#level());
    this.#kind = options.kind;
    // The transport guard (`docs/specs/remote-network.md` → "Policy"): every
    // socket, request, and direct peer this service opens goes through these
    // three, which refuse at the call while the level is `nothing` — unread and
    // disposed included (`#level`) — so a path that forgets its own check still
    // opens nothing. Each feature keeps its own check, for the error a person
    // reads.
    const createWebSocket =
      options.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.#createWebSocket = (url) => {
      this.#refuseNothing();
      return createWebSocket(url);
    };
    // Looked up at the call, like `burrowFetch`'s default; a request that gets
    // no answer says which host and why, never undici's bare `fetch failed`.
    const injectedFetch = describingFetchFailures((input, init) =>
      (options.fetch ?? globalThis.fetch)(input, init),
    );
    this.#fetch = async (input, init) => {
      this.#refuseNothing();
      return injectedFetch(input, init);
    };
    // A factory's `null` is a direct path declined, the session kept relayed.
    const createDirectPeer = options.createDirectPeer;
    this.#createDirectPeer =
      createDirectPeer &&
      ((pathPolicy, stun) => (this.#level() === 'nothing' ? null : createDirectPeer(pathPolicy, stun)));
    this.#now = options.now ?? (() => Date.now());
    this.#readOffer = options.readOffer ?? (() => readEnrollmentOffer());
    this.#listInterfaces = options.listInterfaces ?? listNetworkInterfaces;
  }

  /**
   * Start from a persisted enrollment, if there is one this build may reach
   * and the network policy lets it run — and announce this instance either
   * way, since a webview that outlived the one before it holds panes under
   * sessions that are gone, and shows that one's one-time connection: a VS Code
   * window that takes the broker over from one with a phone connected, or a
   * restarted sidecar.
   */
  start(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    // Once the policy is read, whose level decides the resting state, and not
    // behind the enrollment read below: the panel stops offering End on a
    // connection that is gone. A read that moved the state has said so already.
    const announced = this.#oneTimeState;
    void this.#settledLevel().then(() => {
      if (this.#oneTimeState === announced) this.#emitOneTime();
    });
    return this.#serialize(async () => {
      try {
        await this.#start();
      } finally {
        // A started Burrow has already said so, this instance included.
        if (!this.#burrow) this.#emitStatus();
      }
    });
  }

  async #start(): Promise<void> {
    // The policy before anything: a read that fails leaves the Burrow down.
    await this.#networkPolicy();
    const enrollment = await loadEnrollmentFor(this.#store, this.#relay.origin);
    if (enrollment) await this.#startBurrow(enrollment);
  }

  /** Stop the Burrow, end any one-time connection, and forget the connection-scoped state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopHostedEnrollment();
    this.#stopBurrow();
    const oneTime = this.#oneTime;
    this.#oneTime = null;
    oneTime?.end('user-ended');
  }

  async handleCommand(raw: unknown): Promise<void> {
    if (this.#disposed || !isBurrowCommand(raw)) return;
    const command = raw;
    try {
      const result = await this.#run(command.cmd, command.params);
      if (this.#disposed) return;
      this.#sendToUi(BURROW_RESULT_EVENT, { burrowRequestId: command.burrowRequestId, result });
    } catch (error) {
      if (this.#disposed) return;
      this.#sendToUi(BURROW_RESULT_EVENT, {
        burrowRequestId: command.burrowRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #run(cmd: string, params: unknown): Promise<unknown> {
    switch (cmd) {
      // Lifecycle changes and approval writes share the chain with `start()`.
      // `reconnect` takes
      // the lease itself, for just the restart half (see `#reconnect`).
      case 'enroll':
        return this.#serialize(() => this.#enroll(params as EnrollParams));
      case 'enrollOffer':
        return this.#serialize(() => this.#enrollOffer(params as EnrollOfferParams));
      // Off the chain: the begin is one request and writes nothing; the poll's
      // enrolled answer takes the lease for its persist-then-start.
      case 'beginHostedEnrollment':
        return this.#beginHostedEnrollment(params as HostedEnrollParams | undefined);
      case 'cancelHostedEnrollment':
        return this.#cancelHostedEnrollment();
      case 'status':
        return this.#status();
      case 'reconnect':
        return this.#reconnect();
      case 'clearEnrollment':
        return this.#serialize(() => this.#clearEnrollment());
      case 'setupQr':
        return this.#setupQr();
      // A one-time answer goes straight to its runtime, never behind the chain:
      // it writes nothing an enrollment's store work could race, and its one
      // attempt must not wait out an enroll's round trip past the link's expiry.
      case 'approve':
        return approvalKind(params as ApproveParams | null) === 'one-time'
          ? this.#approve(params as ApproveParams)
          : this.#serialize(() => this.#approve(params as ApproveParams));
      case 'deny':
        return this.#deny(params as DenyParams);
      case 'oneTimeOpen':
        return this.#openOneTime();
      case 'oneTimeEnd':
        return this.#endOneTime();
      case 'oneTimeStatus':
        // After the policy's first read, so a panel seeding from it is not told
        // `network-off` only to be told otherwise.
        await this.#settledLevel();
        return this.#oneTimeState;
      case 'networkPolicy':
        return this.#networkPolicyResult(await this.#networkPolicy());
      case 'dismissPathRefusal':
        return this.#dismissPathRefusal();
      case 'setNetworkPolicy':
        return this.#serialize(() => this.#setNetworkPolicy(params as SetNetworkPolicyParams | undefined));
      case 'pushTest':
        return this.#pushTest();
      case 'pushDevices':
        return this.#pushDevices();
      case 'pairingQueue':
        return this.#queueSnapshot();
      case 'takeBack':
        return this.#takeBack(params as TakeBackParams | undefined);
      default:
        throw new Error(`unknown burrow command: ${cmd}`);
    }
  }

  // --- Commands ---

  async #enroll(params: EnrollParams): Promise<EnrollResult> {
    if (this.#relay.mode !== 'self-host') throw new Error(this.#hostedEnrollmentRefusal());
    await this.#networkPolicy();
    this.#refuseNothing();
    this.#refuseOtherOrigin((params as { relayUrl?: unknown }).relayUrl);
    return this.#enrollWith({ password: params.password }, params.label);
  }

  /**
   * The policy as it stands, refused while the level is `nothing` — unread and
   * disposed included (`#level`) — before any request: by the transport guard
   * at the call, and by a command **after awaiting `#networkPolicy()` and
   * before the next await**, so a `setNetworkPolicy` or a `dispose()` that
   * landed during that await is the one it reads.
   */
  #refuseNothing(): NetworkPolicy {
    const policy = this.#policy;
    if (!policy || this.#level() === 'nothing') throw new Error(NETWORK_OFF_REFUSAL);
    return policy;
  }

  /**
   * An older webview still names the Relay — `enroll`'s `relayUrl`, or
   * `enrollOffer`'s echoed `origin` — and one naming any but the baked origin
   * is refused, rather than enrolled with this build's Relay instead.
   *
   * Compatibility reader for webviews built before v1.2.0 (a VS Code window
   * not yet reloaded onto this broker's build); removable once no supported
   * build predates it.
   */
  #refuseOtherOrigin(named: unknown): void {
    if (named === undefined) return;
    if (typeof named === 'string' && isRelayOrigin(named, this.#relay.origin)) return;
    throw new Error(
      `This Dormouse enrolls only with ${this.#relay.origin}, the Relay it was built for, ` +
        `not ${String(named)}.`,
    );
  }

  /**
   * One-click enrollment from the offer an installer left on this machine
   * (`docs/specs/burrow-service.md` → "Remote control, in the Settings dialog").
   */
  async #enrollOffer(params: EnrollOfferParams): Promise<EnrollResult> {
    if (this.#relay.mode !== 'self-host') throw new Error(this.#hostedEnrollmentRefusal());
    await this.#networkPolicy();
    this.#refuseNothing();
    this.#refuseOtherOrigin((params as { origin?: unknown }).origin);
    // Re-read at the click, and refused before the token leaves the machine
    // unless it names the one Relay this build enrolls with.
    const offer = await readUsableOffer(this.#relay, this.#readOffer);
    if (!offer) {
      throw new Error(
        `There is no enrollment offer for ${this.#relay.origin} on this machine — it may have been ` +
          'redeemed already. Re-run the installer to mint a new one, or enroll with the setup password.',
      );
    }
    return await this.#enrollWith({ enrollToken: offer.token }, params.label);
  }

  /**
   * The one enrollment flow, whichever credential proves the right to it: the
   * exchange with the baked origin — the only Relay this build reaches — then
   * the Relay's own origin checked against it, then store-first persistence and
   * the status edge the webview gate needs.
   */
  async #enrollWith(credential: BurrowEnrollCredential, label: string): Promise<EnrollResult> {
    const enrollment = await performEnrollment(this.#relay.origin, credential, label, this.#fetch);
    await this.#adoptEnrollment(
      enrollment,
      `The Relay has already recorded Burrow ${enrollment.burrowId}; remove it from burrows.json.`,
    );
    return { burrowId: enrollment.burrowId };
  }

  /**
   * Hold an enrollment either exchange just minted: the Relay's own origin
   * checked against the baked one, then store-first persistence and the
   * status edge the webview gate needs. **Runs on `#serialize`.** `leftBehind`
   * names, for the operator, the Burrow the Relay recorded for an origin this
   * build refuses; `onSaved` lets the Hosted caller distinguish a lost
   * credential from a startup failure after persistence.
   */
  async #adoptEnrollment(
    enrollment: BurrowEnrollment,
    leftBehind?: string,
    onSaved?: () => void,
  ): Promise<void> {
    if (!isRelayOrigin(enrollment.origin, this.#relay.origin)) {
      // An older Relay, which ignores the request's `origin` and so enrolled a
      // Burrow built for another: nothing is persisted here, and the row it
      // appended is named for the operator (docs/specs/burrow-service.md → "Relay origin").
      const mismatch = originMismatchMessage(enrollment.origin, this.#relay.origin);
      throw new Error(leftBehind ? `${mismatch} ${leftBehind}` : mismatch);
    }
    // Persist before touching the running Burrow. The credential we just minted
    // exists nowhere else and cannot be minted again from the same exchange — a
    // spent offer's token least of all — so a save that fails after the old Burrow
    // had been stopped would strand the machine with no Burrow, a status that says
    // otherwise, and a brand-new `burrowToken` lost to the failure. Failing here
    // instead leaves the old Burrow running and everything it reports still true.
    await this.#store.saveEnrollment(enrollment);
    onSaved?.();
    if (this.#burrow) {
      // Swapping one running Burrow for another. The gate the webviews arm their
      // outbound work on is edge-triggered (`enrolled-gate.ts`), and everything
      // it holds — the mirrored pairing queue, the push device list — belongs
      // to the Relay we are leaving. Without a `false` between the two Burrows
      // the gate never cycles: the Settings dialog keeps naming the old
      // Relay's devices, and a device fetch already on the wire can land after
      // the swap and put them back.
      this.#stopBurrow();
      this.#enrollment = null;
      this.#emitStatus();
    }
    await this.#startBurrow(enrollment);
    // A Burrow the level holds without running announced nothing; `start()`
    // says the same for the same reason.
    if (!this.#burrow) this.#emitStatus();
  }

  // --- Hosted enrollment (`docs/specs/hosted.md` -> "Burrow enrollment") ---

  /**
   * Begin a device-code enrollment and poll it from here, answering the
   * `waiting` state the panel draws. **A code already waiting or redeeming is
   * answered, not voided** — another VS Code window's Enroll lands on the same
   * service — and a begin in flight is joined; one that ended is replaced once
   * a new code is in hand. Refused in a self-host build, on an enrolled
   * machine, and under `nothing` before any request.
   */
  async #beginHostedEnrollment(params: HostedEnrollParams | undefined): Promise<HostedEnrollmentState> {
    if (this.#relay.mode === 'self-host') throw new Error(SELF_HOST_DEVICE_CODE_REFUSAL);
    const named = typeof params?.label === 'string' ? params.label.trim() : '';
    const label = named || suggestedBurrowLabel(this.#kind);
    await this.#networkPolicy();
    this.#refuseNothing();
    this.#refuseEnrolled();
    if (this.#enrollRun) return this.#hostedEnrollmentState()!;
    if (this.#enrollBegin) return await this.#enrollBegin;
    const begun = this.#beginRun(label, ++this.#enrollSeq);
    this.#enrollBegin = begun;
    try {
      return await begun;
    } finally {
      if (this.#enrollBegin === begun) this.#enrollBegin = null;
    }
  }

  /** The begin request, then the run it starts in place of any before it, unless `seq` was superseded. */
  async #beginRun(label: string, seq: number): Promise<HostedEnrollmentState> {
    const { begin, noiseStatic } = await beginHostedEnrollment(this.#relay.origin, this.#fetch);
    if (seq !== this.#enrollSeq || this.#disposed) {
      throw new Error('This enrollment was cancelled.');
    }
    // Enrolled, or redeeming another code, while this one was asked for.
    this.#refuseEnrolled();
    if (this.#enrollRun?.redeeming) return this.#hostedEnrollmentState()!;
    const verificationUrl = enrollVerificationUrl(this.#relay, begin);
    const now = this.#now();
    const wait = Math.min(
      Math.max(begin.expiresAt - now, HOSTED_ENROLLMENT_MIN_WAIT_MS),
      HOSTED_ENROLLMENT_MAX_WAIT_MS,
    );
    const run: HostedEnrollmentRun = {
      deviceCode: begin.deviceCode,
      noiseStatic,
      label,
      userCode: begin.userCode,
      verificationUrl,
      expiresAt: now + wait,
      intervalMs: begin.interval * 1000,
      accountFull: false,
      redeeming: false,
      timer: null,
    };
    this.#clearEnrollRun();
    this.#enrollEnded = null;
    this.#enrollRun = run;
    this.#accountOrigin = new URL(verificationUrl).origin;
    this.#schedulePoll(run);
    this.#emitStatus();
    return this.#hostedEnrollmentState()!;
  }

  /** What `enroll` and `enrollOffer` answer in a Hosted build: the account this build approves codes at. */
  #hostedEnrollmentRefusal(): string {
    return hostedEnrollmentRefusal(accountOriginFor(this.#relay, this.#accountOrigin) ?? HOSTED_ACCOUNT_ORIGIN);
  }

  /** What a begin on an enrolled machine answers: a second enrollment would replace the first. */
  #refuseEnrolled(): void {
    if (this.#enrollment) {
      throw new Error(
        `This computer is already enrolled as Burrow ${this.#enrollment.burrowId}. Disconnect it to enroll again.`,
      );
    }
  }

  /**
   * Stop the enrollment waiting or ended, and say so; a begin in flight keeps
   * nothing. **A redeeming one is left to land**: its credential is spent.
   * Cancel stops future polls, but a poll already out that redeems is still
   * held ({@link #redeemHostedEnrollment}).
   */
  #cancelHostedEnrollment(): Record<string, never> {
    this.#enrollSeq++;
    this.#enrollBegin = null;
    const run = this.#enrollRun && !this.#enrollRun.redeeming ? this.#enrollRun : null;
    const had = run !== null || this.#enrollEnded !== null;
    if (run) this.#clearEnrollRun();
    this.#enrollEnded = null;
    if (had) this.#emitStatus();
    return {};
  }

  /** At disposal: forget every Hosted enrollment, unannounced, and void a begin in flight. */
  #stopHostedEnrollment(): void {
    this.#enrollSeq++;
    this.#enrollBegin = null;
    this.#clearEnrollRun();
    this.#enrollEnded = null;
  }

  #clearEnrollRun(): void {
    if (this.#enrollRun?.timer) clearTimeout(this.#enrollRun.timer);
    this.#enrollRun = null;
  }

  /** The next poll after `run.intervalMs`, or at the deadline if that comes first. */
  #schedulePoll(run: HostedEnrollmentRun): void {
    const delay = Math.max(0, Math.min(run.intervalMs, run.expiresAt - this.#now()));
    run.timer = setTimeout(() => void this.#pollHostedEnrollment(run), delay);
  }

  async #pollHostedEnrollment(run: HostedEnrollmentRun): Promise<void> {
    run.timer = null;
    if (this.#enrollRun !== run) return;
    if (this.#now() >= run.expiresAt) {
      this.#endHostedEnrollment(run, { reason: 'expired' });
      return;
    }
    const answer = await pollHostedEnrollment(
      this.#relay.origin,
      run.deviceCode,
      run.label,
      run.noiseStatic,
      this.#fetch,
    );
    // Held whatever happened while the poll was out: see the method.
    if (answer.status === 'enrolled') {
      await this.#redeemHostedEnrollment(run, answer.enrollment);
      return;
    }
    if (this.#enrollRun !== run) return;
    switch (answer.status) {
      case 'pending':
        this.#setAccountFull(run, false);
        this.#schedulePoll(run);
        return;
      case 'retry':
        if (answer.slowDown) {
          run.intervalMs = Math.min(
            run.intervalMs + HOSTED_ENROLLMENT_SLOW_DOWN_MS,
            MAX_ENROLL_POLL_INTERVAL_S * 1000,
          );
        }
        this.#schedulePoll(run);
        return;
      case 'expired':
        this.#endHostedEnrollment(run, { reason: 'expired' });
        return;
      // An earlier poll redeemed it and its answer was lost on the way.
      case 'redeemed':
        this.#endHostedEnrollment(run, { reason: 'answer-lost', burrowId: answer.burrowId });
        return;
      // The Relay keeps an approval it refused, so a full account polls on
      // and enrolls once a computer is removed; an entitlement ends it.
      case 'refused':
        if (answer.reason === 'account-full') {
          this.#setAccountFull(run, true);
          this.#schedulePoll(run);
        } else {
          this.#endHostedEnrollment(run, { reason: answer.reason });
        }
        return;
      case 'failed':
        this.#endHostedEnrollment(run, { reason: 'failed', message: answer.message });
        return;
    }
  }

  /**
   * Hold an enrollment a poll of `run` redeemed. **Single-use, and recorded by
   * the Relay**, so it is held even when `run` was cancelled or replaced while
   * the poll was out; `run`, if still current, reports `redeeming` until the
   * save-and-start on the lifecycle chain finishes. Only an enrolled machine or
   * a disposed service cannot hold it, and a failure to — either of those, the
   * origin check, or the save — ends every enrollment with a sentence naming
   * the Burrow the account must remove (a console warning once disposed,
   * there being nothing left to show it).
   */
  async #redeemHostedEnrollment(run: HostedEnrollmentRun, enrollment: BurrowEnrollment): Promise<void> {
    if (this.#enrollRun === run) {
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
      run.redeeming = true;
      this.#emitStatus();
    }
    const stranded =
      `Your account holds Burrow ${enrollment.burrowId}, which this computer could not keep; ` +
      `remove it at ${new URL(run.verificationUrl).origin}${ACCOUNT_PAGE_PATH}.`;
    let saved = false;
    try {
      await this.#serialize(async () => {
        if (this.#disposed) throw new Error('Dormouse closed before it could save the enrollment.');
        if (this.#enrollment) {
          throw new Error(
            `This computer was already enrolled as Burrow ${this.#enrollment.burrowId} when another code was approved.`,
          );
        }
        await this.#adoptEnrollment(enrollment, undefined, () => {
          saved = true;
          // Retain the persisted identity even if startup's ACL read fails.
          this.#enrollment = enrollment;
        });
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = saved
        ? `${detail} This computer saved its enrollment; restart Dormouse to try connecting again.`
        : `${detail} ${stranded}`;
      if (this.#disposed) {
        console.warn(`[burrow] ${message}`);
        return;
      }
      // A redemption of another code still landing reports itself first.
      if (this.#enrollRun === run || !this.#enrollRun?.redeeming) {
        this.#enrollSeq++;
        this.#clearEnrollRun();
      }
      this.#enrollEnded = { reason: 'failed', message };
      this.#emitStatus();
      return;
    }
    // Enrolled: whatever code is still waiting — a replacing begin's — is moot.
    this.#enrollSeq++;
    this.#clearEnrollRun();
    this.#emitStatus();
  }

  #setAccountFull(run: HostedEnrollmentRun, full: boolean): void {
    if (run.accountFull === full) return;
    run.accountFull = full;
    this.#emitStatus();
  }

  /** End `run` short of enrolling, if it is still the one waiting. */
  #endHostedEnrollment(run: HostedEnrollmentRun, ended: HostedEnrollmentEnded): void {
    if (this.#enrollRun !== run) return;
    this.#clearEnrollRun();
    this.#enrollEnded = ended;
    this.#emitStatus();
  }

  /** What `status` reports of the Hosted enrollment: never its device code. */
  #hostedEnrollmentState(): HostedEnrollmentState | null {
    const run = this.#enrollRun;
    if (run?.redeeming) return { status: 'redeeming' };
    if (run) {
      return {
        status: 'waiting',
        userCode: run.userCode,
        verificationUrl: run.verificationUrl,
        expiresAt: run.expiresAt,
        accountFull: run.accountFull,
      };
    }
    return this.#enrollEnded ? { status: 'ended', ...this.#enrollEnded } : null;
  }

  /**
   * **Every await comes first; the snapshot is built after the last suspension
   * point.** A seed `status` that started while un-enrolled can be sitting in
   * the offer-file read when an enroll completes, and the webview's gate is
   * last-writer-wins over the `{ enrolled: true }` event — so a snapshot
   * assembled from an `#enrollment` sampled *before* the read would disarm that
   * gate for a poll interval (`lib/src/remote/burrow/enrolled-gate.ts`). Reading
   * `#enrollment` only below the read makes the answer name whichever
   * enrollment exists when the answer is made.
   *
   * The read itself is still skipped while enrolled — an enrolled Burrow has
   * nothing to offer, so the 2 s poll must not stat a file every tick.
   */
  async #status(): Promise<BurrowConsoleStatus> {
    const offer = this.#enrollment ? null : await readUsableOffer(this.#relay, this.#readOffer);
    const enrollment = this.#enrollment;
    const hostedEnrollment = this.#hostedEnrollmentState();
    const accountOrigin = accountOriginFor(this.#relay, this.#accountOrigin);
    if (!enrollment) {
      return unenrolledStatus(offer, this.#kind, this.#relay, this.#serving(), hostedEnrollment, accountOrigin);
    }
    return {
      enrolled: true,
      serving: this.#serving(),
      relayOrigin: this.#relay.origin,
      relayMode: this.#relay.mode,
      burrowId: enrollment.burrowId,
      connection: this.#burrow?.status ?? 'stopped',
      pairedClients: this.#burrow?.activeRecords.length ?? 0,
      suggestedLabel: suggestedBurrowLabel(this.#kind),
      offer: false,
      hostedEnrollment,
      accountOrigin,
    };
  }

  /**
   * Re-open the relay socket now. The only way back from a latched state
   * (`BurrowLatch`): a latched Burrow stands down for good — rather than
   * fighting the Burrow that replaced it, or retrying a token its Relay
   * refuses — so returning has to be asked for.
   *
   * Only the restart takes the lifecycle lease. The status snapshot after it is
   * a plain read — one that may touch the disk for the offer file — and holding
   * the lease across it would queue every enroll/clear behind that read.
   */
  async #reconnect(): Promise<BurrowConsoleStatus> {
    await this.#serialize(async () => {
      if (this.#burrow) this.#burrow.start();
      else await this.#start();
    });
    return this.#status();
  }

  async #clearEnrollment(): Promise<Record<string, never>> {
    // The delete first, and nothing else unless it succeeded. Stopping and
    // forgetting the Burrow ahead of it would report un-enrolled while the
    // credential was still on disk, and the next launch would read it back and
    // let every paired device in again — an un-enrollment the user believes
    // happened is the one thing this command must not get wrong.
    //
    // ACL records stay keyed by their burrowId. They are unreachable without an
    // enrollment naming that burrow, and keeping them means a re-enrollment onto
    // the same burrowId does not silently de-pair every device.
    await this.#store.clearEnrollment();
    this.#stopBurrow();
    this.#enrollment = null;
    this.#emitStatus();
    return {};
  }

  /**
   * Compose this machine's pairing QR: the Relay's single-use setup token,
   * minted over the Burrow's own authenticated channel because this service is
   * the half that holds the bearer, plus an invitation the `BurrowRuntime` mints
   * locally — an id and a one-use X25519 responder key the Relay never sees.
   *
   * The URL is composed here, from the origin this Burrow enrolled against, for
   * the reason `SetupTokenResponse` carries the token alone: a URL minted
   * server-side would be one more place the deployment's own address is decided.
   */
  async #setupQr(): Promise<SetupQrResult> {
    const enrollment = this.#enrollment;
    const burrow = this.#burrow;
    if (!enrollment || !burrow || relayRefuses(burrow.status)) throw await this.#notConnected();
    const response = await burrowFetch(
      { enrollment, fetch: this.#fetch, errorPrefix: 'could not mint a setup code' },
      API_ROUTES.burrowSetupToken,
      // The empty POST body: this endpoint's only input is the bearer, which is
      // what says which Burrow is asking.
      {},
    );
    const body: unknown = await response.json().catch(() => null);
    // Guarded like every other 200 off this wire: an `undefined` token would go
    // into the QR, and an unbounded one throws inside the encoder.
    if (!isSetupTokenResponse(body)) {
      throw new Error('could not mint a setup code: the Relay’s answer was not a setup token.');
    }
    // The Burrow captured above, not whatever `#burrow` holds now: a swap during the
    // round trip means this code belongs to the Relay we just left, so it is
    // dropped rather than minted onto the replacement — which could not verify
    // it anyway, and whose panel must not paint a code for the old Relay.
    if (this.#burrow !== burrow) {
      throw new Error(
        'could not mint a setup code: this machine reconnected to a different Relay.',
      );
    }
    // The invitation, and the half that makes the ceremony unforgeable by the
    // Relay: its private key exists only in this Burrow's memory, and a phone
    // completing IK against the public half has proved it is talking to the
    // machine whose screen it photographed.
    const invitation = await burrow.mintInvitation(body.token, body.expiresAt);
    // `enrollment.origin` is the phone-facing WebAuthn origin — where Pocket is
    // served and where the passkey will be registered — which enrollment checked
    // equals this build's relay origin. The formatter refuses a URL too long to
    // scan before any encoder sees it.
    return {
      url: formatPairingInvitationUrl(enrollment.origin, invitation),
      inviteId: invitation.inviteId,
      // The invitation's own expiry, which is never later than the token's.
      expiresAt: invitation.expiry * 1000,
    };
  }

  async #approve(params: ApproveParams): Promise<Record<string, never>> {
    // The code the person typed, straight through. The service never held the
    // expected one — the Burrow compares, once (`service-protocol.ts` →
    // `PairingQueueItem`); a one-time runtime spends its one attempt before it
    // looks at the digits.
    await this.#pendingRequest(params).approve(typeof params.code === 'string' ? params.code : '');
    return {};
  }

  #deny(params: DenyParams): Record<string, never> {
    this.#pendingRequest(params).deny();
    return {};
  }

  /**
   * Resolve an action only against the exact request its modal displayed — a
   * one-time request by its ticket alone, so a ticket from a link this service
   * has since replaced names nothing.
   */
  #pendingRequest(params: DenyParams): PendingPairing {
    const pending =
      approvalKind(params) === 'one-time'
        ? this.#oneTimeApproval?.pending
        : this.#pairings.get(params.clientId);
    if (!pending || pending.pairingId !== params.pairingId) {
      throw new Error('pairing request is no longer pending');
    }
    return pending;
  }

  // --- One-time connection ---

  /**
   * Open a one-time connection, answering the state the open settled at —
   * `waiting` with the link, or `ended`. **No parameters**: the origin is this
   * build's, never the webview's.
   *
   * An open in flight is joined, not replaced; a waiting, confirming, or ended
   * connection is replaced, and its link dies with it. **A connecting or
   * connected one is refused**: a phone holds it, and only End lets it go.
   */
  async #openOneTime(): Promise<OneTimeState> {
    const hosted = this.#hostedOrigin;
    if (hosted === null) {
      throw new Error(
        'One-time connections are unavailable in a self-host build: their links are made at ' +
          `Dormouse Hosted, and this build reaches only its own Relay (${this.#relay.origin}).`,
      );
    }
    await this.#networkPolicy();
    // Synchronous from here to the runtime's open: a `setNetworkPolicy` that
    // landed during the await is read here, since it ends only a live runtime,
    // and a second click that awaited the same read joins this one rather than
    // minting a second room.
    const policy = this.#refuseNothing();
    if (!opensOneTimeLinks(policy)) throw new Error(NO_NETWORK_ALLOWED_REFUSAL);
    const state = this.#oneTimeState;
    if (this.#oneTimeOpening) return this.#oneTimeOpening;
    if (state.status === 'connecting' || state.status === 'connected') {
      throw new Error(
        'A phone is already connected through a one-time link. End it before opening another.',
      );
    }
    const runtime: OneTimeRuntime = new OneTimeRuntime({
      origin: hosted,
      createWebSocket: this.#createWebSocket,
      createSession: (opts) => this.#createApiSession(opts),
      directPeering: directPeeringFor(policy, this.#createDirectPeer),
      // The name the phone shows: the one this machine enrolled under, else the
      // one the enrollment form would have suggested.
      burrowLabel: this.#enrollment?.label || suggestedBurrowLabel(this.#kind),
      requestApproval: (request) => this.#requestOneTimeApproval(runtime, request),
      dismissApproval: () => this.#dismissOneTimeApproval(runtime),
      onChange: (next) => this.#onOneTimeChanged(runtime, next),
      onPathRefused: (refusal) => this.#recordPathRefusal(refusal),
      now: this.#now,
    });
    // Swapped in before either runtime moves: the one being replaced ends
    // unannounced, and this one's first state is the next the webviews hear.
    const replaced = this.#oneTime;
    this.#oneTime = runtime;
    replaced?.end('user-ended');
    const opening = runtime.open();
    this.#oneTimeOpening = opening;
    try {
      return await opening;
    } finally {
      if (this.#oneTimeOpening === opening) this.#oneTimeOpening = null;
    }
  }

  /**
   * End the live one-time connection (`ended`, `user-ended`) — the panel's End
   * and Cancel — or put an ended one back to `idle`, its Done. Never reached
   * under `nothing`, whose change rests an ended one at once (`#restOneTime`).
   */
  #endOneTime(): Record<string, never> {
    if (this.#oneTime) this.#oneTime.end('user-ended');
    else if (this.#oneTimeState.status === 'ended') this.#setOneTimeState({ status: 'idle' });
    return {};
  }

  /**
   * Put a one-time connection that is not live at rest under the policy as it
   * stands, announcing only a change. A live one is its runtime's to move.
   */
  #restOneTime(): void {
    if (this.#oneTime) return;
    const resting = idleOneTimeState(this.#hostedOrigin, this.#level());
    const state = this.#oneTimeState;
    const reason = (value: OneTimeState) => ('reason' in value ? value.reason : null);
    if (state.status === resting.status && reason(state) === reason(resting)) return;
    this.#setOneTimeState(resting);
  }

  // --- Network policy ---

  /**
   * The policy, read once and then kept: this service is its only writer
   * (`#setNetworkPolicy`). **A read that fails rejects**, every caller fails
   * closed on it, and the next call reads again.
   */
  #networkPolicy(): Promise<NetworkPolicy> {
    if (this.#policy) return Promise.resolve(this.#policy);
    // Held before any reader resumes; a `setNetworkPolicy` joins this read
    // for its `previous`, so none can land first.
    this.#policyRead ??= peekNetworkPolicyFor(this.#store, this.#relay)
      .then(async ({ policy, stored }) => {
        // The default is saved at once, so it never flips later.
        if (!stored) await this.#store.saveNetworkPolicy(policy);
        this.#policy = policy;
        this.#restOneTime();
        return policy;
      })
      .finally(() => {
        this.#policyRead = null;
      });
    return this.#policyRead;
  }

  /** The level as it stands: `nothing` until the policy has been read, and for good once disposed. */
  #level(): NetworkLevel {
    return this.#disposed ? 'nothing' : (this.#policy?.level ?? 'nothing');
  }

  /** The level once the policy has been read — `nothing` for a read that fails. */
  async #settledLevel(): Promise<NetworkLevel> {
    await this.#networkPolicy().catch(() => {});
    return this.#level();
  }

  /**
   * Whether the policy lets this process reach Hosted on its own — managed
   * voice's check (`sidecar-entry.ts`): anything but `nothing`.
   */
  async networkAllowed(): Promise<boolean> {
    return (await this.#settledLevel()) !== 'nothing';
  }

  /**
   * Hold `params.policy` from now on (`docs/specs/remote-network.md` →
   * "Policy"). **Persisted first**: a save that fails changes nothing. A change
   * to the level, or to the allowed networks under Local networks, ends the
   * live one-time connection, `user-ended`, so a narrowed policy never leaves
   * an old path exempt; the allowed networks under any other level, and
   * `autoUpdate`, touch no connection. Then the relay socket follows the
   * level: stopped under one that runs no Burrow, the enrollment kept; started
   * under one that does ({@link runsBurrow}), and restarted on any change
   * {@link samePaths} sees, since a runtime holds its paths for its life.
   */
  async #setNetworkPolicy(params: SetNetworkPolicyParams | undefined): Promise<NetworkPolicyResult> {
    const next = requestedNetworkPolicy(params?.policy, this.#relay);
    // One that cannot be read is `nothing` here as everywhere, so the user's
    // choice can still be saved over it.
    const previous = await this.#networkPolicy().catch(() => nothingPolicy());
    await this.#store.saveNetworkPolicy(next);
    this.#policy = next;
    // Nothing polls nothing: an enrollment awaiting approval ends with the level.
    if (next.level === 'nothing') this.#cancelHostedEnrollment();
    if (!samePaths(previous, next)) {
      this.#oneTime?.end('user-ended');
      this.#restOneTime();
    }
    const result = this.#networkPolicyResult(next);
    try {
      // A running Burrow holds the paths it started under for its life
      // (`directPeeringFor`), so any change to them restarts it; its sessions
      // hear the goodbye as it stops.
      if (this.#burrow && (!runsBurrow(next.level) || !samePaths(previous, next))) {
        this.#stopBurrow();
        this.#emitStatus();
      }
      if (runsBurrow(next.level) && !this.#burrow) await this.#start();
    } finally {
      // Saved either way, so said either way: a start that failed is its own error.
      this.#emit({ name: 'network-policy', ...result });
    }
    return result;
  }

  /** What `networkPolicy` answers for `policy`: this build's levels, the interfaces now, and the refusal held. */
  #networkPolicyResult(policy: NetworkPolicy): NetworkPolicyResult {
    return networkPolicyResult(policy, this.#relay.mode, this.#listInterfaces(), this.#pathRefusal);
  }

  /** Hold `refusal` as the latest, and say so to every window. */
  #recordPathRefusal(refusal: PathRefusal): void {
    if (this.#disposed) return;
    this.#pathRefusal = refusal;
    if (this.#policy) this.#emit({ name: 'network-policy', ...this.#networkPolicyResult(this.#policy) });
  }

  /**
   * Forget the refusal held when Dismiss arrived — the panel's Dismiss — and
   * say so to every window. Captured before the policy read: one recorded
   * meanwhile is news the panel has not shown, and stays.
   */
  async #dismissPathRefusal(): Promise<NetworkPolicyResult> {
    const dismissing = this.#pathRefusal;
    const policy = await this.#networkPolicy();
    const cleared = dismissing !== null && this.#pathRefusal === dismissing;
    if (cleared) this.#pathRefusal = null;
    const result = this.#networkPolicyResult(policy);
    if (cleared) this.#emit({ name: 'network-policy', ...result });
    return result;
  }

  #onOneTimeChanged(runtime: OneTimeRuntime, state: OneTimeState): void {
    if (this.#oneTime !== runtime) return;
    // An ended runtime holds nothing more; its last state stays for the panel.
    if (state.status === 'ended') this.#oneTime = null;
    this.#setOneTimeState(state);
  }

  #setOneTimeState(state: OneTimeState): void {
    const wasServing = this.#serving();
    this.#oneTimeState = state;
    this.#emitOneTime();
    if (this.#serving() !== wasServing) this.#emitStatus();
  }

  #requestOneTimeApproval(runtime: OneTimeRuntime, request: OneTimeApprovalRequest): void {
    if (this.#oneTime !== runtime) return;
    this.#oneTimeApproval = {
      runtime,
      pending: {
        kind: 'one-time',
        clientId: '',
        // A fresh ticket per request, for the reason a pairing carries one: a
        // modal left open over a replaced link must answer nothing.
        pairingId: randomBase64Url(ONE_TIME_TICKET_BYTES),
        label: request.label,
        requestedAt: request.requestedAt,
        approve: (code) => request.approve(code),
        deny: () => request.deny(),
      },
    };
    this.#emitQueue();
  }

  #dismissOneTimeApproval(runtime: OneTimeRuntime): void {
    if (this.#oneTimeApproval?.runtime !== runtime) return;
    this.#oneTimeApproval = null;
    this.#emitQueue();
  }

  /**
   * One due alarm push, from the alert host in this same process — the
   * sidecar's, or VS Code's through `pushAlert` in `vscode-ext/src/burrow.ts`
   * (`docs/specs/alert.md` -> Push notifications). No Burrow means no ACL and
   * no Relay to post to, so nothing is sent. Never rejects: a push that fails is
   * logged, since a dead push must never break the alert path.
   */
  async push(sessionId: string, title: string): Promise<void> {
    const deps = this.#pushDeps();
    if (!deps) return;
    await sendPush(deps, sessionId, title).catch((error: unknown) => {
      console.warn('[burrow] push notification failed', error);
    });
  }

  /**
   * The Settings dialog's "Send test push".
   *
   * The inverse of {@link push} in the one way that matters: nothing is
   * swallowed. A test whose whole purpose is to report an outcome must let the
   * failure through, so an unenrolled machine, an unreachable Relay, and a
   * fan-out that reached nobody all read differently at the button.
   */
  async #pushTest(): Promise<PushSendSummary> {
    const deps = this.#pushDeps();
    if (!deps) throw await this.#notConnected();
    // A fixed tag, so pressing the button repeatedly replaces the notification
    // on the phone rather than stacking copies — the same per-Session collapse
    // rule the ring path uses, with the test as its own "Session".
    return await sendPush(deps, PUSH_TEST_TAG, PUSH_TEST_TITLE);
  }

  /** Why there is no Burrow to ask: the policy, or no enrollment. */
  async #notConnected(): Promise<Error> {
    return new Error(
      (await this.#settledLevel()) === 'nothing'
        ? NETWORK_OFF_REFUSAL
        : 'This machine is not connected to a Dormouse Relay.',
    );
  }

  async #pushDevices(): Promise<PushDevicesResult> {
    const deps = this.#pushDeps();
    if (!deps) return null;
    return { devices: await loadPushDevices(deps) };
  }

  // --- Burrow lifecycle ---

  /**
   * The Noise static gate. **A Burrow without a usable one does not start**, and
   * so reads as un-enrolled with the Settings dialog offering enrollment again —
   * that is the entire Burrow-state version
   * (`docs/specs/remote-security-model.md` → Burrow identity).
   *
   * Two cases, and they end differently on purpose:
   *
   * - **Absent** is an enrollment from before the field existed. Minting is
   *   never retried once it has failed, so a gate without this backfill would
   *   un-enroll a machine over one transient failure. The mint is persisted
   *   before the Burrow starts, so it survives the next launch.
   * - **Present but not corresponding** is a corrupt or hand-edited state file.
   *   Starting anyway would present a Burrow identity every paired Client reads as
   *   *changed*, which looks like a different machine rather than the local
   *   damage it is — so it stays down, loudly, naming the store.
   */
  async #enrolledWithNoiseStatic(enrollment: BurrowEnrollment): Promise<BurrowEnrollment | null> {
    const { noiseStaticPrivateKey, noiseStaticPublicKey } = enrollment;
    if (noiseStaticPrivateKey !== undefined && noiseStaticPublicKey !== undefined) {
      try {
        if ((await deriveNoiseStaticPublicKey(noiseStaticPrivateKey)) === noiseStaticPublicKey) {
          return enrollment;
        }
      } catch {
        // Falls through to the same refusal: a private half that will not import
        // is as unusable as one that names a different public point.
      }
      console.warn(
        `[burrow] the stored Noise static for ${enrollment.burrowId} does not match its public half; ` +
          'this machine\'s remote-control state is corrupt. Enroll again to replace it.',
      );
      return null;
    }
    let material;
    try {
      material = await mintNoiseStaticKeyPair();
    } catch (error) {
      console.warn('[burrow] could not mint this machine\'s Noise static key', error);
      return null;
    }
    const backfilled: BurrowEnrollment = {
      ...enrollment,
      noiseStaticPrivateKey: material.privateKeyPkcs8,
      noiseStaticPublicKey: material.publicKey,
    };
    // A disposed service saves nothing: a successor may already hold its own.
    if (this.#disposed) return null;
    // Persisted first, for the reason enrollment persists first: a Burrow running
    // on an identity no restart can recover is one every paired Client would
    // have to pair with again after a reboot.
    await this.#store.saveEnrollment(backfilled);
    return backfilled;
  }

  async #startBurrow(incoming: BurrowEnrollment): Promise<void> {
    if (this.#disposed) return;
    const enrollment = await this.#enrolledWithNoiseStatic(incoming);
    if (!enrollment || this.#disposed) return;
    // Never two. Callers are serialized (see `#serialize`), but a Burrow left in
    // `#burrow` here would be dropped without its socket being closed, so the
    // replacement is explicit rather than implied by the assignment below.
    this.#stopBurrow();
    // The one gate on the relay socket, and on everything that needs a running
    // Burrow — push, the device list, setup codes: under a level that runs
    // none, or before the policy is read, the enrollment is held and reported,
    // `stopped`, and nothing is opened. Disposal was checked just above.
    const policy = this.#policy;
    if (policy === null || !runsBurrow(policy.level)) {
      this.#enrollment = enrollment;
      return;
    }
    // Seed the synchronous ACL lookup before constructing. Approval awaits the
    // async store before publishing that record or telling the Client it paired.
    const records = await this.#store.loadAcl(enrollment.burrowId);
    // Deactivation can land during that store round trip. Disposal is terminal:
    // constructing here would leave a relay socket alive after its owner had
    // dropped the service and could no longer stop it.
    if (this.#disposed) return;
    this.#enrollment = enrollment;
    this.#burrow = new BurrowRuntime({
      enrollment,
      createWebSocket: this.#createWebSocket,
      directPeering: directPeeringFor(policy, this.#createDirectPeer),
      createSession: (opts) => this.#createApiSession(opts),
      loadAcl: () => records,
      saveAcl: (burrowId, next) => this.#store.saveAcl(burrowId, next),
      requestApproval: (pending) => this.#enqueuePairing({ ...pending, kind: 'pairing' }),
      dismissApproval: (clientId) => this.#resolvePairing(clientId),
      onInvitationChanged: (inviteId, state, outcome) =>
        this.#emitInvitation(inviteId, state, outcome),
      onPathRefused: (refusal) => this.#recordPathRefusal(refusal),
      probeStanding: () => probeBurrowStanding({ enrollment, fetch: this.#fetch }),
      now: this.#now,
    });
    this.#burrow.start();
    this.#emitStatus();
  }

  /**
   * The remote-api handler both runtimes serve an authorized session through,
   * under a fresh holder id: what a pane it sizes names it by, and what Take
   * back ends it by.
   */
  #createApiSession(context: RemoteApiSessionContext): RemoteApiSession {
    const holder = randomBase64Url(HOLDER_ID_BYTES);
    this.#holders.set(holder, context.end);
    return new RemoteApiSession({
      burrowId: context.burrowId,
      send: context.send,
      provider: this.#provider,
      holder: { id: holder, label: context.label, serviceId: this.#serviceId },
      onDispose: () => this.#holders.delete(holder),
    });
  }

  /**
   * A pane strip's Take back: end the session holding that pane's size, as its
   * runtime ends one — the goodbye, then the dispose, whose release re-fits the
   * pane (`docs/specs/remote-api.md` → "Size authority"). A one-time session's
   * end is End itself. Answers whether one was ended: a holder this service
   * does not know — ended already, or held under a broker that is gone — ends
   * nothing, and the pane clears its own strip.
   */
  #takeBack(params: TakeBackParams | undefined): TakeBackResult {
    const end = typeof params?.holder === 'string' ? this.#holders.get(params.holder) : undefined;
    end?.();
    return { ended: end !== undefined };
  }

  /** A running Burrow, or a one-time connection holding a socket or a session. */
  #serving(): boolean {
    return !!this.#burrow || oneTimeServing(this.#oneTimeState);
  }

  /**
   * Tell the webviews whether there is a Burrow at all, and whether anything can
   * reach this machine's terminals. Everything they do *for* one — announcing
   * that the directory may have changed on every pane-state, activity, and focus
   * change — costs a crossing per event on a machine that may never enroll, so
   * they arm on this and idle without it
   * (`lib/src/remote/burrow/enrolled-gate.ts`). Sent when either field may
   * have changed, and once as this instance starts, for its `serviceId`.
   *
   * Both fields mean the same thing as the `status` command's fields of those
   * names, which is how a webview seeds before any event arrives.
   */
  #emitStatus(): void {
    this.#emit(this.statusEvent());
  }

  /**
   * The status event as it stands, for a UI that arrived after the last change
   * and so has no event coming (`vscode-ext/src/burrow.ts` greets a window
   * that joins the broker with it).
   */
  statusEvent(): BurrowStatusEvent {
    return {
      name: 'status',
      enrolled: !!this.#enrollment,
      serving: this.#serving(),
      serviceId: this.#serviceId,
    };
  }

  /** The one-time event as it stands, for the same late arrival as {@link statusEvent}. */
  oneTimeEvent(): OneTimeEvent {
    return { name: 'one-time', state: this.#oneTimeState };
  }

  #emitOneTime(): void {
    this.#emit(this.oneTimeEvent());
  }

  /** Every `burrow:event`; nothing is said once disposed. */
  #emit(event: BurrowUiEvent): void {
    if (this.#disposed) return;
    this.#sendToUi(BURROW_EVENT_EVENT, event);
  }

  #stopBurrow(): void {
    this.#burrow?.stop();
    // Invitations go with it: their one-use keys live on the `BurrowRuntime`
    // precisely so a code the old Relay's QR carried cannot complete a
    // handshake against the new one.
    this.#burrow = null;
    // `stop()` dismisses every in-flight pairing, which empties the queue and
    // pushes the empty snapshot; clear defensively in case there was no Burrow.
    if (this.#pairings.size > 0) {
      this.#pairings.clear();
      this.#emitQueue();
    }
  }

  // --- Pairing queue ---

  #enqueuePairing(pending: PendingPairing): void {
    // Bounded, like the controller's own map: this one is mirrored to the
    // webview in full on every change, so an unbounded queue costs quadratic
    // bridge traffic on top of the memory. `BurrowRuntime` evicts on its side too;
    // both are capped because either can be fed independently, and a cap that
    // only one of them honors is not a cap.
    while (this.#pairings.size >= MAX_PENDING_PAIRINGS) {
      const oldest = this.#pairings.keys().next();
      if (oldest.done) break;
      this.#pairings.delete(oldest.value);
    }
    // Coalesce by clientId: a re-sent pair for the same client replaces the old.
    this.#pairings.set(pending.clientId, pending);
    this.#emitQueue();
  }

  #resolvePairing(clientId: string): void {
    if (!this.#pairings.delete(clientId)) return;
    this.#emitQueue();
  }

  #queueSnapshot(): PairingQueueItem[] {
    const pending = [...this.#pairings.values()];
    // The one-time request last: the modal shows the head, and pairings that
    // were already waiting keep their order.
    if (this.#oneTimeApproval) pending.push(this.#oneTimeApproval.pending);
    // Field by field, never a spread: the pending pairing the Burrow handed us
    // carries the approve/deny closures, and a spread would try to serialize
    // them across the bridge. Naming the five is what keeps this projection the
    // whole of what a webview learns.
    return pending.map(({ kind, clientId, pairingId, label, requestedAt }) => ({
      kind,
      clientId,
      pairingId,
      label,
      requestedAt,
    }));
  }

  /**
   * Announce that an invitation a Settings panel may be displaying changed
   * state, naming it so a panel showing a *different* code stays live.
   */
  #emitInvitation(inviteId: string, state: InvitationState, outcome?: PairingOutcome): void {
    this.#emit({
      name: 'invitation',
      inviteId,
      state,
      // Spread rather than always set: this crosses a JSON bridge, and an
      // explicit `outcome: undefined` is a key the VS Code side would drop and
      // the Tauri side would keep, leaving the two hosts sending different
      // events for the same retirement.
      ...(outcome ? { outcome } : {}),
    } satisfies InvitationEvent);
  }

  #emitQueue(): void {
    this.#emit({
      name: 'pairing-queue',
      queue: this.#queueSnapshot(),
    } satisfies PairingQueueEvent);
  }

  /**
   * Push delivery needs a live Burrow its Relay still takes: the ACL it reads
   * is the running one's.
   * **Its fetch asks again at the request**: sealing awaits, and a Burrow
   * stopped meanwhile — Nothing, a clear, a swap — sends nothing.
   */
  #pushDeps(): AlertPushDeps | null {
    const burrow = this.#burrow;
    const enrollment = this.#enrollment;
    if (!burrow || !enrollment || relayRefuses(burrow.status)) return null;
    return {
      enrollment,
      activeRecords: () => burrow.activeRecords,
      seal: (clientStaticPublicKey, plaintext) =>
        burrow.sealPushForClient(clientStaticPublicKey, plaintext),
      fetch: (input, init) =>
        this.#burrow === burrow
          ? this.#fetch(input, init)
          : Promise.reject(new Error('the Burrow stopped before the request was sent')),
    };
  }
}
