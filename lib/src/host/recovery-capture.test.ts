import { describe, expect, it } from 'vitest';
import { AGENT_EXIT_FIXTURES } from '../lib/__fixtures__/coding-agents';
import {
  BLIND_SECOND_PRESS_MS,
  MAX_PRESSES,
  RECOVERY_SIZE,
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
  /** Every host call that changes a PTY, in order. */
  readonly calls: string[] = [];
  private resized: Array<(id: string) => void> = [];
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

  /** `data` arrives `delay` ms after the pane is resized. */
  onResize(id: string, delay: number, data: string): this {
    this.resized.push((target) => { if (target === id) this.queue.push({ due: this.time + delay, id, data }); });
    return this;
  }

  exit(id: string): this {
    this.live = this.live.filter((other) => other !== id);
    return this;
  }

  liveIds(): string[] { return [...this.live]; }

  resize(id: string, cols: number, rows: number): void {
    this.calls.push(`resize ${id} ${cols}x${rows}`);
    for (const react of this.resized) react(id);
  }

  /** Virtual time since the first `^C` (the capture widens and settles before it). */
  get sincePress(): number { return this.time - (this.firstPressAt ?? this.time); }
  private firstPressAt: number | null = null;

  async interrupt(ids: string[]): Promise<void> {
    this.firstPressAt ??= this.time;
    this.calls.push(`^C ${ids.join(',')}`);
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

/** `data` every `period` ms after the pane's first press, for `span` ms. */
function every(host: FakePtys, id: string, period: number, span: number, data: string): FakePtys {
  for (let at = period; at <= span; at += period) host.onPress(id, 1, at, data);
  return host;
}

const fixture = (agent: string) => AGENT_EXIT_FIXTURES.find((item) => item.agent === agent)!;

/** Pi exits only when the second press lands within 500ms of the first; a later
 *  one just clears its editor again. */
function piIgnoresLatePress(host: FakePtys): FakePtys {
  const interrupt = host.interrupt.bind(host);
  host.interrupt = async (ids) => {
    if (host.presses.length === 1 && host.sincePress >= 500) return;
    await interrupt(ids);
  };
  return host;
}

const CLAUDE_HINT = 'claude --resume 11111111-1111-4111-8111-111111111111';
const CODEX_HINT = 'codex resume 22222222-2222-7222-8222-222222222222';

describe('captureAgentRecovery', () => {
  it.each(AGENT_EXIT_FIXTURES)('waits through every ID split in the $agent exit hint', async ({ output, command }) => {
    const id = command.split(' ').at(-1)!;
    const idStart = output.indexOf(id);
    expect(idStart).toBeGreaterThanOrEqual(0);
    // Include the cut just after the full ID: only the next read proves it ended.
    for (let length = 1; length <= id.length; length++) {
      const cut = idStart + length;
      const host = new FakePtys(['a'])
        .onPress('a', 1, 20, output.slice(0, cut))
        .onPress('a', 1, 80, output.slice(cut));
      await captureAgentRecovery(host);
      expect(host.found.a, `split at ID character ${length}`).toBe(command);
      expect(host.sincePress).toBe(80);
    }
  });

  it('does not turn an unterminated hint into a command at the capture deadline', async () => {
    const host = new FakePtys(['a']).onPress('a', 1, 20, CODEX_HINT);
    expect(await captureAgentRecovery(host, { maxWaitMs: 200 })).toBe(0);
    expect(host.found).toEqual({});
  });

  it('presses every live pane once and reports each hint as it arrives', async () => {
    const host = new FakePtys(['a', 'b'])
      .onPress('a', 1, 80, `\r\nResume with \`${CLAUDE_HINT}\`.\r\n`)
      .onPress('b', 1, 240, `\r\nRun ${CODEX_HINT} to continue\r\n`);

    const found = await captureAgentRecovery(host);

    expect(host.presses[0].sort()).toEqual(['a', 'b']);
    expect(found).toBe(2);
    expect(host.found).toEqual({ a: CLAUDE_HINT, b: CODEX_HINT });
  });

  it.each(['Ctrl-C', 'Ctrl+C'])('presses again as soon as a pane asks with %s, through its TUI escapes', async (chord) => {
    // claude (Ctrl-C) and Cursor (Ctrl+C) render the prompt inside a TUI, so the
    // raw bytes carry escapes through the phrase — the ask gate strips before it
    // matches.
    const ask = `\x1b[1mPress \x1b[0m\x1b[7m${chord}\x1b[0m again\x1b[K to exit`;
    const host = new FakePtys(['a'])
      .onPress('a', 1, 40, ask)
      .onPress('a', 2, 40, `\r\n${CLAUDE_HINT}\r\n`);

    await captureAgentRecovery(host);

    // Second press well inside the blind window, so the ask is what triggered it.
    expect(host.presses).toEqual([['a'], ['a']]);
    expect(host.sincePress).toBeLessThan(BLIND_SECOND_PRESS_MS);
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
    const secondPressAt = host.sincePress;
    expect(secondPressAt).toBeGreaterThanOrEqual(BLIND_SECOND_PRESS_MS + QUIET_BEFORE_RETRY_MS);
  });

  it("captures Pi's double-press exit", async () => {
    const host = piIgnoresLatePress(new FakePtys(['pi'])
      .onPress('pi', 1, 40, '\x1b[2K\r')
      .onPress('pi', 2, 40, fixture('Pi').output));
    expect(await captureAgentRecovery(host)).toBe(1);
    expect(host.presses).toEqual([['pi'], ['pi']]);
    expect(host.sincePress).toBeLessThan(500);
    expect(host.found.pi).toBe(fixture('Pi').command);
  });

  describe('an agent interrupted mid-turn', () => {
    // Measured 2026-10 (claude 2.1.288, copilot 1.0.88, pi 1.0.0): the first ^C
    // only cancels the turn; the agent's own exit gesture comes after it.

    it('presses Claude a third time when it asks after cancelling the turn', async () => {
      // After the cancel Claude polls the cursor position (`ESC[?6n`) every ~200ms:
      // control bytes, not a print in flight.
      const host = new FakePtys(['claude'])
        .onPress('claude', 1, 40, '\x1b[2K  ⎿  Interrupted · What should Claude do instead?\r\n\x1b[1G❯ ');
      every(host, 'claude', 200, 1300, '\x1b[?6n');
      host.onPress('claude', 2, 10, '\x1b[1G\x1b[2KPress Ctrl-C again to exit')
        .onPress('claude', 3, 12, `\r\nResume this session with:\r\n${CLAUDE_HINT}\r\n`);
      expect(await captureAgentRecovery(host)).toBe(1);
      expect(host.presses).toHaveLength(3);
      expect(host.found.claude).toBe(CLAUDE_HINT);
    });

    it("presses Copilot again on its lowercase `ctrl+c again`", async () => {
      const host = new FakePtys(['copilot'])
        .onPress('copilot', 1, 40, '\r\n ● Operation cancelled by user\r\n')
        .onPress('copilot', 2, 20, '\x1b[3;1H\x1b[1mctrl+c\x1b[22m again to exit\x1b[K')
        .onPress('copilot', 3, 20, fixture('GitHub Copilot').output);
      expect(await captureAgentRecovery(host)).toBe(1);
      expect(host.presses).toHaveLength(3);
      expect(host.found.copilot).toBe(fixture('GitHub Copilot').command);
    });

    it('presses Pi twice inside its 500ms window through its spinner', async () => {
      // Pi keeps redrawing `Working` in place every ~82ms and exits only on two
      // presses less than 500ms apart.
      const host = every(new FakePtys(['pi']), 'pi', 80, 1300,
        '\x1b[?2026h\x1b[36;1H\x1b[2K── ⠴ Working ──\x1b[?2026l');
      piIgnoresLatePress(host.onPress('pi', 2, 40, fixture('Pi').output));
      expect(await captureAgentRecovery(host)).toBe(1);
      expect(host.found.pi).toBe(fixture('Pi').command);
    });
  });

  it('counts only an ask that arrived after the latest press', async () => {
    // Claude's exit is slow here: the first press's ask is still in the scan
    // window when the second press lands, and must not earn a third.
    const host = new FakePtys(['a'])
      .onPress('a', 1, 40, 'Press Ctrl-C again to exit')
      .onPress('a', 2, 160, `\r\n${CLAUDE_HINT}\r\n`);
    await captureAgentRecovery(host);
    expect(host.presses).toHaveLength(2);
    expect(host.found.a).toBe(CLAUDE_HINT);
  });

  it('bounds the presses of a pane that asks after every one', async () => {
    const host = new FakePtys(['a']);
    for (let press = 1; press <= 10; press++) host.onPress('a', press, 20, '\r\nPress Ctrl-C again to exit');
    await captureAgentRecovery(host);
    expect(host.presses).toHaveLength(MAX_PRESSES);
  });

  it('never presses a program that does not ask more than twice, even one that only repaints', async () => {
    // Repainting in place is no print in flight, so the blind second press may
    // land; nothing past it is unasked.
    const host = every(new FakePtys(['top']), 'top', 50, 1300, '\x1b[H\x1b[2Kload 0.42');
    await captureAgentRecovery(host);
    expect(host.presses).toHaveLength(2);
  });

  it('lets Codex print its delayed one-press exit without interrupting it again', async () => {
    const host = new FakePtys(['codex'])
      .onPress('codex', 1, 260, `\r\n${CODEX_HINT}\r\n`);
    expect(await captureAgentRecovery(host)).toBe(1);
    expect(host.presses).toEqual([['codex']]);
    expect(host.found.codex).toBe(CODEX_HINT);
  });

  it('never presses a pane that already yielded, and presses each pane at most twice', async () => {
    const host = new FakePtys(['quick', 'silent'])
      .onPress('quick', 1, 40, `\r\n${CLAUDE_HINT}\r\n`);

    await captureAgentRecovery(host);

    expect(host.presses[0].sort()).toEqual(['quick', 'silent']);
    // Every later press is the silent pane's alone, and there is only one.
    expect(host.presses.slice(1)).toEqual([['silent']]);
  });

  it('widens every target before its first press, so no agent wraps its hint', async () => {
    // Copilot hard-wraps its exit summary to the pane: below ~74 columns the
    // separator its wrap adds lands inside the id.
    const host = new FakePtys(['a', 'b']);
    await captureAgentRecovery(host, { maxWaitMs: 100 });
    const size = `${RECOVERY_SIZE.cols}x${RECOVERY_SIZE.rows}`;
    expect(host.calls.slice(0, 3)).toEqual([`resize a ${size}`, `resize b ${size}`, '^C a,b']);
    expect(RECOVERY_SIZE.cols).toBeGreaterThanOrEqual(200);
  });

  it('does not scan the repaint the widening provokes', async () => {
    // A full-screen program redraws what it shows — here a hint printed long
    // before this capture — and that is not output the interrupt produced.
    const host = new FakePtys(['a']).onResize('a', 20, `\r\nold: ${CLAUDE_HINT}\r\n`);
    await captureAgentRecovery(host);
    expect(host.found).toEqual({});
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
    const host = new FakePtys(['a']).seed('a', `\r\nold: claude --resume 33333333-3333-4333-8333-333333333333\r\n`);
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
    expect(host.sincePress).toBeLessThanOrEqual(80);
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
