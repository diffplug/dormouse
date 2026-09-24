/**
 * The one browser-automation host behind every webview
 * (docs/specs/dor-browser.md → "Browser Host"), shared by
 * the VS Code extension host and the standalone sidecar. Every request arrives
 * as one provider-tagged `BrowserRequest`, is validated here once — the
 * security boundary for both providers — and runs under one lifecycle: launches
 * and closes serialized per native identity, the post-launch blank-tab sweep,
 * the viewer sockets and their crisp captures, the editing scripts, headed
 * tracking and shutdown. A provider implements only the primitives that
 * genuinely differ (`BrowserProvider`): agent-browser its daemon state files,
 * stream and argv, Playwright its install discovery, registry and CDP.
 */
import { randomBytes } from 'crypto';
import * as path from 'path';
import {
  BROWSER_PROVIDERS,
  isBrowserProvider,
  sessionForKey,
  type BrowserAutomationProvider,
  type BrowserBinding,
} from 'dor-lib-common/browser-providers';
import { messageOf } from '../lib/errors';
import { settleAllWithin } from '../lib/settle-within';
import {
  BROWSER_CLOSE_MAX_CANCELS,
  BROWSER_REQUEST_TIMEOUT_MS,
  isBlankUrl,
  isBrowsableUrl,
  type BrowserEditOp,
  type BrowserOp,
  type BrowserRequest,
  type BrowserRequestBinding,
  type BrowserResult,
} from '../lib/platform/browser-automation';
import { createBrowserCaptures } from './browser-capture';
import type { WebSocket } from 'ws';
import { BrowserView, createViewerServer, type Upstream, type ViewerSink } from './browser-viewer';

/** An operation on a live browser that each provider maps to its own call:
 *  a fixed agent-browser argv, or a Playwright client call. */
export type BrowserAct = Extract<BrowserOp, { op: 'navigate' | 'history' | 'tab' | 'viewport' | 'device' }>;

/** The binding a provider runs one request with: the session named, or minted
 *  for a new launch. */
export type ProviderBinding = BrowserBinding;

/** A browser that is up: its stream — what `view` subscribes to — and
 *  whether it runs headed when the provider can tell. */
export interface LiveBrowser {
  stream: number;
  headed?: boolean;
}

/** How a CLI's `open` ended. */
export interface OpenOutcome {
  exitCode: number;
  stderr: string;
}

/**
 * The primitives a provider implements beneath the shared lifecycle. `B` is
 * its resolved binding, made once per request.
 */
export interface BrowserProvider<B = unknown> {
  /** Resolve a validated binding; throws when the provider cannot run. */
  bind(binding: ProviderBinding): B;
  /** The native identity of `b`'s browser: what launches and closes serialize
   *  on, and what a Surface is found by. */
  identity(b: B): string;
  /** What a launch or attach answers with beside the port. */
  describe(b: B): BrowserBinding;
  /** The live browser, found without starting one; `gone` (why) when nothing
   *  runs the session, `named` when something still carries its name, so a
   *  relaunch stops it first. Throws when one runs that cannot be viewed. */
  find(b: B): Promise<LiveBrowser | { gone: string; named: boolean }>;
  /** End whatever runs the session so a relaunch starts it in the mode it
   *  asks for; answers what `probe` needs to tell the replacement from it. */
  stop(b: B, timeoutMs: number): Promise<unknown>;
  /** Start the CLI's `open` — blank without a `url`. Settles when `open`
   *  returns, possibly long after the browser is up. */
  open(b: B, url: string | undefined, headed: boolean): Promise<OpenOutcome>;
  /** One readiness check during a launch: the browser once it is up, why the
   *  launch is lost, or `undefined` for not yet. `opened` is set once `open`
   *  returned; `replaced` is what `stop` answered. */
  probe(b: B, launch: { replaced: unknown; opened?: OpenOutcome; deadline: number }): Promise<LiveBrowser | { failed: string } | undefined>;
  /** How often a launch probes, in ms. */
  readonly pollMs: number;
  /** Close the session within `timeoutMs`; throws when the CLI refused or
   *  overran. The host has released `b` first. */
  close(b: B, timeoutMs: number): Promise<void>;
  /** Drop what the provider holds for `b` besides the session itself. */
  release?(b: B): Promise<void>;
  /** The session's tabs, and closing one, for the post-launch sweep. */
  listTabs(b: B): Promise<{ tabId: string; url: string }[]>;
  closeTab(b: B, tabId: string): Promise<void>;
  act(b: B, act: BrowserAct): Promise<BrowserResult>;
  /** Run one of the host's fixed editing scripts in the page. */
  evaluate(b: B, script: string): Promise<unknown>;
  /** One device-resolution JPEG at `CAPTURE_JPEG_QUALITY`: written to
   *  `file()` by a CLI, or its bytes. */
  screenshot(b: B, file: () => Promise<string>): Promise<{ path: string } | { bytes: Uint8Array }>;
  /** Subscribe `sink` to the browser at `stream` (a `find` or `probe`
   *  answer): its changed frames — none for a `headed` viewer — and state.
   *  Rejects when that browser is not live. */
  view(b: B, stream: number, opts: { headed: boolean }, sink: ViewerSink): Promise<Upstream>;
  /** Shutdown: release every client-side resource. */
  dispose?(): Promise<void>;
}

export interface BrowserHostDeps {
  /** Write text to the OS clipboard (copy/cut land here). VS Code passes
   *  `vscode.env.clipboard.writeText`; the sidecar shells out (pbcopy/clip/…). */
  writeClipboardText(text: string): void | Promise<void>;
  log?(message: string): void;
  /** Each provider this host drives, made on its first request — Playwright's
   *  bundle carries `ws`, and most sessions never open a Playwright pane. */
  providers: { [P in BrowserAutomationProvider]?: () => BrowserProvider<any> };
}

// The host owns the exact JS for each editing op — the webview only selects a
// name, so this never becomes an arbitrary-eval channel. copy/cut return the
// selected text; selectAll returns ''. Inputs/textareas use selection ranges;
// everything else falls back to the Selection API + execCommand.
const EDIT_SCRIPTS: Record<BrowserEditOp, string> = {
  selectAll: `(()=>{const el=document.activeElement;if(el&&'select'in el&&'value'in el){el.select();}else{document.execCommand('selectAll');}return'';})()`,
  copy: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){return el.value.slice(el.selectionStart,el.selectionEnd);}return String(window.getSelection()||'');})()`,
  cut: `(()=>{const el=document.activeElement;if(el&&'selectionStart'in el&&el.selectionStart!=null){const s=el.selectionStart,e=el.selectionEnd,t=el.value.slice(s,e);el.setRangeText('',s,e,'end');el.dispatchEvent(new Event('input',{bubbles:true}));return t;}const sel=String(window.getSelection()||'');if(sel)document.execCommand('delete');return sel;})()`,
};

/** The fixed script for an editing op; undefined for any other name.
 *
 *  `op` arrives from webview IPC unvalidated, and a plain-object lookup answers
 *  for inherited keys too: `op: 'constructor'` yields `Object`, which is truthy
 *  and would walk straight past a caller's rejection into the page.
 *  `hasOwnProperty.call` keeps the table's own three names the only ones that
 *  select a script. Same guard, same reason as `own()` in
 *  `RemoteControlSection.tsx`. */
function editScript(op: unknown): string | undefined {
  return typeof op === 'string' && Object.prototype.hasOwnProperty.call(EDIT_SCRIPTS, op)
    ? EDIT_SCRIPTS[op as BrowserEditOp]
    : undefined;
}

/** A fresh managed session for a browser the GUI opens with none named, in
 *  `dor`'s `sessionForKey` namespace so it can't collide with a user's own. */
function generateGuiSession(): string {
  return sessionForKey(`gui-${randomBytes(6).toString('hex')}`);
}

const TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,63}$/;
/** A webview-minted id of a request that can bring a browser up. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

/** `value` as an optional request id: absent, valid, or `null` when invalid. */
function optionalRequestId(value: unknown): { requestId?: string } | null {
  if (value === undefined) return {};
  return typeof value === 'string' && REQUEST_ID.test(value) ? { requestId: value } : null;
}

function dimension(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

/**
 * `raw`, as a request the providers may run, or why it may not. The request
 * arrives from webview IPC unvalidated, so the result is rebuilt field by
 * field: a provider renders its own argv or client call from these values, and
 * no caller token reaches a CLI as it came — agent-browser reads launch
 * options anywhere on its command line (rationale in docs/specs/dor-browser.md
 * → "Browser Host").
 */
function parseBrowserRequest(raw: unknown): BrowserRequest | string {
  if (!raw || typeof raw !== 'object') return 'invalid browser request';
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  if (!isBrowserProvider(provider)) return 'unknown browser provider';
  const given = (r.binding && typeof r.binding === 'object' ? r.binding : {}) as Record<string, unknown>;
  const binding: BrowserRequestBinding = {};
  if (given.session !== undefined) {
    if (!BROWSER_PROVIDERS[provider].isSessionName(given.session)) return 'a valid session name is required';
    binding.session = given.session;
  }
  if (typeof given.cwd === 'string' && path.isAbsolute(given.cwd)) binding.cwd = given.cwd;
  // Checked against the provider's allowlist where it is spawned.
  if (typeof given.binaryPath === 'string') binding.binaryPath = given.binaryPath;
  const op = parseOp(r);
  if (typeof op === 'string') return op;
  if (op.op === 'launch') {
    // A new session opens where it was asked; a relaunch only carries its page
    // along, reopening blank on one it may not navigate to.
    if (binding.session === undefined && !isBrowsableUrl(op.url)) return 'Browser navigation requires an http(s) URL';
  } else if (binding.session === undefined) {
    return 'a valid session name is required';
  }
  return { provider, binding, ...op };
}

function parseOp(r: Record<string, unknown>): BrowserOp | string {
  switch (r.op) {
    case 'launch':
    case 'attach': {
      const id = optionalRequestId(r.requestId);
      if (!id) return 'invalid request id';
      const url = isBrowsableUrl(r.url) ? { url: r.url } : {};
      return r.op === 'launch'
        ? { op: 'launch', ...url, headed: r.headed === true, ...id }
        : { op: 'attach', ...url, ...(r.headed === true ? { headed: true } : {}), ...id };
    }
    case 'view': {
      const stream = r.stream;
      if (typeof stream !== 'number' || !Number.isSafeInteger(stream) || stream <= 0) return 'a stream is required';
      return { op: 'view', stream, ...(r.headed === true ? { headed: true } : {}), ...(r.debug === true ? { debug: true } : {}) };
    }
    case 'edit':
      return editScript(r.edit) !== undefined ? { op: 'edit', edit: r.edit as BrowserEditOp } : `unknown edit op '${String(r.edit)}'`;
    case 'navigate':
      return isBrowsableUrl(r.url) ? { op: 'navigate', url: r.url } : 'Browser navigation requires an http(s) URL';
    case 'history':
      return r.dir === 'back' || r.dir === 'forward' || r.dir === 'reload' ? { op: 'history', dir: r.dir } : 'unknown history direction';
    case 'tab': {
      const { action, tabId } = r;
      if ((action !== 'select' && action !== 'close') || typeof tabId !== 'string' || !TAB_ID.test(tabId)) return 'invalid tab operation';
      return { op: 'tab', action, tabId };
    }
    case 'viewport': {
      const [width, height, dpr] = [dimension(r.width, 16384), dimension(r.height, 16384), dimension(r.dpr, 10)];
      return width && height && dpr ? { op: 'viewport', width, height, dpr } : 'invalid viewport';
    }
    case 'device':
      return typeof r.name === 'string' && DEVICE_NAME.test(r.name) ? { op: 'device', name: r.name } : 'invalid device name';
    case 'close': {
      const cancels = r.cancels;
      if (cancels === undefined) return { op: 'close' };
      const valid = Array.isArray(cancels) && cancels.length <= BROWSER_CLOSE_MAX_CANCELS
        && cancels.every((id) => typeof id === 'string' && REQUEST_ID.test(id));
      return valid ? { op: 'close', cancels: [...cancels] as string[] } : 'invalid cancelled request ids';
    }
    default:
      return `unsupported browser operation '${String(r.op)}'`;
  }
}

// A launch answers inside every transport's wait for any request
// (`BROWSER_REQUEST_TIMEOUT_MS`), or the webview gives up on a browser the host
// is still bringing up. The whole request, from its arrival, gets
// REQUEST_BUDGET_MS, a margin short of that wait for the transport. Startup —
// queueing behind an earlier launch, stopping the old browser, probing — ends
// LAUNCH_CLOSE_RESERVE_MS before it; a launch that gives up then waits up to
// OPEN_SETTLE_MS for its `open`, and closes the session with whatever remains.
const REQUEST_BUDGET_MS = BROWSER_REQUEST_TIMEOUT_MS - 2_000;
// Everything else run in a browser's lifecycle queue is bounded too, so one
// hung CLI holds that browser's later requests, and shutdown, only this long.
const CLOSE_TIMEOUT_MS = 10_000;
const OPEN_SETTLE_MS = 4_000;
const LAUNCH_CLOSE_RESERVE_MS = OPEN_SETTLE_MS + 4_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One request, resolved: its provider, the provider's binding, and the
 *  native identity everything per-browser keys on. */
type Bound = { p: BrowserProvider<unknown>; b: unknown; id: string };

export function createBrowserHost(deps: BrowserHostDeps) {
  const log = (error: unknown) => deps.log?.(`[browser-host] ${messageOf(error)}`);
  const providers = new Map<BrowserAutomationProvider, BrowserProvider<unknown>>();
  const viewers = createViewerServer();
  // The viewer sockets open on each browser: a launch or close ends them.
  const views = new Map<string, Set<BrowserView>>();
  const captures = createBrowserCaptures();
  let closed = false;

  function providerFor(id: BrowserAutomationProvider): BrowserProvider<unknown> {
    let provider = providers.get(id);
    if (!provider) {
      const make = deps.providers[id];
      if (!make) throw new Error(`${id} is unavailable on this host`);
      provider = make();
      providers.set(id, provider);
    }
    return provider;
  }

  // --- per-identity lifecycle ---

  // Launches, attaches and closes of one browser run one at a time, in arrival
  // order.
  const lifecycle = new Map<string, Promise<unknown>>();
  function serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const operation = (lifecycle.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    lifecycle.set(id, operation);
    void operation.finally(() => { if (lifecycle.get(id) === operation) lifecycle.delete(id); }).catch(() => {});
    return operation;
  }

  // The closes of each browser that have arrived.
  const closesArrived = new Map<string, number>();
  /** Serialize work that can bring `id`'s browser up — a launch, an attach —
   *  unless a close of it arrives before its turn: a Surface closed meanwhile
   *  sent it, and run after that close it would reopen the session, possibly
   *  under the next Surface to launch the name. */
  function bringUp<T>(id: string, action: () => Promise<T>): Promise<T> {
    const closes = closesArrived.get(id) ?? 0;
    return serialize(id, async () => {
      if ((closesArrived.get(id) ?? 0) !== closes) throw new Error('the browser was closed');
      return action();
    });
  }

  // Requests a close cancelled — sent before it by the Surface it closed —
  // that have not arrived yet: a transport may deliver them after the close,
  // and one run then would bring the browser up for a closed Surface. Kept
  // well past any request's wait (`BROWSER_REQUEST_TIMEOUT_MS`) and bounded,
  // oldest first; one already arrived is superseded above if still queued, or
  // closed after by the close if running, so its entry just expires.
  const cancelled = new Map<string, number>();
  const CANCEL_TTL_MS = 5 * 60_000;
  const MAX_CANCELLED = 256;
  function cancelRequests(ids: readonly string[] = []): void {
    const now = Date.now();
    // Insertion order is expiry order: the TTL is fixed.
    for (const [id, expires] of cancelled) {
      if (expires > now) break;
      cancelled.delete(id);
    }
    for (const id of ids) {
      cancelled.delete(id);
      cancelled.set(id, now + CANCEL_TTL_MS);
    }
    for (const id of cancelled.keys()) {
      if (cancelled.size <= MAX_CANCELLED) break;
      cancelled.delete(id);
    }
  }
  /** Whether a close already cancelled request `id`, forgetting it. */
  function wasCancelled(id: string | undefined): boolean {
    if (id === undefined) return false;
    const expires = cancelled.get(id);
    cancelled.delete(id);
    return expires !== undefined && expires > Date.now();
  }

  // The browsers a launch is replacing or a close is ending right now. An
  // operation reaching one meanwhile would drive the browser in the gap —
  // agent-browser's CLI starts a competing daemon at about:blank to answer —
  // so every operation but these three is refused until the launch or close
  // is done.
  const settling = new Map<string, number>();
  async function settle<T>(id: string, work: () => Promise<T>): Promise<T> {
    settling.set(id, (settling.get(id) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (settling.get(id) ?? 1) - 1;
      if (left > 0) settling.set(id, left);
      else settling.delete(id);
    }
  }

  // Bumped by every launch and close: work begun for an earlier browser (a
  // post-launch sweep, a capture to join) must not reach the one that
  // replaced it.
  const generations = new Map<string, number>();
  async function invalidate({ p, b, id }: Bound): Promise<number> {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    captures.forget(id);
    // Their browser is going: whoever still views it asks again.
    for (const view of views.get(id) ?? []) view.close(1001, 'the browser was relaunched or closed');
    await p.release?.(b);
    return generation;
  }

  /** Release what the provider holds for the browser, then close its session. */
  async function shut({ p, b }: Bound, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    await p.release?.(b);
    await p.close(b, Math.max(0, timeoutMs));
  }

  // Browsers launched headed are real OS windows, so shutdown closes them.
  // Headless ones are left alive to reattach across webview reloads.
  const headed = new Map<string, Bound>();
  function trackHeaded(bound: Bound, isHeaded: boolean | undefined): void {
    if (isHeaded === true) headed.set(bound.id, bound);
    else if (isHeaded === false) headed.delete(bound.id);
  }

  // The newest launch per identity; a failed launch's late close defers to it.
  const latestLaunch = new Map<string, object>();

  /** Launch `bound`'s browser at `url`, or blank without one: headed or not,
   *  stopping what runs the session first unless it is `fresh`. Answers once
   *  the browser is up, never waiting for the page. */
  function launch(bound: Bound, url: string | undefined, isHeaded: boolean, fresh: boolean, requestDeadline: number): Promise<LiveBrowser> {
    return settle(bound.id, () => bringUpBrowser(bound, url, isHeaded, fresh, requestDeadline));
  }

  async function bringUpBrowser(bound: Bound, url: string | undefined, isHeaded: boolean, fresh: boolean, requestDeadline: number): Promise<LiveBrowser> {
    const { p, b, id } = bound;
    if (closed) throw new Error('the browser host is shutting down');
    const deadline = requestDeadline - LAUNCH_CLOSE_RESERVE_MS;
    if (Date.now() >= deadline) throw new Error('the browser launch timed out behind an earlier one');
    const generation = await invalidate(bound);
    const replaced = fresh ? undefined : await p.stop(b, Math.max(0, deadline - Date.now()));
    const token = {};
    latestLaunch.set(id, token);
    // Before the launch, so a window whose page never loads is still closed.
    trackHeaded(bound, isHeaded);
    let opened: OpenOutcome | undefined;
    const opening = p.open(b, url, isHeaded).then(
      (outcome) => { opened = outcome; },
      (error: unknown) => { opened = { exitCode: 1, stderr: messageOf(error) }; },
    );
    // The browser coming up, not the page loading, completes a launch.
    let why: string | undefined;
    while (Date.now() < deadline && !closed) {
      let probe: Awaited<ReturnType<typeof p.probe>>;
      try {
        probe = await p.probe(b, { replaced, opened, deadline });
      } catch (error) {
        why = messageOf(error);
      }
      if (probe && 'stream' in probe) {
        sweepAfter(opening, bound, generation);
        return probe;
      }
      if (probe && 'failed' in probe) {
        why = probe.failed;
        break;
      }
      await wait(p.pollMs);
    }
    // Until `open` registers the session, a close has nothing to close, and the
    // browser it then brings up is one nothing tracks. Let it land first; if it
    // is still running, close again once it does, unless a newer launch has
    // taken the session over by then.
    const [landed] = await settleAllWithin([opening.then(() => true)], OPEN_SETTLE_MS, false);
    await shut(bound, requestDeadline - Date.now()).catch(log);
    if (latestLaunch.get(id) === token) headed.delete(id);
    if (!landed) {
      void opening.then(async () => {
        if (latestLaunch.get(id) === token) await shut(bound);
      }).catch(log);
    }
    throw new Error(opened?.stderr.trim() || why || 'the browser launch timed out');
  }

  /** Once `open` returns, close the blank tabs a launch can leave — only while
   *  a real page is open, so never the sole tab, and only for the browser this
   *  launch brought up. Best-effort: a failure here fails nothing. */
  function sweepAfter(opening: Promise<void>, { p, b, id }: Bound, generation: number): void {
    const current = () => !closed && generations.get(id) === generation;
    void opening.then(async () => {
      if (!current()) return;
      const tabs = await p.listTabs(b);
      // The list may have queued behind `open`; a newer launch or a close can
      // begin while it waits.
      if (!current() || tabs.length < 2 || !tabs.some((tab) => isBrowsableUrl(tab.url))) return;
      // Last first, so a provider that names tabs by index keeps the rest's.
      for (const tab of [...tabs].reverse()) {
        if (!current()) return;
        if (isBlankUrl(tab.url)) await p.closeTab(b, tab.tabId);
      }
    }).catch(log);
  }

  /** A named launch into a browser already up in the mode it asks for: the
   *  page opens there — a navigation, not waited on — and nothing is stopped,
   *  so an agent driving the session keeps its tabs, state and CDP clients.
   *  Undefined when the browser is gone, cannot be viewed, or runs in the
   *  other mode, which a relaunch changes. agent-browser cannot report its
   *  mode, so a browser this host did not launch headed counts as headless. */
  async function reuse(bound: Bound, url: string | undefined, isHeaded: boolean): Promise<LiveBrowser | undefined> {
    const { p, b, id } = bound;
    const found = await p.find(b).catch(() => undefined);
    if (!found || !('stream' in found) || (found.headed ?? headed.has(id)) !== isHeaded) return undefined;
    if (isBrowsableUrl(url)) {
      void p.act(b, { op: 'navigate', url }).then((result) => {
        if (!result.ok) log(`navigating ${id} to ${url} failed: ${result.error ?? 'no reason given'}`);
      }, log);
    }
    return { ...found, headed: isHeaded };
  }

  /** The live browser; one that is gone relaunches at `url` when the caller
   *  names a page — `relaunched`, so the caller has no navigation left to run
   *  there — and fails otherwise. Serialized with launches, so two panes
   *  restoring one session relaunch it once. */
  function attach(bound: Bound, url: string | undefined, isHeaded: boolean, requestDeadline: number): Promise<LiveBrowser & { relaunched?: true }> {
    return bringUp(bound.id, async () => {
      const found = await bound.p.find(bound.b);
      if ('stream' in found) return found;
      if (!isBrowsableUrl(url)) throw new Error(found.gone);
      return { ...await launch(bound, url, isHeaded, !found.named, requestDeadline), relaunched: true };
    });
  }

  /** Close `bound`'s browser once the launch or attach of it running now has
   *  landed, so what that brings up is closed too; one still queued is
   *  superseded (`bringUp`), and one arriving later runs after. */
  function closeSession(bound: Bound): Promise<void> {
    closesArrived.set(bound.id, (closesArrived.get(bound.id) ?? 0) + 1);
    return serialize(bound.id, () => settle(bound.id, async () => {
      // The session is closed on purpose, so it is no longer shutdown's to
      // close. Invalidating released it.
      await invalidate(bound);
      headed.delete(bound.id);
      await bound.p.close(bound.b, CLOSE_TIMEOUT_MS);
    }));
  }

  // --- viewer sockets and their captures ---

  /** Open one viewer socket on the browser at `stream`, unless a launch or
   *  close of it began since its URL was granted (`generation`). */
  function openView(socket: WebSocket, bound: Bound, stream: number, isHeaded: boolean, debug: boolean, generation: number): void {
    if (closed || (generations.get(bound.id) ?? 0) !== generation) {
      socket.close(1001, 'the browser was relaunched or closed');
      return;
    }
    const view = new BrowserView(socket, {
      headed: isHeaded,
      capture: () => crisp(bound),
      onClose: () => {
        const open = views.get(bound.id);
        open?.delete(view);
        if (open?.size === 0) views.delete(bound.id);
      },
      ...(debug && deps.log ? { log: deps.log } : {}),
    });
    let open = views.get(bound.id);
    if (!open) views.set(bound.id, open = new Set());
    open.add(view);
    bound.p.view(bound.b, stream, { headed: isHeaded }, view).then(
      (upstream) => view.attach(upstream),
      (error: unknown) => view.close(1011, messageOf(error)),
    );
  }

  /** One device-resolution JPEG of `bound`'s browser, for its viewer sockets'
   *  crisp paint; undefined when none can be taken. A launch or close ends
   *  every viewer socket of the browser first, so none asks mid-relaunch. */
  async function crisp({ p, b, id }: Bound): Promise<Uint8Array | undefined> {
    try {
      return await captures.take(id, (file) => p.screenshot(b, file));
    } catch (error) {
      log(error);
      return undefined;
    }
  }

  // --- editing ---

  async function edit({ p, b, id }: Bound, op: BrowserEditOp): Promise<BrowserResult> {
    // The page answers an editing chord the way it answers a keystroke.
    for (const view of views.get(id) ?? []) view.openProvisionalWindow();
    const result = await p.evaluate(b, EDIT_SCRIPTS[op]);
    if (op === 'selectAll') return { ok: true };
    const text = typeof result === 'string' ? result : '';
    // Skip empty, so an empty selection doesn't clobber the clipboard.
    if (text) {
      try {
        await deps.writeClipboardText(text);
      } catch (error) {
        return { ok: false, error: `clipboard write failed: ${messageOf(error)}` };
      }
    }
    return { ok: true, text };
  }

  // --- dispatch ---

  async function run(raw: unknown): Promise<BrowserResult> {
    const r = parseBrowserRequest(raw);
    if (typeof r === 'string') return { ok: false, error: r };
    try {
      if (closed) throw new Error('the browser host is shutting down');
      // Sent before a close that cancelled it, delivered after: it opens
      // nothing for the Surface that close was for.
      if ((r.op === 'launch' || r.op === 'attach') && wasCancelled(r.requestId)) throw new Error('the browser was closed');
      const p = providerFor(r.provider);
      const b = p.bind({ ...r.binding, session: r.binding.session ?? generateGuiSession() });
      const bound: Bound = { p, b, id: p.identity(b) };
      const answer = (live: LiveBrowser): BrowserResult => {
        trackHeaded(bound, live.headed);
        return { ok: true, ...p.describe(b), nativeIdentity: bound.id, stream: live.stream, ...(live.headed !== undefined ? { headed: live.headed } : {}) };
      };
      const requestDeadline = Date.now() + REQUEST_BUDGET_MS;
      if (r.op !== 'launch' && r.op !== 'attach' && r.op !== 'close' && settling.has(bound.id)) {
        return { ok: false, error: 'the browser is being relaunched or closed' };
      }
      switch (r.op) {
        case 'launch': {
          const fresh = r.binding.session === undefined;
          const live = await bringUp(bound.id, async () => (fresh ? undefined : await reuse(bound, r.url, r.headed))
            ?? launch(bound, r.url, r.headed, fresh, requestDeadline));
          return answer({ headed: r.headed, ...live });
        }
        case 'attach': {
          const { relaunched, ...live } = await attach(bound, r.url, r.headed === true, requestDeadline);
          return { ...answer(live), ...(relaunched ? { relaunched } : {}) };
        }
        case 'close':
          cancelRequests(r.cancels);
          await closeSession(bound);
          return { ok: true };
        case 'view': {
          const { stream, headed: viewHeaded = false, debug = false } = r;
          const generation = generations.get(bound.id) ?? 0;
          return { ok: true, url: await viewers.grant((socket) => openView(socket, bound, stream, viewHeaded, debug, generation)) };
        }
        case 'edit':
          return await edit(bound, r.edit);
        default:
          return await p.act(b, r);
      }
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  return {
    /** One request from the webview. */
    request: run,
    /** Shutdown: end every viewer socket, close every headed window — so
     *  quitting orphans none — and drop the capture directory, so no frame of
     *  the user's browser outlives the process that took it. */
    close: async () => {
      // Every launch and sweep still pending now finds itself superseded.
      closed = true;
      const windows = [...headed.values()];
      headed.clear();
      await Promise.all([
        viewers.close(),
        ...windows.map((bound) => shut(bound).catch(log)),
        captures.remove(),
      ]);
      await settleAllWithin([...lifecycle.values()], CLOSE_TIMEOUT_MS, undefined);
      await Promise.all([...providers.values()].map((provider) => provider.dispose?.()));
    },
  };
}

