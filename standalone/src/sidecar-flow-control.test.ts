// @vitest-environment node
/**
 * Output flow control on real PTYs (`docs/specs/transport.md` -> "Output flow
 * control"): the sidecar exactly as `sidecar/main.js` composes it — the pinned
 * node-pty under `pty-core`, its events through the shared host's parse and
 * flow control — minus Rust and the webview, whose acknowledgements these tests
 * send or withhold. Here rather than beside `pty-core`'s `node --test` suites
 * because the host is TypeScript that only this package's vitest reads from
 * source. Written to run on Windows too, where ConPTY's pause is the open
 * question.
 *
 * Every flood is capped in bytes (`FLOOD_CAP`) and every wait in time, so a
 * broken backpressure fails a test rather than filling memory or running on.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSidecarHost, type SidecarHost, type SidecarHostPtyManager } from 'dormouse-lib/host/remote/sidecar-entry';
import { sliceSince } from 'dormouse-lib/host/replay-buffer';
import { PTY_HIGH_WATERMARK_CHARS, PTY_LOW_WATERMARK_CHARS } from 'dormouse-lib/lib/pty-flow';

const sidecarRequire = createRequire(fileURLToPath(new URL('../sidecar/package.json', import.meta.url)));
const { create } = sidecarRequire('./pty-core.js') as {
  create(send: (event: string, data: unknown) => void, pty: unknown, options: unknown): SidecarHostPtyManager & {
    killAll(): void;
    gracefulKill(ids: string[], timeout: number, requestId: string): void;
  };
};
const nodePty = sidecarRequire('node-pty');

/** What one paused PTY may still forward: one node-pty read past the mark. */
const ONE_READ = 64 * 1024;
const FLOOD_CAP = 40_000_000;
const IS_WINDOWS = process.platform === 'win32';
const YES = ['/usr/bin/yes', '/bin/yes'].find((candidate) => {
  try { readFileSync(candidate); return true; } catch { return false; }
});

/**
 * A program that writes `cap` chars of 80-column lines as fast as its PTY
 * takes them, recording how many it has written in `counter` after each
 * write: that file is how a test sees it blocked. With a `tail`, it instead
 * writes `cap` chars as one line in one write, so the host pauses on its last
 * char with nothing left unread, then after `pauseMs` writes the tail and
 * exits 7.
 */
const FLOOD_SCRIPT = `
const fs = require('fs');
const [counter, cap, tail, pauseMs] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const write = (text) => {
  for (let at = 0; at < text.length;) {
    try { at += fs.writeSync(1, text.slice(at)); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; sleep(5); }
  }
};
if (tail) {
  write('y'.repeat(Number(cap)));
  fs.writeFileSync(counter, cap);
  sleep(Number(pauseMs));
  write(tail);
  process.exit(7);
}
const chunk = ('y'.repeat(79) + '\\n').repeat(50);
let written = 0;
while (written < Number(cap)) {
  write(chunk);
  written += chunk.length;
  fs.writeFileSync(counter, String(written));
}
`;

interface Pty {
  /** Chars the host sent the window as \`pty:data\`. */
  forwarded: number;
  /** The last 200 chars it sent. */
  tail: string;
  exit?: { exitCode: number; at: number };
}

const until = async (predicate: () => boolean, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const step of cleanup.reverse()) {
    try { step(); } catch { /* best effort */ }
  }
  cleanup = [];
  vi.restoreAllMocks();
});

function sidecar() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dormouse-flow-'));
  const script = path.join(dir, 'flood.js');
  writeFileSync(script, FLOOD_SCRIPT);
  const ptys = new Map<string, Pty>();
  const pty = (id: string) => {
    let entry = ptys.get(id);
    if (!entry) ptys.set(id, entry = { forwarded: 0, tail: '' });
    return entry;
  };
  // The Burrow's memory-only store says so once.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Wired as `sidecar/main.js` wires them: every pty-core event through the
  // host's tap first, and only non-data events forwarded raw.
  let host: SidecarHost | null = null;
  const send = (event: string, data: unknown) => {
    const detail = data as { id?: string; data?: string; exitCode?: number };
    if (event === 'pty:data' && detail.id && typeof detail.data === 'string') {
      const entry = pty(detail.id);
      entry.forwarded += detail.data.length;
      entry.tail = (entry.tail + detail.data).slice(-200);
    } else if (event === 'pty:exit' && detail.id) {
      pty(detail.id).exit = { exitCode: detail.exitCode ?? -1, at: Date.now() };
    }
  };
  const mgr = create((event, data) => {
    host!.onPtyEvent(event, data);
    if (event !== 'data') send(`pty:${event}`, data);
  }, nodePty, { replay: true, sliceSince });
  // Which PTYs the host has paused, so a test knows it exercised one.
  const pauses: string[] = [];
  const pause = mgr.pause;
  mgr.pause = (id) => { pauses.push(id); pause(id); };
  host = createSidecarHost({ send, mgr });
  const live = host;
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  cleanup.push(() => mgr.killAll());
  cleanup.push(() => live.dispose());

  const counterOf = (id: string) => path.join(dir, `${id}.count`);
  return {
    host: live,
    mgr,
    pauses,
    pty,
    /** How many chars the program behind `id` has written. */
    written: (id: string) => {
      try { return Number(readFileSync(counterOf(id), 'utf8')) || 0; } catch { return 0; }
    },
    flood(id: string, cap = FLOOD_CAP, tail = '', pauseMs = 0) {
      live.handleCommand('pty:spawn', {
        id,
        options: { shell: process.execPath, args: [script, counterOf(id), String(cap), tail, String(pauseMs)], cwd: dir, cols: 100, rows: 30 },
      });
    },
    spawn(id: string, shell: string, args: string[]) {
      live.handleCommand('pty:spawn', { id, options: { shell, args, cwd: dir, cols: 100, rows: 30 } });
    },
    ack(id: string, chars: number) {
      live.handleCommand('pty:ack', { id, chars });
    },
  };
}

type Sidecar = ReturnType<typeof sidecar>;

/** Waits until `id` forwards nothing for `quietMs`: its PTY is paused. */
async function settled(side: Sidecar, id: string, quietMs = 400): Promise<number> {
  let last = -1;
  let since = Date.now();
  await until(() => {
    const now = side.pty(id).forwarded;
    if (now !== last) {
      last = now;
      since = Date.now();
      return false;
    }
    return now > 0 && Date.now() - since >= quietMs;
  }, `${id} to stop forwarding`);
  return last;
}

describe('a flood nobody acknowledges', { timeout: 30_000 }, () => {
  it('stops being forwarded within the high watermark plus one read, and blocks its program', async () => {
    const side = sidecar();
    side.flood('a');
    const forwarded = await settled(side, 'a');
    expect(forwarded).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS);
    expect(forwarded).toBeLessThanOrEqual(PTY_HIGH_WATERMARK_CHARS + ONE_READ);
    // The program's own count stops: its writes block on the full PTY.
    const before = side.written('a');
    await sleep(500);
    expect(side.written('a')).toBe(before);
    expect(before).toBeLessThan(FLOOD_CAP);
  });

  it('resumes as the window acknowledges', async () => {
    const side = sidecar();
    side.flood('a');
    const paused = await settled(side, 'a');
    const written = side.written('a');
    side.ack('a', paused - PTY_LOW_WATERMARK_CHARS);
    const resumed = await settled(side, 'a');
    expect(resumed).toBeGreaterThan(paused + PTY_LOW_WATERMARK_CHARS);
    expect(side.written('a')).toBeGreaterThan(written);
  });

  it('is forgiven and resumed when its window re-asks, and at a transfer mark', async () => {
    const side = sidecar();
    side.flood('a');
    const first = await settled(side, 'a');
    side.host.handleCommand('pty:requestInit', { ids: ['a'], forWindow: 'main', requestId: 'init-1' });
    const second = await settled(side, 'a');
    // Nothing was acknowledged: a whole fresh window's worth went out.
    expect(second - first).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS - ONE_READ);
    side.host.handleCommand('pty:mark', { ids: ['a'], requestId: 'mark-1' });
    const third = await settled(side, 'a');
    expect(third - second).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS - ONE_READ);
  });

  it('leaves a second PTY flowing', async () => {
    const side = sidecar();
    side.flood('stuck');
    await settled(side, 'stuck');
    const stuck = side.pty('stuck').forwarded;
    // A renderer that keeps up with the other PTY: it acknowledges everything.
    const cap = 4_000_000;
    side.flood('free', cap);
    let acknowledged = 0;
    const keepUp = setInterval(() => {
      const owed = side.pty('free').forwarded - acknowledged;
      if (owed <= 0) return;
      side.ack('free', owed);
      acknowledged += owed;
    }, 5);
    cleanup.push(() => clearInterval(keepUp));
    await until(() => side.pty('free').exit !== undefined, 'the free PTY to finish', 20_000);
    expect(side.written('free')).toBeGreaterThanOrEqual(cap);
    expect(side.pty('stuck').forwarded).toBe(stuck);
  });
});

describe('a paused PTY', { timeout: 30_000 }, () => {
  it('delivers the tail its program wrote before exiting, then the exit', async () => {
    const side = sidecar();
    // One char past the high watermark, then quiet while the host pauses,
    // then a tail nothing reads until the program is gone.
    side.flood('a', PTY_HIGH_WATERMARK_CHARS + 1, 'TAIL-OF-THE-RUN', 300);
    await until(() => side.pauses.includes('a'), 'the pause');
    await until(() => side.pty('a').exit !== undefined, 'the exit');
    expect(side.pty('a').exit!.exitCode).toBe(7);
    expect(side.pty('a').tail).toContain('TAIL-OF-THE-RUN');
  });

  it.skipIf(!YES || IS_WINDOWS)('ends a paused `yes` at a Ctrl+C', async () => {
    const side = sidecar();
    side.spawn('yes', YES!, ['y']);
    await settled(side, 'yes');
    const pressed = Date.now();
    side.host.handleCommand('pty:input', { id: 'yes', data: '\x03' });
    await until(() => side.pty('yes').exit !== undefined, 'yes to exit', 5_000);
    expect(side.pty('yes').exit!.at - pressed).toBeLessThan(1_000);
  });

  it('ends a paused program at a Ctrl+C, on every platform', async () => {
    const side = sidecar();
    side.flood('a');
    await settled(side, 'a');
    const pressed = Date.now();
    side.host.handleCommand('pty:input', { id: 'a', data: '\x03' });
    await until(() => side.pty('a').exit !== undefined, 'the program to exit', 5_000);
    expect(side.pty('a').exit!.at - pressed).toBeLessThan(1_000);
    expect(side.written('a')).toBeLessThan(FLOOD_CAP);
  });

  it('stops and reports its exit at a graceful kill', async () => {
    const side = sidecar();
    side.flood('a');
    await settled(side, 'a');
    side.mgr.gracefulKill(['a'], 2_000, 'stop-1');
    await until(() => side.pty('a').exit !== undefined, 'the exit', 5_000);
  });
});
