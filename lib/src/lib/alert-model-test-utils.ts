/**
 * The driver for `alert-model.test.ts`: a real `AlertManager` and the real
 * delivery scheduler under fake timers, fed random sequences of the events the
 * alert layer accepts, read after every step, and held to the state diagrams
 * of `docs/specs/alert.md` -> "State machines" and to the invariants its rules
 * state. Nothing here models the alert logic: the diagrams are the oracle.
 *
 * - **Reading.** `read` maps the manager onto each diagram's state names. What
 *   `AlertState` does not show (Hold, Acknowledged, the input windows, Quiet
 *   vs Candidate, Active vs Ending, Seen vs Unseen) it reads from the manager's
 *   private fields by element access, which `tsc` type-checks: a renamed field
 *   fails the build, never the reading. An await's Grace vs Parked and a
 *   delivery's Pending vs Spent live in closures, so those instances are read
 *   as the set of both, and the diagram's exact triggers tell them apart.
 * - **Binding.** `BINDINGS` gives every drawn edge, by its exact text, the
 *   predicate saying its trigger happened in a step, in the words of the spec's
 *   Terms list (input, gesture, verb, output, work, withdraw, reset, command
 *   boundary). A diagram edit changes a key, which fails the binding check
 *   until the table follows it.
 * - **Checking.** `ModelTracker` (soundness and coverage) and `INVARIANTS`
 *   after every step; `runAlertModel` replays a list, `generateAlertModel`
 *   draws one from a seed.
 */
import { vi } from 'vitest';
import { cfg } from '../cfg';
import {
  AlertManager,
  DEFAULT_ALERT_STATE,
  MAX_AWAIT_TIMEOUT_MS,
  type ActivityNotification,
  type AlertState,
  type AwaitHandle,
  type AwaitOutcome,
  type AwaitUntil,
  type ProtocolProgressState,
} from './alert-manager';
import { createAlertDeliveryScheduler, type AlertDeliveryScheduler } from './alert-delivery-scheduler';
import type { AlertSink } from './alert-delivery-model';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from './alert-settings-model';
import { watchRuleFor } from './terminal-state';
import type { DiagramMachine } from './mermaid-state-diagram-test-utils';
import { ModelTracker, mulberry32, pickWeighted, type MachineBinding } from './state-model-test-utils';

/** The Session every machine is read on; `T` is only somewhere else to focus. */
export const S = 'surface:1';
export const T = 'surface:2';
const VIEWER_IDS = ['V1', 'V2'] as const;
type ViewerId = typeof VIEWER_IDS[number];
const LABEL = 'pane label';

// ---------------------------------------------------------------------------
// Events: everything the alert layer accepts, one manager call (or two) each.

export type AlertModelEvent =
  /** The application alarm defaults, as the host's settings store installs them. */
  | { k: 'settings'; speak: boolean; push: boolean; speakDelayMs: number; pushDelayMs: number }
  /** A painting output chunk. */
  | { k: 'output' }
  /** A keystroke: a gesture with input, and input. */
  | { k: 'key' }
  /** A wheel tick sent as a mouse report: a gesture with input, not input. */
  | { k: 'wheel' }
  /** A program's write (`dor send`, a launch): input, no gesture. */
  | { k: 'send' }
  /** A terminal reply: neither. */
  | { k: 'reply' }
  | { k: 'start'; line: string }
  | { k: 'finish'; code: number }
  | { k: 'prompt' }
  /** PTY exit. */
  | { k: 'exit'; code: number }
  | { k: 'report'; source: 'OSC 9' | 'OSC 777' | 'BEL' }
  | { k: 'progress'; state: ProtocolProgressState; percent: number | null }
  | { k: 'present'; viewer: ViewerId; focus: 'S' | 'T' | null }
  | { k: 'idle'; viewer: ViewerId }
  | { k: 'leave'; viewer: ViewerId }
  /** The viewer's realm ends (`removeViewer`). */
  | { k: 'realmEnd'; viewer: ViewerId }
  /** A gesture without input: a Pane click, a Door, a tab's pill. */
  | { k: 'click' }
  /** `a`. */
  | { k: 'dismiss' }
  /** The Pane header's TODO pill. */
  | { k: 'pill' }
  /** `t`. */
  | { k: 't' }
  | { k: 'rule'; key: string; on: boolean }
  | { k: 'await'; until: AwaitUntil; timeoutMs: number }
  /** Cancel the nth await parked so far (`dor` hung up, the realm reaped it). */
  | { k: 'cancel'; nth: number }
  /** The host stops the run itself (`silenceRun`). */
  | { k: 'interrupt' }
  | { k: 'remove' }
  /** A new PTY generation; `todo`/`clean` seed it from a persisted state. */
  | { k: 'respawn'; seed: 'none' | 'todo' | 'clean' }
  | { k: 'helper'; on: boolean }
  | { k: 'sink'; sink: AlertSink; on: boolean }
  | { k: 'wait'; ms: number }
  /** Run exactly the next timer. */
  | { k: 'tick' }
  | { k: 'dispose' };

type Kind = AlertModelEvent['k'];
type Of<K extends Kind> = Extract<AlertModelEvent, { k: K }>;

/** An event as a TypeScript literal, to paste into a test. */
export function formatEvent(event: AlertModelEvent): string {
  const fields = Object.entries(event).map(([name, value]) =>
    `${name}: ${typeof value === 'string' ? `'${value}'` : String(value)}`);
  return `{ ${fields.join(', ')} }`;
}

const REPORTS: Record<Of<'report'>['source'], ActivityNotification> = {
  'OSC 9': { source: 'OSC 9', title: null, body: 'needs input' },
  'OSC 777': { source: 'OSC 777', title: 'build', body: 'done' },
  BEL: { source: 'BEL', title: 'Terminal bell', body: null },
};

const RESTORED: ActivityNotification = { source: 'OSC 9', title: null, body: 'restored' };

// ---------------------------------------------------------------------------
// The world: one manager, its delivery scheduler, and what they told us.

interface AwaitRecord {
  n: number;
  until: AwaitUntil;
  timeoutMs: number;
  handle: AwaitHandle;
  arrivedStep: number;
  arrivedAt: number;
  outcome: AwaitOutcome | null;
  settledStep: number | null;
}

interface DeliveryRecord {
  sink: AlertSink;
  episode: string | null;
  title: string | null;
  step: number;
}

interface Emission {
  step: number;
  state: AlertState;
  /** Sent as the entry went: whatever comes next is a first state again. */
  discard: boolean;
}

class World {
  readonly manager = new AlertManager();
  readonly scheduler: AlertDeliveryScheduler;
  settings: AlertSettings = DEFAULT_ALERT_SETTINGS;
  /** Each viewer's last report, as the events sent it. */
  readonly reports = new Map<ViewerId, { present: boolean; focus: string | null }>();
  readonly awaits: AwaitRecord[] = [];
  readonly deliveries: DeliveryRecord[] = [];
  readonly emissions: Emission[] = [];
  step = -1;
  disposed = false;

  constructor() {
    this.scheduler = createAlertDeliveryScheduler({
      manager: this.manager,
      speak: (id, episodeId) => {
        if (id === S) this.deliveries.push({ sink: 'speech', episode: episodeId, title: null, step: this.step });
      },
      push: (id, title) => {
        if (id !== S) return;
        // A push names no episode: it is the Ring's current one.
        const episode = this.manager['entries'].get(S)?.ring?.episode.id ?? null;
        this.deliveries.push({ sink: 'push', episode, title, step: this.step });
      },
    });
    this.scheduler.publish('realm', { [S]: { label: LABEL, overrides: {} } });
    this.manager.onStateChange((id, state) => {
      if (id === S) this.emissions.push({ step: this.step, state, discard: !this.manager['entries'].has(S) });
    });
  }

  apply(event: AlertModelEvent): void {
    const { manager } = this;
    switch (event.k) {
      case 'settings':
        this.settings = {
          ...DEFAULT_ALERT_SETTINGS,
          speakEnabled: event.speak, pushEnabled: event.push,
          speakDelayMs: event.speakDelayMs, pushDelayMs: event.pushDelayMs,
        };
        this.scheduler.setDefaults(this.settings);
        return;
      case 'sink':
        this.settings = { ...this.settings, [event.sink === 'speech' ? 'speakEnabled' : 'pushEnabled']: event.on };
        this.scheduler.setDefaults(this.settings);
        return;
      case 'output': return manager.onData(S);
      case 'key': return manager.onWrite(S, 'x', { userInput: true });
      case 'wheel': return manager.onWrite(S, '\x1b[<64;10;10M', { userInput: true });
      case 'send': return manager.onWrite(S, '\r');
      case 'reply': return manager.onWrite(S, '\x1b[?1;2c');
      case 'start':
        return manager.applyTerminalSemanticEvents(S, [
          { type: 'commandLine', commandLine: event.line },
          { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
        ]);
      case 'finish': return manager.applyTerminalSemanticEvents(S, [{ type: 'commandFinish', exitCode: event.code }]);
      case 'prompt': return manager.applyTerminalSemanticEvents(S, [{ type: 'promptStart' }]);
      case 'exit': return manager.onExit(S, event.code);
      case 'report': return manager.notifyFromProtocol(S, REPORTS[event.source]);
      case 'progress': return manager.updateProtocolProgress(S, { state: event.state, percent: event.percent });
      case 'present':
        this.reports.set(event.viewer, { present: true, focus: focusId(event.focus) });
        return manager.setViewer(event.viewer, { present: true, focusId: focusId(event.focus) });
      case 'idle': {
        const focus = this.reports.get(event.viewer)?.focus ?? null;
        this.reports.set(event.viewer, { present: false, focus });
        return manager.setViewer(event.viewer, { present: false, focusId: focus }, 'idle');
      }
      case 'leave':
        this.reports.set(event.viewer, { present: false, focus: null });
        return manager.setViewer(event.viewer, { present: false, focusId: null }, 'leave');
      case 'realmEnd':
        this.reports.set(event.viewer, { present: false, focus: null });
        return manager.removeViewer(event.viewer);
      case 'click': return manager.acknowledge(S, { input: false });
      case 'dismiss': return manager.dismissAlert(S);
      case 'pill': return manager.clearTodo(S);
      case 't': return manager.toggleTodo(S);
      case 'rule': return manager.setCommandWatched(event.key, event.on);
      case 'await': {
        const record: AwaitRecord = {
          n: this.awaits.length, until: event.until, timeoutMs: event.timeoutMs,
          handle: manager.awaitCompletion(S, { until: event.until, timeoutMs: event.timeoutMs }),
          arrivedStep: this.step, arrivedAt: Date.now(), outcome: null, settledStep: null,
        };
        this.awaits.push(record);
        void record.handle.promise.then((outcome) => {
          record.outcome = outcome;
          record.settledStep = this.step;
        });
        return;
      }
      case 'cancel': {
        const record = this.awaits[event.nth];
        record?.handle.cancel();
        return;
      }
      case 'interrupt': return manager.silenceRun(S);
      case 'remove': return manager.remove(S);
      case 'respawn':
        manager.restart(S);
        if (event.seed !== 'none') {
          manager.seed(S, event.seed === 'todo' ? { todo: true, notification: RESTORED } : { todo: false, notification: null });
        }
        return;
      case 'helper': return manager.setHelper(S, event.on);
      case 'wait':
        vi.advanceTimersByTime(event.ms);
        return;
      case 'tick':
        vi.advanceTimersToNextTimer();
        return;
      case 'dispose':
        this.disposed = true;
        this.scheduler.dispose();
        manager.dispose();
        return;
    }
  }
}

function focusId(focus: 'S' | 'T' | null): string | null {
  return focus === 'S' ? S : focus === 'T' ? T : null;
}

// ---------------------------------------------------------------------------
// Reading: the manager mapped onto each diagram's state names.

/** The machines a Session's entry holds, and so starts over with. */
const ENTRY_MACHINES = ['Echo', 'Work', 'Detector', 'Progress', 'Command', 'Ring', 'Hold', 'Todo', 'Acked'] as const;
type EntryMachine = typeof ENTRY_MACHINES[number];

/** What a ring or a hold holds: its sources (`watching:<key>` for that one) and its detail. */
interface Latch {
  episode: string | null;
  sources: string[];
  watchingKey: string | null;
  /** Work arrived since `watching` joined (`docs/specs/alert.md` -> Await). */
  workSince: boolean | null;
  detail: ActivityNotification;
}

export interface Snap {
  now: number;
  entry: object | null;
  helper: boolean;
  /** The id is retired: removed, no new generation since. */
  retired: boolean;
  /** Each present viewer's focus, as the manager holds it. */
  viewers: ReadonlyMap<string, string | null>;
  engaged: boolean;
  /** Each entry machine's state; empty without an entry. */
  state: Partial<Record<EntryMachine, string>>;
  ring: Latch | null;
  held: Latch | null;
  /** The running command's watch key, if any. */
  watchKey: string | null;
  todo: boolean;
  /** The TODO's own detail (the ring shows its own). */
  todoDetail: ActivityNotification | null;
  echoUntil: number;
  workExpectedAt: number;
  ackedUntil: number;
  /** The detector's last counted chunk, null without candidate history. */
  lastOutputAt: number | null;
  published: AlertState;
  rules: string[];
}

/** Candidate history counts this long after its last chunk (`QuiesceDetector.onData`). */
const CANDIDATE_TTL_MS = cfg.alert.busyCandidateGap + cfg.alert.busyConfirmGap;

function read(world: World): Snap {
  const { manager } = world;
  const now = Date.now();
  const entry = world.disposed ? undefined : manager['entries'].get(S);
  const viewers = new Map(manager['viewers']);
  const state: Partial<Record<EntryMachine, string>> = {};
  let ring: Latch | null = null;
  let held: Latch | null = null;
  if (entry) {
    const detector = entry.detector;
    const status = detector['status'];
    const last = detector['lastOutputAt'];
    state.Echo = now < entry.echoUntil ? 'EchoOpen' : 'EchoShut';
    state.Work = now - detector['lastWorkExpectedAt'] <= cfg.alert.workStartWindow ? 'WorkOpen' : 'WorkShut';
    state.Detector = status !== 'NOTHING_TO_SHOW' ? status
      : detector['firstOutputAt'] !== null && last !== null && now - last <= CANDIDATE_TTL_MS ? 'Candidate' : 'Quiet';
    state.Progress = entry.progress === null ? 'NoCycle' : entry.progress.end === null ? 'Active' : 'Ending';
    state.Command = entry.commandExitWatch === null ? 'NoCommand' : entry.commandExitWatch.seen ? 'Seen' : 'Unseen';
    state.Ring = entry.ring === null ? 'NoRing' : 'Ringing';
    state.Hold = entry.held === null ? 'NoHold' : entry.leaveGrace !== null ? 'Leaving' : 'Held';
    state.Todo = entry.todo ? 'On' : 'Off';
    state.Acked = now < entry.ackedUntil ? 'Yes' : 'Fresh';
    const latch = (from: NonNullable<typeof entry.ring> | NonNullable<typeof entry.held>, episode: string | null): Latch => ({
      episode,
      sources: [...from.sources, ...(from.watching ? [`watching:${from.watching.key}`] : [])].sort(),
      watchingKey: from.watching?.key ?? null,
      workSince: from.watching?.workSince ?? null,
      detail: from.detail,
    });
    if (entry.ring) ring = latch(entry.ring, entry.ring.episode.id);
    if (entry.held) held = latch(entry.held, null);
  }
  return {
    now,
    entry: entry ?? null,
    helper: !world.disposed && manager['helpers'].has(S),
    retired: !world.disposed && manager['removed'].has(S),
    viewers,
    engaged: !world.disposed && manager.isEngaged(S),
    state,
    ring,
    held,
    watchKey: entry?.commandExitWatch?.watchKey ?? null,
    todo: entry?.todo ?? false,
    todoDetail: entry?.notification ?? null,
    echoUntil: entry?.echoUntil ?? 0,
    workExpectedAt: entry ? entry.detector['lastWorkExpectedAt'] : -Infinity,
    ackedUntil: entry?.ackedUntil ?? 0,
    lastOutputAt: entry ? entry.detector['lastOutputAt'] : null,
    published: world.disposed ? DEFAULT_ALERT_STATE : manager.getState(S),
    rules: world.disposed ? [] : manager.getWatchedCommands(),
  };
}

// ---------------------------------------------------------------------------
// One step, as every binding and invariant sees it.

export interface Step {
  ev: AlertModelEvent;
  index: number;
  pre: Snap;
  post: Snap;
  world: World;
  /** Set for the Viewer, Await, and Delivery instances' own bindings. */
  viewer?: ViewerId;
  await?: AwaitRecord;
  delivery?: DeliveryInstance;
}

const is = (step: Step, ...kinds: Kind[]): boolean => kinds.includes(step.ev.k);

// The spec's Terms (`docs/specs/alert.md` -> State machines), over one step.

/** Time passed and nothing else happened. */
const time = (s: Step) => is(s, 'wait', 'tick');
/** A command boundary: a command start or finish, a prompt, or PTY exit. */
const boundary = (s: Step) => is(s, 'start', 'finish', 'prompt', 'exit');
/** Input: a PTY write but a terminal reply or a mouse report. */
const input = (s: Step) => is(s, 'key', 'send');
/** An acknowledging gesture, with input or without (Engagement). */
const gesture = (s: Step) => is(s, 'key', 'wheel', 'click');
const gestureWithInput = (s: Step) => is(s, 'key', 'wheel');
/** A user verb that acts: a helper's gestures and TODO controls do not
 *  (`docs/specs/alert.md` -> Pane Header). */
const verb = (s: Step) => s.ev.k === 'dismiss' || (is(s, 'key', 'wheel', 'click', 'pill', 't') && !s.pre.helper);
const activeProgress = (s: Step) => s.ev.k === 'progress' && !s.pre.helper && isActiveProgress(s.ev);
const endProgress = (s: Step) => s.ev.k === 'progress' && !s.pre.helper && !isActiveProgress(s.ev);
function isActiveProgress(ev: Of<'progress'>): boolean {
  return ev.state === 'warning' || ev.state === 'indeterminate' || (ev.state === 'normal' && ev.percent !== 100);
}
/** Output: a painting chunk outside an Open echo window that, while the
 *  detector is quiet with no candidate, also falls inside an Open work-start window. */
const output = (s: Step) => s.ev.k === 'output' && s.pre.state.Echo === 'EchoShut'
  && !(s.pre.state.Detector === 'Quiet' && s.pre.state.Work === 'WorkShut');
/** Work: output, or an active progress update. */
const work = (s: Step) => output(s) || activeProgress(s);
/** Watched: a rule covers the running command's watch key. */
const watched = (snap: Snap) => watchRuleFor(new Set(snap.rules), snap.watchKey) !== null;
/** A settle: the detector fell quiet from waiting for silence, no cycle holding it back. */
const settled = (s: Step) => time(s) && s.pre.state.Progress === 'NoCycle'
  && (s.pre.state.Detector === 'BUSY' || s.pre.state.Detector === 'MIGHT_NEED_ATTENTION') && s.post.state.Detector === 'Quiet';
/** A cycle's end counted: a report, unless a gesture with input settled it inside its echo window. */
const progressReport = (s: Step) => (time(s) || boundary(s)) && s.pre.state.Progress === 'Ending' && s.post.state.Progress !== 'Ending';
/** Held sources going back to Dispatch: an idle lapse, or the leave grace with no viewer present. */
const escalated = (s: Step) => (s.ev.k === 'idle' && s.pre.state.Hold === 'Held')
  || (time(s) && s.pre.state.Hold === 'Leaving' && s.post.viewers.size === 0);
/** A completion Dispatch may ring or hold, past the helper gate: a settle
 *  while watched, a command finish from Seen, or a report
 *  (`docs/specs/alert.md` -> Completion events); or a held source going back
 *  to Dispatch, which passes that gate and goes on at Engaged?. */
const completion = (s: Step) => !s.pre.helper && (escalated(s)
  || (settled(s) && watched(s.pre))
  || (is(s, 'finish', 'prompt', 'exit') && s.pre.state.Command === 'Seen')
  || s.ev.k === 'report' || progressReport(s));
const awaitsSettledNow = (s: Step) => s.world.awaits.filter((record) => record.settledStep === s.index);
/** Withdraw: an await consumes a source, an await claims a settle, or a rule stops covering `watching`'s key. */
const withdraw = (s: Step) => (s.ev.k === 'await' && s.world.awaits[s.world.awaits.length - 1]?.outcome?.kind === 'resolved')
  || (time(s) && awaitsSettledNow(s).some((record) => record.outcome?.kind === 'resolved' && record.outcome.cause === 'quiet'))
  || (s.ev.k === 'rule' && !s.ev.on);
const hadWatching = (snap: Snap) => snap.ring?.watchingKey != null || snap.held?.watchingKey != null;
const progressEnded = (s: Step) => s.pre.state.Progress !== undefined && s.pre.state.Progress !== 'NoCycle' && s.post.state.Progress === 'NoCycle';
/** Reset: a command boundary, a cycle's end, a host interrupt, or a verb or await answering a `watching` source. */
const reset = (s: Step) => boundary(s) || progressEnded(s) || is(s, 'interrupt') || ((verb(s) || is(s, 'await')) && hadWatching(s.pre));
const ringOpened = (s: Step) => s.post.ring !== null && s.post.ring.episode !== s.pre.ring?.episode;
const engagedAgain = (s: Step) => !s.pre.engaged && s.post.engaged;
/** Engagement left Engaged this step, by `lapse`. */
function disengaged(s: Step, lapse: 'idle' | 'leave' | 'focus'): boolean {
  if (!s.pre.engaged || s.post.engaged) return false;
  if (lapse === 'idle') return s.ev.k === 'idle';
  if (lapse === 'leave') return is(s, 'leave', 'realmEnd');
  return s.ev.k === 'present';
}
/** Hold: a completion dispatched while Engaged (an escalation goes back to Dispatch disengaged). */
const hold = (s: Step) => completion(s) && !escalated(s) && (s.pre.engaged || s.post.engaged);
const sameDetail = (a: ActivityNotification | null, b: ActivityNotification | null) =>
  a === b || (a !== null && b !== null && a.source === b.source && a.title === b.title && a.body === b.body);
/** The latch changed its sources or detail, staying the same latch. */
function latchMoved(s: Step, which: 'ring' | 'held'): boolean {
  const before = s.pre[which];
  const after = s.post[which];
  if (before === null || after === null || before.episode !== after.episode) return false;
  return before.sources.join() !== after.sources.join() || !sameDetail(before.detail, after.detail);
}
const focusedS = (s: Step, viewer: string) => s.pre.viewers.get(viewer) === S;
const viewerOfEvent = (s: Step): string | null => 'viewer' in s.ev ? s.ev.viewer : null;
/** The viewer that moved was the one focusing S. */
const lastFocuserMoved = (s: Step) => {
  const viewer = viewerOfEvent(s);
  return viewer !== null && focusedS(s, viewer);
};

// Await and Delivery instances.

const arriving = (s: Step) => s.await !== undefined && s.await.arrivedStep === s.index;
const settledNow = (s: Step) => s.await !== undefined && s.await.settledStep === s.index && s.await.arrivedStep !== s.index;
const outcomeIs = (s: Step, kind: AwaitOutcome['kind']) => s.await?.outcome?.kind === kind;
const invalidTimeout = (ms: number) => !Number.isFinite(ms) || ms <= 0 || ms > MAX_AWAIT_TIMEOUT_MS;
/** The arrival fails at once: an invalid request, a helper, a removed Session. */
const failsOnArrival = (s: Step) => invalidTimeout(s.await!.timeoutMs) || s.pre.helper || s.pre.retired;
/**
 * The causes a latched source offers an await arriving now: a report always
 * (`bell`), `exit` only with nothing running, `watching` only under `quiet`
 * with no work since it joined (`docs/specs/alert.md` -> Await).
 */
function offeredCauses(snap: Snap, until: AwaitUntil): Set<string> {
  const causes = new Set<string>();
  for (const latch of [snap.ring, snap.held]) {
    if (!latch) continue;
    if (until === 'quiet' && latch.sources.includes('report')) causes.add('bell');
    if (latch.sources.includes('exit') && (snap.state.Command ?? 'NoCommand') === 'NoCommand') causes.add('exit');
    if (until === 'quiet' && latch.watchingKey !== null && latch.workSince === false) causes.add('quiet');
  }
  return causes;
}
/** The step could hand an await this cause (`docs/specs/alert.md` -> Await). */
function claimFits(s: Step): boolean {
  const outcome = s.await?.outcome;
  if (outcome?.kind !== 'resolved' || outcome.cause === 'idle') return false;
  if (s.await!.until === 'exit' && outcome.cause !== 'exit') return false;
  switch (outcome.cause) {
    case 'exit': return is(s, 'finish', 'prompt', 'exit');
    case 'quiet': return time(s);
    case 'bell': return time(s) || boundary(s) || gestureWithInput(s) || s.ev.k === 'report';
  }
}

interface DeliveryInstance {
  key: string;
  episode: string;
  sink: AlertSink;
  dueAt: number;
  onAtOpen: boolean;
  openedStep: number;
}

const opening = (s: Step) => s.delivery!.openedStep === s.index;
const sinkTurnedOff = (s: Step) => (s.ev.k === 'sink' && s.ev.sink === s.delivery!.sink && !s.ev.on)
  || (s.ev.k === 'settings' && !(s.delivery!.sink === 'speech' ? s.ev.speak : s.ev.push));
const due = (s: Step) => time(s) && s.post.now >= s.delivery!.dueAt;
/** Speech spares an engaged Session; a push waits until no viewer is present. */
const blocked = (s: Step) => s.delivery!.sink === 'speech' ? s.post.engaged : s.post.viewers.size > 0;
/** The episode is one Ringing stretch of the Ring. */
const episodeEnded = (s: Step) => s.post.ring?.episode !== s.delivery!.episode;
/** The Session was made a helper (Pane Header), which ends no episode. */
const demoted = (s: Step) => s.ev.k === 'helper' && s.ev.on && !s.pre.helper;

// ---------------------------------------------------------------------------
// Every drawn edge, by its exact text, and the step that fires it.

const always = () => true;

export const BINDINGS: Readonly<Record<string, MachineBinding<Step>>> = {
  Viewer: {
    accept: {
      'Viewer: [*] --> Absent': always,
      'Viewer: Absent --> Present: activity, or focus or visibility returns, in an active window': (s) => s.ev.k === 'present' && s.ev.viewer === s.viewer,
      'Viewer: Present --> Present: activity, or its focus moves': (s) => s.ev.k === 'present' && s.ev.viewer === s.viewer,
      'Viewer: Present --> Absent: idle — no activity for the inactivity timeout, no iframe holding focus': (s) => s.ev.k === 'idle' && s.ev.viewer === s.viewer,
      'Viewer: Present --> Absent: leave — blur without document focus, hide, or the realm ends': (s) => is(s, 'leave', 'realmEnd') && viewerOfEvent(s) === s.viewer,
    },
  },
  Engagement: {
    accept: {
      'Engagement: [*] --> NotEngaged': always,
      'Engagement: NotEngaged --> Engaged: a Present viewer focuses it': (s) => s.ev.k === 'present' && s.ev.focus === 'S',
      'Engagement: Engaged --> NotEngaged: idle — its last focusing viewer goes idle': (s) => s.ev.k === 'idle' && lastFocuserMoved(s),
      'Engagement: Engaged --> NotEngaged: leave — its last focusing viewer leaves': (s) => is(s, 'leave', 'realmEnd') && lastFocuserMoved(s),
      'Engagement: Engaged --> NotEngaged: focus moves on — its last focusing viewer, still Present, focuses elsewhere': (s) => s.ev.k === 'present' && s.ev.focus !== 'S' && lastFocuserMoved(s),
    },
  },
  Echo: {
    accept: {
      'Echo: [*] --> EchoShut': always,
      'Echo: EchoShut --> EchoOpen: a gesture with input': gestureWithInput,
      'Echo: EchoOpen --> EchoOpen: a gesture with input, restarting it': (s) => gestureWithInput(s) && s.post.echoUntil > s.pre.echoUntil,
      'Echo: EchoOpen --> EchoShut: echo window elapses': (s) => time(s) && s.post.now >= s.pre.echoUntil,
    },
  },
  Work: {
    accept: {
      'Work: [*] --> WorkShut': always,
      'Work: WorkShut --> WorkOpen: input, or an active progress update': (s) => input(s) || activeProgress(s),
      'Work: WorkOpen --> WorkOpen: input or an active progress update, restarting it': (s) => (input(s) || activeProgress(s)) && s.post.workExpectedAt > s.pre.workExpectedAt,
      'Work: WorkOpen --> WorkShut: work-start window elapses': (s) => time(s) && s.post.now - s.pre.workExpectedAt > cfg.alert.workStartWindow,
    },
  },
  Detector: {
    accept: {
      'Detector: [*] --> Quiet': always,
      'Detector: Quiet --> Candidate: output': output,
      'Detector: Candidate --> Candidate: output within the candidate gap': output,
      'Detector: Candidate --> MIGHT_BE_BUSY: a second chunk, once the candidate gap has passed': (s) => output(s) || time(s),
      'Detector: Candidate --> Quiet: candidate history expires, or reset': (s) =>
        (time(s) && s.pre.lastOutputAt !== null && s.post.now - s.pre.lastOutputAt > CANDIDATE_TTL_MS) || reset(s),
      'Detector: MIGHT_BE_BUSY --> BUSY: output': output,
      'Detector: MIGHT_BE_BUSY --> Candidate: no output for the confirm gap, the last chunk a new candidate': time,
      'Detector: MIGHT_BE_BUSY --> Quiet: reset': reset,
      'Detector: BUSY --> BUSY: output': output,
      'Detector: BUSY --> MIGHT_NEED_ATTENTION: silence': time,
      'Detector: BUSY --> Quiet: reset': reset,
      'Detector: MIGHT_NEED_ATTENTION --> BUSY: output': output,
      'Detector: MIGHT_NEED_ATTENTION --> Quiet: more silence — a settle, unless the progress cycle is Active or Ending': time,
      'Detector: MIGHT_NEED_ATTENTION --> Quiet: reset': reset,
    },
  },
  Progress: {
    accept: {
      'Progress: [*] --> NoCycle': always,
      'Progress: NoCycle --> Active: normal below 100, warning, or indeterminate': activeProgress,
      'Progress: Active --> Active: another of those': activeProgress,
      'Progress: Active --> Ending: normal 100, clear, or error': endProgress,
      'Progress: Active --> NoCycle: command boundary or host interrupt': (s) => boundary(s) || is(s, 'interrupt'),
      'Progress: Ending --> Active: normal below 100, warning, or indeterminate': activeProgress,
      'Progress: Ending --> Ending: normal 100, clear, or error, the first end standing': endProgress,
      'Progress: Ending --> NoCycle: the end grace elapses, a gesture with input, or a command boundary — a reset, then a report': (s) => time(s) || (gestureWithInput(s) && !s.pre.helper) || boundary(s),
      'Progress: Ending --> NoCycle: host interrupt': (s) => is(s, 'interrupt'),
      'Progress: NoCycle --> NoCycle: normal 100, clear, or error': endProgress,
    },
  },
  Command: {
    accept: {
      'Command: [*] --> NoCommand': always,
      'Command: NoCommand --> Seen: start while Engaged': (s) => s.ev.k === 'start' && s.pre.engaged,
      'Command: NoCommand --> Unseen: start while NotEngaged': (s) => s.ev.k === 'start' && !s.pre.engaged,
      'Command: Unseen --> Seen: Engaged, or a gesture': (s) => engagedAgain(s) || (gesture(s) && !s.pre.helper),
      'Command: Unseen --> NoCommand: finish, prompt, or PTY exit — an unseen command finish': (s) => is(s, 'finish', 'prompt', 'exit'),
      'Command: Seen --> NoCommand: finish, prompt, or PTY exit — a command finish': (s) => is(s, 'finish', 'prompt', 'exit'),
      'Command: Unseen --> NoCommand: host interrupt, or another start before its own start edge': (s) => is(s, 'interrupt', 'start'),
      'Command: Seen --> NoCommand: host interrupt, or another start before its own start edge': (s) => is(s, 'interrupt', 'start'),
    },
  },
  Ring: {
    accept: {
      'Ring: [*] --> NoRing': always,
      'Ring: NoRing --> Ringing: ring — an episode opens': completion,
      'Ring: Ringing --> Ringing: ring, detail only if richer, or withdraw leaving other sources': (s) => (completion(s) || withdraw(s)) && latchMoved(s, 'ring'),
      'Ring: Ringing --> NoRing: a verb — the episode ends': verb,
      'Ring: Ringing --> NoRing: withdraw of its last source — the episode ends': withdraw,
    },
  },
  Hold: {
    accept: {
      'Hold: [*] --> NoHold': always,
      'Hold: NoHold --> Held: hold': hold,
      'Hold: Held --> Held: hold, detail only if richer, or withdraw leaving other sources': (s) => (hold(s) || withdraw(s)) && latchMoved(s, 'held'),
      'Hold: Held --> NoHold: Engagement idle — each source back to Dispatch': (s) => disengaged(s, 'idle'),
      'Hold: Held --> NoHold: Engagement focus moves on, or a verb': (s) => disengaged(s, 'focus') || verb(s),
      'Hold: Held --> NoHold: withdraw of its last source': withdraw,
      'Hold: Held --> Leaving: Engagement leave': (s) => disengaged(s, 'leave'),
      'Hold: Leaving --> Held: Engaged again': engagedAgain,
      'Hold: Leaving --> Leaving: withdraw leaving other sources': (s) => withdraw(s) && latchMoved(s, 'held'),
      'Hold: Leaving --> NoHold: the leave grace elapses with no viewer Present — each source back to Dispatch': (s) => time(s) && s.post.viewers.size === 0,
      'Hold: Leaving --> NoHold: the leave grace elapses with a viewer Present, a verb, or withdraw of its last source': (s) => (time(s) && s.post.viewers.size > 0) || verb(s) || withdraw(s),
    },
  },
  Todo: {
    accept: {
      'Todo: [*] --> Off': always,
      'Todo: [*] --> On: restored': (s) => s.ev.k === 'respawn' && s.ev.seed === 'todo',
      'Todo: Off --> On: hold, t, or a gesture without input or dismiss while Ringing': (s) => hold(s) || (s.ev.k === 't' && !s.pre.helper)
        || (s.pre.state.Ring === 'Ringing' && ((s.ev.k === 'click' && !s.pre.helper) || s.ev.k === 'dismiss')),
      "Todo: On --> On: hold or receipt, detail only if richer, or a gesture without input or dismiss while Ringing, taking the ring's detail": (s) => completion(s)
        || (s.pre.state.Ring === 'Ringing' && ((s.ev.k === 'click' && !s.pre.helper) || s.ev.k === 'dismiss')),
      'Todo: On --> Off: a gesture with input, the pill, or t': (s) => is(s, 'key', 'wheel', 'pill', 't') && !s.pre.helper,
    },
  },
  Acked: {
    accept: {
      'Acked: [*] --> Fresh': always,
      'Acked: Fresh --> Yes: a verb while Ringing, Held, or Leaving': (s) => verb(s)
        && (s.pre.state.Ring === 'Ringing' || s.pre.state.Hold === 'Held' || s.pre.state.Hold === 'Leaving'),
      'Acked: Yes --> Fresh: work, ring, a command start, or three minutes': (s) => work(s) || ringOpened(s) || s.ev.k === 'start'
        || (time(s) && s.post.now >= s.pre.ackedUntil),
    },
  },
  Delivery: {
    accept: {
      'Delivery: [*] --> Pending: the episode opens, the sink on': (s) => opening(s) && s.delivery!.onAtOpen,
      'Delivery: [*] --> Spent: the episode opens, the sink off': (s) => opening(s) && !s.delivery!.onAtOpen,
      'Delivery: Pending --> Delivered: due, not blocked': (s) => due(s) && !blocked(s),
      'Delivery: Pending --> Spent: due while blocked, the sink turned off, a demotion to helper, or the episode ends': (s) =>
        (due(s) && blocked(s)) || sinkTurnedOff(s) || demoted(s) || episodeEnded(s),
      'Delivery: Delivered --> [*]': always,
      'Delivery: Spent --> [*]': always,
    },
    // Pending and Spent read alike, so every trigger out of Pending is exact.
    exact: new Set([
      'Delivery: Pending --> Delivered: due, not blocked',
      'Delivery: Pending --> Spent: due while blocked, the sink turned off, a demotion to helper, or the episode ends',
    ]),
  },
  Await: {
    accept: {
      'Await: [*] --> arrive': arriving,
      'Await: arrive --> Failed: an invalid request or a helper Session — cancelled': (s) => arriving(s) && outcomeIs(s, 'cancelled')
        && (invalidTimeout(s.await!.timeoutMs) || s.pre.helper),
      'Await: arrive --> Failed: the Session already removed — died': (s) => arriving(s) && outcomeIs(s, 'died') && s.pre.retired,
      'Await: arrive --> Resolved: Ringing, else a hold, with a source it accepts — withdraw it': (s) => arriving(s) && !failsOnArrival(s)
        && s.await!.outcome?.kind === 'resolved' && offeredCauses(s.pre, s.await!.until).has(s.await!.outcome.cause),
      'Await: arrive --> Parked: Seen or Unseen': (s) => arriving(s) && !failsOnArrival(s) && offeredCauses(s.pre, s.await!.until).size === 0
        && (s.pre.state.Command === 'Seen' || s.pre.state.Command === 'Unseen'),
      'Await: arrive --> Grace: NoCommand': (s) => arriving(s) && !failsOnArrival(s) && offeredCauses(s.pre, s.await!.until).size === 0
        && (s.pre.state.Command ?? 'NoCommand') === 'NoCommand',
      'Await: Grace --> Parked: a command start, or work under quiet': (s) => !arriving(s) && (s.ev.k === 'start' || (s.await!.until === 'quiet' && work(s))),
      'Await: Grace --> Resolved: grace elapses — idle': (s) => settledNow(s) && time(s) && s.await!.outcome?.kind === 'resolved' && s.await!.outcome.cause === 'idle',
      'Await: Grace --> Resolved: claimed': (s) => settledNow(s) && claimFits(s),
      'Await: Parked --> Resolved: claimed': (s) => settledNow(s) && claimFits(s),
      'Await: Grace --> Failed: the ceiling — timeout, PTY exit or removal — died, a cancel, its realm ending, or disposal — cancelled': (s) => settledNow(s) && failedFits(s),
      'Await: Parked --> Failed: the ceiling — timeout, PTY exit or removal — died, a cancel, its realm ending, or disposal — cancelled': (s) => settledNow(s) && failedFits(s),
    },
    // Grace and Parked read alike; a command start or work under quiet must move it.
    exact: new Set(['Await: Grace --> Parked: a command start, or work under quiet']),
  },
};

function failedFits(s: Step): boolean {
  switch (s.await!.outcome?.kind) {
    case 'timeout': return time(s);
    case 'died': return is(s, 'exit', 'remove', 'respawn');
    case 'cancelled': return (s.ev.k === 'cancel' && s.ev.nth === s.await!.n) || s.ev.k === 'dispose';
    default: return false;
  }
}

/** Machines this driver does not run, and why. */
export const NOT_DRIVEN: Readonly<Record<string, string>> = {
  Speech: 'renderer-side (`startAlertSpeech`, `SpeechQueue`, the stubbed engine): needs a second, jsdom driver',
};

// ---------------------------------------------------------------------------
// Invariants the rules state, checked after every step.

const RANK: Record<ActivityNotification['source'], number> = {
  // `docs/specs/alert.md` -> Clearing And TODO: a text report > COMMAND_EXIT > OSC 9;4 > WATCHING > BEL.
  'OSC 9': 4, 'OSC 99': 4, 'OSC 777': 4, COMMAND_EXIT: 3, 'OSC 9;4': 2, WATCHING: 1, BEL: 0,
};

const ringing = (state: AlertState) => state.status === 'ALERT_RINGING';
/** What a realm reads of a state (`docs/specs/alert.md` -> Public State). */
const realmView = (state: AlertState) => JSON.stringify([
  ringing(state), state.episode?.id ?? null, state.todo, state.awaited,
  state.notification && [state.notification.source, state.notification.title, state.notification.body],
]);
const totalSources = (snap: Snap) => (snap.ring?.sources.length ?? 0) + (snap.held?.sources.length ?? 0);

export interface Invariant {
  /** `Heading: rule`, the key a `KNOWN` entry names. */
  key: string;
  /** A description of the breach, or null. */
  check(s: Step): string | null;
}

export const INVARIANTS: readonly Invariant[] = [
  {
    key: 'Public State: status is the first matching rung of the ladder',
    check(s) {
      const { post } = s;
      if (!post.entry || post.helper) return null;
      const { state, published } = post;
      const detector = state.Detector === 'Quiet' || state.Detector === 'Candidate' ? 'NOTHING_TO_SHOW' : state.Detector;
      const expected = state.Ring === 'Ringing' ? 'ALERT_RINGING'
        : state.Progress !== 'NoCycle' ? 'OSC_NOTIF_BUSY'
          : published.watchingEnabled ? detector
            : state.Command === 'Seen' && !post.engaged ? 'COMMAND_EXIT_ARMED'
              : 'WATCHING_DISABLED';
      return published.status === expected ? null : `status ${published.status}, the ladder gives ${expected}`;
    },
  },
  {
    key: 'Public State: an episode exactly while ringing',
    check: ({ post }) => (post.published.episode !== null) === ringing(post.published) ? null
      : `episode ${post.published.episode ? 'set' : 'null'} with status ${post.published.status}`,
  },
  {
    key: 'Public State: realms are sent every change to what they read, and only those',
    check(s) {
      const emitted = s.world.emissions;
      const mine = emitted.filter((emission) => emission.step === s.index);
      for (const emission of mine) {
        const before = emitted[emitted.indexOf(emission) - 1];
        // A Session's first state, or its first after the entry went, is news.
        if (before && !before.discard && realmView(before.state) === realmView(emission.state)) return 'sent a state no realm can tell from the last';
      }
      if (s.world.disposed) return null;
      const last = emitted[emitted.length - 1]?.state ?? DEFAULT_ALERT_STATE;
      return realmView(last) === realmView(s.post.published) ? null : `realms hold ${realmView(last)}, the manager ${realmView(s.post.published)}`;
    },
  },
  {
    key: 'Completion events: a claimed event never rings, sets TODO, or stores a notification',
    check(s) {
      // Only where the step dispatched one completion: a report, or one timer.
      if (!is(s, 'report', 'tick')) return null;
      if (!awaitsSettledNow(s).some((record) => record.outcome?.kind === 'resolved' && record.outcome.cause !== 'idle')) return null;
      if (ringOpened(s)) return 'a claimed completion opened a ring';
      if (s.pre.todo !== s.post.todo || !sameDetail(s.pre.todoDetail, s.post.todoDetail)) return 'a claimed completion changed the TODO';
      return null;
    },
  },
  {
    key: 'Completion events: a hold sets TODO at once',
    check: ({ post }) => post.held !== null && !post.todo ? 'a hold with TODO off' : null,
  },
  {
    key: 'Clearing And TODO: never summon twice for an acknowledged state',
    check: (s) => s.ev.k === 'report' && s.pre.state.Acked === 'Yes' && ringOpened(s) ? 'a report rang while acknowledged' : null,
  },
  {
    key: 'Clearing And TODO: a withdrawal never acknowledges, and leaves TODO as it stood',
    check(s) {
      if (!(s.ev.k === 'await' || (s.ev.k === 'rule' && !s.ev.on))) return null;
      if (s.pre.state.Acked === 'Fresh' && s.post.state.Acked === 'Yes') return 'a withdrawal acknowledged';
      if (s.pre.entry && (s.pre.todo !== s.post.todo || !sameDetail(s.pre.todoDetail, s.post.todoDetail))) return 'a withdrawal changed the TODO';
      return null;
    },
  },
  {
    key: 'Await: consuming withdraws exactly the one source it resolved on',
    check(s) {
      if (s.ev.k !== 'await') return null;
      const record = s.world.awaits[s.world.awaits.length - 1];
      if (record.outcome?.kind !== 'resolved') return null;
      const gone = totalSources(s.pre) - totalSources(s.post);
      return gone === 1 ? null : `${gone} sources withdrawn`;
    },
  },
  {
    key: 'Await: a PTY exit or removal leaves no await parked',
    check: (s) => is(s, 'exit', 'remove', 'respawn') && s.world.awaits.some((record) => record.outcome === null)
      ? 'an await still parked' : null,
  },
  {
    key: 'Await: no await outlives its ceiling',
    check: (s) => s.world.awaits.some((record) => record.outcome === null && s.post.now >= record.arrivedAt + record.timeoutMs)
      ? 'an await parked past its timeout' : null,
  },
  {
    key: 'Await: disposal cancels every parked await',
    check: (s) => s.ev.k === 'dispose' && s.world.awaits.some((record) => record.settledStep === s.index && record.outcome?.kind !== 'cancelled')
      ? 'disposal settled an await otherwise' : s.ev.k === 'dispose' && s.world.awaits.some((record) => record.outcome === null) ? 'an await still parked' : null,
  },
  {
    key: 'WATCHING Track: every command boundary resets the detector',
    check: (s) => boundary(s) && s.post.entry && s.post.state.Detector !== 'Quiet' ? `detector ${s.post.state.Detector} after a boundary` : null,
  },
  {
    key: 'WATCHING Track: never reset the detector for engagement alone',
    check: (s) => is(s, 'present', 'idle', 'leave', 'realmEnd') && s.pre.entry === s.post.entry && s.pre.state.Detector !== s.post.state.Detector
      ? `detector ${s.pre.state.Detector} -> ${s.post.state.Detector} on engagement` : null,
  },
  {
    key: 'WATCHING Track: a verb or await answering a watching source resets the detector',
    check: (s) => (verb(s) || s.ev.k === 'await') && hadWatching(s.pre) && !hadWatching(s.post) && s.post.state.Detector !== 'Quiet'
      ? `detector ${s.post.state.Detector}` : null,
  },
  {
    key: 'WATCHING Track: a latched watching source is covered by a rule',
    check(s) {
      const rules = new Set(s.post.rules);
      for (const latch of [s.post.ring, s.post.held]) {
        if (latch?.watchingKey != null && watchRuleFor(rules, latch.watchingKey) === null) return `watching:${latch.watchingKey} with no rule`;
      }
      return null;
    },
  },
  {
    key: 'WATCHING Track: a retired id stays retired',
    check: (s) => s.pre.retired && !is(s, 'respawn', 'dispose') && s.post.entry !== null ? `revived by ${s.ev.k}` : null,
  },
  {
    key: 'Clearing And TODO: destroying the Session clears all its state',
    check: (s) => s.ev.k === 'remove' && (s.post.entry !== null || realmView(s.post.published) !== realmView(DEFAULT_ALERT_STATE)) ? 'state survived removal' : null,
  },
  {
    key: 'Public State: a restore never recreates a ring, a cycle, or a command-exit arm',
    check(s) {
      if (s.ev.k !== 'respawn') return null;
      const { state } = s.post;
      if ((state.Ring ?? 'NoRing') !== 'NoRing' || (state.Progress ?? 'NoCycle') !== 'NoCycle' || (state.Command ?? 'NoCommand') !== 'NoCommand') {
        return `restored ${state.Ring}/${state.Progress}/${state.Command}`;
      }
      return s.post.todo === (s.ev.seed === 'todo') ? null : 'TODO is not the restored one';
    },
  },
  {
    key: 'Engagement: engaged exactly while some present viewer focuses it',
    check(s) {
      if (s.world.disposed) return null;
      const expected = [...s.world.reports.values()].some((report) => report.present && report.focus === S);
      return s.post.engaged === expected ? null : `engaged ${s.post.engaged}, the viewers' reports say ${expected}`;
    },
  },
  {
    key: 'Engagement: user input opens the echo window',
    check: (s) => gestureWithInput(s) && s.post.entry && s.post.state.Echo !== 'EchoOpen' ? 'echo window shut after input' : null,
  },
  {
    key: 'Engagement: acknowledging never creates an entry',
    check: (s) => is(s, 'click', 'dismiss') && !s.pre.entry && s.post.entry ? 'an entry appeared' : null,
  },
  {
    key: 'Terminal reports: a progress cycle never changes the ring, and the ring never changes it',
    check(s) {
      if (s.ev.k === 'progress' && s.pre.ring !== null && s.post.ring?.episode !== s.pre.ring.episode) return 'a progress update ended a ring';
      if (is(s, 'click', 'dismiss', 'pill', 't') && s.pre.entry === s.post.entry && s.pre.state.Progress !== s.post.state.Progress) return `${s.ev.k} moved the cycle`;
      return null;
    },
  },
  {
    key: 'Clearing And TODO: a ring shows its own detail, joined only by one as rich',
    check(s) {
      const { pre, post } = s;
      if (pre.ring === null || post.ring === null || pre.ring.episode !== post.ring.episode) return null;
      return RANK[post.ring.detail.source] >= RANK[pre.ring.detail.source] ? null
        : `${pre.ring.detail.source} replaced by ${post.ring.detail.source}`;
    },
  },
  {
    key: 'Pane Header: a helper never rings or holds',
    check: (s) => s.pre.helper && s.pre.entry === s.post.entry && (ringOpened(s) || (s.pre.held === null && s.post.held !== null))
      ? `a helper ${ringOpened(s) ? 'rang' : 'held'}` : null,
  },
  {
    key: 'Pane Header: a helper publishes only the default state',
    check: (s) => s.post.helper && realmView(s.post.published) !== realmView(DEFAULT_ALERT_STATE) ? 'a helper published state' : null,
  },
  {
    key: 'Alarm settings: at most one delivery per sink per episode',
    check(s) {
      for (const delivery of s.world.deliveries.filter((record) => record.step === s.index)) {
        const same = s.world.deliveries.filter((record) => record.sink === delivery.sink && record.episode === delivery.episode);
        if (same.length > 1) return `${delivery.sink} delivered ${same.length} times`;
      }
      return null;
    },
  },
  {
    key: 'Alarm settings: a push carries the Pane label, never the notification',
    // The label the realm published, or the fallback once its publication is gone.
    check: (s) => s.world.deliveries.some((record) => record.step === s.index && record.sink === 'push' && record.title !== LABEL && record.title !== 'terminal')
      ? 'a push titled otherwise' : null,
  },
  {
    key: 'Command-exit Track: a command merely ending never clears the ring',
    check: (s) => is(s, 'finish', 'prompt', 'exit') && s.pre.ring !== null && s.post.ring?.episode !== s.pre.ring.episode
      ? 'a command end cleared the ring' : null,
  },
];

// ---------------------------------------------------------------------------
// The run: apply, read, explain, check.

export interface Finding {
  kind: 'soundness' | 'invariant';
  key: string;
  /** Index of the failing step in the event list. */
  step: number;
  detail: string;
}

export interface RunResult {
  events: AlertModelEvent[];
  findings: Finding[];
}

/** Every machine the spec draws, and the coverage of every edge across runs. */
export interface ModelSuite {
  machines: readonly DiagramMachine[];
  coverage: Map<string, number>;
}

class Checker {
  private readonly trackers = new Map<string, ModelTracker<Step>>();
  private readonly awaitTrackers = new Map<AwaitRecord, ModelTracker<Step>>();
  private readonly deliveries = new Map<string, { instance: DeliveryInstance; tracker: ModelTracker<Step> }>();
  /** Every episode-sink ever opened: an episode opens once. */
  private readonly opened = new Set<string>();
  private readonly byId: Map<string, DiagramMachine>;
  private entry: object | null = null;

  constructor(private readonly suite: ModelSuite, private readonly bindings: Readonly<Record<string, MachineBinding<Step>>>) {
    this.byId = new Map(suite.machines.map((machine) => [machine.id, machine]));
  }

  private tracker(machine: string, instance: string): ModelTracker<Step> {
    const key = `${machine}:${instance}`;
    let tracker = this.trackers.get(key);
    if (!tracker) {
      tracker = new ModelTracker(this.byId.get(machine)!, instance, this.bindings[machine], this.suite.coverage);
      this.trackers.set(key, tracker);
    }
    return tracker;
  }

  step(s: Step): Finding[] {
    const findings: Finding[] = [];
    const explain = (tracker: ModelTracker<Step>, step: Step, observed: ReadonlySet<string> | null) => {
      const violation = tracker.step(step, observed);
      if (violation) findings.push({ kind: 'soundness', key: violation.key, step: s.index, detail: `${violation.from.join('|')} -> ${violation.to.join('|')} on ${formatEvent(s.ev)}` });
    };
    if (s.world.disposed) {
      // Disposal ends every machine but the awaits it settles.
      for (const tracker of this.trackers.values()) explain(tracker, s, null);
    } else {
      this.stepSession(s, explain);
      this.stepDeliveries(s, explain);
    }
    for (const record of s.world.awaits) {
      if (record.settledStep !== null && record.settledStep < s.index) continue;
      let tracker = this.awaitTrackers.get(record);
      if (!tracker) {
        tracker = new ModelTracker(this.byId.get('Await')!, `await ${record.n}`, this.bindings.Await, this.suite.coverage);
        this.awaitTrackers.set(record, tracker);
      }
      const observed = record.outcome === null ? ['Grace', 'Parked'] : record.outcome.kind === 'resolved' ? ['Resolved'] : ['Failed'];
      explain(tracker, { ...s, await: record }, new Set(observed));
    }
    for (const invariant of INVARIANTS) {
      const breach = invariant.check(s);
      if (breach) findings.push({ kind: 'invariant', key: invariant.key, step: s.index, detail: `${breach} on ${formatEvent(s.ev)}` });
    }
    return findings;
  }

  private stepSession(s: Step, explain: (tracker: ModelTracker<Step>, step: Step, observed: ReadonlySet<string> | null) => void): void {
    for (const viewer of VIEWER_IDS) {
      explain(this.tracker('Viewer', viewer), { ...s, viewer }, new Set([s.post.viewers.has(viewer) ? 'Present' : 'Absent']));
    }
    explain(this.tracker('Engagement', S), s, new Set([s.post.engaged ? 'Engaged' : 'NotEngaged']));
    // A new generation starts every entry machine over.
    const replaced = this.entry !== null && s.post.entry !== this.entry;
    for (const machine of ENTRY_MACHINES) {
      const tracker = this.tracker(machine, S);
      if (replaced) explain(tracker, s, null);
      explain(tracker, s, s.post.entry ? new Set([s.post.state[machine]!]) : null);
    }
    this.entry = s.post.entry;
  }

  private stepDeliveries(s: Step, explain: (tracker: ModelTracker<Step>, step: Step, observed: ReadonlySet<string> | null) => void): void {
    const ring = s.post.entry ? s.world.manager['entries'].get(S)?.ring : null;
    if (ring) {
      for (const sink of ['speech', 'push'] as const) {
        const key = `${ring.episode.id}:${sink}`;
        if (this.opened.has(key)) continue;
        this.opened.add(key);
        const delay = sink === 'speech' ? s.world.settings.speakDelayMs : s.world.settings.pushDelayMs;
        const instance: DeliveryInstance = {
          key, episode: ring.episode.id, sink, dueAt: ring.episode.startedAt + delay,
          onAtOpen: sink === 'speech' ? s.world.settings.speakEnabled : s.world.settings.pushEnabled,
          openedStep: s.index,
        };
        this.deliveries.set(key, { instance, tracker: new ModelTracker(this.byId.get('Delivery')!, key, this.bindings.Delivery, this.suite.coverage) });
      }
    }
    for (const [key, { instance, tracker }] of this.deliveries) {
      const step = { ...s, delivery: instance };
      const delivered = s.world.deliveries.some((record) => record.sink === instance.sink && record.episode === instance.episode && record.step >= instance.openedStep);
      explain(tracker, step, new Set(delivered ? ['Delivered'] : ['Pending', 'Spent']));
      const settled = tracker.states !== null && [...tracker.states].every((state) => state !== 'Pending');
      if (settled && episodeEnded(step)) {
        explain(tracker, step, null);
        this.deliveries.delete(key);
      }
    }
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/**
 * Run `events` from a fresh manager, or draw them from `generate` as it goes,
 * reading and checking after every step. Stops after `dispose`.
 */
async function run(
  suite: ModelSuite,
  next: (index: number, snap: Snap, world: World) => AlertModelEvent | null,
  bindings: Readonly<Record<string, MachineBinding<Step>>> = BINDINGS,
): Promise<RunResult> {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 1));
  const world = new World();
  const checker = new Checker(suite, bindings);
  const events: AlertModelEvent[] = [];
  const findings: Finding[] = [];
  let pre = read(world);
  try {
    for (let index = 0; ; index++) {
      const ev = next(index, pre, world);
      if (ev === null) break;
      events.push(ev);
      world.step = index;
      world.apply(ev);
      await flush();
      const post = read(world);
      findings.push(...checker.step({ ev, index, pre, post, world }));
      pre = post;
      if (ev.k === 'dispose') break;
    }
  } finally {
    if (!world.disposed) {
      world.scheduler.dispose();
      world.manager.dispose();
    }
    vi.useRealTimers();
  }
  return { events, findings };
}

/** Replay a fixed event list: the reproduction a finding prints. */
export function runAlertModel(suite: ModelSuite, events: readonly AlertModelEvent[], bindings?: Readonly<Record<string, MachineBinding<Step>>>): Promise<RunResult> {
  return run(suite, (index) => events[index] ?? null, bindings);
}

// ---------------------------------------------------------------------------
// Generation: weighted toward sequences that make sense, nonsense allowed.

const COMMANDS = ['claude', 'pnpm test', 'make', 'ls'] as const;
const RULE_KEYS = ['claude', 'pnpm', 'make'] as const;
const WAITS = [8, 300, 760, 1_000, 1_600, 2_000, 3_000, 5_100, 15_000, 180_100] as const;
const VALID_TIMEOUTS = [4_000, 30_000, 600_000] as const;
const INVALID_TIMEOUTS = [0, -5, Number.NaN, MAX_AWAIT_TIMEOUT_MS + 1] as const;

export interface GenerateOptions {
  length: number;
  /** Event kinds never drawn: the coverage mutation check's lever. */
  without?: ReadonlySet<Kind>;
}

/** Short scripts that reach deep states uniform draws rarely do. */
const SCRIPTS: ReadonlyArray<readonly [(rng: () => number) => AlertModelEvent[], number]> = [
  // A run of work: BUSY, then quiet.
  [() => [{ k: 'send' }, { k: 'output' }, { k: 'wait', ms: 1_600 }, { k: 'output' }, { k: 'output' }], 3],
  [() => [{ k: 'wait', ms: 2_000 }, { k: 'wait', ms: 3_000 }], 2],
  // A watched turn that settles.
  [(rng) => {
    const line = pick(rng, ['claude', 'pnpm test'] as const);
    return [
      { k: 'rule', key: line === 'claude' ? 'claude' : 'pnpm', on: true }, { k: 'start', line },
      { k: 'send' }, { k: 'output' }, { k: 'wait', ms: 1_600 }, { k: 'output' }, { k: 'output' },
      { k: 'wait', ms: 2_000 }, { k: 'wait', ms: 3_000 },
    ];
  }, 3],
  // A progress cycle that ends.
  [() => [{ k: 'progress', state: 'normal', percent: 10 }, { k: 'output' }, { k: 'progress', state: 'normal', percent: 100 }, { k: 'tick' }], 2],
  // An engaged command, then the user walks away.
  [(rng) => [{ k: 'present', viewer: 'V1', focus: 'S' }, { k: 'start', line: pick(rng, COMMANDS) }, { k: 'present', viewer: 'V1', focus: 'T' }], 2],
  // A completion while engaged, then a lapse.
  [(rng) => [
    { k: 'present', viewer: 'V1', focus: 'S' }, { k: 'report', source: 'OSC 9' },
    pick(rng, [{ k: 'idle', viewer: 'V1' }, { k: 'leave', viewer: 'V1' }, { k: 'present', viewer: 'V1', focus: 'T' }] as const),
    { k: 'wait', ms: 1_000 },
  ], 2],
  // A hold of two sources whose viewer leaves, then an await or a return inside the leave grace.
  [(rng) => [
    { k: 'rule', key: 'claude', on: true }, { k: 'present', viewer: 'V1', focus: 'S' }, { k: 'start', line: 'claude' },
    { k: 'send' }, { k: 'output' }, { k: 'wait', ms: 1_600 }, { k: 'output' }, { k: 'output' },
    { k: 'wait', ms: 2_000 }, { k: 'wait', ms: 3_000 }, { k: 'report', source: 'OSC 9' }, { k: 'leave', viewer: 'V1' },
    pick(rng, [{ k: 'await', until: 'quiet', timeoutMs: 30_000 }, { k: 'present', viewer: 'V1', focus: 'S' }, { k: 'click' }] as const),
  ], 1],
  // A cycle's end the host interrupts.
  [() => [{ k: 'progress', state: 'normal', percent: 10 }, { k: 'progress', state: 'normal', percent: 100 }, { k: 'interrupt' }], 0.5],
  // A ring, then a verb or an await.
  [(rng) => [{ k: 'report', source: pick(rng, ['OSC 9', 'BEL', 'OSC 777'] as const) }, pick(rng, [{ k: 'click' }, { k: 'dismiss' }, { k: 'key' }, { k: 'await', until: 'quiet', timeoutMs: 30_000 }] as const)], 2],
];

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

function draw(rng: () => number, snap: Snap, world: World, without: ReadonlySet<Kind>): AlertModelEvent {
  const running = snap.state.Command === 'Seen' || snap.state.Command === 'Unseen';
  const ringing = snap.ring !== null;
  const holding = snap.held !== null;
  const viewer = pick(rng, VIEWER_IDS);
  // Each maker draws its fields only once chosen.
  const options: ReadonlyArray<readonly [Kind, number, () => AlertModelEvent]> = [
    ['output', 14, () => ({ k: 'output' })],
    ['wait', 12, () => ({ k: 'wait', ms: pick(rng, WAITS) })],
    ['tick', 8, () => ({ k: 'tick' })],
    ['key', 4, () => ({ k: 'key' })],
    ['wheel', 1, () => ({ k: 'wheel' })],
    ['send', 5, () => ({ k: 'send' })],
    ['reply', 1, () => ({ k: 'reply' })],
    ['start', running ? 1 : 5, () => ({ k: 'start', line: pick(rng, COMMANDS) })],
    ['finish', running ? 6 : 1, () => ({ k: 'finish', code: pick(rng, [0, 1]) })],
    ['prompt', running ? 2 : 1, () => ({ k: 'prompt' })],
    ['exit', 0.6, () => ({ k: 'exit', code: 0 })],
    ['report', 4, () => ({ k: 'report', source: pick(rng, ['OSC 9', 'OSC 777', 'BEL'] as const) })],
    ['progress', 5, () => pick(rng, [
      { k: 'progress', state: 'normal', percent: 30 }, { k: 'progress', state: 'warning', percent: 50 },
      { k: 'progress', state: 'indeterminate', percent: null }, { k: 'progress', state: 'normal', percent: 100 },
      { k: 'progress', state: 'clear', percent: null }, { k: 'progress', state: 'error', percent: null },
    ] as const)],
    ['present', 6, () => ({ k: 'present', viewer, focus: pick(rng, ['S', 'S', 'T', null] as const) })],
    ['idle', holding ? 4 : 2, () => ({ k: 'idle', viewer })],
    ['leave', holding ? 4 : 2, () => ({ k: 'leave', viewer })],
    ['realmEnd', 0.6, () => ({ k: 'realmEnd', viewer })],
    ['click', ringing || holding ? 5 : 1.5, () => ({ k: 'click' })],
    ['dismiss', ringing || holding ? 3 : 1, () => ({ k: 'dismiss' })],
    ['pill', 1, () => ({ k: 'pill' })],
    ['t', 1, () => ({ k: 't' })],
    ['rule', 2, () => ({ k: 'rule', key: pick(rng, RULE_KEYS), on: rng() < 0.6 })],
    ['await', ringing || holding ? 5 : 2.5, () => ({
      k: 'await', until: rng() < 0.7 ? 'quiet' : 'exit',
      timeoutMs: rng() < 0.12 ? pick(rng, INVALID_TIMEOUTS) : pick(rng, VALID_TIMEOUTS),
    })],
    ['cancel', world.awaits.some((record) => record.outcome === null) ? 1.5 : 0,
      () => ({ k: 'cancel', nth: Math.floor(rng() * Math.max(1, world.awaits.length)) })],
    ['interrupt', 0.8, () => ({ k: 'interrupt' })],
    ['remove', 0.25, () => ({ k: 'remove' })],
    ['respawn', snap.retired ? 3 : 0.4, () => ({ k: 'respawn', seed: pick(rng, ['none', 'todo', 'clean'] as const) })],
    ['helper', snap.helper ? 2 : 0.3, () => ({ k: 'helper', on: !snap.helper })],
    ['sink', 1, () => ({ k: 'sink', sink: pick(rng, ['speech', 'push'] as const), on: rng() < 0.5 })],
  ];
  const allowed = options.filter(([kind, weight]) => weight > 0 && !without.has(kind));
  return pickWeighted(rng, allowed.map(([, weight, make]) => [make, weight] as const))();
}

/** Draw a sequence from `seed` as it runs, reading the manager to weight each draw. */
export function generateAlertModel(suite: ModelSuite, seed: number, options: GenerateOptions): Promise<RunResult> {
  const rng = mulberry32(seed);
  const without = options.without ?? new Set<Kind>();
  const queue: AlertModelEvent[] = [];
  return run(suite, (index, snap, world) => {
    if (index === 0) {
      return {
        k: 'settings', speak: rng() < 0.7, push: rng() < 0.7,
        speakDelayMs: pick(rng, [1_000, 4_000, 20_000]), pushDelayMs: pick(rng, [1_000, 4_000, 20_000]),
      };
    }
    if (index === options.length - 1) return rng() < 0.5 ? { k: 'dispose' } : null;
    if (index >= options.length) return null;
    if (queue.length === 0 && rng() < 0.12) queue.push(...pickWeighted(rng, SCRIPTS)(rng).filter((event) => !without.has(event.k)));
    return queue.shift() ?? draw(rng, snap, world, without);
  });
}

