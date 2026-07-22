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
  const startProgram = vi.fn(
    (name: string, _args: string[], onExit: () => void) => {
      if (name !== "ascii-splash" && name !== "splash") return null;
      exitProgram = onExit;
      return program;
    },
  );
  const shell = new TutorialShell((data) => output.push(data), startProgram);
  return {
    output,
    program,
    shell,
    startProgram,
    exitProgram: () => exitProgram?.(),
  };
}

describe("TutorialShell program dispatch", () => {
  it("launches the program named by the first token and delegates input", () => {
    const { output, program, shell, startProgram, exitProgram } = createHarness();

    shell.handleInput("ascii-splash --no-mouse\r");
    shell.handleInput("q");

    expect(startProgram).toHaveBeenCalledWith(
      "ascii-splash",
      ["--no-mouse"],
      expect.any(Function),
    );
    expect(program.start).toHaveBeenCalledTimes(1);
    expect(program.handleInput).toHaveBeenCalledWith("q");

    exitProgram();
    expect(output.join("")).toContain("$ ");
  });

  it("forwards trailing bytes to a program launched within the same chunk", () => {
    const { program, shell, startProgram } = createHarness();

    // A single chunk (e.g. a paste) both launches the program and carries the
    // first keystroke for it. The trailing `q` must reach the program, not the
    // shell line editor.
    shell.handleInput("ascii-splash --no-mouse\rq");

    expect(startProgram).toHaveBeenCalledWith(
      "ascii-splash",
      ["--no-mouse"],
      expect.any(Function),
    );
    expect(program.handleInput).toHaveBeenCalledWith("q");
  });

  it("disposes the active program with the shell", () => {
    const { program, shell } = createHarness();

    shell.handleInput("splash\r");
    shell.dispose();

    expect(program.dispose).toHaveBeenCalledTimes(1);
  });

  it("auto-launches via runCommand without parsing input", () => {
    const { program, shell, startProgram } = createHarness();

    shell.runCommand("ascii-splash");

    expect(startProgram).toHaveBeenCalledWith(
      "ascii-splash",
      [],
      expect.any(Function),
    );
    expect(program.start).toHaveBeenCalledTimes(1);
  });

  it("prints an unknown-command message when startProgram returns null", () => {
    const { output, shell } = createHarness();
    shell.handleInput("nope\r");
    expect(output.join("")).toContain("Unknown command");
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
