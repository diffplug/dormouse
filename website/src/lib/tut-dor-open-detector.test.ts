import { describe, expect, it } from "vitest";
import { createTerminalPaneState, type CommandRun, type TerminalPaneState } from "dormouse-lib/lib/terminal-state";
import { watchDorOpen } from "./tut-dor-open-detector";
import { DESKTOP_SECTIONS } from "./tut-items";
import { TutorialState } from "./tutorial-state";

const CWD = "/home/demo/dor-tools-lib";
let nextRun = 0;
const run = (rawCommandLine: string, exitCode?: number): CommandRun => ({
  id: `run-${nextRun++}`, rawCommandLine, displayCommand: rawCommandLine, cwdAtStart: null, startedAt: 0, exitCode, source: "osc633_E",
});

function harness() {
  const panes = new Map<string, TerminalPaneState>();
  let listener = () => {};
  const state = new TutorialState(DESKTOP_SECTIONS);
  watchDorOpen(state, {
    subscribeToTerminalPaneState: (next) => { listener = next; return () => {}; },
    getTerminalPaneStateSnapshot: () => panes,
  });
  const set = (id: string, currentCommand: CommandRun | null, lastCommand: CommandRun | null = null) => {
    panes.set(id, { ...createTerminalPaneState(), currentCommand, lastCommand });
    listener();
  };
  const done = () => [...DESKTOP_SECTIONS.find((section) => section.id === "dor-open")!.items]
    .filter((item) => state.isComplete(item.id)).map((item) => item.id);
  return { set, done };
}

describe("watchDorOpen", () => {
  it("credits each built-in Tool by the viewer it runs", () => {
    const { set, done } = harness();
    const typed = run("dor open x", 0);
    set("a", run("dor __view-file /home/demo/.config/dormouse/dormouse.yml"), typed);
    set("b", run(`dor __view-file ${CWD}/README.md`), typed);
    set("c", run(`dor __view-folder ${CWD}`), typed);
    expect(done()).toEqual(["op-config", "op-markdown", "op-folder"]);
  });

  it("credits a preview as a new pane's first viewer while a folder is open", () => {
    const { set, done } = harness();
    set("p", run(`dor __view-file ${CWD}/LICENSE`));
    expect(done()).toEqual([]);
    set("f", run(`dor __view-folder ${CWD}`), run("dor open .", 0));
    set("q", run(`dor __view-file ${CWD}/package.json`));
    expect(done()).toContain("op-preview");
  });

  it("ignores a run that finished before it started", () => {
    const panes = new Map([["a", { ...createTerminalPaneState(), lastCommand: run("dor o", 0) }]]);
    let listener = () => {};
    const state = new TutorialState(DESKTOP_SECTIONS);
    watchDorOpen(state, { subscribeToTerminalPaneState: (next) => { listener = next; return () => {}; }, getTerminalPaneStateSnapshot: () => panes });
    listener();
    expect(state.isComplete("op-pick")).toBe(false);
  });

  it("credits the picker only when it opened something, and README.md as source", () => {
    const { set, done } = harness();
    set("a", null, run("dor o", 1));
    set("b", null, run("dor open README.md", 0));
    expect(done()).toEqual([]);
    set("c", run(`dor __view-code ${CWD}/README.md`), run("dor o --preview", 0));
    expect(done()).toEqual(["op-pick", "op-handler"]);
  });
});
