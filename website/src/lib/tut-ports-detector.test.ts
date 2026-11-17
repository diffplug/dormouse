import { describe, expect, it } from "vitest";
import { createTerminalPaneState, type CommandRun, type TerminalPaneState } from "dormouse-lib/lib/terminal-state";
import { PortsWatcher } from "./tut-ports-detector";
import { DESKTOP_SECTIONS } from "./tut-items";
import { TutorialState } from "./tutorial-state";

let nextRun = 0;
const run = (rawCommandLine: string): CommandRun => ({
  id: `run-${nextRun++}`, rawCommandLine, displayCommand: rawCommandLine, cwdAtStart: null, startedAt: 0, source: "osc633_E",
});

function harness() {
  const panes = new Map<string, TerminalPaneState>();
  let listener = () => {};
  const state = new TutorialState(DESKTOP_SECTIONS);
  const watcher = new PortsWatcher(state, {
    subscribeToTerminalPaneState: (next) => { listener = next; return () => {}; },
    getTerminalPaneStateSnapshot: () => panes,
  });
  watcher.start();
  const set = (id: string, currentCommand: CommandRun | null) => {
    panes.set(id, { ...createTerminalPaneState(), currentCommand });
    listener();
  };
  const done = () => DESKTOP_SECTIONS.find((section) => section.id === "ports")!.items
    .filter((item) => state.isComplete(item.id)).map((item) => item.id);
  return { watcher, set, done };
}

describe("PortsWatcher", () => {
  it("credits opening properties, but not the aux terminal", () => {
    const { watcher, done } = harness();
    watcher.contextOpened("a", "aux");
    expect(done()).toEqual([]);
    watcher.contextOpened("a", "properties");
    expect(done()).toEqual(["pb-context"]);
  });

  it("credits two dev servers running at once, never one run after another", () => {
    const { set, done } = harness();
    set("a", run("npm run dev"));
    set("a", null);
    set("b", run("npm run dev"));
    set("c", run("npm install"));
    expect(done()).toEqual([]);
    set("a", run("npm  run   dev"));
    expect(done()).toEqual(["pb-dev"]);
  });

  it("credits the ports once properties open on two panes running a dev server", () => {
    const { watcher, set, done } = harness();
    set("a", run("npm run dev"));
    set("b", run("npm run dev"));
    set("c", run("agent"));
    watcher.contextOpened("a", "properties");
    watcher.contextOpened("a", "properties");
    watcher.contextOpened("c", "properties");
    expect(done()).not.toContain("pb-ports");
    watcher.contextOpened("b", "properties");
    expect(done()).toContain("pb-ports");
  });
});
