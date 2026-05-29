import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';
import { log } from './log';
import type { DorControlRequestPayload, DorControlResponsePayload } from '../../dor/src/protocol';

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
  alive: boolean;
  exitCode?: number;
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

function createBufferEntry(alive: boolean, exitCode?: number): PtyBufferEntry {
  return {
    replayChunks: [],
    replayChars: 0,
    scrollbackChunks: [],
    scrollbackChars: 0,
    alive,
    exitCode,
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

export function getBufferedPtys(): Map<string, { alive: boolean; exitCode?: number }> {
  const result = new Map<string, { alive: boolean; exitCode?: number }>();
  for (const [id, entry] of ptyBuffers) {
    result.set(id, { alive: entry.alive, exitCode: entry.exitCode });
  }
  return result;
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

let child: ChildProcess | null = null;
let childReady = false;
let pendingMessages: any[] = [];
const callbackSet = new Set<PtyCallbacks>();
const dorControlRequestListeners = new Set<(request: DorControlRequest) => void>();
const dorControlToken = randomBytes(24).toString('hex');
const dorControlSocket = process.platform === 'win32'
  ? `\\\\.\\pipe\\dormouse-vscode-${process.pid}-dor`
  : path.join(os.tmpdir(), `dormouse-vscode-${process.pid}-dor.sock`);

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

function getDorRuntimeEnv(extensionPath: string): Record<string, string> {
  if (dorRuntimeEnvCache?.path === extensionPath) return dorRuntimeEnvCache.env;
  const dorCliRoot = path.join(extensionPath, 'dor-cli');
  const env = {
    DORMOUSE_NODE: resolveNodeBinary(),
    DORMOUSE_CLI_BIN: path.join(dorCliRoot, 'bin'),
    DORMOUSE_CLI_JS: path.join(dorCliRoot, 'dist', 'dor.js'),
    DORMOUSE_CONTROL_SOCKET: dorControlSocket,
    DORMOUSE_CONTROL_TOKEN: dorControlToken,
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
  ptyBuffers.set(id, createBufferEntry(true));
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

export function gracefulKillAll(timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (!child?.connected) { resolve(); return; }
    const timeout = setTimeout(() => {
      child?.off('message', handler);
      resolve();
    }, timeoutMs + 500); // extra margin beyond the pty-host timeout
    const handler = (msg: any) => {
      if (msg.type === 'gracefulKillDone') {
        clearTimeout(timeout);
        child?.off('message', handler);
        resolve();
      }
    };
    child.on('message', handler);
    child.send({ type: 'gracefulKillAll', timeout: timeoutMs });
  });
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
