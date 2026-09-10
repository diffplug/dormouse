import { describe, expect, it } from 'vitest';
import {
  BLIND_SECOND_PRESS_MS,
  QUIET_BEFORE_RETRY_MS,
  captureAgentRecovery,
  type RecoveryHost,
} from './recovery-capture';

/**
 * A PTY host on a virtual clock. `sleep` is the only thing that moves time, so
 * the whole capture runs synchronously-fast while the second-press rules see
 * exactly the delays a real agent would produce.
 */
class FakePtys implements RecoveryHost {
  time = 0;
  /** Every `^C` batch, in order. */
  readonly presses: string[][] = [];
  readonly found: Record<string, string> = {};
  private readonly text = new Map<string, string>();
  private readonly count = new Map<string, number>();
  private queue: Array<{ due: number; id: string; data: string }> = [];
  private reactions = new Map<string, Array<(press: number) => void>>();

  constructor(private live: string[]) {
    for (const id of live) { this.text.set(id, ''); this.count.set(id, 0); }
  }

  /** Pre-existing output, received before the capture takes its mark. */
  seed(id: string, data: string): this {
    this.emitNow(id, data);
    return this;
  }

  /** `data` arrives `delay` ms after the pane's `press`-th `^C`. */
  onPress(id: string, press: number, delay: number, data: string): this {
    const list = this.reactions.get(id) ?? [];
    list.push((n) => { if (n === press) this.queue.push({ due: this.time + delay, id, data }); });
    this.reactions.set(id, list);
    return this;
  }

  exit(id: string): this {
    this.live = this.live.filter((other) => other !== id);
    return this;
  }

  liveIds(): string[] { return [...this.live]; }

  async interrupt(ids: string[]): Promise<void> {
    this.presses.push([...ids]);
    for (const id of ids) {
      const n = this.presses.filter((batch) => batch.includes(id)).length;
      for (const react of this.reactions.get(id) ?? []) react(n);
    }
  }

  receivedChars(id: string): number { return this.count.get(id) ?? 0; }

  outputSince(id: string, mark: number): string {
    // No eviction in the fake: the buffer holds everything, so a mark always
    // resolves exactly.
    const received = this.count.get(id) ?? 0;
    if (mark >= received) return '';
    return (this.text.get(id) ?? '').slice(mark);
  }

  onCommand(id: string, command: string): void { this.found[id] = command; }

  now(): number { return this.time; }

  async sleep(ms: number): Promise<void> {
    this.time += ms;
    const due = this.queue.filter((item) => item.due <= this.time);
    this.queue = this.queue.filter((item) => item.due > this.time);
    for (const item of due) this.emitNow(item.id, item.data);
  }

  private emitNow(id: string, data: string): void {
    this.text.set(id, (this.text.get(id) ?? '') + data);
    this.count.set(id, (this.count.get(id) ?? 0) + data.length);
  }
}

const CLAUDE_HINT = 'claude --resume 01JABCDEF';
const CODEX_HINT = 'codex resume 01HXYZ';

describe('captureAgentRecovery', () => {
  it('presses every live pane once and reports each hint as it arrives', async () => {
    const host = new FakePtys(['a', 'b'])
      .onPress('a', 1, 80, `\r\nResume with \`${CLAUDE_HINT}\`.\r\n`)
      .onPress('b', 1, 240, `\r\nRun ${CODEX_HINT} to continue\r\n`);

    const found = await captureAgentRecovery(host);

    expect(host.presses[0].sort()).toEqual(['a', 'b']);
    expect(found).toBe(2);
    expect(host.found).toEqual({ a: CLAUDE_HINT, b: CODEX_HINT });
  });

  it('presses again as soon as a pane asks, through its TUI escapes', async () => {
    // claude renders the prompt inside its TUI, so the raw bytes carry escapes
    // through the phrase — the ask gate strips before it matches.
    const ask = '[1mPress [0m[7mCtrl-C[0m again[K to exit';
    const host = new FakePtys(['a'])
      .onPress('a', 1, 40, ask)
      .onPress('a', 2, 40, `\r\n${CLAUDE_HINT}\r\n`);

    await captureAgentRecovery(host);

    // Second press well inside the blind window, so the ask is what triggered it.
    expect(host.presses).toHaveLength(2);
    expect(host.presses[1]).toEqual(['a']);
    expect(host.found.a).toBe(CLAUDE_HINT);
  });

  it('waits for both fallback clocks before pressing a silent pane again', async () => {
    const host = new FakePtys(['a']);
    // Chatty right up to just before the blind window closes, so `quietFor` is
    // what holds the second press back after `elapsed` has passed.
    for (let at = 40; at <= BLIND_SECOND_PRESS_MS; at += 40) host.onPress('a', 1, at, '.');
    host.onPress('a', 2, 40, `\r\n${CLAUDE_HINT}\r\n`);

    await captureAgentRecovery(host);

    expect(host.presses).toHaveLength(2);
    // Not at BLIND_SECOND_PRESS_MS: the pane was still printing, and a press
    // landing mid-print destroys the hint.
    const secondPressAt = host.time;
    expect(secondPressAt).toBeGreaterThanOrEqual(BLIND_SECOND_PRESS_MS + QUIET_BEFORE_RETRY_MS);
  });

  it('never presses a pane that already yielded, and presses each pane at most twice', async () => {
    const host = new FakePtys(['quick', 'silent'])
      .onPress('quick', 1, 40, `\r\n${CLAUDE_HINT}\r\n`);

    await captureAgentRecovery(host);

    expect(host.presses[0].sort()).toEqual(['quick', 'silent']);
    // Every later press is the silent pane's alone, and there is only one.
    expect(host.presses.slice(1)).toEqual([['silent']]);
  });

  it('never presses an exited pane', async () => {
    const host = new FakePtys(['alive', 'gone']).exit('gone');
    await captureAgentRecovery(host);
    expect(host.presses.every((batch) => !batch.includes('gone'))).toBe(true);
  });

  it('does nothing at all when no pane is live', async () => {
    const host = new FakePtys([]);
    expect(await captureAgentRecovery(host)).toBe(0);
    expect(host.presses).toEqual([]);
  });

  it('reads only bytes received after its own mark', async () => {
    // A hint from a PREVIOUS run, sitting in the buffer before the capture starts.
    const host = new FakePtys(['a']).seed('a', `\r\nold: claude --resume STALE0000\r\n`);
    await captureAgentRecovery(host);
    expect(host.found).toEqual({});
  });

  it('does not finish early on quiet — a pane that speaks late is still caught', async () => {
    // codex says nothing for ~250ms after the interrupt and then prints its whole
    // shutdown at once; settling on the gap loses it.
    const host = new FakePtys(['a']).onPress('a', 1, 1_000, `\r\n${CODEX_HINT}\r\n`);
    expect(await captureAgentRecovery(host)).toBe(1);
    expect(host.found.a).toBe(CODEX_HINT);
  });

  it('stops at the ceiling and reports what it has', async () => {
    const host = new FakePtys(['a', 'b'])
      .onPress('a', 1, 40, `\r\n${CLAUDE_HINT}\r\n`);
    // 'b' never answers at all.
    expect(await captureAgentRecovery(host, { maxWaitMs: 300 })).toBe(1);
    expect(host.time).toBeLessThan(600);
    expect(host.found).toEqual({ a: CLAUDE_HINT });
  });

  it('exits as soon as every pane has yielded', async () => {
    const host = new FakePtys(['a']).onPress('a', 1, 40, `\r\n${CLAUDE_HINT}\r\n`);
    await captureAgentRecovery(host, { maxWaitMs: 10_000 });
    expect(host.time).toBeLessThanOrEqual(80);
  });

  it('restricts the capture to the ids it is given', async () => {
    const host = new FakePtys(['a', 'b'])
      .onPress('a', 1, 40, `\r\n${CLAUDE_HINT}\r\n`)
      .onPress('b', 1, 40, `\r\n${CODEX_HINT}\r\n`);

    await captureAgentRecovery(host, { ids: ['a'] });

    expect(host.presses.flat()).toEqual(['a']);
    expect(host.found).toEqual({ a: CLAUDE_HINT });
  });
});
