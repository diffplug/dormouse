import { describe, expect, it, vi } from "vitest";
import { lazyProgram } from "./lazy-program";
import type { InteractiveProgram } from "./tutorial-shell";

function fakeProgram() {
  const calls: string[] = [];
  const program: InteractiveProgram = {
    start: () => calls.push("start"),
    handleInput: (data) => calls.push(`input:${data}`),
    dispose: () => calls.push("dispose"),
  };
  return { program, calls };
}

describe("lazyProgram", () => {
  it("starts the loaded program, then replays the input typed while it loaded", async () => {
    const { program, calls } = fakeProgram();
    const lazy = lazyProgram(() => Promise.resolve(program), vi.fn());
    lazy.start();
    lazy.handleInput("a");
    lazy.handleInput("b");
    await Promise.resolve();
    await Promise.resolve();
    lazy.handleInput("c");
    expect(calls).toEqual(["start", "input:a", "input:b", "input:c"]);
  });

  it("disposes a program that loads after it was disposed, without starting it", async () => {
    const { program, calls } = fakeProgram();
    const lazy = lazyProgram(() => Promise.resolve(program), vi.fn());
    lazy.start();
    lazy.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["dispose"]);
  });

  it("exits with status 1 when its module fails to load", async () => {
    const onExit = vi.fn();
    lazyProgram(() => Promise.reject(new Error("offline")), onExit).start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
