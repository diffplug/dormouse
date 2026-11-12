import { createAlertEpisode, type AlertEpisode } from './alert-episode';
import { QuiesceDetector, type QuiesceStatus } from './quiesce-detector';
import { cfg } from '../cfg';
import { inputCanStartWork } from './terminal-report-filter';
import {
  commandWatchKey,
  resolveCommandStart,
  watchRuleFor,
  DEFAULT_COMMAND_TITLE,
  type TerminalSemanticEvent,
} from './terminal-state';

/**
 * The public Activity status: the detector's own states when WATCHING is on,
 * plus the manager-level projections (`docs/specs/alert.md` -> Public State).
 */
export type SessionStatus =
  | QuiesceStatus
  | 'WATCHING_DISABLED'
  | 'ALERT_RINGING'
  | 'OSC_NOTIF_BUSY'
  | 'COMMAND_EXIT_ARMED';

export const ACTIVITY_NOTIFICATION_SOURCES = ['OSC 9', 'OSC 9;4', 'OSC 99', 'OSC 777', 'BEL', 'COMMAND_EXIT', 'WATCHING'] as const;
export type ActivityNotificationSource = typeof ACTIVITY_NOTIFICATION_SOURCES[number];

export interface ActivityNotification {
  source: ActivityNotificationSource;
  title: string | null;
  body: string | null;
}

/**
 * How much a notification says, by its source (`docs/specs/alert.md` ->
 * Clearing And TODO). Read through `richer`, never compared by hand.
 */
const DETAIL_RANK: Record<ActivityNotificationSource, number> = {
  'OSC 9': 4,
  'OSC 99': 4,
  'OSC 777': 4,
  COMMAND_EXIT: 3,
  'OSC 9;4': 2,
  WATCHING: 1,
  BEL: 0,
};

/** `next`, unless `current` says more: at equal rank the later call wins. */
function richer(current: ActivityNotification | null, next: ActivityNotification): ActivityNotification {
  return current !== null && DETAIL_RANK[current.source] > DETAIL_RANK[next.source] ? current : next;
}

export type ProtocolProgressState = 'clear' | 'normal' | 'warning' | 'indeterminate' | 'error';

export interface ProtocolProgressUpdate {
  state: ProtocolProgressState;
  percent: number | null;
}

type ActiveProtocolProgressState = 'normal' | 'warning' | 'indeterminate';

interface ActiveProtocolProgress {
  state: ActiveProtocolProgressState;
  percent: number | null;
  /** Set once the program has ended the cycle, until that end counts. */
  end: PendingProgressEnd | null;
}

/** How a progress cycle ended. */
type ProgressOutcome = 'complete' | 'warning' | 'error';

/** A cycle's end, waiting out `cfg.alert.progressEndGrace` to see if it was one. */
interface PendingProgressEnd {
  outcome: ProgressOutcome;
  percent: number | null;
  timer: ReturnType<typeof setTimeout>;
}

/** A progress title by outcome: after the running command, or on its own. */
const PROGRESS_TITLES: Record<ProgressOutcome, { afterCommand: string; alone: string }> = {
  complete: { afterCommand: 'finished', alone: 'Progress complete' },
  warning: { afterCommand: 'finished with a warning', alone: 'Progress warning' },
  error: { afterCommand: 'reported an error', alone: 'Progress error' },
};

/** What raised a ring: a watched settle, a terminal report, or a command exit. */
type RingSource = 'watching' | 'report' | 'exit';

/** A source `SourceSet.sources` lists; `watching` carries state of its own. */
type ListedRingSource = Exclude<RingSource, 'watching'>;

/** The listed sources in escalation order: a report last, so it joins the
 *  ring an exit opened rather than opening one the exit then joins. */
const LISTED_RING_SOURCES: readonly ListedRingSource[] = ['exit', 'report'];

/** The `watching` source: the rule key that raised it, and whether work has
 *  arrived since it joined, which the detector cannot tell
 *  (`docs/specs/alert.md` -> Await). */
interface WatchingSource {
  key: string;
  workSince: boolean;
}

/** The sources a ring holds, or held completions would raise. */
interface SourceSet {
  sources: ListedRingSource[];
  /** Removing the rule that covers its key withdraws it. */
  watching: WatchingSource | null;
}

function addSource(set: SourceSet, source: ListedRingSource | WatchingSource): void {
  if (typeof source !== 'string') set.watching = source;
  else if (!set.sources.includes(source)) set.sources.push(source);
}

/** Every source a set holds: `watching` first, then the escalation order. */
function eachSource(set: SourceSet, visit: (source: ListedRingSource | WatchingSource) => void): void {
  if (set.watching !== null) visit(set.watching);
  for (const source of LISTED_RING_SOURCES) {
    if (set.sources.includes(source)) visit(source);
  }
}

/** Take `watching` off a set. Returns whether that left it empty. */
function dropWatching(set: SourceSet): boolean {
  set.watching = null;
  return set.sources.length === 0;
}

/** The one ring latch a Session holds (`docs/specs/alert.md` -> Public State). */
interface Ring extends SourceSet {
  episode: AlertEpisode;
  /** What it shows, and what the TODO a look turns it into keeps. */
  detail: ActivityNotification;
}

/**
 * Completions the user was looking at when they happened, already shown as
 * TODO (`docs/specs/alert.md` -> Completion events): the sources they would
 * raise if the user goes idle or leaves the host, and the richest detail among them.
 */
interface HeldCompletion extends SourceSet {
  detail: ActivityNotification;
}

interface CommandExitWatch {
  displayCommand: string;
  /** `commandWatchKey` of the command line; null without one to key on. */
  watchKey: string | null;
  /** Engaged at its start, or engaged or acknowledged since: its exit may ring. */
  seen: boolean;
}

/** One renderer realm's report (`docs/specs/alert.md` -> Engagement). */
export interface Engagement {
  present: boolean;
  /** The terminal Session this viewer points at, or null. */
  focusId: string | null;
}

/** Why a viewer stopped being present: its inactivity timeout ran out
 *  (`idle`), or its window blurred, hid, or ended (`leave`). */
export type EngagementLapse = 'idle' | 'leave';

export function normalizeActivityNotification(value: unknown): ActivityNotification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(ACTIVITY_NOTIFICATION_SOURCES as readonly string[]).includes(record.source as string)) return null;

  const title = normalizeNotificationTextField(record.title);
  const body = normalizeNotificationTextField(record.body);
  if (!title && !body) return null;
  return {
    source: record.source as ActivityNotificationSource,
    title,
    body,
  };
}

function normalizeNotificationTextField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A Session finished something. Dispatched before any suppression or ring decision. */
export type CompletionEvent =
  | { kind: 'settled' }
  | {
      kind: 'commandFinished';
      displayCommand: string;
      exitCode: number | undefined;
      /** The run was seen: engaged at its start, or engaged or acknowledged since. */
      seen: boolean;
    }
  | { kind: 'notification'; notification: ActivityNotification };

/** Return true to claim the event. A claimed event never reaches the ring rules. */
export type CompletionClaimant = (event: CompletionEvent) => boolean;

/** How much evidence of completion a parked `dor await` will accept. */
export type AwaitUntil = 'quiet' | 'exit';

/** Why a resolved await stopped waiting. */
export type AwaitCause = 'quiet' | 'exit' | 'bell' | 'idle';

export type AwaitOutcome =
  | { kind: 'resolved'; cause: AwaitCause; waitedMs: number }
  | { kind: 'timeout'; waitedMs: number }
  /** The Session's PTY exited, or the Session was removed, before it finished. */
  | { kind: 'died'; waitedMs: number }
  /** `cancel()` was called — or the manager was disposed — before anything else settled it. */
  | { kind: 'cancelled'; waitedMs: number };

export interface AwaitOptions {
  until: AwaitUntil;
  /**
   * Ceiling on the wait. Enforced here, in the host, so no intermediate hop can
   * reap a parked await early and no caller can park forever.
   */
  timeoutMs: number;
}

export interface AwaitHandle {
  promise: Promise<AwaitOutcome>;
  cancel(): void;
}

/** Detector floor for reaching BUSY; prevents a pre-output false idle. */
export const AWAIT_GRACE_MS = cfg.alert.busyCandidateGap + cfg.alert.busyConfirmGap;

/** Host-side cap below `setTimeout`'s signed-32-bit overflow boundary. */
export const MAX_AWAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** One parked await. Owned by the `AlertManager`; see `awaitCompletion`. */
interface AwaitWaiter {
  /** Offer one completion. Returns whether this waiter woke on it. */
  offer(event: CompletionEvent): boolean;
  /** The Session produced output (cancels a `quiet` grace window). */
  onOutput(): void;
  /** A foreground command started (cancels an `exit` grace window). */
  onCommandStart(): void;
  /** The Session's PTY exited or the Session was removed. */
  die(): void;
  cancel(): void;
}

/** Every await parked on one Session, plus the single claimant they share. */
interface AwaitGroup {
  waiters: Set<AwaitWaiter>;
  unregister: () => void;
}

export interface AlertState {
  /** The unresolved summons' delivery identity. */
  episode: AlertEpisode | null;
  status: SessionStatus;
  watchingEnabled: boolean;
  /** Set by a look at a ring or by hand, never by a ring opening. */
  todo: boolean;
  /** The ring's detail while ringing, else the TODO's. */
  notification: ActivityNotification | null;
  /** At least one `dor await` is parked on this Session. Never persisted. */
  awaited: boolean;
}

export const DEFAULT_ALERT_STATE: AlertState = {
  episode: null,
  status: 'WATCHING_DISABLED',
  watchingEnabled: false,
  todo: false,
  notification: null,
  awaited: false,
};

/** One ring latch fed by three sources, an independent progress cycle, and an
 * always-on, non-latching detector. WATCHING gates detector projection. */
interface AlertEntry {
  /** Always-on output/silence detector. Never disposed before the entry is. */
  detector: QuiesceDetector;
  ring: Ring | null;
  /**
   * Until this instant, a user verb cleared a ring or a hold and no output has
   * arrived since, so a report describes the state the user already
   * acknowledged (`holdOrDeliver`). Opening a ring or starting a command
   * forgets it (0), so it implies no ring. Bounded in time because output
   * counts as work only near input: a program that reports on its own
   * schedule would otherwise never ring again after one acknowledgement.
   */
  ackedUntil: number;
  /** The live `OSC 9;4` cycle. Never touches the ring, and the ring never touches it. */
  progress: ActiveProtocolProgress | null;
  commandExitWatch: CommandExitWatch | null;
  pendingCommandLine: string | null;
  todo: boolean;
  /** The TODO's detail: null without one. A ring shows its own instead. */
  notification: ActivityNotification | null;
  /** Completions withheld while engaged, already shown as TODO: rung if the user goes idle or leaves the host (`setViewer`), dropped if focus moves on. */
  held: HeldCompletion | null;
  /** Pending while the viewer that held it has left, until the host shows whether the user is still here. */
  leaveGrace: ReturnType<typeof setTimeout> | null;
  /** Output and completions before this instant answer the user's own input (`acknowledge`). */
  echoUntil: number;
}

/** Portable Session Activity manager. `dispatchCompletion` is the single
 * observe→claim→ring seam, so await can claim completions before suppression. */
export class AlertManager {
  private entries = new Map<string, AlertEntry>();
  /** Blocks anything the killed generation still emits from recreating a
   * removed entry. Only `restart` — a new PTY generation — clears one. */
  private removed = new Set<string>();
  private claimants = new Map<string, Set<CompletionClaimant>>();
  private awaits = new Map<string, AwaitGroup>();
  /** Each present viewer's focus. An absent viewer engages nothing, so it is not kept. */
  private viewers = new Map<string, string | null>();
  private listeners = new Set<(id: string, state: AlertState) => void>();
  private removeListeners = new Set<(id: string) => void>();
  private lastEmitted = new Map<string, AlertState>();
  private watchedCommands = new Set<string>();
  /** Helper Sessions alert no one until promotion (docs/specs/alert.md → Pane
   *  Header). They still build command state and feed the detector, so one
   *  promoted mid-command knows what it is running; everything else — reports,
   *  controls, awaits, completion dispatch, publishing — drops them, so a host
   *  marks the id once instead of guarding each call. */
  private helpers = new Set<string>();

  setHelper(id: string, helper: boolean): void {
    if (helper) this.helpers.add(id);
    else this.helpers.delete(id);
    // Promotion publishes the state the helper built up — nothing that was
    // suppressed, since a helper's completions were never kept. A failed
    // placement's demotion takes back whatever the Session had published.
    if (this.entries.has(id)) this.notify(id);
  }

  // --- State change subscription ---

  onStateChange(listener: (id: string, state: AlertState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A Session gone for good: every `remove`, whatever state it left, and never
   * a `restart`, whose Session goes on under the same id.
   */
  onRemove(listener: (id: string) => void): () => void {
    this.removeListeners.add(listener);
    return () => this.removeListeners.delete(listener);
  }

  // --- Feed PTY events ---

  onData(id: string): void {
    // The detector runs for every Session, including one that has never
    // produced a semantic or protocol event, so output creates the entry.
    const entry = this.streamEntry(id);
    if (!entry) return;
    // The echo of the user's own keystroke is not the program working.
    if (this.inEchoWindow(entry)) return;
    if (entry.detector.onData()) this.noteWork(id, entry);
  }

  /**
   * The program worked — output counted, or it announced progress: a settle
   * the ring or hold carries no longer describes it, the acknowledged state
   * is over, and an await's grace has its answer.
   */
  private noteWork(id: string, entry: AlertEntry): void {
    if (entry.ring?.watching) entry.ring.watching.workSince = true;
    if (entry.held?.watching) entry.held.watching.workSince = true;
    entry.ackedUntil = 0;
    this.eachWaiter(id, (waiter) => waiter.onOutput());
  }

  onExit(id: string, exitCode?: number): void {
    const entry = this.entries.get(id);
    if (entry && this.finishCommandExitWatch(id, entry, exitCode)) this.notify(id);
    // The command-exit dispatch above already resolved anything waiting on the
    // run that just ended; whatever is still parked is waiting on a Session
    // that no longer exists.
    this.eachWaiter(id, (waiter) => waiter.die());
  }

  /**
   * A write is about to reach the PTY. Human input acknowledges, and any input
   * but terminal replies and mouse reports lets output start work — a `dor
   * send` or a launch as much as a keystroke (`QuiesceDetector.expectWork`).
   */
  onWrite(id: string, data: string, { userInput = false }: { userInput?: boolean } = {}): void {
    // Same reasoning as `onData`: the first keystroke can beat any output. The
    // entry comes first, since acknowledging creates none and the echo window
    // it opens must cover that keystroke's echo too.
    const entry = inputCanStartWork(data, { userInput }) ? this.streamEntry(id) : null;
    if (userInput) this.acknowledge(id, { input: true });
    entry?.detector.expectWork();
  }

  // --- WATCHING rule set ---

  /**
   * Replace the set of command keys WATCHING applies to (`docs/specs/alert.md`).
   * Pushed from the renderer, which owns the persisted copy — neither host
   * process has `localStorage` of its own.
   */
  setWatchedCommands(names: string[]): void {
    const next = new Set(names);
    if (next.size === this.watchedCommands.size && [...next].every((name) => this.watchedCommands.has(name))) return;
    this.watchedCommands = next;
    for (const [id, entry] of this.entries) {
      // Dropping a rule is an explicit "stop alerting on this": it silences the
      // `watching` source that rule raised, unless another rule still covers its
      // key, which the source keeps past command exit for exactly this.
      this.invalidateWatching(entry, (key) => watchRuleFor(this.watchedCommands, key) === null);
      // WATCHING is derived from the rule set, so every entry may have changed.
      this.notify(id);
    }
  }

  setCommandWatched(name: string, watched: boolean): void {
    const trimmed = name.trim();
    if (!trimmed || this.watchedCommands.has(trimmed) === watched) return;
    const next = new Set(this.watchedCommands);
    if (watched) next.add(trimmed);
    else next.delete(trimmed);
    this.setWatchedCommands([...next]);
  }

  getWatchedCommands(): string[] {
    return [...this.watchedCommands].sort();
  }

  /**
   * WATCHING follows the foreground command's watch key: on while a command a
   * rule covers runs, off at the prompt. The detector keeps running either way;
   * this only decides whether its state is public and whether a settle rings.
   */
  private isWatching(entry: AlertEntry): boolean {
    return watchRuleFor(this.watchedCommands, entry.commandExitWatch?.watchKey ?? null) !== null;
  }

  private createDetector(id: string): QuiesceDetector {
    return new QuiesceDetector({
      // Every transition may move WATCHING's public state; `notify` skips
      // what did not change.
      onChange: () => this.notify(id),
      onSettled: () => this.onSettled(id),
    });
  }

  /**
   * Void the `watching` source whose key `voids` names, ringing or held alike,
   * leaving the detector running. Never an acknowledgement: a ring or a hold
   * left empty goes, leaving no TODO.
   */
  private invalidateWatching(entry: AlertEntry, voids: (key: string) => boolean): void {
    const { ring, held } = entry;
    if (ring?.watching && voids(ring.watching.key) && dropWatching(ring)) entry.ring = null;
    if (held?.watching && voids(held.watching.key) && dropWatching(held)) entry.held = null;
  }

  /** A busy Session went quiet. Whether that rings is decided downstream. */
  private onSettled(id: string): void {
    const entry = this.entries.get(id);
    // A program reporting progress says when its turn ends; the cycle's end
    // is the completion, not a pause inside it.
    if (!entry || entry.progress) return;
    if (this.dispatchCompletion(id, entry, { kind: 'settled' })) {
      // An await answering this settle also answers the inference retained
      // through its output. An earlier explicit report remains separate news.
      this.invalidateWatching(entry, () => true);
      this.notify(id);
    }
  }

  // --- Completion events ---

  /**
   * Watch every completion on one Session before any suppression runs — the
   * seam `dor await` waits on. Claimants are offered events in registration
   * order and the first to return `true` claims it, so it never rings, never
   * sets TODO, and never stores a notification. Returns the unregister function.
   */
  registerCompletionClaimant(id: string, claimant: CompletionClaimant): () => void {
    let claimants = this.claimants.get(id);
    if (!claimants) {
      claimants = new Set();
      this.claimants.set(id, claimants);
    }
    claimants.add(claimant);
    return () => {
      const current = this.claimants.get(id);
      if (!current) return;
      current.delete(claimant);
      if (current.size === 0) this.claimants.delete(id);
    };
  }

  /**
   * Observe -> claim -> ring rule, for every ring source. Every ring rule lives
   * here and nowhere else, so an emit site only has to describe what happened;
   * the decision to bother a human is made once, after the claimants have
   * passed on it. Returns whether a claimant took the event.
   */
  private dispatchCompletion(id: string, entry: AlertEntry, event: CompletionEvent): boolean {
    // A helper's completion reaches no one, and is not kept for promotion.
    if (this.helpers.has(id)) return false;
    // Snapshot: a claimant may unregister itself (or register another) while
    // being offered this very event.
    const claimants = [...(this.claimants.get(id) ?? [])];
    if (claimants.some((claimant) => claimant(event))) return true;

    // A completion inside the echo window answers the keystroke that opened
    // it — a bell on Tab, the exit `Ctrl-C` caused — so it neither rings nor
    // holds.
    if (this.inEchoWindow(entry)) return false;

    switch (event.kind) {
      case 'settled': {
        // Only a watched command rings. The originating command key latches on
        // the ring so it outlives the command that raised it.
        const key = entry.commandExitWatch?.watchKey;
        if (!key || !this.isWatching(entry)) break;
        this.holdOrDeliver(id, entry, { key, workSince: false }, { source: 'WATCHING', title: `${key} went quiet`, body: null });
        break;
      }
      case 'commandFinished':
        if (!event.seen) break;
        this.holdOrDeliver(id, entry, 'exit', {
          source: 'COMMAND_EXIT',
          title: 'Command finished',
          body: formatCommandExitBody(event.displayCommand, event.exitCode),
        });
        break;
      case 'notification':
        this.holdOrDeliver(id, entry, 'report', event.notification);
        break;
    }
    return false;
  }

  /**
   * The path from a completion that may ring to the ring: a live one and an
   * escalated hold alike. Engaged, it is held — a TODO at once, rung if the
   * user goes idle or leaves the host; otherwise a report goes through the acknowledged-state
   * check, and anything else rings. Publishes.
   */
  private holdOrDeliver(
    id: string,
    entry: AlertEntry,
    source: ListedRingSource | WatchingSource,
    detail: ActivityNotification,
    escalated = false,
  ): void {
    if (this.isEngaged(id)) {
      this.hold(entry, source, detail);
    } else if (source === 'report' && Date.now() < entry.ackedUntil) {
      // A receipt: a report about the state the user just acknowledged never
      // summons, and only enriches a TODO still on, so one the user cleared
      // stays cleared. A hold already put its detail on the TODO, which may
      // have moved on since.
      if (!escalated && entry.todo) entry.notification = richer(entry.notification, detail);
    } else {
      this.raiseRing(entry, source, detail);
    }
    this.notify(id);
  }

  // --- Await ---

  /**
   * Park until this Session finishes what it is doing, then report why the wait
   * ended (`docs/specs/alert.md` -> Await). The caller is `dor await`: a
   * program, not a human, so a completion it consumes is delivered to it
   * instead of ringing anyone.
   *
   * Resolves immediately when the Session is already ringing, consuming only
   * the one ring source it resolved on. That never acknowledges, so it leaves
   * no TODO and clears none.
   */
  awaitCompletion(id: string, options: AwaitOptions): AwaitHandle {
    if (this.helpers.has(id)) return settledAwait({ kind: 'cancelled', waitedMs: 0 });
    if (
      !Number.isFinite(options.timeoutMs)
      || options.timeoutMs <= 0
      || options.timeoutMs > MAX_AWAIT_TIMEOUT_MS
    ) {
      return settledAwait({ kind: 'cancelled', waitedMs: 0 });
    }

    // Awaiting a Session that has already been removed is the `died` case, not
    // a reason to recreate its entry and park on a PTY nobody will ever feed.
    if (this.removed.has(id)) return settledAwait({ kind: 'died', waitedMs: 0 });

    const entry = this.getOrCreateEntry(id);
    const startedAt = Date.now();

    const ringingCause = this.consumeAwaitableSource(entry, 'ring', options.until)
      ?? this.consumeAwaitableSource(entry, 'held', options.until);
    if (ringingCause !== null) {
      this.notify(id);
      return settledAwait({ kind: 'resolved', cause: ringingCause, waitedMs: 0 });
    }

    let settled = false;
    let resolveOutcome!: (outcome: AwaitOutcome) => void;
    const promise = new Promise<AwaitOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: AwaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(timeoutTimer);
      this.dropWaiter(id, waiter);
      resolveOutcome(outcome);
      // `awaited` may have just gone false.
      this.notify(id);
    };

    const waiter: AwaitWaiter = {
      offer: (event) => {
        const cause = awaitCauseFor(options.until, event);
        if (cause === null) return false;
        settle({ kind: 'resolved', cause, waitedMs: Date.now() - startedAt });
        return true;
      },
      onOutput: () => {
        if (options.until === 'quiet') clearTimeout(graceTimer);
      },
      // Under either condition: a command that starts silently is still
      // running, so `idle` ("nothing was running") would be wrong.
      onCommandStart: () => clearTimeout(graceTimer),
      die: () => settle({ kind: 'died', waitedMs: Date.now() - startedAt }),
      cancel: () => settle({ kind: 'cancelled', waitedMs: Date.now() - startedAt }),
    };

    this.addWaiter(id, waiter);

    // Is there anything to wait for? A running foreground command answers yes
    // outright. Otherwise give the Session one grace window to prove it is
    // doing something, and call it `idle` if nothing arrives.
    if (entry.commandExitWatch === null) {
      graceTimer = setTimeout(() => {
        settle({ kind: 'resolved', cause: 'idle', waitedMs: Date.now() - startedAt });
      }, AWAIT_GRACE_MS);
    }

    timeoutTimer = setTimeout(() => {
      settle({ kind: 'timeout', waitedMs: Date.now() - startedAt });
    }, options.timeoutMs);

    this.notify(id);
    return { promise, cancel: () => waiter.cancel() };
  }

  /**
   * Consume the source an await arriving right now would resolve on from one
   * latch, if any: the ring first, else a hold, so a completion the user
   * happened to be looking at answers a program the same as one nobody saw.
   * Only that source is withdrawn. Gated because a latch outlives the fact a
   * source describes (`docs/specs/alert.md` -> Await, rationale): `exit` only
   * with nothing running, `watching` only with no output since it joined, a
   * report always.
   */
  private consumeAwaitableSource(entry: AlertEntry, latch: 'ring' | 'held', until: AwaitUntil): AwaitCause | null {
    if (until === 'quiet' && this.withdrawRingSource(entry, 'report', latch)) return 'bell';
    if (entry.commandExitWatch === null && this.withdrawRingSource(entry, 'exit', latch)) return 'exit';
    if (
      until === 'quiet'
      && entry[latch]?.watching?.workSince === false
      && this.withdrawRingSource(entry, 'watching', latch)
    ) return 'quiet';
    return null;
  }

  private addWaiter(id: string, waiter: AwaitWaiter): void {
    let group = this.awaits.get(id);
    if (!group) {
      // One claimant covers every await on the Session, so a completion is
      // delivered to all of them rather than only to whoever registered first
      // — the claimant seam itself stops at the first claim.
      const waiters = new Set<AwaitWaiter>();
      group = {
        waiters,
        unregister: this.registerCompletionClaimant(id, (event) => {
          let claimed = false;
          for (const parked of [...waiters]) {
            if (parked.offer(event)) claimed = true;
          }
          return claimed;
        }),
      };
      this.awaits.set(id, group);
    }
    group.waiters.add(waiter);
  }

  private dropWaiter(id: string, waiter: AwaitWaiter): void {
    const group = this.awaits.get(id);
    if (!group || !group.waiters.delete(waiter)) return;
    if (group.waiters.size > 0) return;
    this.awaits.delete(id);
    group.unregister();
  }

  private eachWaiter(id: string, visit: (waiter: AwaitWaiter) => void): void {
    const group = this.awaits.get(id);
    if (!group) return;
    // Snapshot: settling removes the waiter from the set being walked.
    for (const waiter of [...group.waiters]) visit(waiter);
  }

  // --- Terminal reports ---

  notifyFromProtocol(id: string, notification: ActivityNotification): void {
    if (this.helpers.has(id)) return;
    const entry = this.streamEntry(id);
    if (!entry) return;
    const normalized = normalizeActivityNotification(notification);
    if (!normalized) return;

    this.dispatchCompletion(id, entry, { kind: 'notification', notification: normalized });
  }

  /** `OSC 9;4`: active updates move the cycle; its end is a report completion. */
  updateProtocolProgress(id: string, progress: ProtocolProgressUpdate): void {
    if (this.helpers.has(id)) return;
    const entry = this.streamEntry(id);
    if (!entry) return;
    const { progress: live } = entry;

    if (progress.state === 'clear' || progress.state === 'error' || (progress.state === 'normal' && progress.percent === 100)) {
      // Only a live cycle's end completes a turn: programs clear defensively,
      // and a command boundary already ended any cycle a late end belongs to.
      // The first end stands: a program may send 100% and then clear.
      if (!live || live.end) return;
      live.end = {
        // A cycle that completes keeps the warning it ran under.
        outcome: progress.state === 'error' ? 'error' : live.state === 'warning' ? 'warning' : 'complete',
        percent: progress.state === 'clear' ? live.percent : progress.percent,
        timer: setTimeout(() => this.settleProgressEnd(id, entry), cfg.alert.progressEndGrace),
      };
      return;
    }

    // The next cycle opened at once: that end was no completion.
    this.cancelProgressEnd(entry);
    // Announced work is work, and may start a run as input does, so output
    // after a mid-turn acknowledgement still makes the turn's end news.
    this.noteWork(id, entry);
    entry.detector.expectWork();
    if (live?.state === progress.state && live.percent === progress.percent) return;
    entry.progress = { state: progress.state, percent: progress.percent, end: null };
    this.notify(id);
  }

  private cancelProgressEnd(entry: AlertEntry): void {
    const { progress } = entry;
    if (!progress?.end) return;
    clearTimeout(progress.end.timer);
    progress.end = null;
  }

  /**
   * A pending end counts now: its grace ran out, or something proved it real.
   * The cycle is over whether or not anyone claims the event, so it is cleared
   * *before* dispatch — a claimant that suppresses the ring must not leave the
   * Session stuck at `OSC_NOTIF_BUSY`.
   */
  private settleProgressEnd(id: string, entry: AlertEntry): void {
    const end = entry.progress?.end;
    if (!end) return;
    // The end completed the turn, so a turn ending mid-run must not settle
    // again five seconds later.
    this.endRun(entry);
    this.dispatchCompletion(id, entry, {
      kind: 'notification',
      notification: {
        source: 'OSC 9;4',
        title: progressTitle(entry.commandExitWatch, end.outcome),
        body: end.percent === null ? null : `Progress ${Math.round(end.percent)}%`,
      },
    });
  }

  // --- Command-exit ---

  applyTerminalSemanticEvents(id: string, events: TerminalSemanticEvent[]): void {
    if (events.length === 0) return;
    const entry = this.streamEntry(id);
    if (!entry) return;
    let changed = false;

    for (const event of events) {
      switch (event.type) {
        case 'commandLine':
          if (entry.pendingCommandLine !== event.commandLine) {
            entry.pendingCommandLine = event.commandLine;
            changed = true;
          }
          break;
        case 'commandStart':
          this.startCommandExitWatch(id, entry, event);
          changed = true;
          break;
        case 'commandFinish':
          changed = this.finishCommandExitWatch(id, entry, event.exitCode) || changed;
          break;
        case 'promptStart':
        case 'promptEnd':
          // A prompt means nothing is in the foreground any more, so WATCHING
          // stops here even if the shell never sent a finish event. Prompt
          // rendering can produce busy output even without a reported command,
          // so its history ends at this boundary too.
          changed = this.finishCommandExitWatch(id, entry, undefined) || changed;
          break;
      }
    }

    if (changed) this.notify(id);
  }

  private startCommandExitWatch(
    id: string,
    entry: AlertEntry,
    event: Extract<TerminalSemanticEvent, { type: 'commandStart' }>,
  ): void {
    // A later stray clear finds no cycle to complete.
    this.endRunAtBoundary(id, entry);
    const resolved = resolveCommandStart(entry.pendingCommandLine, event);
    entry.pendingCommandLine = null;
    // A new command is news the acknowledgement never saw, even when it stays
    // silent until its report: its echo fell in the echo window, not output.
    entry.ackedUntil = 0;
    entry.commandExitWatch = {
      displayCommand: resolved.displayCommand,
      watchKey: resolved.rawCommandLine === null ? null : commandWatchKey(resolved.rawCommandLine),
      seen: this.isEngaged(id),
    };
    this.eachWaiter(id, (waiter) => waiter.onCommandStart());
  }

  private finishCommandExitWatch(
    id: string,
    entry: AlertEntry,
    exitCode: number | undefined,
  ): boolean {
    this.endRunAtBoundary(id, entry);
    const watch = entry.commandExitWatch;
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;

    // Every finish is observable, including the unseen ones that can never
    // ring and the engaged ones it holds — the ring rule is what filters them.
    if (watch !== null) {
      this.dispatchCompletion(id, entry, {
        kind: 'commandFinished',
        displayCommand: watch.displayCommand,
        exitCode,
        seen: watch.seen,
      });
    }

    // Clearing the watch turns WATCHING off, which flips `watchingEnabled` and
    // the status even when command-exit never armed, so subscribers must hear
    // about any finish — `notify` dedupes if nothing is visible.
    return watch !== null;
  }

  /**
   * The one path every ring takes (`docs/specs/alert.md` -> Clearing And TODO),
   * whatever the source. Opening a ring starts an episode and shows its own
   * detail, leaving TODO alone; a source joining an active ring enriches that
   * same summons, its detail shown only if at least as rich as what is shown.
   */
  private raiseRing(
    entry: AlertEntry,
    source: ListedRingSource | WatchingSource,
    detail: ActivityNotification,
  ): void {
    let ring = entry.ring;
    if (ring === null) {
      ring = { episode: createAlertEpisode(), sources: [], watching: null, detail };
      entry.ring = ring;
      entry.ackedUntil = 0;
    } else {
      ring.detail = richer(ring.detail, detail);
    }
    addSource(ring, source);
  }

  /**
   * An await answers one source, taking it off the ring or the hold. Never an
   * acknowledgement: a ring left empty goes, leaving no TODO; a hold left
   * empty goes, leaving the TODO it set. Returns whether the source was there.
   */
  private withdrawRingSource(entry: AlertEntry, source: RingSource, latch: 'ring' | 'held' = 'ring'): boolean {
    const ring = entry[latch];
    if (ring === null) return false;
    let empty: boolean;
    if (source === 'watching') {
      if (ring.watching === null) return false;
      empty = dropWatching(ring);
    } else {
      if (!ring.sources.includes(source)) return false;
      ring.sources = ring.sources.filter((candidate) => candidate !== source);
      empty = ring.sources.length === 0 && ring.watching === null;
    }
    if (empty) entry[latch] = null;
    if (source === 'watching') this.answeredWatching(entry);
    return true;
  }

  /**
   * A user verb stops the summons: the ring goes with whatever was held. TODO
   * is the caller's to decide, from the ring returned. Only clearing a ring or
   * a hold records an acknowledgement.
   */
  private clearRingForUser(entry: AlertEntry): Ring | null {
    const { ring, held } = entry;
    if (ring === null && held === null) return null;
    if (ring !== null) entry.ring = null;
    entry.held = null;
    entry.ackedUntil = Date.now() + cfg.alert.acknowledgedFor;
    if (ring?.watching || held?.watching) this.answeredWatching(entry);
    return ring;
  }

  /** A look at a ring: it becomes a TODO showing what the ring showed — its
   *  detail replaces the TODO's outright, unlike a hold's or a receipt's. */
  private ringToTodo(entry: AlertEntry, ring: Ring | null): void {
    if (ring === null) return;
    entry.todo = true;
    entry.notification = ring.detail;
  }

  /**
   * A `watching` source was answered: start the detector over, so the tail of
   * the run that rang cannot settle again straight away. The caller publishes.
   */
  private answeredWatching(entry: AlertEntry): void {
    entry.detector.reset();
  }

  /**
   * A run ended — a command boundary, a host interrupt, a progress cycle's end,
   * a restore: a cycle the program never closed goes with it, and the detector
   * starts over, so one run's output history never leaks into the next nor
   * settles as a completion after it. The caller publishes.
   */
  private endRun(entry: AlertEntry): void {
    this.cancelProgressEnd(entry);
    entry.progress = null;
    entry.detector.reset();
  }

  /**
   * A command boundary. A pending end counts first, under the command it ended:
   * the program said it was done and has now stopped, so that end was real.
   */
  private endRunAtBoundary(id: string, entry: AlertEntry): void {
    this.settleProgressEnd(id, entry);
    this.endRun(entry);
  }

  /** Stop everything that could still fire for an entry on its way out. */
  private disposeEntry(entry: AlertEntry): void {
    entry.detector.dispose();
    this.endLeaveGrace(entry);
    this.cancelProgressEnd(entry);
  }

  // --- Engagement (`docs/specs/alert.md` -> Engagement) ---

  /** Some present viewer points at `id`: all the ring rules read, and what
   *  keeps a spoken alarm from the pane the user is looking at. */
  isEngaged(id: string): boolean {
    for (const focusId of this.viewers.values()) {
      if (focusId === id) return true;
    }
    return false;
  }

  /**
   * One renderer realm's presence and focus, as its reporter computed them.
   * How a Session stops being engaged decides what it does with the
   * completions it held: an `idle` lapse rings them, a `leave` rings them once
   * the whole host is absent, and focus moving on leaves only their TODO.
   */
  setViewer(viewerId: string, state: Engagement, lapse?: EngagementLapse): void {
    // Revalidated: in VS Code the shape crosses from the webview.
    const focusId = typeof state?.focusId === 'string' ? state.focusId : null;
    const before = this.viewers.get(viewerId);
    const after = state?.present === true ? focusId : undefined;
    if (before === after) return;
    // Only this viewer moved, so only the Sessions it pointed at can change.
    const touched = [...new Set([before, after])]
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({ id, was: this.isEngaged(id) }));
    if (after === undefined) this.viewers.delete(viewerId);
    else this.viewers.set(viewerId, after);

    for (const { id, was } of touched) {
      const entry = this.entries.get(id);
      if (!entry || this.helpers.has(id) || this.isEngaged(id) === was) continue;
      if (!was) {
        this.endLeaveGrace(entry);
        this.markSeen(entry);
      } else if (after !== undefined) {
        // Focus moved on while present: the user saw it, so the TODO the hold
        // set is enough.
        entry.held = null;
      } else if (lapse === 'idle') {
        this.escalateHeld(id, entry);
      } else {
        this.startLeaveGrace(id, entry);
      }
      // COMMAND_EXIT_ARMED is derived from engagement.
      this.notify(id);
    }
  }

  /** The realm is gone: a disengage for whatever it pointed at. */
  removeViewer(viewerId: string): void {
    this.setViewer(viewerId, { present: false, focusId: null }, 'leave');
  }

  viewerIds(): string[] {
    return [...this.viewers.keys()];
  }

  /**
   * A human interacted with the Session. Both kinds clear the ring
   * (`clearRingForUser`) and whatever it held, and mark the running command
   * seen; without `input` a cleared ring becomes a TODO, while `input` — keys,
   * a paste, a drop, acknowledged as the host writes them — turns TODO off and
   * opens the echo window, a helper's included, since its detector runs. Never creates an
   * entry: an id with none — a browser Surface — has nothing to clear.
   */
  acknowledge(id: string, { input }: { input: boolean }): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (input) entry.echoUntil = Date.now() + cfg.alert.echoWindow;
    if (this.helpers.has(id)) return;
    this.markSeen(entry);
    if (input) {
      // Answered: it lands in the echo window just opened, so only an await sees it.
      this.settleProgressEnd(id, entry);
      this.clearRingForUser(entry);
      this.setTodoForUser(id, entry, false);
      return;
    }
    this.ringToTodo(entry, this.clearRingForUser(entry));
    this.notify(id);
  }

  private markSeen(entry: AlertEntry): void {
    if (entry.commandExitWatch) entry.commandExitWatch.seen = true;
  }

  private inEchoWindow(entry: AlertEntry): boolean {
    return Date.now() < entry.echoUntil;
  }

  /** The user is looking: the completion is a TODO already, kept to ring if they go idle or leave the host. */
  private hold(entry: AlertEntry, source: ListedRingSource | WatchingSource, detail: ActivityNotification): void {
    const held = entry.held ??= { sources: [], watching: null, detail };
    held.detail = richer(held.detail, detail);
    addSource(held, source);
    // Unlike a receipt, a hold turns the TODO on: the user is looking at it.
    entry.todo = true;
    entry.notification = richer(entry.notification, detail);
  }

  /**
   * The viewer holding it left — a blur, a hide, its realm ending. Ring what it
   * held only if the user left the whole host; another viewer still present (the
   * VS Code window around a webview, another Dormouse window) means focus moved
   * on. The grace lets that viewer's own report land first.
   */
  private startLeaveGrace(id: string, entry: AlertEntry): void {
    this.endLeaveGrace(entry);
    if (entry.held === null) return;
    entry.leaveGrace = setTimeout(() => {
      entry.leaveGrace = null;
      if (this.viewers.size === 0) this.escalateHeld(id, entry);
      else entry.held = null;
    }, cfg.alert.leaveGrace);
  }

  private endLeaveGrace(entry: AlertEntry): void {
    if (entry.leaveGrace === null) return;
    clearTimeout(entry.leaveGrace);
    entry.leaveGrace = null;
  }

  /**
   * The user went idle, or left the host: each held source takes the path it
   * would have taken unengaged, with the richest held detail. A Session made a
   * helper since the hold drops them, as `dispatchCompletion` drops a helper's
   * fresh completion: a helper never rings.
   */
  private escalateHeld(id: string, entry: AlertEntry): void {
    const held = entry.held;
    if (held === null) return;
    entry.held = null;
    if (this.helpers.has(id)) return;
    eachSource(held, (source) => this.holdOrDeliver(id, entry, source, held.detail, true));
  }

  // --- Alert controls ---

  dismissAlert(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    // Dismissing a ring leaves a TODO behind, so the summons is not lost. With
    // nothing ringing or held, nothing changes and `notify` publishes nothing.
    this.ringToTodo(entry, this.clearRingForUser(entry));
    this.notify(id);
  }

  // --- Todo controls ---

  toggleTodo(id: string): void {
    if (this.helpers.has(id)) return;
    const entry = this.streamEntry(id);
    if (!entry) return;
    this.setTodoForUser(id, entry, !entry.todo);
  }

  clearTodo(id: string): void {
    if (this.helpers.has(id)) return;
    const entry = this.streamEntry(id);
    if (entry) this.setTodoForUser(id, entry, false);
  }

  /** A TODO verb: the ring goes, on keeps the ring's detail, and off drops the
   *  notification. `notify` dedupes unchanged state. */
  private setTodoForUser(id: string, entry: AlertEntry, todo: boolean): void {
    const ring = this.clearRingForUser(entry);
    if (todo) this.ringToTodo(entry, ring);
    entry.todo = todo;
    if (!todo) entry.notification = null;
    this.notify(id);
  }

  // --- Query ---

  getState(id: string): AlertState {
    const entry = this.entries.get(id);
    if (!entry || this.helpers.has(id)) return DEFAULT_ALERT_STATE;
    return {
      status: this.getProjectedStatus(id, entry),
      watchingEnabled: this.isWatching(entry),
      todo: entry.todo,
      notification: entry.ring?.detail ?? entry.notification,
      awaited: (this.awaits.get(id)?.waiters.size ?? 0) > 0,
      episode: entry.ring?.episode ?? null,
    };
  }

  /** Whether `id` has state to publish: an entry that is not a helper's.
   *  Exactly the ids {@link getAllStates} answers. */
  has(id: string): boolean {
    return this.entries.has(id) && !this.helpers.has(id);
  }

  getAllStates(): Map<string, AlertState> {
    const result = new Map<string, AlertState>();
    for (const [id] of this.entries) {
      if (!this.helpers.has(id)) result.set(id, this.getState(id));
    }
    return result;
  }

  /**
   * The host is about to stop this Session's run itself — a reap, an in-place
   * restart, a preview retarget (`docs/specs/alert.md` -> Command-exit Track)
   * — so its end is no news: forget the
   * run as a different command start would, without ringing. The ring and
   * TODO already owed stay.
   */
  silenceRun(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    this.endRun(entry);
    this.notify(id);
  }

  remove(id: string): void {
    this.discard(id);
    for (const listener of this.removeListeners) listener(id);
  }

  /**
   * A new PTY generation under `id`: what the old one left goes as on
   * `remove`, but no tombstone, since the output about to arrive is the new
   * Session's own, and no removal, since the Session lives on.
   */
  restart(id: string): void {
    this.discard(id);
    this.removed.delete(id);
  }

  private discard(id: string): void {
    this.removed.add(id);
    // Nobody parked here has anything left to wait for.
    this.eachWaiter(id, (waiter) => waiter.die());
    // Claimants go with the Session, entry or not — a dead Session dispatches
    // nothing, so holding their closures would only leak them.
    this.claimants.delete(id);
    const entry = this.entries.get(id);
    if (entry) {
      this.disposeEntry(entry);
      this.entries.delete(id);
      this.notify(id);
    }
    // Last, so `notify` still knows a helper that never published has nothing
    // for subscribers to forget.
    this.helpers.delete(id);
  }

  /**
   * Seed alert state from a persisted session (cold-start restore). Only the
   * TODO reminder and its notification detail survive a restart — WATCHING is
   * re-derived from the rule set at the next command start, and restore must
   * never resurrect a ring or an in-flight progress cycle.
   */
  seed(id: string, state: { todo: unknown; notification?: unknown }): void {
    if (this.helpers.has(id)) return;
    const entry = this.getOrCreateEntry(id);
    entry.todo = state.todo === true;
    entry.notification = entry.todo ? normalizeActivityNotification(state.notification) : null;
    entry.ring = null;
    entry.held = null;
    entry.ackedUntil = 0;
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    this.endRun(entry);
    this.notify(id);
  }

  dispose(): void {
    // Settled first, while listeners are still attached: a parked caller that
    // never hears an outcome absorbed a completion it never delivered.
    for (const id of [...this.awaits.keys()]) this.eachWaiter(id, (waiter) => waiter.cancel());
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.removed.clear();
    this.helpers.clear();
    this.awaits.clear();
    this.claimants.clear();
    this.viewers.clear();
    this.listeners.clear();
    this.removeListeners.clear();
    this.lastEmitted.clear();
  }

  // --- Internals ---

  /**
   * The entry an event or control should feed, or `null` if the Session was
   * removed and no new generation has claimed the id since. Such an event may
   * still be a live Session's first, so the entry is created on demand — but a
   * retired one must not be rebuilt by what was already on its way when the
   * pane was killed (see `removed`).
   */
  private streamEntry(id: string): AlertEntry | null {
    if (this.removed.has(id)) return null;
    return this.getOrCreateEntry(id);
  }

  private getProjectedStatus(id: string, entry: AlertEntry): SessionStatus {
    if (entry.ring !== null) return 'ALERT_RINGING';
    if (entry.progress !== null) return 'OSC_NOTIF_BUSY';
    // WATCHING outranks the command-exit arm: a watched command is by
    // definition running, so COMMAND_EXIT_ARMED would otherwise mask the
    // detector's busy/quiet states for the entire run. The detector is derived
    // from real output, so it is the more informative of the two.
    if (this.isWatching(entry)) return entry.detector.getStatus();
    // Armed: a seen command running while nobody engages it.
    if (entry.commandExitWatch?.seen && !this.isEngaged(id)) return 'COMMAND_EXIT_ARMED';
    return 'WATCHING_DISABLED';
  }

  private getOrCreateEntry(id: string): AlertEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        detector: this.createDetector(id),
        ring: null,
        ackedUntil: 0,
        progress: null,
        commandExitWatch: null,
        pendingCommandLine: null,
        todo: false,
        notification: null,
        held: null,
        leaveGrace: null,
        echoUntil: 0,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private notify(id: string): void {
    const state = this.getState(id);
    const last = this.lastEmitted.get(id);
    // A helper publishes nothing, but takes back what it published before a demotion.
    if (last ? alertStatesEqual(last, state) : this.helpers.has(id)) return;
    if (this.entries.has(id)) {
      this.lastEmitted.set(id, state);
    } else {
      this.lastEmitted.delete(id);
    }
    for (const listener of this.listeners) {
      listener(id, state);
    }
  }
}

/**
 * Whether any realm could tell two states apart. Realms read only whether it
 * rings, the episode, TODO, its detail, and `awaited`; the rest of `status`
 * and `watchingEnabled` move on every detector and engagement edge, and
 * publishing those cost an IPC message and every pane header a re-render with
 * nothing to show, so they ride along on the next change that matters.
 */
function alertStatesEqual(a: AlertState, b: AlertState): boolean {
  if (
    (a.status === 'ALERT_RINGING') !== (b.status === 'ALERT_RINGING')
    || a.todo !== b.todo
    || a.awaited !== b.awaited
    || a.episode?.id !== b.episode?.id
  ) return false;
  const an = a.notification;
  const bn = b.notification;
  if (an === bn) return true;
  if (an === null || bn === null) return false;
  return an.source === bn.source && an.title === bn.title && an.body === bn.body;
}

/**
 * Which completions each `--until` wakes on, and what it calls the cause.
 * `quiet` is the permissive rung: a settle, an exit, or an explicit bell.
 * `exit` takes command exits and nothing else — plenty of build tools ring on a
 * warning, and being the strict one is `exit`'s whole job.
 */
function awaitCauseFor(until: AwaitUntil, event: CompletionEvent): AwaitCause | null {
  if (event.kind === 'commandFinished') return 'exit';
  if (until === 'exit') return null;
  return event.kind === 'settled' ? 'quiet' : 'bell';
}

/** An await that was over before it parked: nothing to cancel, nothing to clean up. */
function settledAwait(outcome: AwaitOutcome): AwaitHandle {
  return { promise: Promise.resolve(outcome), cancel: () => {} };
}

/** Names the running command when there is one: its watch key, else its display command. */
function progressTitle(watch: CommandExitWatch | null, outcome: ProgressOutcome): string {
  const titles = PROGRESS_TITLES[outcome];
  return watch === null ? titles.alone : `${watch.watchKey ?? watch.displayCommand} ${titles.afterCommand}`;
}

function formatCommandExitBody(displayCommand: string, exitCode: number | undefined): string {
  const command = displayCommand.trim() || DEFAULT_COMMAND_TITLE;
  if (exitCode === undefined) return command;
  return `${command} exited ${exitCode}`;
}
