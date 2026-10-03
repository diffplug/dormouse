import { describe, expect, it, vi } from "vitest";
import { shellWords, TutorialShell, type InteractiveProgram, type StartProgram } from "./tutorial-shell";
import { VirtualFs } from "./playground-fs/vfs";
import { promptFor } from "dormouse-lib/lib/ansi";

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

// The playground shell drives the alert tutorial's WATCHING/command-exit demos
// (docs/specs/tutorial.md) entirely through OSC 633 shell-integration reports.
// Nothing else asserts these bytes, so a refactor could silently stop emitting
// them and leave every alert demo showing "nothing is running" while the rest
// of the suite stays green.
describe("TutorialShell OSC 633 shell integration", () => {
  it("reports the prompt with OSC 633;A / 633;B", () => {
    const { output, shell } = createHarness();
    shell.handleInput("a"); // first input triggers the prompt
    const data = output.join("");
    expect(data).toContain("\x1b]633;A\x07");
    expect(data).toContain("\x1b]633;B\x07");
  });

  it("reports the command line and start, then exit 0 on a successful run", () => {
    const { output, shell, exitProgram } = createHarness();
    shell.handleInput("ascii-splash --no-mouse\r");
    const launched = output.join("");
    expect(launched).toContain("\x1b]633;E;ascii-splash --no-mouse\x07");
    expect(launched).toContain("\x1b]633;C\x07");
    expect(launched).not.toContain("\x1b]633;D"); // no finish while running

    output.length = 0;
    exitProgram();
    expect(output.join("")).toContain("\x1b]633;D;0\x07");
  });

  it("reports exit 127 for an unknown command", () => {
    const { output, shell } = createHarness();
    shell.handleInput("nope\r");
    expect(output.join("")).toContain("\x1b]633;D;127\x07");
  });

  it("reports exit 127 for an unknown runCommand auto-launch", () => {
    const { output, shell } = createHarness();
    shell.runCommand("nope");
    expect(output.join("")).toContain("\x1b]633;D;127\x07");
  });

  it("re-announces the running command line via reportRunningCommand", () => {
    const { output, shell } = createHarness();
    shell.handleInput("ascii-splash --no-mouse\r");
    output.length = 0;

    shell.reportRunningCommand();
    const data = output.join("");
    expect(data).toContain("\x1b]633;E;ascii-splash --no-mouse\x07");
    expect(data).toContain("\x1b]633;C\x07");
  });

  it("reportRunningCommand is a no-op at a prompt", () => {
    const { output, shell } = createHarness();
    shell.handleInput("a"); // prompt shown, no command running
    output.length = 0;

    shell.reportRunningCommand();
    expect(output.join("")).toBe("");
  });
});

/** A shell in `/home/demo/p` of `files`, past its first prompt. */
function createFsShell(files: Record<string, string>, startProgram: StartProgram = () => null) {
  const output: string[] = [];
  const shell = new TutorialShell((data) => output.push(data), startProgram, { fs: new VirtualFs(files), cwd: "/home/demo/p" });
  shell.showInitialPrompt();
  return { shell, text: () => output.join(""), clear: () => { output.length = 0; } };
}

describe("TutorialShell with a filesystem", () => {
  const files = { "/home/demo/p/src/a.ts": "", "/home/demo/p/README.md": "" };
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

  it("reports its directory with every prompt and shows it home-relative", () => {
    const { text } = createFsShell(files);
    expect(text()).toContain("\x1b]633;P;Cwd=/home/demo/p\x07");
    expect(plain(text())).toContain("user@dormouse:~/p$ ");
  });

  it("changes directory with cd and reports the new one", () => {
    const { shell, text, clear } = createFsShell(files);
    clear();
    shell.handleInput("cd src\r");
    expect(shell.cwd).toBe("/home/demo/p/src");
    expect(text()).toContain("\x1b]633;D;0\x07");
    expect(text()).toContain("\x1b]633;P;Cwd=/home/demo/p/src\x07");
    shell.handleInput("cd\r");
    expect(shell.cwd).toBe("/home/demo");
    clear();
    shell.handleInput("cd nope\r");
    expect(plain(text())).toContain("cd: no such file or directory: nope");
    expect(text()).toContain("\x1b]633;D;1\x07");
  });

  it("lists directories first, marked with a slash, and prints pwd", () => {
    const { shell, text, clear } = createFsShell(files);
    clear();
    shell.handleInput("ls\r");
    expect(plain(text())).toContain("src/  README.md\r\n");
    clear();
    shell.handleInput("pwd\r");
    expect(plain(text())).toContain("/home/demo/p\r\n");
  });

  it("escapes a reported command line's separators", () => {
    const { shell, text } = createFsShell(files);
    shell.handleInput("ls 'a;b'\r");
    expect(text()).toContain("\x1b]633;E;ls 'a\\x3bb'\x07");
  });

  it("splits words as a POSIX shell quotes them", () => {
    expect(shellWords(`dor __view-error '/a b' "it's \\"x\\"" c\\ d`)).toEqual(["dor", "__view-error", "/a b", `it's "x"`, "c d"]);
    expect(shellWords("  a   ''  ")).toEqual(["a", ""]);
  });
});

describe("TutorialShell tab completion", () => {
  const files = {
    "/home/demo/p/src/osc.ts": "", "/home/demo/p/src/frame.ts": "", "/home/demo/p/README.md": "", "/home/demo/p/sub/x": "",
  };

  function typed(input: string) {
    const program: InteractiveProgram = { start: vi.fn(), handleInput: vi.fn(), dispose: vi.fn() };
    const { shell, text, clear } = createFsShell(files, (name) => (name === "dor" ? program : null));
    clear();
    shell.handleInput(input);
    return { program, echo: text() };
  }

  it("completes a command name, and lists every command on an empty line", () => {
    expect(typed("tu\t").echo).toBe("tutorial ");
    expect(typed("c\t\t").echo).toBe("c\r\ncd  changelog\r\n" + promptFor("~/p") + "c");
    expect(typed("\t\t").echo).toBe("\r\nascii-splash  cd  changelog  dor  ls  pwd  tutorial\r\n" + promptFor("~/p"));
    expect(typed("./t\t").echo).toBe("./t");
  });

  it("completes only the programs in a shell without a filesystem", () => {
    const output: string[] = [];
    const shell = new TutorialShell((data) => output.push(data), () => null, { promptShown: true });
    shell.handleInput("\t\t");
    expect(output.join("")).toContain("ascii-splash  changelog  tutorial\r\n");
    output.length = 0;
    shell.handleInput("ls s\t");
    expect(output.join("")).toBe("ls s");
  });

  it("completes dor's verb and a path, closing a file with a space and a directory with a slash", () => {
    expect(typed("dor op\t").echo).toBe("dor open ");
    expect(typed("dor open R\t").echo).toBe("dor open README.md ");
    expect(typed("ls s\t").echo).toBe("ls s");
    expect(typed("ls sr\t").echo).toBe("ls src/");
    expect(typed("ls src/o\t").echo).toBe("ls src/osc.ts ");
    expect(typed("ls ~/p/R\t").echo).toBe("ls ~/p/README.md ");
  });

  it("offers cd only directories", () => {
    expect(typed("cd s\t\t").echo).toContain("src/  sub/");
    expect(typed("cd R\t").echo).toBe("cd R");
  });

  it("lists an ambiguous completion on the second Tab, then redraws the line", () => {
    const { echo } = typed("ls src/\t\t");
    expect(echo).toBe("ls src/\r\nframe.ts  osc.ts\r\n" + promptFor("~/p") + "ls src/");
  });

  it("runs what it completed", () => {
    const { program } = typed("dor op\tR\t\r");
    expect(program.start).toHaveBeenCalled();
  });

  it("leaves Tab to a running program", () => {
    const { program } = typed("dor\r\t");
    expect(program.handleInput).toHaveBeenCalledWith("\t");
  });
});

describe("TutorialShell Ctrl+C", () => {
  it("abandons the line for a new prompt without running it", () => {
    const startProgram = vi.fn(() => null);
    const output: string[] = [];
    const shell = new TutorialShell((data) => output.push(data), startProgram);
    shell.handleInput("tutorial\x03");
    expect(output.join("")).toContain("tutorial\r\n\x1b]633;A\x07");
    expect(output.join("")).not.toContain("^C");
    output.length = 0;
    shell.handleInput("\r");
    expect(startProgram).not.toHaveBeenCalled();
    expect(output.join("")).not.toContain("633;E");
  });
});
