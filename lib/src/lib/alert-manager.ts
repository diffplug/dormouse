import { QuiesceDetector, type QuiesceStatus } from './quiesce-detector';
import { cfg } from '../cfg';
import {
  commandArgv0,
  resolveCommandStart,
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

export const ACTIVITY_NOTIFICATION_SOURCES = ['OSC 9', 'OSC 9;4', 'OSC 99', 'OSC 777', 'BEL', 'COMMAND_EXIT'] as const;
export type ActivityNotificationSource = typeof ACTIVITY_NOTIFICATION_SOURCES[number];

export interface ActivityNotification {
  source: ActivityNotificationSource;
  title: string | null;
  body: string | null;
}

export type ProtocolProgressState = 'clear' | 'normal' | 'warning' | 'indeterminate' | 'error';

export interface ProtocolProgressUpdate {
  state: ProtocolProgressState;
  percent: number | null;
}

type ProtocolStatus = 'IDLE' | 'OSC_NOTIF_BUSY' | 'ALERT_RINGING';
type CommandExitStatus = 'IDLE' | 'COMMAND_EXIT_ARMED' | 'ALERT_RINGING';
type ActiveProtocolProgressState = 'normal' | 'warning' | 'indeterminate';

interface ActiveProtocolProgress {
  state: ActiveProtocolProgressState;
  percent: number | null;
}

interface CommandExitWatch {
  displayCommand: string;
  /** Bare program name the WATCHING rule set is keyed on; null without shell integration. */
  argv0: string | null;
  source: CommandRunSource;
  startedAt: number;
  seenWithAttentionAt: number | null;
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
      argv0: string | null;
      exitCode: number | undefined;
      /** Wall time from commandStart to this finish. */
      ranMs: number;
      /** The command-exit track was armed (attention was lost mid-run) when it finished. */
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

/**
 * Grace window: the detector's own floor for reaching BUSY, so a caller that
 * arrives before the peer's first byte cannot be told "nothing is happening"
 * before the machine it is watching could possibly have reported. Derived from
 * `cfg.alert`, not a new number.
 */
export const AWAIT_GRACE_MS = cfg.alert.busyCandidateGap + cfg.alert.busyConfirmGap;

/**
 * Ceiling on a parked await, matching `dor await --timeout`'s own 24h cap. It
 * exists here because the value ends up in `setTimeout`, whose delay is a
 * *signed 32-bit* millisecond count: anything above ~24.9 days silently
 * overflows and fires on the next tick, turning a long park into an instant
 * `timeout`. Rejecting is therefore safer than clamping — a caller asking for
 * more than a day is confused, not patient.
 */
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
  status: SessionStatus;
  watchingEnabled: boolean;
  todo: TodoState;
  notification: ActivityNotification | null;
  /** Used by the bell transition table to detect a post-attention dismiss */
  attentionDismissedRing: boolean;
  /** At least one `dor await` is parked on this Session. Never persisted. */
  awaited: boolean;
}

export const DEFAULT_ALERT_STATE: AlertState = {
  status: 'WATCHING_DISABLED',
  watchingEnabled: false,
  todo: false,
  notification: null,
  attentionDismissedRing: false,
  awaited: false,
};

/**
 * Three independent alarm tracks per Session, unioned into one public status.
 * Each track is IDLE -> (a busy/armed state) -> ringing, and each ring latches
 * in the entry until it is attended, dismissed, or TODO'd.
 *
 * The output/silence detector is not one of the tracks: it runs for every
 * Session for its whole lifetime and never latches anything. WATCHING is the
 * policy gate — whether the watched-commands rule set matches the foreground
 * command (`isWatching`) — and it decides both whether the detector's state is
 * publicly visible and whether a settle is allowed to ring. The ring itself
 * latches in `watchingRingingCommand`, which is why it survives the command
 * exiting (the same moment that usually turns WATCHING off).
 */
interface AlertEntry {
  /** Always-on output/silence detector. Never disposed before the entry is. */
  detector: QuiesceDetector;
  /** Command rule that raised the latched WATCHING ring, even after command exit. */
  watchingRingingCommand: string | null;
  protocolStatus: ProtocolStatus;
  progress: ActiveProtocolProgress | null;
  commandExitStatus: CommandExitStatus;
  commandExitWatch: CommandExitWatch | null;
  pendingCommandLine: string | null;
  todo: TodoState;
  notification: ActivityNotification | null;
  attentionDismissedRing: boolean;
}

/**
 * Manages the always-on output/silence detectors, attention tracking, the
 * WATCHING rule set, and todo state for PTY sessions.
 *
 * Every completion runs the same three steps in order: **observe** — a settle,
 * a command finish, or a notification/progress cycle end becomes a
 * `CompletionEvent`; **claim** — registered claimants get first refusal in
 * registration order, and a claimed event stops there; **ring rule** — only an
 * unclaimed event reaches its track's suppression rules and may latch a ring.
 * `dispatchCompletion` is the single place those ring rules live, so an
 * observer (`dor await`) can see completions that never ring a human.
 *
 * Portable — no DOM dependencies. Can run in the extension host (VSCode),
 * in the webview adapter (Tauri), or in tests.
 */
export class AlertManager {
  private entries = new Map<string, AlertEntry>();
  /**
   * Sessions `remove()` has retired, until something proves the id is live
   * again. `disposeSession` calls `alertRemove` and only *then* kills the PTY,
   * so output already in flight keeps arriving after the entry is gone — and
   * every PTY-driven entry point creates the entry it cannot find. Without
   * this, each killed pane that was still producing output leaves behind a
   * fresh `AlertEntry` and `QuiesceDetector` that nothing will ever dispose.
   *
   * Raw output and resizes cannot lift it: they are exactly what a dying PTY
   * emits, and they carry no evidence that anyone is home. A semantic or
   * protocol event does lift it, because an id can be handed to a *new*
   * Session (a replacement pane reuses it, and the WATCHING rule set is
   * supposed to apply immediately), and a command start is the first thing
   * that Session reports.
   */
  private removed = new Set<string>();
  private claimants = new Map<string, Set<CompletionClaimant>>();
  private awaits = new Map<string, AwaitGroup>();
  private attentionId: string | null = null;
  private attentionTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(id: string, state: AlertState) => void>();
  private lastEmitted = new Map<string, AlertState>();
  private watchedCommands = new Set<string>();
  private inactivityTimeoutMs = cfg.alert.userAttention;

  // --- Settings ---

  /**
   * The walk-away window (`docs/specs/alert.md` -> Attention): how long
   * "looking at this pane" lasts, and — because the same idea gates it — the
   * minimum runtime a command needs before its exit is allowed to ring.
   *
   * `AlertSettingsHost` clamps before this is reached, but the value originates
   * in a renderer and ends up in `setTimeout`, so nonsense is rejected here too
   * rather than trusted from one caller away.
   */
  setInactivityTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this.inactivityTimeoutMs) return;
    this.inactivityTimeoutMs = ms;
    // Re-arm from now so a shortened window takes effect immediately instead of
    // waiting out the window that was already running.
    if (this.attentionTimer !== null && this.attentionId !== null) {
      this.setAttention(this.attentionId);
    }
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
    this.eachWaiter(id, (waiter) => waiter.onOutput());
  }

  onExit(id: string, exitCode?: number): void {
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
   * Replace the set of command names WATCHING applies to (`docs/specs/alert.md`).
   * Pushed from the renderer, which owns the persisted copy — the extension host
   * has no `localStorage` of its own.
   */
  setWatchedCommands(names: string[]): void {
    const next = new Set(names);
    if (next.size === this.watchedCommands.size && [...next].every((name) => this.watchedCommands.has(name))) return;
    this.watchedCommands = next;
    for (const [id, entry] of this.entries) {
      // Dropping a rule is an explicit "stop alerting on this", so it also
      // silences the ring that rule already raised. The originating key stays
      // latched after command exit precisely so this still works at a prompt.
      if (
        entry.watchingRingingCommand !== null
        && !this.watchedCommands.has(entry.watchingRingingCommand)
      ) {
        entry.watchingRingingCommand = null;
      }
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
   * WATCHING follows the foreground command's name: on while a watched command
   * runs, off at the prompt. The detector keeps running either way; this only
   * decides whether its state is public and whether a settle rings.
   */
  private isWatching(entry: AlertEntry): boolean {
    const argv0 = entry.commandExitWatch?.argv0 ?? null;
    return argv0 !== null && this.watchedCommands.has(argv0);
  }

  private createDetector(id: string): QuiesceDetector {
    return new QuiesceDetector({
      // Detector state is public only while WATCHING, so only then can a
      // transition change the projection.
      onChange: () => {
        const entry = this.entries.get(id);
        if (entry && this.isWatching(entry)) this.notify(id);
      },
      onSettled: () => this.onSettled(id),
    });
  }

  /** A busy Session went quiet. Whether that rings is decided downstream. */
  private onSettled(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.dispatchCompletion(id, entry, { kind: 'settled' });
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
   * Observe -> claim -> ring rule, for all three tracks. Every ring rule lives
   * here and nowhere else, so a track's emit site only has to describe what
   * happened; the decision to bother a human is made once, after the claimants
   * have passed on it. Returns whether a claimant took the event.
   */
  private dispatchCompletion(id: string, entry: AlertEntry, event: CompletionEvent): boolean {
    // Snapshot: a claimant may unregister itself (or register another) while
    // being offered this very event.
    const claimants = [...(this.claimants.get(id) ?? [])];
    if (claimants.some((claimant) => claimant(event))) return true;

    switch (event.kind) {
      case 'settled':
        // Only a watched command rings, and only if the user is not looking at
        // it right now. The originating command key latches here so the ring
        // outlives the command that raised it.
        if (!this.isWatching(entry) || this.hasAttention(id)) break;
        entry.watchingRingingCommand = entry.commandExitWatch?.argv0 ?? null;
        this.notify(id);
        break;
      case 'commandFinished':
        if (!event.armed || this.hasAttention(id) || event.ranMs < this.inactivityTimeoutMs) break;
        this.setCommandExitRinging(id, entry, event.displayCommand, event.exitCode);
        break;
      case 'notification':
        if (this.hasAttention(id)) {
          // A progress cycle was already cleared before dispatch, so publish
          // that; a plain direct notification changes nothing and dedupes away.
          this.notify(id);
          break;
        }
        this.setProtocolRinging(id, entry, event.notification);
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
   * the one latch it resolved on and leaving TODO, notification detail, and
   * attention exactly as they were.
   */
  awaitCompletion(id: string, options: AwaitOptions): AwaitHandle {
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
   * Consume the ring an await arriving right now would resolve on, if any.
   * Only that track's latch is released: TODO, its notification detail, and
   * `attentionDismissedRing` are the human's and stay untouched.
   *
   * Two of the three are gated, because their latches outlive the fact they
   * describe.
   *
   * The command-exit ring outlives the run that raised it —
   * `startCommandExitWatch` deliberately preserves `ALERT_RINGING` — so once a
   * *new* foreground command is running it can only describe a previous one,
   * and consuming it would answer "the command exited" about the command still
   * running. That is precisely the misreport `dor send` followed by `dor await
   * --until exit` would act on, so a running `commandExitWatch` suppresses it
   * and the await parks for the real exit instead.
   *
   * The WATCHING ring is the same hazard one level down. It legitimately
   * describes the command still running — a long-running watched command going
   * quiet is the `claude` case `--until quiet` exists for — but it is an
   * *inference from silence*, not a discrete event, and nothing clears it when
   * output resumes. Consuming a latched ring after a `dor send` restarted the
   * peer would answer "output stopped" about a turn that is mid-flight, and the
   * documented `await && read` idiom would read a half-drawn screen. So it is
   * consumed only while the detector still agrees nothing is happening; once
   * output has resumed the await parks for the real settle.
   *
   * The protocol ring is ungated: `OSC 9` is a discrete "I need input" that
   * stays true until it is answered, so a peer ringing mid-run still means what
   * it said whenever the await arrives.
   */
  private consumeAwaitableRing(entry: AlertEntry, until: AwaitUntil): AwaitCause | null {
    if (until === 'quiet' && this.releaseRing(entry, 'protocol')) return 'bell';
    if (entry.commandExitWatch === null && this.releaseRing(entry, 'commandExit')) return 'exit';
    if (
      until === 'quiet'
      && entry.detector.getStatus() === 'NOTHING_TO_SHOW'
      && this.releaseRing(entry, 'watching')
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

  // --- Terminal-report protocol track ---

  notifyFromProtocol(id: string, notification: ActivityNotification): void {
    const entry = this.reportedEntry(id);
    const normalized = normalizeActivityNotification(notification);
    if (!normalized) return;

    this.dispatchCompletion(id, entry, { kind: 'notification', notification: normalized });
  }

  updateProtocolProgress(id: string, progress: ProtocolProgressUpdate): void {
    const entry = this.reportedEntry(id);

    if (progress.state === 'clear') {
      if (!entry.progress) return;
      this.completeProtocolProgress(id, entry, entry.progress);
      return;
    }

    if (progress.state === 'error') {
      this.finishProtocolProgressCycle(id, entry, 'Progress error', progress.percent);
      return;
    }

    if (progress.state === 'normal' && progress.percent === 100) {
      this.completeProtocolProgress(id, entry, {
        state: entry.progress?.state === 'warning' ? 'warning' : 'normal',
        percent: progress.percent,
      });
      return;
    }

    if (
      entry.protocolStatus === 'OSC_NOTIF_BUSY'
      && entry.progress?.state === progress.state
      && entry.progress?.percent === progress.percent
    ) {
      return;
    }

    entry.progress = { state: progress.state, percent: progress.percent };
    entry.protocolStatus = 'OSC_NOTIF_BUSY';
    this.notify(id);
  }

  private completeProtocolProgress(id: string, entry: AlertEntry, progress: ActiveProtocolProgress): void {
    const title = progress.state === 'warning' ? 'Progress warning' : 'Progress complete';
    this.finishProtocolProgressCycle(id, entry, title, progress.percent);
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
    title: string,
    percent: number | null,
  ): void {
    entry.progress = null;
    if (entry.protocolStatus === 'OSC_NOTIF_BUSY') entry.protocolStatus = 'IDLE';
    const claimed = this.dispatchCompletion(id, entry, {
      kind: 'notification',
      notification: {
        source: 'OSC 9;4',
        title,
        body: percent === null ? null : `Progress ${Math.round(percent)}%`,
      },
    });
    // Clearing the cycle is publicly visible (`OSC_NOTIF_BUSY` falls back); the
    // ring rules publish it themselves, a claim stops before they run.
    if (claimed) this.notify(id);
  }

  private setProtocolRinging(id: string, entry: AlertEntry, notification: ActivityNotification): void {
    entry.notification = notification;
    entry.todo = true;
    entry.protocolStatus = 'ALERT_RINGING';
    entry.progress = null;
    this.notify(id);
  }

  // --- Command-exit track ---

  applyTerminalSemanticEvents(id: string, events: TerminalSemanticEvent[]): void {
    if (events.length === 0) return;
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
          // stops here even if the shell never sent a finish event.
          if (entry.pendingCommandLine !== null || entry.commandExitWatch !== null) {
            this.finishCommandExitWatch(id, entry, undefined);
            changed = true;
          }
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
    if (entry.commandExitStatus !== 'ALERT_RINGING') entry.commandExitStatus = 'IDLE';
    entry.commandExitWatch = {
      displayCommand: resolved.displayCommand,
      argv0: resolved.rawCommandLine === null ? null : commandArgv0(resolved.rawCommandLine),
      source: resolved.source,
      startedAt: resolved.startedAt,
      seenWithAttentionAt: this.hasAttention(id) ? Date.now() : null,
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
    const wasArmed = entry.commandExitStatus === 'COMMAND_EXIT_ARMED';
    if (entry.commandExitStatus !== 'ALERT_RINGING') {
      entry.commandExitStatus = 'IDLE';
    }

    // Every finish is observable, including the short, unarmed, and attended
    // ones that can never ring — the ring rule is what filters them.
    if (watch !== null) {
      this.dispatchCompletion(id, entry, {
        kind: 'commandFinished',
        displayCommand: watch.displayCommand,
        argv0: watch.argv0,
        exitCode,
        ranMs: Date.now() - watch.startedAt,
        armed: wasArmed,
      });
    }

    // The command boundary reset, covering commandFinish, promptStart/End, and
    // PTY exit. Last, so the reset's own `onChange` cannot publish a
    // half-finished projection.
    entry.detector.reset();
    // Clearing the watch turns WATCHING off, which flips `watchingEnabled` and
    // the status even when command-exit never armed, so subscribers must hear
    // about any finish — `notify` dedupes if nothing is visible.
    return watch !== null;
  }

  private markCommandExitSeen(entry: AlertEntry): void {
    const watch = entry.commandExitWatch;
    if (!watch) return;
    if (watch.seenWithAttentionAt === null) watch.seenWithAttentionAt = Date.now();
    if (entry.commandExitStatus === 'COMMAND_EXIT_ARMED') entry.commandExitStatus = 'IDLE';
  }

  private armCommandExitOnAttentionLoss(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.commandExitWatch) return false;
    if (entry.commandExitStatus !== 'IDLE') return false;
    if (entry.commandExitWatch.seenWithAttentionAt === null) return false;
    entry.commandExitStatus = 'COMMAND_EXIT_ARMED';
    return true;
  }

  /** The watch record is already gone by the time this runs, so it takes the text it needs. */
  private setCommandExitRinging(
    id: string,
    entry: AlertEntry,
    displayCommand: string,
    exitCode: number | undefined,
  ): void {
    entry.commandExitStatus = 'ALERT_RINGING';
    entry.todo = true;
    // A protocol ring carries richer text; never overwrite it with the generic one.
    if (entry.protocolStatus !== 'ALERT_RINGING') {
      entry.notification = {
        source: 'COMMAND_EXIT',
        title: 'Command finished',
        body: formatCommandExitBody(displayCommand, exitCode),
      };
    }
    this.notify(id);
  }

  /** Release every latched ring across the three tracks. Returns whether any was active. */
  private clearAllRingsIfActive(entry: AlertEntry): boolean {
    // Release all three, no short-circuit.
    const released = [
      this.releaseRing(entry, 'protocol'),
      this.releaseRing(entry, 'commandExit'),
      this.releaseRing(entry, 'watching'),
    ];
    return released.includes(true);
  }

  /** Release one track's latched ring. Returns whether it was ringing. */
  private releaseRing(entry: AlertEntry, track: 'protocol' | 'commandExit' | 'watching'): boolean {
    switch (track) {
      case 'protocol':
        if (entry.protocolStatus !== 'ALERT_RINGING') return false;
        entry.protocolStatus = 'IDLE';
        entry.progress = null;
        return true;
      case 'commandExit':
        if (entry.commandExitStatus !== 'ALERT_RINGING') return false;
        entry.commandExitStatus = 'IDLE';
        return true;
      case 'watching':
        if (entry.watchingRingingCommand === null) return false;
        entry.watchingRingingCommand = null;
        // Releasing a WATCHING ring starts the detector over, so the tail of
        // the run that just rang cannot immediately settle again.
        entry.detector.reset();
        return true;
    }
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

  /** Mark that the user is paying attention to this session. */
  attend(id: string): void {
    const entry = this.getOrCreateEntry(id);
    this.setAttention(id);

    if (this.clearAllRingsIfActive(entry)) {
      entry.attentionDismissedRing = true;
      entry.todo = true;
    }
    this.markCommandExitSeen(entry);
    this.notify(id);
  }

  clearAttention(id?: string): void {
    if (id !== undefined && this.attentionId !== id) return;
    const lostAttentionId = this.attentionId;
    this.attentionId = null;
    this.clearAttentionTimer();
    if (lostAttentionId && this.armCommandExitOnAttentionLoss(lostAttentionId)) {
      this.notify(lostAttentionId);
    }
  }

  // --- Alert controls ---

  dismissAlert(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const dismissed = this.clearAllRingsIfActive(entry);
    if (dismissed) entry.todo = true;
    // The flag exists so the next bell click opens the dialog instead of
    // silently changing a rule; an explicit dismiss *is* that next click.
    const hadFlag = entry.attentionDismissedRing;
    entry.attentionDismissedRing = false;

    if (dismissed || hadFlag) this.notify(id);
  }

  // --- Todo controls ---

  toggleTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    entry.todo = !entry.todo;
    if (!entry.todo) entry.notification = null;
    this.clearAllRingsIfActive(entry);
    this.notify(id);
  }

  markTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    const cleared = this.clearAllRingsIfActive(entry);
    if (entry.todo && !cleared) return;
    entry.todo = true;
    this.notify(id);
  }

  clearTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    if (!entry.todo) return;
    entry.todo = false;
    entry.notification = null;
    this.clearAllRingsIfActive(entry);
    this.notify(id);
  }

  // --- Query ---

  getState(id: string): AlertState {
    const entry = this.entries.get(id);
    if (!entry) return DEFAULT_ALERT_STATE;
    return {
      status: this.getProjectedStatus(entry),
      watchingEnabled: this.isWatching(entry),
      todo: entry.todo,
      notification: entry.notification,
      attentionDismissedRing: entry.attentionDismissedRing,
      awaited: (this.awaits.get(id)?.waiters.size ?? 0) > 0,
    };
  }

  getAllStates(): Map<string, AlertState> {
    const result = new Map<string, AlertState>();
    for (const [id] of this.entries) {
      result.set(id, this.getState(id));
    }
    return result;
  }

  /** Completely remove alert state for a PTY (used when PTY is destroyed) */
  remove(id: string): void {
    this.removed.add(id);
    // Nobody parked here has anything left to wait for.
    this.settleWaiters(id, 'died');
    // Claimants go with the Session, entry or not — a dead Session dispatches
    // nothing, so holding their closures would only leak them.
    this.claimants.delete(id);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.detector.dispose();
    this.entries.delete(id);
    if (this.attentionId === id) {
      this.attentionId = null;
      this.clearAttentionTimer();
    }
    this.notify(id);
  }

  /**
   * Seed alert state from a persisted session (cold-start restore). Only the
   * TODO reminder and its notification detail survive a restart — WATCHING is
   * re-derived from the rule set at the next command start, and restore must
   * never resurrect a ring or an in-flight progress cycle.
   */
  seed(id: string, state: { todo: unknown; notification?: unknown }): void {
    const entry = this.getOrCreateEntry(id);
    entry.todo = state.todo === true;
    entry.notification = entry.todo ? normalizeActivityNotification(state.notification) : null;
    entry.watchingRingingCommand = null;
    entry.protocolStatus = 'IDLE';
    entry.progress = null;
    entry.commandExitStatus = 'IDLE';
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    // Restore must never carry detector state either.
    entry.detector.reset();
    this.notify(id);
  }

  dispose(): void {
    // Settled first, while listeners are still attached: a parked caller that
    // never hears an outcome absorbed a completion it never delivered.
    for (const id of [...this.awaits.keys()]) this.settleWaiters(id, 'cancelled');
    for (const entry of this.entries.values()) {
      entry.detector.dispose();
    }
    this.entries.clear();
    this.removed.clear();
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
    if (this.removed.has(id)) return null;
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
    if (
      entry.protocolStatus === 'ALERT_RINGING'
      || entry.commandExitStatus === 'ALERT_RINGING'
      || entry.watchingRingingCommand !== null
    ) return 'ALERT_RINGING';
    if (entry.protocolStatus === 'OSC_NOTIF_BUSY') return 'OSC_NOTIF_BUSY';
    // WATCHING outranks the command-exit arm: a watched command is by
    // definition running, so COMMAND_EXIT_ARMED would otherwise mask the
    // detector's busy/quiet states for the entire run. The detector is derived
    // from real output, so it is the more informative of the two.
    if (this.isWatching(entry)) return entry.detector.getStatus();
    if (entry.commandExitStatus === 'COMMAND_EXIT_ARMED') return 'COMMAND_EXIT_ARMED';
    return 'WATCHING_DISABLED';
  }

  private getOrCreateEntry(id: string): AlertEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        detector: this.createDetector(id),
        watchingRingingCommand: null,
        protocolStatus: 'IDLE',
        progress: null,
        commandExitStatus: 'IDLE',
        commandExitWatch: null,
        pendingCommandLine: null,
        todo: false,
        notification: null,
        attentionDismissedRing: false,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private notify(id: string): void {
    const state = this.getState(id);
    const last = this.lastEmitted.get(id);
    if (last && alertStatesEqual(last, state)) return;
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
    || a.attentionDismissedRing !== b.attentionDismissedRing
    || a.awaited !== b.awaited
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

function formatCommandExitBody(displayCommand: string, exitCode: number | undefined): string {
  const command = displayCommand.trim() || DEFAULT_COMMAND_TITLE;
  if (exitCode === undefined) return command;
  return `${command} exited ${exitCode}`;
}
