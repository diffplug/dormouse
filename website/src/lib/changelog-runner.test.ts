import { describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { ChangelogRunner } from "./changelog-runner";

function createHarness() {
  const adapter = new FakePtyAdapter();
  const onExit = vi.fn();
  adapter.spawnPty("changelog", { cols: 80, rows: 24 });
  const runner = new ChangelogRunner({ adapter, terminalId: "changelog", onExit });
  runner.start();
  return { onExit, runner };
}

function selectedIndex(runner: ChangelogRunner): number {
  return (runner as unknown as { selectedIndex: number }).selectedIndex;
}

describe("ChangelogRunner", () => {
  it("moves on a modified arrow key instead of exiting", () => {
    const { onExit, runner } = createHarness();
    runner.handleInput("\x1b[1;2B"); // Shift+Down
    expect(onExit).not.toHaveBeenCalled();
    expect(selectedIndex(runner)).toBe(1);
    runner.handleInput("\x1b[1;5A"); // Ctrl+Up
    expect(onExit).not.toHaveBeenCalled();
    expect(selectedIndex(runner)).toBe(0);
  });

  it("pages the detail on a modified Page Down", () => {
    const { onExit, runner } = createHarness();
    runner.handleInput("\x1b[6;2~"); // Shift+PageDown
    expect(onExit).not.toHaveBeenCalled();
    expect((runner as unknown as { detailOffset: number }).detailOffset).toBeGreaterThan(0);
  });

  it("exits on a bare Escape", () => {
    const { onExit, runner } = createHarness();
    runner.handleInput("\x1b");
    expect(onExit).toHaveBeenCalledOnce();
  });
});
