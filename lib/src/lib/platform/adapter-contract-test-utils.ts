/**
 * The contract every `PlatformAdapter` answers to (`docs/specs/transport.md`),
 * run against each implementation from a harness file beside its own tests
 * (`*.contract.test.ts`): `adapterContract('vscode', open)`. A harness builds a
 * fresh adapter and plays its host — delivers output, an exit, a list, a
 * replay, a failed request — in that adapter's own transport, and reports what
 * reached the host in the contract's words (`HostOp`).
 *
 * Each case observes one value and compares it with what the rule expects.
 * Where an implementation legitimately differs, `DIFFERENCES` says what it does
 * instead and why; where it cannot be played at all, `DIFFERENCES` says `na`
 * and the test proves the harness indeed cannot play it. Where an
 * implementation breaks a rule, `KNOWN` holds the case as `it.fails` with the
 * evidence, until the fix deletes the entry (the vitest form of
 * `standalone/sidecar/shell-conformance.test.js`'s `KNOWN`). Nothing is skipped.
 *
 * `MEMBERS` answers, for every member of `PlatformAdapter`, which
 * implementations have it and what pins it. It is typed over every key of the
 * interface, so a new member does not compile until each implementation is
 * answered for, and the `members` case checks the answer against each adapter.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS } from '../alert-settings-model';
import { PTY_ACK_BATCH_CHARS } from '../pty-flow';
import type { PersistedWindow } from '../session-types';
import { getTerminalPaneState } from '../terminal-state-store';
import type { AlertStateDetail, PlatformAdapter, PtyDataDetail, PtyListDetail, PtyReplayDetail } from './types';

export type Impl = 'fake' | 'vscode' | 'tauri' | 'harness' | 'remote';

/** What reached the host, in the contract's words: each harness maps its wire onto these. */
export type HostOp = 'spawn' | 'write' | 'resize' | 'kill' | 'ack' | 'init' | 'theme' | 'alert' | 'cwds';
export type SentRecord = { op: HostOp } & Record<string, unknown>;

export interface ContractHarness {
  adapter: PlatformAdapter;
  /** The host sends one live output chunk for `id`. */
  data(id: string, data: string, textData?: string): void | Promise<void>;
  /** The host reports `id`'s process exited. */
  exit(id: string, exitCode: number): void | Promise<void>;
  /** The host answers a `requestInit` with its list, then a replay. */
  list?(detail: PtyListDetail): void;
  replay?(detail: PtyReplayDetail): void;
  /** Everything that reached the host since the adapter was built, normalized
   *  (an alert verb as `{ op: 'alert', command }`). */
  sent?(): SentRecord[];
  /** Every request the host gets from now on fails, the way this transport fails. */
  failRequests?(): void;
  /** Make `id` the pane this adapter shows, where showing is what lets it speak. */
  show?(id: string): Promise<void>;
  /** Await `promise`, letting any clock the transport times out on run. */
  settle<T>(promise: Promise<T>): Promise<T>;
}

type Hook = 'list' | 'replay' | 'sent' | 'failRequests';

interface ContractCase {
  /** The outcome, stated as the test's title. */
  title: string;
  /** The spec heading that states the rule. */
  rule: string;
  /** Host hooks the case plays; an implementation without one must declare the case `na`. */
  needs?: Hook[];
  /** Optional members the case calls; where `MEMBERS` marks one absent, the case checks the absence. */
  members?: Array<keyof PlatformAdapter>;
  observe(h: ContractHarness, impl: Impl): Promise<unknown>;
  expect: unknown;
}

// ---------------------------------------------------------------------------
// Members: one row per member of `PlatformAdapter`, one letter per
// implementation in the order F(ake) V(S Code) T(auri) H(arness) R(emote).
// Upper case: present. `-`: absent. Lower case: present only in some builds or
// on some platforms, so the `members` check accepts either, and a case calling
// it needs a harness built where it exists. Then the cases that pin the member
// here, or the test that pins it elsewhere ('unpinned': none does).

type Has<L extends string> = L | Lowercase<L> | '-';
type Presence = `${Has<'F'>}${Has<'V'>}${Has<'T'>}${Has<'H'>}${Has<'R'>}`;
type MemberRow = readonly [Presence, readonly CaseId[] | string];
const LETTER: Record<Impl, string> = { fake: 'F', vscode: 'V', tauri: 'T', harness: 'H', remote: 'R' };
const FAIL = (member: FailMember) => [`fail:${member}`] as const;
const ALERT_VERB = ['alert-verbs'] as const;

const MEMBERS = {
  init: ['FVTHR', 'each adapter\'s own tests (vscode-adapter.test.ts "init mints from the extension host", sidecar-adapters.test.ts)'],
  burrow: ['-VTH-', 'link-client.test.ts; tauri-adapter.test.ts "remote host link"'],
  getAvailableShells: ['FVTHR', FAIL('getAvailableShells')],
  terminalContext: ['FVTH-', FAIL('terminalContext')],
  spawnPty: ['FVTHR', ['pty-wire']],
  writePty: ['FVTHR', ['pty-wire']],
  resizePty: ['FVTHR', ['pty-wire']],
  killPty: ['FVTHR', ['pty-wire', 'kill-no-exit']],
  hostOwnsTheme: ['-V---', 'vscode-adapter.test.ts "owns the theme, the shell, and updates"'],
  hostOwnsShells: ['-V---', 'vscode-adapter.test.ts "owns the theme, the shell, and updates"'],
  offersThemeStore: ['F----', 'unpinned'],
  offersLabs: ['--TH-', 'unpinned'],
  hostOwnsUpdates: ['-V---', 'vscode-adapter.test.ts "owns the theme, the shell, and updates"'],
  getRecoveryCommands: ['-VTH-', 'tauri-adapter.test.ts, browser-sidecar-adapter.test.ts "claims the recovery commands"'],
  recoveryReady: ['--TH-', 'tauri-adapter.test.ts "claims the recovery commands"'],
  requestAppRestart: ['--T--', 'unpinned'],
  getCwd: ['FVTHR', FAIL('getCwd')],
  getCwds: ['-VTH-', ['cwds-shared', 'fail:getCwds']],
  getOpenPorts: ['FVTHR', FAIL('getOpenPorts')],
  getOpenPortsMany: ['FVTHR', FAIL('getOpenPortsMany')],
  readClipboardFilePaths: ['FVTHR', FAIL('readClipboardFilePaths')],
  readClipboardImageAsFilePath: ['FVTHR', FAIL('readClipboardImageAsFilePath')],
  readClipboardText: ['--TH-', FAIL('readClipboardText')],
  // `nativeClipboardWriter`: macOS and Windows only.
  writeClipboardText: ['-Vth-', FAIL('writeClipboardText')],
  onFilesDropped: ['--T--', 'browser-sidecar-adapter.test.ts "does not claim native file-drop support"'],
  openExternal: ['FVTH-', 'tauri-adapter.test.ts "revalidates every URI"; vscode-adapter.test.ts "posts external hyperlink open requests"'],
  opensOtherApps: ['--T--', 'tauri-adapter.test.ts "admits IPv6-literal web links"'],
  runWorkbenchCommand: ['-V---', 'vscode-adapter.test.ts "posts allowlisted VS Code workbench commands"'],
  browserProviders: ['-VTH-', 'vscode-adapter.test.ts "declares both providers"'],
  browser: ['-VTH-', FAIL('browser')],
  createIframeProxyUrl: ['-VTH-', FAIL('createIframeProxyUrl')],
  releaseIframeProxy: ['-VTH-', 'iframe-lease-order.test.ts'],
  toolControl: ['-VTH-', FAIL('toolControl')],
  reapsTools: ['-VTH-', 'unpinned'],
  gitInfo: ['--TH-', FAIL('gitInfo')],
  onPtyData: ['FVTHR', ['pair', 'ack-unclaimed', 'ack-parsed']],
  offPtyData: ['FVTHR', ['pair']],
  acknowledgePtyData: ['FVTHR', ['ack-unclaimed', 'ack-parsed', 'ack-replay', 'ack-wire']],
  onPtyExit: ['FVTHR', ['exit', 'kill-no-exit']],
  offPtyExit: ['FVTHR', ['exit']],
  requestInit: ['FVTHR', ['init-token', 'theme']],
  onPtyList: ['FVTHR', ['list']],
  offPtyList: ['FVTHR', ['list']],
  onPtyReplay: ['FVTHR', ['replay']],
  offPtyReplay: ['FVTHR', ['replay']],
  onPtyMarked: ['--TH-', 'workspace-move.test.ts (over a stand-in platform)'],
  reopenClosedWindow: ['--T--', 'unpinned'],
  transferWorkspace: ['--T--', 'workspace-move.test.ts (over a stand-in platform)'],
  onRequestSessionFlush: ['FVTHR', 'tauri-adapter.test.ts "fans a requestId out to handlers"'],
  offRequestSessionFlush: ['FVTHR', 'tauri-adapter.test.ts "stops fanning out to a removed handler"'],
  notifySessionFlushComplete: ['FVTHR', 'tauri-adapter.test.ts "fans a requestId out to handlers"'],
  alertSetWatchedCommands: ['FVTHR', ALERT_VERB],
  alertSetCommandWatched: ['FVTHR', ALERT_VERB],
  alertPublishSettings: ['FVTHR', ALERT_VERB],
  alertDismiss: ['FVTHR', ALERT_VERB],
  alertEngagement: ['FVTHR', ALERT_VERB],
  alertPublishSessions: ['FVTHR', ALERT_VERB],
  alertAcknowledge: ['FVTHR', ALERT_VERB],
  alertToggleTodo: ['FVTHR', ALERT_VERB],
  alertClearTodo: ['FVTHR', ALERT_VERB],
  alertSilenceRun: ['FVTH-', ALERT_VERB],
  alertAwait: ['FVTHR', ALERT_VERB],
  onAlertState: ['FVTHR', ['replay']],
  onWatchedCommands: ['FVTHR', 'alert-client.test.ts'],
  onAlertSettings: ['FVTHR', 'alert-client.test.ts'],
  onAlertSpeak: ['FVTHR', 'alert-client.test.ts'],
  saveState: ['FVTHR', ['state']],
  getState: ['FVTHR', ['state']],
  getWindowState: ['--TH-', ['window-state']],
  saveWindowState: ['--TH-', ['window-state']],
  // Hosted desktop builds only; the harnesses build self-host. Pinned per build
  // by sidecar-adapters.test.ts and vscode-adapter.test.ts "managed voice".
  managedVoice: ['-vth-', 'sidecar-adapters.test.ts "offers managed voice only in a Hosted build"'],
  // Attached after construction, in standalone's main window (`standalone/src/main.tsx`).
  updates: ['-----', 'unpinned'],
} as const satisfies { [K in keyof PlatformAdapter]-?: MemberRow };

const presence = (impl: Impl, member: keyof PlatformAdapter): 'yes' | 'no' | 'either' => {
  const letter = MEMBERS[member][0][Object.keys(LETTER).indexOf(impl)];
  return letter === LETTER[impl] ? 'yes' : letter === '-' ? 'no' : 'either';
};

// ---------------------------------------------------------------------------
// Request failures: each request member settles a failed host request with its
// documented failure (the members' comments in `types.ts`; `git-types.ts`).

const rejection = (error: unknown) => ({ rejected: error instanceof TypeError ? 'TypeError' : 'error' });
const FAILURES = {
  terminalContext: { call: (a) => a.terminalContext!({ op: 'home' }), expect: { rejected: 'error' } },
  toolControl: { call: (a) => a.toolControl!({ op: 'lookup', name: 'demo', cwd: '/repo' }), expect: { value: { status: 'error', message: expect.any(String) } } },
  browser: { call: (a) => a.browser!({ provider: 'agent-browser', binding: {}, op: 'diagnostics' }), expect: { value: { ok: false, error: expect.any(String) } } },
  createIframeProxyUrl: { call: (a) => a.createIframeProxyUrl!('http://127.0.0.1:5173/'), expect: { value: { ok: false, reason: 'unreachable', detail: expect.any(String) } } },
  gitInfo: { call: (a) => a.gitInfo!(['/repo']), expect: { rejected: 'error' } },
  writeClipboardText: { call: (a) => a.writeClipboardText!('copied'), expect: { rejected: 'error' } },
  readClipboardText: { call: (a) => a.readClipboardText!(), expect: { value: null } },
  readClipboardFilePaths: { call: (a) => a.readClipboardFilePaths(), expect: { value: null } },
  readClipboardImageAsFilePath: { call: (a) => a.readClipboardImageAsFilePath(), expect: { value: null } },
  getAvailableShells: { call: (a) => a.getAvailableShells(), expect: { value: [] } },
  getCwd: { call: (a) => a.getCwd('p'), expect: { value: null } },
  // An id with no answer keeps its previous cwd, null or absent alike.
  getCwds: { call: (a) => a.getCwds!(['p']).then((cwds) => cwds.p ?? null), expect: { value: null } },
  getOpenPorts: { call: (a) => a.getOpenPorts('p'), expect: { value: [] } },
  // Absent means unscanned; `[]` would claim a scan that found nothing.
  getOpenPortsMany: { call: (a) => a.getOpenPortsMany(['p']), expect: { value: {} } },
} satisfies Record<string, { call(a: PlatformAdapter): Promise<unknown>; expect: unknown }>;
type FailMember = keyof typeof FAILURES;

const failureCases = Object.fromEntries(Object.entries(FAILURES).map(([member, { call, expect }]) => [`fail:${member}`, {
  title: `settles ${member} with its documented failure when the host fails it, never a hang or a silent success`,
  rule: member === 'terminalContext' ? 'transport.md → Auxiliary helper metadata' : `PlatformAdapter.${member} in types.ts`,
  needs: ['failRequests'],
  members: [member as FailMember],
  async observe(h: ContractHarness) {
    h.failRequests!();
    return h.settle(call(h.adapter).then((value) => ({ value }), rejection));
  },
  expect,
} satisfies ContractCase])) as unknown as Record<`fail:${FailMember}`, ContractCase>;

// ---------------------------------------------------------------------------
// The cases.

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const listen = <T>(on: (handler: (detail: T) => void) => void) => {
  const seen: T[] = [];
  on((detail) => void seen.push(detail));
  return seen;
};
const sentOf = (h: ContractHarness, ...ops: HostOp[]) => h.sent!().filter((record) => ops.includes(record.op));
const spyAcks = (adapter: PlatformAdapter) => {
  const acks: Array<[string, number]> = [];
  const original = adapter.acknowledgePtyData.bind(adapter);
  adapter.acknowledgePtyData = (id, chars) => { acks.push([id, chars]); original(id, chars); };
  return acks;
};
const OUTPUT_FLOW = 'transport.md → Output flow control';
const RECONNECTION = 'transport.md → Reconnection protocol';
const MESSAGES = 'transport.md → Message protocol';
const IMAGE = 'pre\x1b]1337;File=inline=1:AAAA\x07post';
const REPLAYED = '\x1b]633;E;sleep 5\x07\x1b]633;C\x07out\x1b]9;Historical\x07';
const WINDOW: PersistedWindow = {
  version: 2,
  activeWorkspaceId: 'workspace:1',
  workspaces: [{ id: 'workspace:1', name: 'Workspace 1', nameIsAuto: true, session: { version: 4, panes: [] } }],
};
const LISTED: PtyListDetail = {
  ptys: [{ id: 'live', alive: true, shell: '/bin/zsh' }, { id: 'dead', alive: false, exitCode: 2 }],
  requestId: 'tok-1',
};

type CaseId = 'members' | 'pair' | 'ack-unclaimed' | 'ack-parsed' | 'ack-replay' | 'ack-wire' | 'exit' | 'kill-no-exit'
  | 'pty-wire' | 'init-token' | 'theme' | 'list' | 'replay' | 'alert-verbs' | 'cwds-shared' | 'state' | 'window-state'
  | `fail:${FailMember}`;

const CASES: Record<CaseId, ContractCase> = {
  members: {
    title: 'has exactly the members MEMBERS declares for it',
    rule: 'transport.md → Adapter model',
    async observe(h, impl) {
      return (Object.keys(MEMBERS) as Array<keyof PlatformAdapter>).filter((member) => {
        const has = presence(impl, member);
        return has !== 'either' && (h.adapter[member] !== undefined) !== (has === 'yes');
      });
    },
    expect: [],
  },
  pair: {
    title: 'hands each output chunk to every data listener as the pair the host sent, and none to a removed one',
    rule: MESSAGES,
    async observe(h) {
      const kept = listen<PtyDataDetail>((handler) => h.adapter.onPtyData(handler));
      const removed: PtyDataDetail[] = [];
      const late = (detail: PtyDataDetail) => void removed.push(detail);
      h.adapter.onPtyData(late);
      await h.show?.('p');
      await h.data('p', IMAGE, 'prepost');
      h.adapter.offPtyData(late);
      await h.data('p', 'plain');
      return { kept: kept.map(({ id, data, textData }) => ({ id, data, textData })), removed: removed.length };
    },
    expect: { kept: [{ id: 'p', data: IMAGE, textData: 'prepost' }, { id: 'p', data: 'plain' }], removed: 1 },
  },
  'ack-unclaimed': {
    title: 'acknowledges live output no terminal took at once, every char exactly once',
    rule: OUTPUT_FLOW,
    async observe(h) {
      const acks = spyAcks(h.adapter);
      h.adapter.onPtyData(() => {});
      await h.show?.('p');
      await h.data('p', 'abc');
      await h.data('p', 'de');
      return acks;
    },
    expect: [['p', 3], ['p', 2]],
  },
  'ack-parsed': {
    title: 'acknowledges a claimed chunk only once parsed, a batch at a time',
    rule: OUTPUT_FLOW,
    async observe(h) {
      const acks = spyAcks(h.adapter);
      const parsed: Array<() => void> = [];
      h.adapter.onPtyData((_detail, claim) => void (claim && parsed.push(claim())));
      await h.show?.('p');
      await h.data('p', 'x'.repeat(PTY_ACK_BATCH_CHARS - 1));
      await h.data('p', 'yz');
      const beforeParse = [...acks];
      for (const done of parsed) done();
      return { beforeParse, afterParse: acks };
    },
    expect: { beforeParse: [], afterParse: [['p', PTY_ACK_BATCH_CHARS + 1]] },
  },
  'ack-replay': {
    title: 'acknowledges none of a replay',
    rule: OUTPUT_FLOW,
    needs: ['replay'],
    async observe(h) {
      const acks = spyAcks(h.adapter);
      h.adapter.onPtyReplay(() => {});
      h.replay!({ id: 'r', data: 'replayed output' });
      return acks;
    },
    expect: [],
  },
  'ack-wire': {
    title: 'sends each acknowledgement to the host as { id, chars }',
    rule: OUTPUT_FLOW,
    needs: ['sent'],
    async observe(h) {
      h.adapter.onPtyData(() => {});
      await h.show?.('p');
      await h.data('p', 'abc');
      return sentOf(h, 'ack');
    },
    expect: [{ op: 'ack', id: 'p', chars: 3 }],
  },
  exit: {
    title: 'hands a host exit to every exit listener with its id and code, and none to a removed one',
    rule: 'transport.md → PTY lifecycle',
    async observe(h) {
      const kept = listen<{ id: string; exitCode: number }>((handler) => h.adapter.onPtyExit(handler));
      let removed = 0;
      const gone = () => void removed++;
      h.adapter.onPtyExit(gone);
      h.adapter.offPtyExit(gone);
      await h.show?.('x');
      await h.exit('x', 3);
      return { kept, removed };
    },
    expect: { kept: [{ id: 'x', exitCode: 3 }], removed: 0 },
  },
  'kill-no-exit': {
    title: 'delivers no exit of its own for a PTY it killed',
    rule: 'PlatformAdapter.killPty in types.ts; standalone.md → Routing',
    async observe(h) {
      await h.show?.('k');
      h.adapter.spawnPty('k');
      const exits = listen<{ id: string; exitCode: number }>((handler) => h.adapter.onPtyExit(handler));
      h.adapter.killPty('k');
      await h.settle(flush());
      return exits;
    },
    expect: [],
  },
  'pty-wire': {
    title: 'carries spawn, write, resize and kill to the host, one message each, in order',
    rule: MESSAGES,
    needs: ['sent'],
    async observe(h) {
      h.adapter.spawnPty('w', { cols: 90, rows: 20 });
      await h.show?.('w');
      h.adapter.writePty('w', 'ls\r');
      h.adapter.resizePty('w', 100, 30);
      h.adapter.killPty('w');
      await h.settle(flush());
      return sentOf(h, 'spawn', 'write', 'resize', 'kill');
    },
    expect: [
      { op: 'spawn', id: 'w', options: { cols: 90, rows: 20 } },
      { op: 'write', id: 'w', data: 'ls\r' },
      { op: 'resize', id: 'w', cols: 100, rows: 30 },
      { op: 'kill', id: 'w' },
    ],
  },
  'init-token': {
    title: "carries the collector's token to the host on requestInit",
    rule: RECONNECTION,
    needs: ['sent'],
    async observe(h) {
      h.adapter.requestInit('tok-1');
      return sentOf(h, 'init');
    },
    expect: [{ op: 'init', requestId: 'tok-1' }],
  },
  theme: {
    title: 'pushes the resolved terminal colours to the host on requestInit',
    rule: MESSAGES,
    needs: ['sent'],
    async observe(h) {
      h.adapter.requestInit();
      return sentOf(h, 'theme').map(({ foreground, background, cursor }) => [foreground, background, cursor].every((c) => typeof c === 'string'));
    },
    expect: [true],
  },
  list: {
    title: "hands the host's list to list listeners as sent, token, exited PTYs and exit codes included",
    rule: `${RECONNECTION}; transport.md → Transferring a Workspace`,
    needs: ['list'],
    async observe(h) {
      const kept = listen<PtyListDetail>((handler) => h.adapter.onPtyList(handler));
      let removed = 0;
      const gone = () => void removed++;
      h.adapter.onPtyList(gone);
      h.adapter.offPtyList(gone);
      h.list!(LISTED);
      return { kept, removed };
    },
    expect: { kept: [LISTED], removed: 0 },
  },
  replay: {
    title: 'hands each replay to replay listeners parsed once, token included, rebuilding pane state and asking nothing of the alerts',
    rule: `${MESSAGES}; transport.md → Universal invariants`,
    needs: ['replay'],
    async observe(h) {
      const replays = listen<PtyReplayDetail>((handler) => h.adapter.onPtyReplay(handler));
      const alerts = listen<AlertStateDetail>((handler) => h.adapter.onAlertState(handler));
      h.replay!({ id: 'r', data: REPLAYED, requestId: 'tok-1' });
      return { replays, alerts, command: getTerminalPaneState('r').currentCommand?.rawCommandLine };
    },
    expect: { replays: [{ id: 'r', data: 'out', requestId: 'tok-1' }], alerts: [], command: 'sleep 5' },
  },
  'alert-verbs': {
    title: 'carries each alert verb to the host as one command',
    rule: MESSAGES,
    needs: ['sent'],
    async observe(h) {
      const a = h.adapter;
      a.alertSetWatchedCommands(['npm']);
      a.alertSetCommandWatched('make', true);
      a.alertPublishSettings(DEFAULT_ALERT_SETTINGS, { seed: false });
      a.alertDismiss('p');
      a.alertEngagement({ present: true, focusId: 'p' });
      a.alertPublishSessions({});
      a.alertAcknowledge('p');
      a.alertToggleTodo('p');
      a.alertClearTodo('p');
      a.alertSilenceRun?.('p');
      a.alertAwait('p', { until: 'exit', timeoutMs: 1000 }).cancel();
      return sentOf(h, 'alert').map(({ command }) => (command as { op: string }).op);
    },
    expect: ['initializeWatchedCommands', 'setCommandWatched', 'updateSettings', 'dismiss', 'engagement', 'sessions',
      'acknowledge', 'toggleTodo', 'clearTodo', 'silenceRun', 'await', 'awaitCancel'],
  },
  'cwds-shared': {
    title: 'asks the host once for every cwd probed in the same microtask',
    rule: 'transport.md → Persisted session types',
    needs: ['sent'],
    members: ['getCwds'],
    async observe(h) {
      const both = Promise.all([h.adapter.getCwds!(['a']), h.adapter.getCwds!(['b'])]);
      await h.settle(both.catch(() => undefined));
      return sentOf(h, 'cwds');
    },
    expect: [{ op: 'cwds', ids: ['a', 'b'] }],
  },
  state: {
    title: 'answers getState with what saveState saved',
    rule: 'transport.md → Persisted session types',
    async observe(h) {
      h.adapter.saveState({ version: 4, saved: true });
      return h.adapter.getState();
    },
    expect: { version: 4, saved: true },
  },
  'window-state': {
    title: 'answers getWindowState with what saveWindowState saved',
    rule: 'transport.md → Persisted session types',
    members: ['getWindowState', 'saveWindowState'],
    async observe(h) {
      h.adapter.saveWindowState!(WINDOW);
      return h.adapter.getWindowState!();
    },
    expect: WINDOW,
  },
  ...failureCases,
};

// ---------------------------------------------------------------------------
// Declared differences: what an implementation does instead, and why, in one
// line each. `na`: it has no way to play the case at all.

type Difference = { expect: unknown; why: string } | { na: string };
const NO_HOST = 'no host: the fake runs every PTY, parse, and alert in process';
const ONE_COLLECTOR = 'one collector per realm: the host echoes no token, so none is sent and none is forwarded (PlatformAdapter.requestInit)';

const DIFFERENCES: { [I in Impl]?: { [C in CaseId | 'fail:*']?: Difference } } = {
  fake: {
    'kill-no-exit': { expect: [{ id: 'k', exitCode: 0 }], why: "reports an exit at once; the website playground's shells dispose on it (PlatformAdapter.killPty)" },
    'ack-replay': { na: 'no replays: requestInit is answered by nothing, so a collection times out (reconnect.ts)' },
    'ack-wire': { na: NO_HOST },
    'pty-wire': { na: NO_HOST },
    'init-token': { na: NO_HOST },
    theme: { na: 'no host: its parse reads the theme in process' },
    list: { na: 'no host to list PTYs: requestInit is answered by nothing' },
    replay: { na: 'no host to replay PTYs: requestInit is answered by nothing' },
    'alert-verbs': { na: NO_HOST },
    'fail:*': { na: 'no host to fail: every request is answered in process' },
  },
  vscode: {
    'init-token': { expect: [{ op: 'init' }], why: ONE_COLLECTOR },
    list: { expect: { kept: [{ ptys: LISTED.ptys }], removed: 0 }, why: ONE_COLLECTOR },
    replay: { expect: { replays: [{ id: 'r', data: 'out' }], alerts: [], command: 'sleep 5' }, why: ONE_COLLECTOR },
  },
  tauri: {
    state: { expect: null, why: 'persists a PersistedWindow, so answers nothing on the bare-Session pair (transport.md → Persisted session types)' },
  },
  harness: {
    state: { expect: null, why: 'mirrors standalone: a PersistedWindow, nothing on the bare-Session pair (standalone.md → Standalone browser-dev harness)' },
  },
  remote: {
    'ack-wire': { expect: [], why: 'a Client mirrors downstream and never pauses a laptop PTY: a no-op (transport.md → Output flow control)' },
    'ack-replay': { na: 'no replays: the Burrow keeps no per-pane replay in protocol-v1 (pocket-app.md → The seam)' },
    'pty-wire': { expect: [{ op: 'write', id: 'w', data: 'ls\r' }, { op: 'resize', id: 'w', cols: 100, rows: 30 }], why: 'panes are Burrow-owned: the phone never spawns or kills one (pocket-app.md → The seam)' },
    'init-token': { expect: [], why: "a no-op: Pocket reads the Burrow's directory, not a PTY list (pocket-app.md → The seam)" },
    theme: { expect: [], why: "the laptop's webview pushes the colours its Burrow's parser answers from" },
    list: { na: "no PTY list: Pocket reads the Burrow's directory (pocket-app.md → The seam)" },
    replay: { na: 'no replays: the Burrow keeps no per-pane replay in protocol-v1' },
    'alert-verbs': { expect: [], why: 'alerts are inert on the phone: the Burrow owns them (pocket-app.md → The seam)' },
    'fail:*': { na: 'no host requests: every query answers a constant (pocket-app.md → The seam)' },
  },
};

// ---------------------------------------------------------------------------
// Known failures: an implementation breaking a rule, held as `it.fails` with
// its evidence until the fix deletes the entry.

const KNOWN: Array<{ impl: Impl; case: CaseId; why: string }> = [
  {
    impl: 'vscode', case: 'cwds-shared',
    why: 'VSCodeAdapter.getCwds posts one pty:getCwds per call: two probes in one microtask cost two host round trips and two pty-host scans; only the standalone adapters coalesce (coalesceCwds)',
  },
];

// ---------------------------------------------------------------------------

/** Register the contract for `impl`, opening a fresh harness for every test. */
export function adapterContract(impl: Impl, open: () => Promise<ContractHarness>): void {
  describe(`${impl}: the PlatformAdapter contract`, () => {
    for (const [id, testCase] of Object.entries(CASES) as Array<[CaseId, ContractCase]>) {
      const title = `${testCase.title} [${testCase.rule}]`;
      const absent = (testCase.members ?? []).filter((member) => presence(impl, member) === 'no');
      const declared = DIFFERENCES[impl]?.[id] ?? (id.startsWith('fail:') ? DIFFERENCES[impl]?.['fail:*'] : undefined);
      const known = KNOWN.find((entry) => entry.impl === impl && entry.case === id);
      if (absent.length > 0) {
        it(`${title} — absent here: ${absent.join(', ')}`, async () => {
          const { adapter } = await open();
          for (const member of absent) expect(adapter[member], `MEMBERS says ${impl} has no ${member}`).toBeUndefined();
        });
      } else if (declared && 'na' in declared) {
        it(`${title} — n/a: ${declared.na}`, async () => {
          const h = await open();
          const playable = (testCase.needs ?? []).every((hook) => h[hook] !== undefined);
          expect(playable, 'declared n/a, but this harness can play the case: declare what it does instead').toBe(false);
        });
      } else {
        (known ? it.fails : it)(known ? `${title} — KNOWN` : title, async () => {
          const h = await open();
          const unplayable = (testCase.needs ?? []).filter((hook) => h[hook] === undefined);
          expect(unplayable, 'this harness cannot play the case: add the hook or declare it n/a').toEqual([]);
          const unbuilt = (testCase.members ?? []).filter((member) => h.adapter[member] === undefined);
          expect(unbuilt, 'a member MEMBERS marks conditional is absent here: build the harness where it exists').toEqual([]);
          expect(await testCase.observe(h, impl)).toEqual(declared && 'expect' in declared ? declared.expect : testCase.expect);
        });
      }
    }
  });
}
