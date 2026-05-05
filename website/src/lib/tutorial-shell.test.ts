import { describe, expect, it, vi } from "vitest";
import { TutorialShell, type InteractiveProgram } from "./tutorial-shell";

function createHarness() {
  const output: string[] = [];
  let exitProgram: (() => void) | null = null;
  const program: InteractiveProgram = {
    start: vi.fn(),
    handleInput: vi.fn(),
    dispose: vi.fn(),
  };
  const startAsciiSplash = vi.fn((args: string[], onExit: () => void) => {
    exitProgram = onExit;
    return program;
  });
  const shell = new TutorialShell((data) => output.push(data), startAsciiSplash);
  return { output, program, shell, startAsciiSplash, exitProgram: () => exitProgram?.() };
}

describe("TutorialShell ascii-splash integration", () => {
  it("launches ascii-splash and delegates input while it is active", () => {
    const { output, program, shell, startAsciiSplash, exitProgram } = createHarness();

    shell.handleInput("ascii-splash --no-mouse\r");
    shell.handleInput("q");

    expect(startAsciiSplash).toHaveBeenCalledWith(["--no-mouse"], expect.any(Function));
    expect(program.start).toHaveBeenCalledTimes(1);
    expect(program.handleInput).toHaveBeenCalledWith("q");

    exitProgram();
    expect(output.join("")).toContain("$ ");
  });

  it("disposes the active program with the shell", () => {
    const { program, shell } = createHarness();

    shell.handleInput("splash\r");
    shell.dispose();

    expect(program.dispose).toHaveBeenCalledTimes(1);
  });

  it("recalls the previous command on up arrow instead of echoing the escape sequence", () => {
    const { output, shell } = createHarness();
    shell.handleInput("bogus\r");
    output.length = 0;

    shell.handleInput("\x1b[A");

    const data = output.join("");
    expect(data).toContain("bogus");
    expect(data).not.toContain("[A");
  });

  it("executes a command recalled from history", () => {
    const { output, shell } = createHarness();
    shell.handleInput("bogus\r");
    output.length = 0;

    shell.handleInput("\x1b[A\r");

    expect(output.join("")).toContain("Unknown command");
  });

  it("restores the current draft when moving down past the newest history entry", () => {
    const { output, shell } = createHarness();
    shell.handleInput("bogus\r");
    output.length = 0;

    shell.handleInput("draft");
    output.length = 0;
    shell.handleInput("\x1b[A");
    shell.handleInput("\x1b[B");

    const data = output.join("");
    expect(data).toContain("bogus");
    expect(data).toContain("draft");
    expect(data).not.toContain("[A");
    expect(data).not.toContain("[B");
  });
});
