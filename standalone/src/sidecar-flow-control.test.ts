// @vitest-environment node
/**
 * Output flow control on real PTYs (`docs/specs/transport.md` -> "Output flow
 * control"): the sidecar exactly as `sidecar/main.js` composes it — the pinned
 * node-pty under `pty-core`, its events through the shared host's parse and
 * flow control — minus Rust and the webview, whose acknowledgements these tests
 * send or withhold. Here rather than beside `pty-core`'s `node --test` suites
 * because the host is TypeScript that only this package's vitest reads from
 * source. Written to run on Windows too: every program is `node` running a
 * fixture script, never a shell line, and a Ctrl+C reaches it as Dormouse's
 * renderer sends one (win32-input-mode records once ConPTY asks for them).
 * Each failure names what the PTY printed first, so a red explains itself.
 *
 * Every flood is capped in bytes (`FLOOD_CAP`). Every wait is on progress, not
 * on a window: a program gets `START_MS` to start, then each phase fails only
 * when nothing more is forwarded or written for `STALL_MS`, and says which
 * phase stalled. A cold `node` start under Windows Defender, right after a
 * checkout, has left a flood barely begun three seconds in.
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
const YES = ['/usr/bin/yes', '/bin/yes'].find((candidate) => {
  try { readFileSync(candidate); return true; } catch { return false; }
});

/**
 * The PTY's program, `node` on every platform. `flood <counter> <cap>` writes
 * `cap` chars of 80-column lines as fast as its PTY takes them, recording how
 * many it has written in `counter` after each write: that file is how a test
 * sees it start, and sees it blocked. `tail <counter> <cap> <tail> <pauseMs>`
 * writes `cap` chars as one line in one write, so the host pauses on its last
 * char with nothing left unread, then after `pauseMs` writes `tail` and exits
 * 7. Every argument is nonempty: an empty one does not survive every
 * platform's command line.
 */
const FLOOD_SCRIPT = `
const fs = require('fs');
const [mode, counter, cap, tail, pauseMs] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const write = (text) => {
  for (let at = 0; at < text.length;) {
    try { at += fs.writeSync(1, text.slice(at)); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; sleep(5); }
  }
};
fs.writeFileSync(counter, '0');
if (mode === 'tail') {
  write('y'.repeat(Number(cap)));
  fs.writeFileSync(counter, cap);
  sleep(Number(pauseMs) || 0);
  write(tail);
  process.exit(7);
}
if (mode !== 'flood') throw new Error('unknown mode ' + mode);
const chunk = ('y'.repeat(79) + '\\n').repeat(50);
let written = 0;
while (written < Number(cap)) {
  write(chunk);
  written += chunk.length;
  fs.writeFileSync(counter, String(written));
}
`;

/** Ctrl+C as Dormouse's renderer sends it: on Windows, once ConPTY has asked for
 *  win32-input-mode, xterm's key records for Ctrl down, C down and up, Ctrl
 *  up; otherwise the control character the tty turns into SIGINT. */
const WIN32_CTRL_C = '\x1b[17;29;0;1;8;1_\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_\x1b[17;29;0;0;0;1_';

interface Pty {
  /** Chars the host sent the window as \`pty:data\`. */
  forwarded: number;
  /** The first 200 chars its program printed, before the parse. */
  head: string;
  /** The last 200 chars the host sent. */
  tail: string;
  /** How many \`T\`s the host sent: a tail test's tail is made of them. */
  ts: number;
  exit?: { exitCode: number; at: number };
}

const until = async (predicate: () => boolean, what: string, ms = 10_000, detail = () => '') => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a program may take to start writing. */
const START_MS = 60_000;
/** How long a phase may see nothing forwarded and nothing written. */
const STALL_MS = 15_000;
/** Above every phase's caps added up, so a phase's own error is what fails. */
const CASE_MS = 150_000;

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
    if (!entry) ptys.set(id, entry = { forwarded: 0, head: '', tail: '', ts: 0 });
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
      for (const char of detail.data) if (char === 'T') entry.ts++;
    } else if (event === 'pty:exit' && detail.id) {
      pty(detail.id).exit = { exitCode: detail.exitCode ?? -1, at: Date.now() };
    }
  };
  const mgr = create((event, data) => {
    const raw = data as { id?: string; data?: string };
    if (event === 'data' && raw.id && typeof raw.data === 'string') {
      const entry = pty(raw.id);
      if (entry.head.length < 200) entry.head = (entry.head + raw.data).slice(0, 200);
    }
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
  // The most each counter has read: a read racing the program's rewrite of
  // the file can see it empty or cut short.
  const most = new Map<string, number>();
  /** How many chars the program behind `id` has written; -1 before it starts. */
  const written = (id: string) => {
    let count = -1;
    try { count = Number(readFileSync(counterOf(id), 'utf8')) || 0; } catch { /* not started */ }
    count = Math.max(count, most.get(id) ?? -1);
    most.set(id, count);
    return count;
  };
  const spawnNode = (id: string, args: string[]) => live.handleCommand('pty:spawn', {
    id,
    options: { shell: process.execPath, args: [script, ...args], cwd: dir, cols: 100, rows: 30 },
  });
  return {
    host: live,
    mgr,
    pauses,
    /** How many times the host has paused `id`, peeks' re-pauses included. */
    pausesOf: (id: string) => pauses.filter((paused) => paused === id).length,
    pty,
    written,
    /** Everything a failure message needs to explain itself. */
    describe: (id: string) => {
      const entry = pty(id);
      return `forwarded ${entry.forwarded}, program wrote ${written(id)}, paused ${pauses.filter((p) => p === id).length}x, `
        + `exit ${JSON.stringify(entry.exit ?? null)}, output began ${JSON.stringify(entry.head)}`;
    },
    flood(id: string, cap = FLOOD_CAP) {
      spawnNode(id, ['flood', counterOf(id), String(cap)]);
    },
    floodThenTail(id: string, cap: number, tail: string, pauseMs: number) {
      spawnNode(id, ['tail', counterOf(id), String(cap), tail, String(pauseMs)]);
    },
    /** Ctrl+C as the renderer would send it to this PTY. */
    interrupt(id: string) {
      const data = pty(id).head.includes('\x1b[?9001h') ? WIN32_CTRL_C : '\x03';
      live.handleCommand('pty:input', { id, data });
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

/** What a paused PTY may still forward in a window: on macOS it is read once
 *  every peek, about 1 KB each. A flowing one forwards megabytes. */
const TRICKLE = ONE_READ / 2;

/** Waits for `id`'s program to start, by default to write its first chunk. */
async function running(side: Sidecar, id: string, started = () => side.written(id) > 0): Promise<void> {
  await until(started, `${id}'s program to start`, START_MS, () => side.describe(id));
}

/** Waits for `done`, failing only on a stall: the deadline restarts whenever
 *  `id`'s PTY forwards more or its program writes more. */
async function progressUntil(side: Sidecar, id: string, done: () => boolean, phase: string): Promise<void> {
  let progress = Number.NaN;
  let deadline = 0;
  while (!done()) {
    const now = Date.now();
    const current = side.pty(id).forwarded + side.written(id);
    if (current !== progress) {
      progress = current;
      deadline = now + STALL_MS;
    } else if (now > deadline) {
      throw new Error(`${id} stalled ${phase}: nothing forwarded or written for ${STALL_MS} ms; ${side.describe(id)}`);
    }
    await sleep(20);
  }
}

/**
 * Waits until `id`'s program runs, the host pauses its PTY (again) with more
 * than `above` forwarded, and the PTY then forwards no more than a trickle
 * over `quietMs`. The pause, not a quiet spell, is the signal: a cold ConPTY
 * has sat quiet for longer than `quietMs` before the flood reached it.
 */
async function settled(side: Sidecar, id: string, above = 0, quietMs = 400): Promise<number> {
  const pausedBefore = side.pausesOf(id);
  await running(side, id);
  await progressUntil(side, id, () => side.pausesOf(id) > pausedBefore && side.pty(id).forwarded > above, `before the host paused it past ${above}`);
  const samples: Array<[number, number]> = [];
  await until(() => {
    const now = Date.now();
    const forwarded = side.pty(id).forwarded;
    samples.push([now, forwarded]);
    while (samples.length > 1 && now - samples[1][0] >= quietMs) samples.shift();
    const [since, then] = samples[0];
    return now - since >= quietMs && forwarded - then < TRICKLE;
  }, `${id} to stop forwarding once paused`, STALL_MS, () => side.describe(id));
  return side.pty(id).forwarded;
}

describe('a flood nobody acknowledges', { timeout: CASE_MS }, () => {
  it('stops being forwarded within the high watermark plus one read, and blocks its program', async () => {
    const side = sidecar();
    side.flood('a');
    const forwarded = await settled(side, 'a');
    expect(forwarded, side.describe('a')).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS);
    expect(forwarded, side.describe('a')).toBeLessThanOrEqual(PTY_HIGH_WATERMARK_CHARS + ONE_READ);
    // The program's own count all but stops: its writes block on the full PTY.
    const before = side.written('a');
    await sleep(500);
    expect(side.written('a') - before, side.describe('a')).toBeLessThan(TRICKLE);
    expect(before, side.describe('a')).toBeLessThan(FLOOD_CAP);
  });

  it('resumes as the window acknowledges', async () => {
    const side = sidecar();
    side.flood('a');
    const paused = await settled(side, 'a', PTY_HIGH_WATERMARK_CHARS);
    const written = side.written('a');
    side.ack('a', paused - PTY_LOW_WATERMARK_CHARS);
    const resumed = await settled(side, 'a', paused);
    expect(resumed, side.describe('a')).toBeGreaterThan(paused + PTY_LOW_WATERMARK_CHARS);
    expect(side.written('a'), side.describe('a')).toBeGreaterThan(written);
  });

  it('is forgiven and resumed when its window re-asks, and at a transfer mark', async () => {
    const side = sidecar();
    side.flood('a');
    const first = await settled(side, 'a', PTY_HIGH_WATERMARK_CHARS);
    side.host.handleCommand('pty:requestInit', { ids: ['a'], forWindow: 'main', requestId: 'init-1' });
    const second = await settled(side, 'a', first);
    // Nothing was acknowledged: a whole fresh window's worth went out.
    expect(second - first, side.describe('a')).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS - ONE_READ);
    side.host.handleCommand('pty:mark', { ids: ['a'], requestId: 'mark-1' });
    const third = await settled(side, 'a', second);
    expect(third - second, side.describe('a')).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS - ONE_READ);
  });

  it('leaves a second PTY flowing', async () => {
    const side = sidecar();
    side.flood('stuck');
    await settled(side, 'stuck', PTY_HIGH_WATERMARK_CHARS);
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
    await running(side, 'free');
    await progressUntil(side, 'free', () => side.pty('free').exit !== undefined, 'before it finished');
    expect(side.written('free'), side.describe('free')).toBeGreaterThanOrEqual(cap);
    expect(side.pty('stuck').forwarded - stuck, side.describe('stuck')).toBeLessThan(TRICKLE);
  });
});

describe('a paused PTY', { timeout: CASE_MS }, () => {
  it('delivers the tail its program wrote before exiting, then the exit', async () => {
    const side = sidecar();
    // One char past the high watermark, then quiet while the host pauses,
    // then a tail nothing reads until the program is gone. Over 1 KB, which
    // macOS discards from an exit it holds unread.
    const tail = `${'T'.repeat(1500)}-end-of-run`;
    side.floodThenTail('a', PTY_HIGH_WATERMARK_CHARS + 1, tail, 300);
    // Its counter reads 0 until the one big write is taken whole.
    await running(side, 'a', () => side.written('a') >= 0);
    await progressUntil(side, 'a', () => side.pauses.includes('a'), 'before the host paused it');
    await progressUntil(side, 'a', () => side.pty('a').exit !== undefined, 'before its exit');
    expect(side.pty('a').exit!.exitCode, side.describe('a')).toBe(7);
    expect(side.pty('a').ts, side.describe('a')).toBe(1500);
    expect(side.pty('a').tail, side.describe('a')).toContain('-end-of-run');
  });

  // `yes` itself, which Windows does not have; the case after it is the same
  // check on every platform, with `node` flooding instead.
  it.skipIf(!YES)('ends a paused `yes` at a Ctrl+C (POSIX: no `yes` on Windows)', async () => {
    const side = sidecar();
    side.spawn('yes', YES!, ['y']);
    await running(side, 'yes', () => side.pty('yes').forwarded > 0);
    await progressUntil(side, 'yes', () => side.pty('yes').forwarded > PTY_HIGH_WATERMARK_CHARS && side.pauses.includes('yes'), 'before the host paused it');
    await sleep(400);
    const pressed = Date.now();
    side.interrupt('yes');
    await progressUntil(side, 'yes', () => side.pty('yes').exit !== undefined, 'before exiting at the Ctrl+C');
    expect(side.pty('yes').exit!.at - pressed, side.describe('yes')).toBeLessThan(1_000);
  });

  it('ends a paused program at a Ctrl+C, on every platform', async () => {
    const side = sidecar();
    side.flood('a');
    await settled(side, 'a', PTY_HIGH_WATERMARK_CHARS);
    const pressed = Date.now();
    side.interrupt('a');
    await progressUntil(side, 'a', () => side.pty('a').exit !== undefined, 'before exiting at the Ctrl+C');
    expect(side.pty('a').exit!.at - pressed, side.describe('a')).toBeLessThan(1_000);
    expect(side.written('a'), side.describe('a')).toBeLessThan(FLOOD_CAP);
  });

  it('stops and reports its exit at a graceful kill', async () => {
    const side = sidecar();
    side.flood('a');
    await settled(side, 'a', PTY_HIGH_WATERMARK_CHARS);
    side.mgr.gracefulKill(['a'], 2_000, 'stop-1');
    await progressUntil(side, 'a', () => side.pty('a').exit !== undefined, 'before exiting at a graceful kill');
  });
});
