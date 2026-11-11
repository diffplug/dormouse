/**
 * Output flow control at VS Code's pty host (`docs/specs/transport.md` ->
 * "Output flow control"): `pty-host.js` exactly as the extension host forks it,
 * over the pinned node-pty and the shared `pty-core`, takes the extension
 * host's word to pause and resume. Run in a VM context as `pty-host-wiring`
 * runs it, since the child loads node-pty from the built `dist` layout. The
 * flood is capped in bytes and every wait in time; written to run on Windows.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const hostPath = require.resolve('../src/pty-host.js');
const { create } = require('../../standalone/sidecar/pty-core.js');
const nodePty = require('node-pty');

const FLOOD_CAP = 40_000_000;
const FLOOD = `
const fs = require('fs');
const chunk = ('y'.repeat(79) + '\\n').repeat(50);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let written = 0; written < ${FLOOD_CAP}; written += chunk.length) {
  for (let at = 0; at < chunk.length;) {
    try { at += fs.writeSync(1, chunk.slice(at)); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; sleep(5); }
  }
}
`;

const until = async (predicate: () => boolean, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.reverse()) {
    try { step(); } catch { /* best effort */ }
  }
  cleanup = [];
});

function ptyHost() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dormouse-vscode-flow-'));
  const script = path.join(dir, 'flood.js');
  writeFileSync(script, FLOOD);
  const handlers: Record<string, (message: unknown) => void> = {};
  const received = new Map<string, number>();
  const exits = new Set<string>();
  runInNewContext(readFileSync(hostPath, 'utf8'), {
    __dirname: path.dirname(hostPath),
    require(id: string) {
      if (id === 'path') return path;
      if (id.endsWith('node-pty')) return nodePty;
      if (id.endsWith('pty-core.js')) return { create };
      if (id.endsWith('dor-control-server.js')) return { createDorControlServer: () => null };
      if (id.endsWith('local-directory')) return { canonicalLocalDirectory: async () => null, resolveBinaryPath: () => undefined };
      throw new Error(`Unexpected module: ${id}`);
    },
    console,
    setTimeout,
    process: {
      env: {},
      on(event: string, handler: (message: unknown) => void) { handlers[event] = handler; },
      send(message: { type: string; id?: string; data?: string }) {
        if (message.type === 'data' && message.id) received.set(message.id, (received.get(message.id) ?? 0) + (message.data?.length ?? 0));
        if (message.type === 'exit' && message.id) exits.add(message.id);
      },
      exit() {},
    },
  });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  cleanup.push(() => handlers.message?.({ type: 'killAll' }));
  return {
    send: (message: Record<string, unknown>) => handlers.message!(message),
    flood: (id: string) => handlers.message!({ type: 'spawn', id, shell: process.execPath, args: [script], cwd: dir, cols: 100, rows: 30 }),
    received: (id: string) => received.get(id) ?? 0,
    exited: (id: string) => exits.has(id),
  };
}

/** Waits until `id` forwards nothing for `quietMs`. */
async function quiet(host: ReturnType<typeof ptyHost>, id: string, quietMs = 400): Promise<number> {
  let last = -1;
  let since = Date.now();
  await until(() => {
    const now = host.received(id);
    if (now !== last) {
      last = now;
      since = Date.now();
      return false;
    }
    return Date.now() - since >= quietMs;
  }, `${id} to fall quiet`);
  return last;
}

describe('the VS Code pty host', { timeout: 30_000 }, () => {
  it('stops reading a PTY it is told to pause, and reads it again when told to resume', async () => {
    const host = ptyHost();
    host.flood('flood');
    await until(() => host.received('flood') > 100_000, 'the flood to start');
    host.send({ type: 'pause', id: 'flood' });
    const paused = await quiet(host, 'flood');
    expect(paused).toBeLessThan(FLOOD_CAP);
    host.send({ type: 'resume', id: 'flood' });
    await until(() => host.received('flood') > paused, 'the flood to resume');
    host.send({ type: 'pause', id: 'flood' });
    await quiet(host, 'flood');
    // A stop still ends a paused PTY, and its exit is still reported.
    host.send({ type: 'kill', id: 'flood' });
    await until(() => host.exited('flood'), 'the exit');
  });
});
