/**
 * The one browser-automation host behind every webview
 * (docs/specs/dor-browser.md → "Browser Host"), shared by
 * the VS Code extension host and the standalone sidecar. Every request arrives
 * as one provider-tagged `BrowserRequest`, is validated here once — the
 * security boundary for both providers — and runs under one lifecycle: launches
 * and closes serialized per native identity, the post-launch blank-tab sweep,
 * capture joins and their private directory, the editing scripts, headed
 * tracking and shutdown. A provider implements only the primitives that
 * genuinely differ (`BrowserProvider`): agent-browser its daemon state files
 * and argv, Playwright its install discovery, registry and CDP viewer.
 */
import { randomBytes } from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import { isBrowserProvider, sessionForKey, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import { messageOf } from '../lib/errors';
import {
  BROWSER_REQUEST_TIMEOUT_MS,
  isBrowsableUrl,
  type BrowserEditOp,
  type BrowserOp,
  type BrowserRequest,
  type BrowserRequestBinding,
  type BrowserResult,
} from '../lib/platform/browser-automation';
import { privateCaptureDir } from './private-capture-dir';

/** An operation on a live browser that each provider maps to its own call:
 *  a fixed agent-browser argv, or a Playwright client call. */
export type BrowserAct = Extract<BrowserOp, { op: 'navigate' | 'history' | 'tab' | 'viewport' | 'device' | 'cdpUrl' }>;

/** The binding a provider runs one request with: the session named, or minted
 *  for a new launch. */
export interface ProviderBinding {
  session: string;
  cwd?: string;
  binaryPath?: string;
}

/** A browser that is up: where it streams, and whether it runs headed when the
 *  provider can tell. */
export interface LiveBrowser {
  wsPort: number;
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
  describe(b: B): { session: string; cwd?: string; binaryPath?: string };
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
  /** Close the session; throws when the CLI refused. */
  close(b: B, timeoutMs?: number): Promise<void>;
  /** Drop what the provider holds for `b` besides the session itself. */
  release?(b: B): Promise<void>;
  /** The session's tabs, for the post-launch sweep. */
  listTabs(b: B): Promise<{ tabId: string; url: string }[]>;
  act(b: B, act: BrowserAct): Promise<BrowserResult>;
  /** Run one of the host's fixed editing scripts in the page. */
  evaluate(b: B, script: string): Promise<unknown>;
  /** One device-resolution frame: written to `file()` by a CLI, or its bytes. */
  screenshot(b: B, opts: { format: 'jpeg' | 'png'; quality: number }, file: () => Promise<string>): Promise<{ path: string } | { bytes: Uint8Array }>;
  /** The URL the webview connects to for a stream port. */
  streamUrl(port: number): Promise<string>;
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
export function editScript(op: unknown): string | undefined {
  return typeof op === 'string' && Object.prototype.hasOwnProperty.call(EDIT_SCRIPTS, op)
    ? EDIT_SCRIPTS[op as BrowserEditOp]
    : undefined;
}

/** A fresh managed session for a browser the GUI opens with none named, in
 *  `dor`'s `sessionForKey` namespace so it can't collide with a user's own. */
function generateGuiSession(): string {
  return sessionForKey(`gui-${randomBytes(6).toString('hex')}`);
}

/** An agent-browser session name. `dor ab --session` passes a user's raw name
 *  through, so anything goes but what agent-browser would read as an option or
 *  its socket directory as a path: the name lands after `--session` and in
 *  `<socket dir>/<session>.pid`, whose pid a relaunch signals. */
export function isAgentBrowserSession(value: unknown): value is string {
  return typeof value === 'string' && /^(?!-)[^/\\\x00-\x1f\x7f]{1,200}$/.test(value);
}

/** A Playwright session name: Dormouse mints these, and the host passes them
 *  as `--session=<name>`, so a strict charset costs nothing. */
export function isPlaywrightSession(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

/** Each provider's session charset — the name lands on its CLI's command
 *  line and, for agent-browser, in a socket-directory path. */
const SESSION_NAME: Record<BrowserAutomationProvider, (value: unknown) => value is string> = {
  'agent-browser': isAgentBrowserSession,
  playwright: isPlaywrightSession,
};

const TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// agent-browser's own `tab` verbs, which a tab id rendered after `tab` would run.
const TAB_VERBS = new Set(['new', 'close', 'list']);
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,63}$/;

function dimension(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

/** A capture's JPEG quality: an integer in 1..100, defaulting to 85. */
function jpegQuality(quality: unknown): number {
  if (typeof quality !== 'number' || !Number.isFinite(quality)) return 85;
  return Math.min(100, Math.max(1, Math.round(quality)));
}

/**
 * `raw`, as a request the providers may run, or why it may not. The request
 * arrives from webview IPC unvalidated, so the result is rebuilt field by
 * field: a provider renders its own argv or client call from these values, and
 * no caller token reaches a CLI as it came — agent-browser reads launch
 * options anywhere on its command line (rationale in docs/specs/dor-browser.md
 * → "Browser Host").
 */
export function parseBrowserRequest(raw: unknown): BrowserRequest | string {
  if (!raw || typeof raw !== 'object') return 'invalid browser request';
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  if (!isBrowserProvider(provider)) return 'unknown browser provider';
  const given = (r.binding && typeof r.binding === 'object' ? r.binding : {}) as Record<string, unknown>;
  const binding: BrowserRequestBinding = {};
  if (given.session !== undefined) {
    if (!SESSION_NAME[provider](given.session)) return 'a valid session name is required';
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
  } else if (op.op !== 'streamUrl' && binding.session === undefined) {
    return 'a valid session name is required';
  }
  if (op.op === 'cdpUrl' && provider !== 'agent-browser') return `${provider} has no cdpUrl operation`;
  return { provider, binding, ...op };
}

function parseOp(r: Record<string, unknown>): BrowserOp | string {
  switch (r.op) {
    case 'launch':
      return { op: 'launch', ...(isBrowsableUrl(r.url) ? { url: r.url } : {}), headed: r.headed === true };
    case 'attach':
      return { op: 'attach', ...(isBrowsableUrl(r.url) ? { url: r.url } : {}), headed: r.headed === true };
    case 'streamUrl': {
      const port = r.port;
      return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? { op: 'streamUrl', port } : 'a stream port is required';
    }
    case 'screenshot':
      return { op: 'screenshot', format: r.format === 'png' ? 'png' : 'jpeg', quality: jpegQuality(r.quality) };
    case 'edit':
      return editScript(r.edit) !== undefined ? { op: 'edit', edit: r.edit as BrowserEditOp } : `unknown edit op '${String(r.edit)}'`;
    case 'navigate':
      return isBrowsableUrl(r.url) ? { op: 'navigate', url: r.url } : 'Browser navigation requires an http(s) URL';
    case 'history':
      return r.dir === 'back' || r.dir === 'forward' || r.dir === 'reload' ? { op: 'history', dir: r.dir } : 'unknown history direction';
    case 'tab': {
      const { action, tabId } = r;
      if ((action !== 'select' && action !== 'close') || typeof tabId !== 'string' || !TAB_ID.test(tabId) || TAB_VERBS.has(tabId)) return 'invalid tab operation';
      return { op: 'tab', action, tabId };
    }
    case 'viewport': {
      const [width, height, dpr] = [dimension(r.width, 16384), dimension(r.height, 16384), dimension(r.dpr, 10)];
      return width && height && dpr ? { op: 'viewport', width, height, dpr } : 'invalid viewport';
    }
    case 'device':
      return typeof r.name === 'string' && DEVICE_NAME.test(r.name) ? { op: 'device', name: r.name } : 'invalid device name';
    case 'cdpUrl':
    case 'close':
      return { op: r.op };
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
const OPEN_SETTLE_MS = 4_000;
const LAUNCH_CLOSE_RESERVE_MS = OPEN_SETTLE_MS + 4_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isBlankTab(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === '' || trimmed === 'about:blank';
}

/** Screenshots answer with their bytes, or — to the sidecar, whose Rust
 *  caller reads the file itself — with the private file holding them. */
type Transport = 'bytes' | 'file';

/** One request, resolved: its provider, the provider's binding, and the
 *  native identity everything per-browser keys on. */
type Bound = { p: BrowserProvider<unknown>; b: unknown; id: string };

export function createBrowserHost(deps: BrowserHostDeps) {
  const log = (error: unknown) => deps.log?.(`[browser-host] ${messageOf(error)}`);
  const providers = new Map<BrowserAutomationProvider, BrowserProvider<unknown>>();
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

  // Bumped by every launch and close: work begun for an earlier browser (a
  // post-launch sweep, a capture to join) must not reach the one that
  // replaced it.
  const generations = new Map<string, number>();
  async function invalidate({ p, b, id }: Bound): Promise<number> {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    forgetInFlight(id);
    await p.release?.(b);
    return generation;
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
  async function launch(bound: Bound, url: string | undefined, isHeaded: boolean, fresh: boolean, requestDeadline: number): Promise<LiveBrowser> {
    const { p, b, id } = bound;
    if (closed) throw new Error('the browser host is shutting down');
    const deadline = requestDeadline - LAUNCH_CLOSE_RESERVE_MS;
    if (Date.now() >= deadline) throw new Error('the browser launch timed out behind an earlier one');
    const generation = await invalidate(bound);
    const replaced = fresh ? undefined : await p.stop(b, deadline - Date.now());
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
      if (probe && 'wsPort' in probe) {
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
    const landed = await Promise.race([opening.then(() => true), wait(OPEN_SETTLE_MS).then(() => false)]);
    await p.close(b, requestDeadline - Date.now()).catch(log);
    if (latestLaunch.get(id) === token) headed.delete(id);
    if (!landed) {
      void opening.then(async () => {
        if (latestLaunch.get(id) === token) await p.close(b);
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
        if (isBlankTab(tab.url)) await p.act(b, { op: 'tab', action: 'close', tabId: tab.tabId });
      }
    }).catch(log);
  }

  /** The live browser; one that is gone relaunches at `url` when the caller
   *  names a page — `relaunched`, so the caller has no navigation left to run
   *  there — and fails otherwise. Serialized with launches, so two panes
   *  restoring one session relaunch it once. */
  function attach(bound: Bound, url: string | undefined, isHeaded: boolean, requestDeadline: number): Promise<LiveBrowser & { relaunched?: true }> {
    return bringUp(bound.id, async () => {
      const found = await bound.p.find(bound.b);
      if ('wsPort' in found) return found;
      if (!isBrowsableUrl(url)) throw new Error(found.gone);
      return { ...await launch(bound, url, isHeaded, !found.named, requestDeadline), relaunched: true };
    });
  }

  /** Close `bound`'s browser once the launch or attach of it running now has
   *  landed, so what that brings up is closed too; one still queued is
   *  superseded (`bringUp`), and one arriving later runs after. */
  function closeSession(bound: Bound): Promise<void> {
    closesArrived.set(bound.id, (closesArrived.get(bound.id) ?? 0) + 1);
    return serialize(bound.id, async () => {
      // The session is closed on purpose, so it is no longer shutdown's to close.
      await invalidate(bound);
      headed.delete(bound.id);
      await bound.p.close(bound.b);
    });
  }

  // --- captures ---

  // Screenshots of the user's authenticated browser land here, written by an
  // external process under the ambient umask — which is why the private
  // directory, not the file mode, is the control.
  const captures = privateCaptureDir('dormouse-browser-');
  // One file per browser, so frames don't litter; one capture of it in flight
  // (below), so reusing the name is safe. The random name keeps it unguessable
  // from the session alone.
  const captureNames = new Map<string, string>();
  async function capturePath(id: string, format: 'jpeg' | 'png'): Promise<string> {
    let name = captureNames.get(id);
    if (name === undefined) captureNames.set(id, name = randomBytes(12).toString('hex'));
    return path.join(await captures.get(), `shot-${name}.${format === 'png' ? 'png' : 'jpg'}`);
  }

  // A capture a caller asking meanwhile joins rather than repeats, one per
  // browser, format and transport: surfaces can share a session, and a caller
  // re-asks after its adapter's timeout. Never one from before the browser's
  // close or relaunch (`forgetInFlight`).
  const inFlight = new Map<string, { id: string; promise: Promise<BrowserResult> }>();
  function joinInFlight(id: string, kind: string, work: () => Promise<BrowserResult>): Promise<BrowserResult> {
    const key = `${kind}\0${id}`;
    const pending = inFlight.get(key);
    if (pending) return pending.promise;
    const entry = { id, promise: Promise.resolve<BrowserResult>({ ok: false }) };
    entry.promise = work().finally(() => { if (inFlight.get(key) === entry) inFlight.delete(key); });
    inFlight.set(key, entry);
    return entry.promise;
  }

  /** Join none of `id`'s pending captures, and give its next capture a fresh
   *  file, so one still running cannot overwrite it. */
  function forgetInFlight(id: string): void {
    for (const [key, entry] of inFlight) if (entry.id === id) inFlight.delete(key);
    captureNames.delete(id);
  }

  function screenshot({ p, b, id }: Bound, opts: { format: 'jpeg' | 'png'; quality: number }, transport: Transport): Promise<BrowserResult> {
    const mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
    // Joined whole, read and unlink included: a caller joining only the capture
    // would read a file the first caller has already removed.
    return joinInFlight(id, `${transport}:${opts.format}`, async (): Promise<BrowserResult> => {
      const target = () => capturePath(id, opts.format);
      let shot: { path: string } | { bytes: Uint8Array };
      try {
        shot = await p.screenshot(b, opts, target);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      if (transport === 'file') {
        if ('path' in shot) return { ok: true, path: shot.path, mime };
        if (closed) return { ok: false, error: 'the browser host is shutting down' };
        const written = await target();
        await fs.writeFile(written, shot.bytes, { mode: 0o600 });
        return { ok: true, path: written, mime };
      }
      if ('bytes' in shot) return { ok: true, bytes: shot.bytes, mime };
      // The bytes go to the webview now, so the frame does not wait on disk for
      // shutdown. The file transport cannot do this: its reader (Rust) reads
      // the file afterwards, so there the next capture overwrites it.
      const buffer = await fs.readFile(shot.path);
      await fs.unlink(shot.path).catch(() => {});
      return { ok: true, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), mime };
    });
  }

  // --- editing ---

  async function edit({ p, b }: Bound, op: BrowserEditOp): Promise<BrowserResult> {
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

  async function run(raw: unknown, transport: Transport): Promise<BrowserResult> {
    const r = parseBrowserRequest(raw);
    if (typeof r === 'string') return { ok: false, error: r };
    try {
      if (closed) throw new Error('the browser host is shutting down');
      const p = providerFor(r.provider);
      if (r.op === 'streamUrl') return { ok: true, url: await p.streamUrl(r.port) };
      const b = p.bind({ ...r.binding, session: r.binding.session ?? generateGuiSession() });
      const bound: Bound = { p, b, id: p.identity(b) };
      const answer = (live: LiveBrowser): BrowserResult => {
        trackHeaded(bound, live.headed);
        return { ok: true, ...p.describe(b), nativeIdentity: bound.id, wsPort: live.wsPort, ...(live.headed !== undefined ? { headed: live.headed } : {}) };
      };
      const requestDeadline = Date.now() + REQUEST_BUDGET_MS;
      switch (r.op) {
        case 'launch': {
          const fresh = r.binding.session === undefined;
          const live = await bringUp(bound.id, () => launch(bound, r.url, r.headed, fresh, requestDeadline));
          return answer({ headed: r.headed, ...live });
        }
        case 'attach': {
          const { relaunched, ...live } = await attach(bound, r.url, r.headed === true, requestDeadline);
          return { ...answer(live), ...(relaunched ? { relaunched } : {}) };
        }
        case 'close':
          await closeSession(bound);
          return { ok: true };
        case 'screenshot':
          return await screenshot(bound, { format: r.format ?? 'jpeg', quality: r.quality ?? 85 }, transport);
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
    /** One request from the webview; a screenshot answers with its bytes. */
    request: (raw: unknown) => run(raw, 'bytes'),
    /** The same, but a screenshot answers with a private file's path. */
    requestFile: (raw: unknown) => run(raw, 'file'),
    /** Shutdown: close every headed window — so quitting orphans none — and
     *  drop the capture directory, so no frame of the user's browser outlives
     *  the process that took it. */
    close: async () => {
      closed = true;
      // Every launch and sweep still pending now finds itself superseded.
      for (const [id, generation] of generations) generations.set(id, generation + 1);
      const windows = [...headed.values()];
      headed.clear();
      await Promise.all([
        ...windows.map(async ({ p, b }) => {
          await p.release?.(b);
          await p.close(b).catch(log);
        }),
        captures.remove().then(() => captureNames.clear()),
      ]);
      await Promise.allSettled(lifecycle.values());
      await Promise.all([...providers.values()].map((provider) => provider.dispose?.()));
    },
  };
}

export type BrowserHost = ReturnType<typeof createBrowserHost>;
