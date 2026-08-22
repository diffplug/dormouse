import { fork, ChildProcess, type Serializable } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { log } from './log';
import type { DorControlRequestPayload, DorControlResponsePayload } from '../../dor/src/protocol';
import type { OpenPort } from '../../lib/src/lib/platform/types';
import { OPEN_PORT_TIMEOUT_MS } from '../../lib/src/lib/platform/types';

export interface PtyCallbacks {
  onData(id: string, data: string): void;
  onExit(id: string, exitCode: number): void;
}

export interface PtySpawnOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  args?: string[];
}

// The pty host forwards the dor wire payloads verbatim over IPC.
export type DorControlRequest = DorControlRequestPayload;
export type DorControlResponse = DorControlResponsePayload;

interface PtyBufferEntry {
  replayChunks: string[];
  replayChars: number;
  scrollbackChunks: string[];
  scrollbackChars: number;
  /** Every char ever buffered for this pane, never decremented by a trim — so it
   *  is a stable coordinate space for marking a position in the stream, which
   *  `scrollbackChars` is not once the cap starts evicting. */
  receivedChars: number;
  alive: boolean;
  exitCode?: number;
  /** Requested shell executable. An absent value means the shared PTY host's
   *  platform default, whose parser family is deterministic. */
  shell?: string;
}

const MAX_BUFFER_CHARS = 1_000_000;
const ptyBuffers = new Map<string, PtyBufferEntry>();
const killedPtyIds = new Set<string>();

function trimChunks(chunks: string[], totalChars: number): number {
  while (totalChars > MAX_BUFFER_CHARS && chunks.length > 1) {
    const removed = chunks.shift()!;
    totalChars -= removed.length;
  }
  return totalChars;
}

function createBufferEntry(alive: boolean, exitCode?: number, shell?: string): PtyBufferEntry {
  return {
    replayChunks: [],
    replayChars: 0,
    scrollbackChunks: [],
    scrollbackChars: 0,
    receivedChars: 0,
    alive,
    exitCode,
    shell,
  };
}

function bufferData(id: string, data: string): void {
  if (killedPtyIds.has(id)) return;
  let entry = ptyBuffers.get(id);
  if (!entry) {
    entry = createBufferEntry(true);
    ptyBuffers.set(id, entry);
  }
  entry.replayChunks.push(data);
  entry.replayChars += data.length;
  entry.replayChars = trimChunks(entry.replayChunks, entry.replayChars);

  entry.scrollbackChunks.push(data);
  entry.scrollbackChars += data.length;
  entry.receivedChars += data.length;
  entry.scrollbackChars = trimChunks(entry.scrollbackChunks, entry.scrollbackChars);
}

function bufferExit(id: string, exitCode: number): void {
  if (killedPtyIds.has(id)) return;
  let entry = ptyBuffers.get(id);
  if (!entry) {
    entry = createBufferEntry(false, exitCode);
    ptyBuffers.set(id, entry);
    return;
  }
  entry.alive = false;
  entry.exitCode = exitCode;
}

export function getBufferedPtys(): Map<string, { alive: boolean; exitCode?: number; shell?: string }> {
  const result = new Map<string, { alive: boolean; exitCode?: number; shell?: string }>();
  for (const [id, entry] of ptyBuffers) {
    result.set(id, { alive: entry.alive, exitCode: entry.exitCode, shell: entry.shell });
  }
  return result;
}

/**
 * The current lifetime record for one PTY, without copying every buffer entry.
 * Natural exits remain recorded until the pane is disposed or a new generation
 * is spawned under the id, so a late stream subscription can close the
 * resolve-to-subscribe race in the remote Host.
 */
export function getPtyStatus(id: string): { alive: boolean; exitCode?: number } | undefined {
  const entry = ptyBuffers.get(id);
  return entry ? { alive: entry.alive, exitCode: entry.exitCode } : undefined;
}

/**
 * Whether this extension host holds a PTY under that id — alive or exited, but
 * not killed. Pane ids are unique within a window and nothing coordinates them
 * across windows, so this is how the peer link tells one of its own terminals
 * from a sibling window's that happens to share the id (`peer-link.ts`).
 */
export function hasPty(id: string): boolean {
  return ptyBuffers.has(id);
}

export function getReplayData(id: string): string | null {
  const entry = ptyBuffers.get(id);
  if (!entry || entry.replayChunks.length === 0) return null;
  const data = entry.replayChunks.join('');
  entry.replayChunks = [];
  entry.replayChars = 0;
  return data;
}

export function getScrollback(id: string): string | null {
  const entry = ptyBuffers.get(id);
  if (!entry || entry.scrollbackChunks.length === 0) return null;
  return entry.scrollbackChunks.join('');
}

/**
 * A mark in the pane's output stream, cheap enough to take on every poll tick:
 * `receivedChars` is maintained exactly by `bufferData`, so a caller watching a
 * pane for growth pays nothing instead of a ~1MB `join()`.
 *
 * Counts everything ever received, NOT what is currently buffered. A pane at the
 * 1MB cap — precisely the long-running agent pane recovery cares about — holds
 * `scrollbackChars` pinned at the cap while output keeps flowing, so a buffer
 * length is neither a usable growth signal nor a usable offset there.
 */
export function getScrollbackReceived(id: string): number {
  return ptyBuffers.get(id)?.receivedChars ?? 0;
}

/**
 * The output received after a `getScrollbackReceived` mark, clamped to what the
 * bounded buffer still holds. Joins only the chunks that span the mark, so
 * repeatedly reading a pane's recent tail costs the tail, not the buffer.
 */
export function getScrollbackSince(id: string, mark: number): string {
  const entry = ptyBuffers.get(id);
  if (!entry) return '';
  // Chunk eviction can have carried the mark off the front; the oldest char the
  // buffer still holds is the furthest back this can honestly answer.
  const oldestHeld = entry.receivedChars - entry.scrollbackChars;
  const wanted = entry.receivedChars - Math.max(mark, oldestHeld);
  if (wanted <= 0) return '';
  const tail: string[] = [];
  let held = 0;
  for (let i = entry.scrollbackChunks.length - 1; i >= 0 && held < wanted; i--) {
    const chunk = entry.scrollbackChunks[i];
    tail.unshift(chunk);
    held += chunk.length;
  }
  const joined = tail.join('');
  return held > wanted ? joined.slice(held - wanted) : joined;
}

let child: ChildProcess | null = null;
let childReady = false;
let pendingMessages: any[] = [];
const callbackSet = new Set<PtyCallbacks>();
const dorControlRequestListeners = new Set<(request: DorControlRequest) => void>();
// The socket path is chosen by the pty-host, not here: it has to land in a
// hardened per-user directory (POSIX) or under an unguessable pipe name
// (Windows), and only the process that binds it knows whether it came up. The
// host reports it back through the spawn env — see pty-host.js and
// docs/specs/dor-cli.md.
const dorControlToken = randomBytes(24).toString('hex');

// Always run the pty host under the editor's own Node — Electron's bundled
// runtime (process.execPath, re-execed as Node via ELECTRON_RUN_AS_NODE, which
// is inherited through `env` at the fork site). VSCode's integrated terminal
// drives node-pty against Electron the same way, and node-pty ships N-API
// prebuilds that load across runtimes, so there's no need to hunt for a
// user-installed system Node — which was unreliable and, on Windows, caused
// multi-second fork stalls.
function resolveNodeBinary(): string {
  return process.execPath;
}

// The runtime env is constant for the life of the extension host (it depends
// only on the fixed extension path and module-level socket/token), so compute
// it once and reuse it across every PTY spawn rather than rebuilding the paths.
let dorRuntimeEnvCache: { path: string; env: Record<string, string> } | null = null;

// What this VS Code window has open: the `.code-workspace` file when one is
// loaded (an untitled workspace has no on-disk file, so fall through), else the
// first workspace folder. Effectively constant per window — switching folder or
// workspace file reloads the extension host.
function resolveHostWorkspace(): string | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile?.scheme === 'file') return workspaceFile.fsPath;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getDorRuntimeEnv(extensionPath: string): Record<string, string> {
  if (dorRuntimeEnvCache?.path === extensionPath) return dorRuntimeEnvCache.env;
  const dorCliRoot = path.join(extensionPath, 'dor-cli');
  const hostWorkspace = resolveHostWorkspace();
  const env = {
    DORMOUSE_HOST: 'vscode',
    ...(hostWorkspace ? { DORMOUSE_HOST_WORKSPACE: hostWorkspace } : {}),
    DORMOUSE_NODE: resolveNodeBinary(),
    DORMOUSE_CLI_BIN: path.join(dorCliRoot, 'bin'),
    DORMOUSE_CLI_JS: path.join(dorCliRoot, 'dist', 'dor.js'),
    // OSC 633 shell-integration scripts, copied next to the bundled pty-host by
    // the build (see package.json `build`). Mirrors how DORMOUSE_CLI_BIN is set.
    DORMOUSE_SHELL_INTEGRATION_DIR: path.join(extensionPath, 'dist', 'shell-integration'),
  };
  dorRuntimeEnvCache = { path: extensionPath, env };
  return env;
}

function ensureChild(extensionPath: string): ChildProcess {
  if (child && child.connected) return child;

  const hostScript = path.join(extensionPath, 'dist', 'pty-host.js');
  const dorEnv = getDorRuntimeEnv(extensionPath);
  const nodePath = dorEnv.DORMOUSE_NODE;

  child = fork(hostScript, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execPath: nodePath,
    execArgv: [], // clear --inspect flags inherited from VSCode debug
    env: {
      ...process.env,
      ...dorEnv,
      // Only the fork gets the token; `getDorRuntimeEnv` deliberately omits it,
      // so it reaches a shell only after pty-host.js has a listening socket to
      // pair it with.
      DORMOUSE_CONTROL_TOKEN: dorControlToken,
    },
  });

  childReady = false;

  child.on('message', (msg: any) => {
    if (msg.type === 'ready') {
      log.info('pty-host ready');
      childReady = true;
      for (const queued of pendingMessages) {
        child?.send(queued);
      }
      pendingMessages = [];
    } else if (msg.type === 'data') {
      bufferData(msg.id, msg.data);
      for (const cb of callbackSet) cb.onData(msg.id, msg.data);
    } else if (msg.type === 'exit') {
      bufferExit(msg.id, msg.exitCode);
      for (const cb of callbackSet) cb.onExit(msg.id, msg.exitCode);
    } else if (msg.type === 'error') {
      log.error(`PTY error for ${msg.id}:`, msg.message);
    } else if (msg.type === 'dor:controlRequest') {
      for (const listener of dorControlRequestListeners) {
        listener({
          requestId: msg.requestId,
          surfaceId: msg.surfaceId,
          method: msg.method,
          params: msg.params,
        });
      }
    }
  });

  child.on('exit', (code) => {
    log.error(`pty-host exited unexpectedly (code ${code})`);
    child = null;
    childReady = false;
    pendingMessages = [];
    shellsCache = null;
  });

  child.stderr?.on('data', (data: Buffer) => {
    log.error(`pty-host stderr: ${data.toString().trim()}`);
  });

  return child;
}

let extensionPath_ = '';

export function setExtensionPath(p: string): void {
  extensionPath_ = p;
}

export function addCallbacks(cb: PtyCallbacks): () => void {
  callbackSet.add(cb);
  return () => { callbackSet.delete(cb); };
}

export function onDorControlRequest(listener: (request: DorControlRequest) => void): () => void {
  dorControlRequestListeners.add(listener);
  return () => { dorControlRequestListeners.delete(listener); };
}

export function respondDorControl(response: DorControlResponse): void {
  if (!child?.connected) return;
  child.send({ type: 'dor:controlResponse', ...response });
}

function sendToChild(msg: any): void {
  ensureChild(extensionPath_);
  if (childReady) {
    child?.send(msg);
  } else {
    pendingMessages.push(msg);
  }
}

export function spawn(id: string, options?: PtySpawnOptions): void {
  killedPtyIds.delete(id);
  ptyBuffers.set(id, createBufferEntry(true, undefined, options?.shell));
  const dorEnv = getDorRuntimeEnv(extensionPath_);
  sendToChild({
    type: 'spawn',
    id,
    cols: options?.cols || 80,
    rows: options?.rows || 30,
    cwd: options?.cwd,
    shell: options?.shell,
    args: options?.args,
    env: dorEnv,
  });
}

export interface ShellEntry {
  name: string;
  path: string;
  args: string[];
}

let shellsCache: Promise<ShellEntry[]> | null = null;

export function getAvailableShells(): Promise<ShellEntry[]> {
  if (shellsCache) return shellsCache;
  const pending = new Promise<ShellEntry[]>((resolve) => {
    const requestId = `shells-${Date.now()}`;
    // Ensure the child process is forked before attaching the listener —
    // otherwise `child` is null on the cold path and the handler is never
    // registered, causing the timeout to fire with an empty list.
    sendToChild({ type: 'getShells', requestId });
    const timeout = setTimeout(() => {
      child?.off('message', handler);
      resolve([]);
    }, 15000);
    const handler = (msg: any) => {
      if (msg.type === 'shells' && msg.requestId === requestId) {
        clearTimeout(timeout);
        child?.off('message', handler);
        resolve(msg.shells || []);
      }
    };
    child?.on('message', handler);
  });
  shellsCache = pending;
  // Don't pin an empty result in the cache — lets a subsequent call retry
  // if the first one timed out or the child was still warming up.
  void pending.then((shells) => {
    if (shells.length === 0 && shellsCache === pending) shellsCache = null;
  });
  return pending;
}

export function getCwd(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    sendToChild({ type: 'getCwd', id });
    const timeout = setTimeout(() => {
      child?.off('message', handler);
      resolve(null);
    }, 1000);
    const handler = (msg: any) => {
      if (msg.type === 'cwd' && msg.id === id) {
        clearTimeout(timeout);
        child?.off('message', handler);
        resolve(msg.cwd);
      }
    };
    child?.on('message', handler);
  });
}

export function getOpenPorts(id: string): Promise<OpenPort[]> {
  return new Promise((resolve) => {
    sendToChild({ type: 'getOpenPorts', id });
    const timeout = setTimeout(() => {
      child?.off('message', handler);
      resolve([]);
    }, OPEN_PORT_TIMEOUT_MS);
    const handler = (msg: any) => {
      if (msg.type === 'openPorts' && msg.id === id) {
        clearTimeout(timeout);
        child?.off('message', handler);
        resolve(msg.ports || []);
      }
    };
    child?.on('message', handler);
  });
}

export function write(id: string, data: string): void {
  sendToChild({ type: 'input', id, data });
}

export function resize(id: string, cols: number, rows: number): void {
  sendToChild({ type: 'resize', id, cols, rows });
}

export function kill(id: string): void {
  killedPtyIds.add(id);
  ptyBuffers.delete(id);
  sendToChild({ type: 'kill', id });
}

let ackRequestSeq = 0;

/**
 * Fire-and-wait for a whole-host pty-host operation: send `msg`, resolve on the
 * matching ack, and resolve anyway once `timeoutMs` elapses. Nothing on a
 * teardown path may wait unbounded, and every one of these runs on one.
 *
 * Acks are correlated by request id, not merely by type, precisely *because* the
 * timeout exists: a timed-out call's ack still arrives afterwards, and a
 * type-only match let that stale reply resolve the next call the instant it was
 * issued. The caller would then act on an interrupt whose `^C` had not been
 * written yet — deciding the next second press against a state that never
 * happened. The pty-host echoes `requestId` on both acks.
 */
function awaitChildAck(msg: Record<string, unknown>, ackType: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!child?.connected) { resolve(); return; }
    const requestId = `ack-${++ackRequestSeq}`;
    const finish = () => {
      clearTimeout(timeout);
      child?.off('message', handler);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    const handler = (reply: any) => {
      if (reply.type === ackType && reply.requestId === requestId) finish();
    };
    child.on('message', handler);
    child.send({ ...msg, requestId } as Serializable);
  });
}

/**
 * Send one `^C` to the named PTYs. Whether a second press follows is the caller's
 * decision, per PTY — codex and claude want opposite things and a blanket second
 * press destroys codex's hint (docs/specs/transport.md).
 */
export function interrupt(ids: string[], timeoutMs = 400): Promise<void> {
  return awaitChildAck({ type: 'interrupt', ids }, 'interruptDone', timeoutMs);
}

export function gracefulKillAll(timeoutMs = 2000): Promise<void> {
  // Extra margin beyond the pty-host's own timeout.
  return awaitChildAck({ type: 'gracefulKillAll', timeout: timeoutMs }, 'gracefulKillDone', timeoutMs + 500);
}

export function killAll(): void {
  ptyBuffers.clear();
  killedPtyIds.clear();
  if (child?.connected) {
    child.send({ type: 'killAll' });
    child.kill();
    child = null;
  }
}
