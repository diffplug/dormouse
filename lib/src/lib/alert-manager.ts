import { createAlertEpisode, type AlertEpisode } from './alert-episode';
import { QuiesceDetector, type QuiesceStatus, type QuiesceSnapshot } from './quiesce-detector';
import {
  applyTerminalEvents,
  collectTerminalSemanticEvents,
  type TerminalProtocolParseResult,
} from './terminal-protocol';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from './alert-settings-model';
import { cfg } from '../cfg';
import {
  commandWatchKey,
  resolveCommandStart,
  watchRuleFor,
  DEFAULT_COMMAND_TITLE,
  type CommandRunSource,
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

/** Boolean TODO state: on (true) or off (false). */
export type TodoState = boolean;

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

/** `next`, unless `current` says more: equal ranks take the newer detail. */
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
}

/** How a progress cycle ended. */
type ProgressOutcome = 'complete' | 'warning' | 'error';

/** A progress title by outcome: after the running command, or on its own
 *  (`docs/specs/alert.md` -> Terminal reports). */
const PROGRESS_TITLES: Record<ProgressOutcome, { afterCommand: string; alone: string }> = {
  complete: { afterCommand: 'finished', alone: 'Progress complete' },
  warning: { afterCommand: 'finished with a warning', alone: 'Progress warning' },
  error: { afterCommand: 'reported an error', alone: 'Progress error' },
};

/** What raised a ring: a watched settle, a terminal report, or a command exit. */
type RingSource = 'watching' | 'report' | 'exit';

/** A source `Ring.sources` lists; `watching` carries state of its own. */
type ListedRingSource = Exclude<RingSource, 'watching'>;

/** The `watching` source: the rule key that raised it, and whether output has
 *  arrived since it joined, which the detector cannot tell
 *  (`docs/specs/alert.md` -> Await). */
interface WatchingSource {
  key: string;
  outputSince: boolean;
}

/** Why a source leaves the ring: `answered` by an await, as a user verb
 *  answers the whole ring, or `invalidated` by resumed work or rule removal
 *  (`watchingLeft`). */
type RingWithdrawal = 'answered' | 'invalidated';

/** The one ring latch a Session holds (`docs/specs/alert.md` -> Public State). */
interface Ring {
  episode: AlertEpisode;
  /** An array, not a Set: the live-transfer snapshot crosses IPC as JSON. */
  sources: ListedRingSource[];
  /** Removing the rule that covers its key withdraws it. */
  watching: WatchingSource | null;
  /** What this ring found, restored whole when a withdrawal empties it. */
  prior: { todo: TodoState; notification: ActivityNotification | null };
}

interface CommandExitWatch {
  displayCommand: string;
  /** `commandWatchKey` of the command line; null without one to key on. */
  watchKey: string | null;
  source: CommandRunSource;
  startedAt: number;
  seenWithAttentionAt: number | null;
  /** Attention was lost after the command was seen, so its exit may ring. */
  armed: boolean;
}

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
  if (value === null || value === undefined) return null;
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
      watchKey: string | null;
      exitCode: number | undefined;
      /** Wall time from commandStart to this finish. */
      ranMs: number;
      /** Command-exit alerting was armed (attention was lost mid-run) when it finished. */
      armed: boolean;
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
  /** Live delivery identity; absent only on older host snapshots. */
  episode?: AlertEpisode | null;
  status: SessionStatus;
  watchingEnabled: boolean;
  todo: TodoState;
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
   * A user verb cleared a ring and no output has arrived since, so a report
   * describes the state the user already acknowledged (`dispatchCompletion`).
   * Opening a ring forgets it.
   */
  ackedQuiet: boolean;
  /** The live `OSC 9;4` cycle. Never touches the ring, and the ring never touches it. */
  progress: ActiveProtocolProgress | null;
  commandExitWatch: CommandExitWatch | null;
  pendingCommandLine: string | null;
  todo: TodoState;
  notification: ActivityNotification | null;
  /**
   * The terminal notification held behind animation, never public or
   * persisted, and when the hold began: a replacement keeps that start, so the
   * ceiling bounds the whole hold.
   */
  deferred: { notification: ActivityNotification; since: number } | null;
  deferredTimer: ReturnType<typeof setTimeout> | null;
}

/** Explicit live handoff only: timers are deadlines, and no caller closures travel. */
export interface AlertRuntimeSnapshot extends Omit<AlertEntry, 'detector' | 'deferredTimer'> {
  detector: QuiesceSnapshot;
}

/** Portable Session Activity manager. `dispatchCompletion` is the single
 * observe→claim→ring seam, so await can claim completions before suppression. */
export class AlertManager {
  private entries = new Map<string, AlertEntry>();
  private suspendedForTransfer = new Set<string>();
  /** Session → request token of the one replay that counts as live (`applyReplay`). */
  private liveReplay = new Map<string, string>();
  /** Blocks late output/resize from recreating a removed entry. Only a semantic
   * or protocol event proves a reused id belongs to a live replacement. */
  private removed = new Set<string>();
  private claimants = new Map<string, Set<CompletionClaimant>>();
  private awaits = new Map<string, AwaitGroup>();
  private attentionId: string | null = null;
  private attentionTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(id: string, state: AlertState) => void>();
  private lastEmitted = new Map<string, AlertState>();
  private watchedCommands = new Set<string>();
  /** Helper Sessions alert no one until promotion (docs/specs/alert.md → Pane
   *  Header). They still build command state and feed the detector, so one
   *  promoted mid-command knows what it is running; everything else — reports,
   *  controls, awaits, completion dispatch, publishing — drops them, so a host
   *  marks the id once instead of guarding each call. */
  private helpers = new Set<string>();
  private inactivityTimeoutMs = cfg.alert.userAttention;
  /** The shipped default (platform-free module: this runs in both hosts), so a
   *  manager that never receives a settings blob behaves like one that does. */
  private deferAlertsUntilQuiet = DEFAULT_ALERT_SETTINGS.deferAlertsUntilQuiet;

  // --- Settings ---

  /**
   * The whole of what this manager consumes from the settings blob, so a new
   * host-owned field is one edit here rather than one per host — where a miss
   * would silently disable it on that host alone. Callers pass an
   * already-normalized blob; the sinks below revalidate anyway.
   */
  applySettings(settings: AlertSettings): void {
    this.setInactivityTimeoutMs(settings.inactivityTimeoutMs);
    this.setDeferAlertsUntilQuiet(settings.deferAlertsUntilQuiet);
  }

  /** Walk-away window for attention. Revalidate at this timer sink. */
  setInactivityTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this.inactivityTimeoutMs) return;
    this.inactivityTimeoutMs = ms;
    // Re-arm from now so a shortened window takes effect immediately instead of
    // waiting out the window that was already running.
    if (this.attentionTimer !== null && this.attentionId !== null) {
      this.setAttention(this.attentionId);
    }
  }

  /** Let confirmed terminal activity finish before terminal-notification rings. */
  setDeferAlertsUntilQuiet(enabled: boolean): void {
    if (enabled === this.deferAlertsUntilQuiet) return;
    this.deferAlertsUntilQuiet = enabled;
    if (enabled) return;

    // Turning the gate off releases news it was holding; dropping it would turn
    // a timing preference into alert loss.
    for (const [id, entry] of this.entries) {
      if (!this.suspendedForTransfer.has(id)) this.flushDeferredNotification(id, entry);
    }
  }

  /** Mark (or, on promotion, unmark) a helper Session. */
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

  // --- Feed PTY events ---

  onData(id: string): void {
    // The detector runs for every Session, including one that has never
    // produced a semantic or protocol event, so output creates the entry.
    const entry = this.streamEntry(id);
    if (!entry) return;
    entry.detector.onData();
    if (entry.ring?.watching) entry.ring.watching.outputSince = true;
    entry.ackedQuiet = false;
    this.eachWaiter(id, (waiter) => waiter.onOutput());
  }

  onExit(id: string, exitCode?: number): void {
    if (this.suspendedForTransfer.has(id)) return;
    const entry = this.entries.get(id);
    if (entry && this.finishCommandExitWatch(id, entry, exitCode)) this.notify(id);
    // The command-exit dispatch above already resolved anything waiting on the
    // run that just ended; whatever is still parked is waiting on a Session
    // that no longer exists.
    this.settleWaiters(id, 'died');
  }

  onResize(id: string): void {
    // Same reasoning as `onData`: the resize grace window is part of the
    // always-on detector, and a Pane's first fit usually beats any PTY event.
    this.streamEntry(id)?.detector.onResize();
  }

  // --- WATCHING rule set ---

  /**
   * Replace the set of command keys WATCHING applies to (`docs/specs/alert.md`).
   * Pushed from the renderer, which owns the persisted copy — the extension host
   * has no `localStorage` of its own.
   */
  setWatchedCommands(names: string[]): void {
    const next = new Set(names);
    if (next.size === this.watchedCommands.size && [...next].every((name) => this.watchedCommands.has(name))) return;
    this.watchedCommands = next;
    for (const [id, entry] of this.entries) {
      // A suspended Session is frozen at its snapshot; `resumeFromTransfer`
      // re-applies this rule wherever the snapshot lands.
      if (this.suspendedForTransfer.has(id)) continue;
      this.withdrawUncoveredWatchingRing(entry);
      // WATCHING is derived from the rule set, so every entry may have changed.
      this.notify(id);
    }
  }

  /** Apply one command-rule mutation without replacing unrelated rules. */
  setCommandWatched(name: string, watched: boolean): void {
    const trimmed = name.trim();
    if (!trimmed || this.watchedCommands.has(trimmed) === watched) return;
    const next = new Set(this.watchedCommands);
    if (watched) next.add(trimmed);
    else next.delete(trimmed);
    this.setWatchedCommands([...next]);
  }

  /** Sorted snapshot used by hosts that mirror the rule set to renderers. */
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
      // Detector state is public only while WATCHING, so only then can a
      // transition change the projection.
      onChange: () => {
        const entry = this.entries.get(id);
        if (!entry || !this.isWatching(entry)) return;
        this.withdrawResumedWatchingRing(entry);
        this.notify(id);
      },
      onSettled: () => this.onSettled(id),
    });
  }

  /**
   * Watched work that resumed invalidates a ring inferred from silence, so the
   * next settle raises a fresh one on fresh delivery delays. The detector is
   * left alone: resetting it would stop this run from settling again. Callers
   * are the WATCHING-only paths; this adds no rule-set check of its own.
   */
  private withdrawResumedWatchingRing(entry: AlertEntry): void {
    if (!this.deferAlertsUntilQuiet || !entry.detector.isConfirmedBusy()) return;
    this.withdrawRingSource(entry, 'watching', 'invalidated');
  }

  /**
   * Dropping a rule is an explicit "stop alerting on this", so it also silences
   * the `watching` source that rule raised — unless another rule still covers
   * it. The source keeps its key after command exit precisely so this still
   * works at a prompt.
   */
  private withdrawUncoveredWatchingRing(entry: AlertEntry): void {
    if (watchRuleFor(this.watchedCommands, entry.ring?.watching?.key ?? null) !== null) return;
    this.withdrawRingSource(entry, 'watching', 'invalidated');
  }

  /** A busy Session went quiet. Whether that rings is decided downstream. */
  private onSettled(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.dispatchCompletion(id, entry, { kind: 'settled' });
    // The settle completion gets first refusal before delivery held from an
    // earlier event. Never re-offer that historical event to current claimants.
    // Unconditional: a claimant taking *this* settle says nothing about the
    // earlier completion it never saw, which is now quiet and due.
    this.flushDeferredNotification(id, entry);
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

    switch (event.kind) {
      case 'settled': {
        // Only a watched command rings, and only if the user is not looking at
        // it right now. The originating command key latches on the ring so it
        // outlives the command that raised it.
        const key = entry.commandExitWatch?.watchKey;
        if (!key || !this.isWatching(entry) || this.hasAttention(id)) break;
        this.raiseRing(entry, { key, outputSince: false }, { source: 'WATCHING', title: `${key} went quiet`, body: null });
        this.notify(id);
        break;
      }
      case 'commandFinished':
        if (!event.armed || this.hasAttention(id) || event.ranMs < cfg.alert.commandExitMinRuntime) break;
        // A shell-reported exit is authoritative, so recent animation never
        // delays it. The detector only gates in-band terminal notifications.
        this.raiseRing(entry, 'exit', {
          source: 'COMMAND_EXIT',
          title: 'Command finished',
          body: formatCommandExitBody(event.displayCommand, event.exitCode),
        });
        // If a terminal notification was already waiting, it can enrich this
        // ring immediately; keeping its timer would publish stale detail later.
        if (entry.deferred !== null) this.flushDeferredNotification(id, entry);
        else this.notify(id);
        break;
      case 'notification':
        if (this.hasAttention(id)) {
          // A progress cycle was already cleared before dispatch, so publish
          // that; a plain direct notification changes nothing and dedupes away.
          this.notify(id);
          break;
        }
        if (entry.ring === null && entry.ackedQuiet) {
          // A report about the state the user just acknowledged updates the
          // receipt instead of summoning again. Nothing is deferred while
          // acknowledged: no output has arrived to animate.
          entry.todo = true;
          entry.notification = richer(entry.notification, event.notification);
          this.notify(id);
          break;
        }
        this.deferOrDeliverNotification(id, entry, event.notification);
        break;
    }
    return false;
  }

  // --- Await ---

  /**
   * Park until this Session finishes what it is doing, then report why the wait
   * ended (`docs/specs/alert.md` -> Await). The caller is `dor await`: a
   * program, not a human, so a completion it consumes is delivered to it
   * instead of ringing anyone.
   *
   * Resolves immediately when the Session is already ringing, consuming only
   * the one ring source it resolved on. That withdraws the TODO the ring
   * itself set, never a TODO that was already there, and never sets attention.
   */
  awaitCompletion(id: string, options: AwaitOptions): AwaitHandle {
    if (this.inert(id)) return settledAwait({ kind: 'cancelled', waitedMs: 0 });
    // The ceiling starts life as a CLI argument a process away and ends up in
    // `setTimeout`, so nonsense is rejected here rather than trusted from one
    // caller away. A rejected request settles `cancelled` — it absorbs nothing
    // and parks nothing.
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

    const ringingCause = this.consumeAwaitableRing(entry, options.until);
    if (ringingCause !== null) {
      this.notify(id);
      return settledAwait({ kind: 'resolved', cause: ringingCause, waitedMs: 0 });
    }

    let settled = false;
    let resolveOutcome!: (outcome: AwaitOutcome) => void;
    const promise = new Promise<AwaitOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const clearGrace = (): void => {
      if (graceTimer === null) return;
      clearTimeout(graceTimer);
      graceTimer = null;
    };

    const settle = (outcome: AwaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearGrace();
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
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
        if (options.until === 'quiet') clearGrace();
      },
      // A foreground command is the strongest possible answer to "is there
      // anything to wait for", so it cancels the grace window under *either*
      // condition. Under `quiet` the window's usual test is output, but a
      // command that starts silently is still running — resolving `idle`
      // ("nothing was running") on it would contradict the rule right above,
      // which parks with no grace window whenever `commandExitWatch` is set.
      onCommandStart: () => clearGrace(),
      die: () => settle({ kind: 'died', waitedMs: Date.now() - startedAt }),
      cancel: () => settle({ kind: 'cancelled', waitedMs: Date.now() - startedAt }),
    };

    this.addWaiter(id, waiter);

    // Is there anything to wait for? A running foreground command answers yes
    // outright. Otherwise give the Session one grace window to prove it is
    // doing something, and call it `idle` if nothing arrives.
    if (entry.commandExitWatch === null) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        settle({ kind: 'resolved', cause: 'idle', waitedMs: Date.now() - startedAt });
      }, AWAIT_GRACE_MS);
    }

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      settle({ kind: 'timeout', waitedMs: Date.now() - startedAt });
    }, options.timeoutMs);

    this.notify(id);
    return { promise, cancel: () => waiter.cancel() };
  }

  /**
   * Consume the ring source an await arriving right now would resolve on, if
   * any: only that source is withdrawn. Gated because the ring outlives the
   * fact a source describes (`docs/specs/alert.md` -> Await, rationale): `exit`
   * only with nothing running, `watching` only with no output since it joined,
   * a report always.
   */
  private consumeAwaitableRing(entry: AlertEntry, until: AwaitUntil): AwaitCause | null {
    if (until === 'quiet' && this.withdrawRingSource(entry, 'report', 'answered')) return 'bell';
    if (entry.commandExitWatch === null && this.withdrawRingSource(entry, 'exit', 'answered')) return 'exit';
    if (
      until === 'quiet'
      && entry.ring?.watching?.outputSince === false
      && this.withdrawRingSource(entry, 'watching', 'answered')
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

  private settleWaiters(id: string, how: 'died' | 'cancelled'): void {
    this.eachWaiter(id, (waiter) => (how === 'died' ? waiter.die() : waiter.cancel()));
  }

  // --- Terminal reports ---

  notifyFromProtocol(id: string, notification: ActivityNotification): void {
    if (this.inert(id)) return;
    const entry = this.reportedEntry(id);
    const normalized = normalizeActivityNotification(notification);
    if (!normalized) return;

    this.dispatchCompletion(id, entry, { kind: 'notification', notification: normalized });
  }

  /** `OSC 9;4`: active updates move the cycle; its end is a report completion. */
  updateProtocolProgress(id: string, progress: ProtocolProgressUpdate): void {
    if (this.inert(id)) return;
    const entry = this.reportedEntry(id);
    // A cycle that completes keeps the warning it ran under.
    const completed: ProgressOutcome = entry.progress?.state === 'warning' ? 'warning' : 'complete';

    if (progress.state === 'clear') {
      // A clear with no live cycle ends nothing: programs clear defensively.
      if (entry.progress) this.finishProtocolProgressCycle(id, entry, completed, entry.progress.percent);
      return;
    }

    if (progress.state === 'error') {
      this.finishProtocolProgressCycle(id, entry, 'error', progress.percent);
      return;
    }

    if (progress.state === 'normal' && progress.percent === 100) {
      this.finishProtocolProgressCycle(id, entry, completed, progress.percent);
      return;
    }

    if (entry.progress?.state === progress.state && entry.progress.percent === progress.percent) return;
    entry.progress = { state: progress.state, percent: progress.percent };
    this.notify(id);
  }

  /**
   * End of a progress cycle (completion or error). The cycle is over whether or
   * not anyone claims the event, so it is cleared *before* dispatch — a
   * claimant that suppresses the ring must not leave the Session stuck at
   * `OSC_NOTIF_BUSY`.
   */
  private finishProtocolProgressCycle(
    id: string,
    entry: AlertEntry,
    outcome: ProgressOutcome,
    percent: number | null,
  ): void {
    entry.progress = null;
    const claimed = this.dispatchCompletion(id, entry, {
      kind: 'notification',
      notification: {
        source: 'OSC 9;4',
        title: progressTitle(entry.commandExitWatch, outcome),
        body: percent === null ? null : `Progress ${Math.round(percent)}%`,
      },
    });
    // Clearing the cycle is publicly visible (`OSC_NOTIF_BUSY` falls back); the
    // ring rules publish it themselves, a claim stops before they run.
    if (claimed) this.notify(id);
  }

  // --- Command-exit ---

  applyTerminalSemanticEvents(id: string, events: TerminalSemanticEvent[]): void {
    if (events.length === 0 || this.suspendedForTransfer.has(id)) return;
    const entry = this.reportedEntry(id);
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
    const resolved = resolveCommandStart(entry.pendingCommandLine, event);
    entry.pendingCommandLine = null;
    // Every command boundary silently ends a progress cycle the program never
    // closed, so a later stray clear finds nothing to complete.
    entry.progress = null;
    entry.commandExitWatch = {
      displayCommand: resolved.displayCommand,
      watchKey: resolved.rawCommandLine === null ? null : commandWatchKey(resolved.rawCommandLine),
      source: resolved.source,
      startedAt: resolved.startedAt,
      seenWithAttentionAt: this.hasAttention(id) ? Date.now() : null,
      armed: false,
    };
    // Every command boundary starts the detector over, so one command's output
    // history can never leak into the next one's busy/quiet reading.
    entry.detector.reset();
    this.eachWaiter(id, (waiter) => waiter.onCommandStart());
  }

  private finishCommandExitWatch(
    id: string,
    entry: AlertEntry,
    exitCode: number | undefined,
  ): boolean {
    const watch = entry.commandExitWatch;
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    // The boundary silently ends a progress cycle, like a command start.
    const endedProgress = entry.progress !== null;
    entry.progress = null;

    // Every finish is observable, including the short, unarmed, and attended
    // ones that can never ring — the ring rule is what filters them.
    if (watch !== null) {
      this.dispatchCompletion(id, entry, {
        kind: 'commandFinished',
        displayCommand: watch.displayCommand,
        watchKey: watch.watchKey,
        exitCode,
        ranMs: Date.now() - watch.startedAt,
        armed: watch.armed,
      });
    }

    // The command boundary reset, covering commandFinish, promptStart/End, and
    // PTY exit. Last, so the reset's own `onChange` cannot publish a
    // half-finished projection.
    entry.detector.reset();
    // Clearing the watch turns WATCHING off, which flips `watchingEnabled` and
    // the status even when command-exit never armed, so subscribers must hear
    // about any finish — `notify` dedupes if nothing is visible.
    return watch !== null || endedProgress;
  }

  private markCommandExitSeen(entry: AlertEntry): void {
    const watch = entry.commandExitWatch;
    if (!watch) return;
    watch.seenWithAttentionAt ??= Date.now();
    watch.armed = false;
  }

  private armCommandExitOnAttentionLoss(id: string): boolean {
    const watch = this.entries.get(id)?.commandExitWatch;
    if (!watch || watch.armed || watch.seenWithAttentionAt === null) return false;
    watch.armed = true;
    return true;
  }

  // --- Deferred terminal notifications ---

  private deferOrDeliverNotification(
    id: string,
    entry: AlertEntry,
    notification: ActivityNotification,
  ): void {
    // Once a ring is active, another source only enriches the same summons.
    // There is no fresh transition left for animation deferral to suppress. An
    // already pending deferral keeps deferring: a command boundary resets the
    // detector, so `isConfirmedBusy` alone could release a notification before
    // quiet.
    if (
      this.deferAlertsUntilQuiet
      && entry.ring === null
      && (entry.deferred !== null || entry.detector.isConfirmedBusy())
    ) {
      // The richer detail waits, as it would show on a ring; the ceiling still
      // counts from the first.
      if (entry.deferred === null) entry.deferred = { notification, since: Date.now() };
      else entry.deferred.notification = richer(entry.deferred.notification, notification);
      this.scheduleDeferredNotification(id, entry);
    } else {
      // An existing ring means this is enrichment, not a fresh summons. Cancel
      // any older pending detail so it cannot overwrite this notification later.
      this.clearDeferredNotification(entry);
      this.raiseRing(entry, 'report', notification);
    }
    // The caller may have cleared a publicly visible cycle and delegated the
    // publish to the ring rules; deferring the ring must not swallow it.
    this.notify(id);
  }

  /**
   * Wake at the earlier of the detector's quiet deadline and the deferral
   * ceiling, re-arming for the remainder if output moved the former — so
   * continuing output costs one timer per quiet window rather than one per PTY
   * chunk. A timer already waiting stays: the due time only moves later, and
   * the wake re-checks it. Mostly the detector's own settle gets there first;
   * the timer is load-bearing after a command boundary resets the detector,
   * which kills the settle that would have flushed, and for output that never
   * goes quiet.
   */
  private scheduleDeferredNotification(id: string, entry: AlertEntry): void {
    if (entry.deferredTimer !== null) return;
    entry.deferredTimer = setTimeout(() => {
      entry.deferredTimer = null;
      if (this.deferredDueAt(entry) > Date.now()) this.scheduleDeferredNotification(id, entry);
      else this.flushDeferredNotification(id, entry);
    }, Math.max(0, this.deferredDueAt(entry) - Date.now()));
  }

  /** Quiet, or the deferral ceiling, whichever comes first. */
  private deferredDueAt(entry: AlertEntry): number {
    return Math.min(entry.detector.quietAt(), (entry.deferred?.since ?? Date.now()) + cfg.alert.deferCeiling);
  }

  private flushDeferredNotification(id: string, entry: AlertEntry): void {
    const deferred = entry.deferred;
    if (deferred === null) return;
    this.clearDeferredNotification(entry);

    // Attending the Session clears this eagerly too; retain the recheck as the
    // timer-side safety rule shared by every delayed alarm path.
    if (this.hasAttention(id)) return;

    this.raiseRing(entry, 'report', deferred.notification);
    this.notify(id);
  }

  private clearDeferredNotification(entry: AlertEntry): void {
    if (entry.deferredTimer !== null) {
      clearTimeout(entry.deferredTimer);
      entry.deferredTimer = null;
    }
    entry.deferred = null;
  }

  /**
   * The one path every ring takes (`docs/specs/alert.md` -> Clearing And TODO),
   * whatever the source. Opening a ring starts an episode, sets TODO and shows
   * its own detail; a source joining an active ring enriches that same
   * summons, its detail shown only if at least as rich as what is shown.
   */
  private raiseRing(
    entry: AlertEntry,
    source: ListedRingSource | WatchingSource,
    detail: ActivityNotification,
  ): void {
    let ring = entry.ring;
    if (ring === null) {
      ring = {
        episode: createAlertEpisode(),
        sources: [],
        watching: null,
        prior: { todo: entry.todo, notification: entry.notification },
      };
      entry.ring = ring;
      entry.todo = true;
      entry.notification = detail;
      entry.ackedQuiet = false;
    } else {
      entry.notification = richer(entry.notification, detail);
    }
    if (typeof source !== 'string') ring.watching = source;
    else if (!ring.sources.includes(source)) ring.sources.push(source);
  }

  /**
   * Take one source off the ring. A ring left empty restores what it found —
   * the TODO, and the notification it replaced. Never an acknowledgement.
   * Returns whether the source was there.
   */
  private withdrawRingSource(entry: AlertEntry, source: RingSource, why: RingWithdrawal): boolean {
    const ring = entry.ring;
    if (ring === null) return false;
    if (source === 'watching') {
      if (ring.watching === null) return false;
      ring.watching = null;
    } else {
      if (!ring.sources.includes(source)) return false;
      ring.sources = ring.sources.filter((candidate) => candidate !== source);
    }
    if (ring.sources.length === 0 && ring.watching === null) {
      entry.ring = null;
      entry.todo = ring.prior.todo;
      entry.notification = ring.prior.notification;
    }
    if (source === 'watching') this.watchingLeft(entry, why);
    return true;
  }

  /**
   * A user verb stops the summons: the whole ring goes, with any delivery still
   * deferred behind animation — a path that stops summoning the user must never
   * leave a timer that summons them a second later. TODO is the caller's to
   * decide. Only clearing an actual ring records an acknowledgement.
   */
  private clearRingForUser(entry: AlertEntry): void {
    this.clearDeferredNotification(entry);
    const ring = entry.ring;
    if (ring === null) return;
    entry.ring = null;
    entry.ackedQuiet = true;
    if (ring.watching !== null) this.watchingLeft(entry, 'answered');
  }

  /**
   * The ring's `watching` source is gone. An answer starts the detector over,
   * so the tail of the run that rang cannot settle again straight away; an
   * invalidation leaves it running. Last in its caller: the reset publishes.
   */
  private watchingLeft(entry: AlertEntry, why: RingWithdrawal): void {
    if (why === 'answered') entry.detector.reset();
  }

  // --- Attention tracking ---

  private hasAttention(id: string): boolean {
    return this.attentionId === id;
  }

  private clearAttentionTimer(): void {
    if (this.attentionTimer !== null) {
      clearTimeout(this.attentionTimer);
      this.attentionTimer = null;
    }
  }

  private setAttention(id: string): void {
    const previousAttentionId = this.attentionId;
    if (previousAttentionId && previousAttentionId !== id && this.armCommandExitOnAttentionLoss(previousAttentionId)) {
      this.notify(previousAttentionId);
    }
    this.attentionId = id;
    this.clearAttentionTimer();
    this.attentionTimer = setTimeout(() => {
      if (this.attentionId === id) {
        this.attentionId = null;
        if (this.armCommandExitOnAttentionLoss(id)) {
          this.notify(id);
        }
      }
      this.attentionTimer = null;
    }, this.inactivityTimeoutMs);
  }

  attend(id: string): void {
    if (this.inert(id)) return;
    const entry = this.getOrCreateEntry(id);
    this.setAttention(id);
    // A ring already set TODO, so clearing it leaves the TODO behind.
    this.clearRingForUser(entry);
    this.markCommandExitSeen(entry);
    this.notify(id);
  }

  clearAttention(id?: string): void {
    if (id !== undefined && (this.attentionId !== id || this.helpers.has(id))) return;
    const lostAttentionId = this.attentionId;
    this.attentionId = null;
    this.clearAttentionTimer();
    if (lostAttentionId && this.armCommandExitOnAttentionLoss(lostAttentionId)) {
      this.notify(lostAttentionId);
    }
  }

  // --- Alert controls ---

  dismissAlert(id: string): void {
    if (this.suspendedForTransfer.has(id)) return;
    const entry = this.entries.get(id);
    if (!entry) return;

    // Dismissing a ring leaves its TODO behind, so the summons is not lost. A
    // Session with nothing ringing has nothing to dismiss, and must keep any
    // notification still deferred behind animation.
    if (entry.ring === null) return;
    this.clearRingForUser(entry);
    this.notify(id);
  }

  // --- Todo controls ---

  toggleTodo(id: string): void {
    if (this.inert(id)) return;
    const entry = this.getOrCreateEntry(id);
    this.setTodoForUser(id, entry, !entry.todo);
  }

  clearTodo(id: string): void {
    if (this.inert(id)) return;
    this.setTodoForUser(id, this.getOrCreateEntry(id), false);
  }

  /** A TODO verb: off drops the notification, and either way the ring goes
   *  with any deferred notification. `notify` dedupes unchanged state. */
  private setTodoForUser(id: string, entry: AlertEntry, todo: TodoState): void {
    entry.todo = todo;
    if (!todo) entry.notification = null;
    this.clearRingForUser(entry);
    this.notify(id);
  }

  // --- Query ---

  getState(id: string): AlertState {
    const entry = this.entries.get(id);
    if (!entry || this.helpers.has(id)) return DEFAULT_ALERT_STATE;
    return {
      status: this.getProjectedStatus(entry),
      watchingEnabled: this.isWatching(entry),
      todo: entry.todo,
      notification: entry.notification,
      awaited: (this.awaits.get(id)?.waiters.size ?? 0) > 0,
      episode: entry.ring?.episode ?? null,
    };
  }

  getAllStates(): Map<string, AlertState> {
    const result = new Map<string, AlertState>();
    for (const [id] of this.entries) {
      if (!this.helpers.has(id)) result.set(id, this.getState(id));
    }
    return result;
  }

  /** Completely remove alert state for a PTY (used when PTY is destroyed) */
  remove(id: string): void {
    this.suspendedForTransfer.delete(id);
    this.liveReplay.delete(id);
    this.removed.add(id);
    // Nobody parked here has anything left to wait for.
    this.settleWaiters(id, 'died');
    // Claimants go with the Session, entry or not — a dead Session dispatches
    // nothing, so holding their closures would only leak them.
    this.claimants.delete(id);
    const entry = this.entries.get(id);
    if (entry) {
      this.clearDeferredNotification(entry);
      entry.detector.dispose();
      this.entries.delete(id);
      if (this.attentionId === id) {
        this.attentionId = null;
        this.clearAttentionTimer();
      }
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
    if (this.inert(id)) return;
    const entry = this.getOrCreateEntry(id);
    entry.todo = state.todo === true;
    entry.notification = entry.todo ? normalizeActivityNotification(state.notification) : null;
    entry.ring = null;
    entry.ackedQuiet = false;
    entry.progress = null;
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    this.clearDeferredNotification(entry);
    // Restore must never carry detector state either.
    entry.detector.reset();
    this.notify(id);
  }

  /** Whether `id` drops reports, controls and awaits: a helper, or a Session
   *  suspended for a live handoff. The output and command-state feeds, which a
   *  helper keeps, check the suspension alone. */
  private inert(id: string): boolean {
    return this.helpers.has(id) || this.suspendedForTransfer.has(id);
  }

  /** Suspend at the output mark. Parked await callers receive an explicit cancellation. */
  pauseForTransfer(id: string): AlertRuntimeSnapshot | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.settleWaiters(id, 'cancelled');
    if (this.attentionId === id) {
      this.attentionId = null;
      this.clearAttentionTimer();
      this.armCommandExitOnAttentionLoss(id);
    }
    this.suspendedForTransfer.add(id);
    const { detector, deferredTimer: _timer, ...state } = entry;
    const snapshot = structuredClone({ ...state, detector: detector.snapshot() });
    detector.dispose();
    if (entry.deferredTimer !== null) clearTimeout(entry.deferredTimer);
    entry.deferredTimer = null;
    return snapshot;
  }

  /** Resume live state before replay; unlike seed, this preserves the ring and
   *  its episode identity. `replayRequestId` names the one since-mark replay that
   *  `applyReplay` treats as live output. */
  resumeFromTransfer(id: string, snapshot: AlertRuntimeSnapshot, replayRequestId?: string): void {
    if (this.helpers.has(id)) return;
    this.suspendedForTransfer.delete(id);
    this.removed.delete(id);
    if (replayRequestId === undefined) this.liveReplay.delete(id);
    else this.liveReplay.set(id, replayRequestId);
    const entry = this.getOrCreateEntry(id);
    entry.detector.dispose();
    if (entry.deferredTimer !== null) clearTimeout(entry.deferredTimer);
    const { detector, ...state } = structuredClone(snapshot);
    Object.assign(entry, state);
    entry.deferredTimer = null;
    entry.detector = this.createDetector(id);
    entry.detector.restore(detector);
    this.withdrawUncoveredWatchingRing(entry);
    if (entry.deferred) {
      if (this.deferAlertsUntilQuiet) this.scheduleDeferredNotification(id, entry);
      else this.flushDeferredNotification(id, entry);
    }
    this.notify(id);
  }

  /**
   * Feed a `pty:replay` chunk. Historical replay applies semantic events alone;
   * only the live since-mark replay of a Workspace handoff, matched by its
   * request token, counts as output and fires notification events
   * (`docs/specs/alert.md` → Live Workspace transfer). Returns the semantic
   * events for the terminal-state store.
   */
  applyReplay(id: string, requestId: string | undefined, parsed: TerminalProtocolParseResult): TerminalSemanticEvent[] {
    if (requestId !== undefined && this.liveReplay.get(id) === requestId) {
      this.liveReplay.delete(id);
      if (parsed.visibleData.length) this.onData(id);
      // The caller records the replay's Tool reports for either kind.
      return applyTerminalEvents(this, id, parsed.events);
    }
    const events = collectTerminalSemanticEvents(parsed.events);
    this.applyTerminalSemanticEvents(id, events);
    return events;
  }

  dispose(): void {
    // Settled first, while listeners are still attached: a parked caller that
    // never hears an outcome absorbed a completion it never delivered.
    for (const id of [...this.awaits.keys()]) this.settleWaiters(id, 'cancelled');
    for (const entry of this.entries.values()) {
      this.clearDeferredNotification(entry);
      entry.detector.dispose();
    }
    this.entries.clear();
    this.suspendedForTransfer.clear();
    this.liveReplay.clear();
    this.removed.clear();
    this.helpers.clear();
    this.awaits.clear();
    this.claimants.clear();
    this.listeners.clear();
    this.lastEmitted.clear();
    this.clearAttentionTimer();
  }

  // --- Internals ---

  /**
   * The entry a raw-output event should feed, or `null` if the Session was
   * removed and nothing has claimed the id since. Such an event may still be a
   * live Session's first, so the entry is created on demand — but a retired one
   * must not be rebuilt by bytes that were already on their way when the pane
   * was killed (see `removed`).
   */
  private streamEntry(id: string): AlertEntry | null {
    if (this.removed.has(id) || this.suspendedForTransfer.has(id)) return null;
    return this.getOrCreateEntry(id);
  }

  /**
   * The entry a semantic or protocol event should feed. Unlike raw output, one
   * of these is evidence that a live Session owns the id — including a
   * replacement pane that reused it — so it retires the tombstone.
   */
  private reportedEntry(id: string): AlertEntry {
    this.removed.delete(id);
    return this.getOrCreateEntry(id);
  }

  private getProjectedStatus(entry: AlertEntry): SessionStatus {
    if (entry.ring !== null) return 'ALERT_RINGING';
    if (entry.progress !== null) return 'OSC_NOTIF_BUSY';
    // WATCHING outranks the command-exit arm: a watched command is by
    // definition running, so COMMAND_EXIT_ARMED would otherwise mask the
    // detector's busy/quiet states for the entire run. The detector is derived
    // from real output, so it is the more informative of the two.
    if (this.isWatching(entry)) return entry.detector.getStatus();
    if (entry.commandExitWatch?.armed) return 'COMMAND_EXIT_ARMED';
    return 'WATCHING_DISABLED';
  }

  private getOrCreateEntry(id: string): AlertEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        detector: this.createDetector(id),
        ring: null,
        ackedQuiet: false,
        progress: null,
        commandExitWatch: null,
        pendingCommandLine: null,
        todo: false,
        notification: null,
        deferred: null,
        deferredTimer: null,
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

function alertStatesEqual(a: AlertState, b: AlertState): boolean {
  if (
    a.status !== b.status
    || a.watchingEnabled !== b.watchingEnabled
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
