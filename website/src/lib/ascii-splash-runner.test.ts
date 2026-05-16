import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { AsciiSplashRunner } from "./ascii-splash-runner";

function createHarness(args: string[] = []) {
  const adapter = new FakePtyAdapter();
  const output: string[] = [];
  const onExit = vi.fn();
  adapter.onPtyData((detail) => {
    if (detail.id === "splash") output.push(detail.data);
  });
  adapter.spawnPty("splash", { cols: 40, rows: 12 });
  const runner = new AsciiSplashRunner({
    adapter,
    terminalId: "splash",
    args,
    onExit,
  });
  return { adapter, output, onExit, runner };
}

function stripAnsi(data: string): string {
  return data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function getRunnerState(runner: AsciiSplashRunner) {
  return runner as unknown as {
    commandExecutor: { patterns: unknown[] } | null;
    currentPatternIndex: number;
    engine: { getPattern(): unknown } | null;
    patterns: unknown[];
  };
}

describe("AsciiSplashRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("starts in alt-screen with mouse reporting enabled by default", () => {
    const { output, runner } = createHarness();

    runner.start();

    const data = output.join("");
    expect(data).toContain("\x1b[?1049h");
    expect(data).toContain("\x1b[?25l");
    expect(data).toContain("\x1b[?1003h");
    expect(data).toContain("\x1b[?1006h");

    runner.dispose();
  });

  it("can start without mouse reporting", () => {
    const { output, runner } = createHarness(["--no-mouse"]);

    runner.start();

    const data = output.join("");
    expect(data).toContain("\x1b[?1049h");
    expect(data).not.toContain("\x1b[?1003h");
    expect(data).not.toContain("\x1b[?1006h");

    runner.dispose();
  });

  it("renders frames with the real upstream animation engine", () => {
    const { output, runner } = createHarness(["--pattern", "waves", "--fps", "30"]);
    runner.start();
    output.length = 0;

    vi.advanceTimersByTime(40);

    const data = output.join("");
    expect(data).toContain("\x1b[1;");
    expect(data).toContain("\x1b[38;2;");

    runner.dispose();
  });

  it("handles resize notifications before rendering the next frame", () => {
    const { adapter, output, runner } = createHarness();
    runner.start();
    output.length = 0;

    adapter.resizePty("splash", 24, 8);
    vi.advanceTimersByTime(40);

    const data = output.join("");
    expect(data).toContain("\x1b[2J\x1b[H");
    expect(data).toContain("\x1b[8;");

    runner.dispose();
  });

  it("parses SGR mouse input without leaving the byte stream", () => {
    const { output, runner } = createHarness(["--pattern", "waves"]);
    runner.start();
    output.length = 0;

    runner.handleInput("\x1b[<35;10;5M");
    vi.advanceTimersByTime(40);

    expect(output.join("")).toContain("\x1b[38;2;");
    runner.dispose();
  });

  it("exits cleanly on q", () => {
    const { output, onExit, runner } = createHarness();
    runner.start();
    output.length = 0;

    runner.handleInput("q");

    const data = output.join("");
    expect(data).toContain("\x1b[?1003l");
    expect(data).toContain("\x1b[?1049l");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("prints help and returns to the shell", async () => {
    const { output, onExit, runner } = createHarness(["--help"]);

    runner.start();
    await Promise.resolve();

    expect(output.join("")).toContain("Usage: ascii-splash [options]");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("keeps overlays isolated across simultaneous runner instances", () => {
    const adapter = new FakePtyAdapter();
    const outputA: string[] = [];
    const outputB: string[] = [];
    adapter.onPtyData((detail) => {
      if (detail.id === "a") outputA.push(detail.data);
      if (detail.id === "b") outputB.push(detail.data);
    });
    adapter.spawnPty("a", { cols: 80, rows: 28 });
    adapter.spawnPty("b", { cols: 80, rows: 28 });
    const runnerA = new AsciiSplashRunner({
      adapter,
      terminalId: "a",
      args: ["--pattern", "waves"],
      onExit: vi.fn(),
    });
    const runnerB = new AsciiSplashRunner({
      adapter,
      terminalId: "b",
      args: ["--pattern", "waves"],
      onExit: vi.fn(),
    });

    runnerA.start();
    runnerB.start();
    outputA.length = 0;
    outputB.length = 0;

    runnerA.handleInput("?");
    vi.advanceTimersByTime(40);

    expect(stripAnsi(outputA.join(""))).toContain("ascii-splash Help");
    expect(stripAnsi(outputB.join(""))).not.toContain("ascii-splash Help");

    runnerA.dispose();
    runnerB.dispose();
  });

  it("keeps command executor patterns synced after random pattern and theme commands", () => {
    const { runner } = createHarness(["--pattern", "waves"]);
    runner.start();
    const targetPatternIndex = 2;
    const initialState = getRunnerState(runner);
    expect(initialState.patterns.length).toBeGreaterThan(targetPatternIndex);
    const random = vi.spyOn(Math, "random").mockReturnValue((targetPatternIndex + 0.1) / initialState.patterns.length);

    try {
      runner.handleInput("r");

      const state = getRunnerState(runner);
      expect(state.currentPatternIndex).toBe(targetPatternIndex);
      expect(state.engine?.getPattern()).toBe(state.patterns[targetPatternIndex]);
      expect(state.commandExecutor?.patterns).toBe(state.patterns);
    } finally {
      runner.dispose();
      random.mockRestore();
    }
  });
});
