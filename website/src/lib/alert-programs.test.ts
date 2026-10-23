import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { DEFAULT_WATCHED_COMMANDS } from "dormouse-lib/lib/coding-agents";
import type { AlertStateDetail } from "dormouse-lib/lib/platform/types";
import { AGENT_TURN_MS, BUILD_MS, startAlertProgram } from "./alert-programs";
import { TutorialShell } from "./tutorial-shell";

/**
 * The Alerts section's programs through a real shell and the fake adapter's
 * alert host: each must ring for the reason its checklist item names
 * (docs/specs/tutorial.md -> Fake shell behavior).
 */

const PANE = "pane";
const OTHER = "tutorial";
/** One `agent` turn, plus a frame for its last write. */
const TURN_MS = AGENT_TURN_MS + 200;
/** Long enough for a quiet screen to settle. */
const QUIET_MS = 5_100;

let adapter: FakePtyAdapter;
let shell: TutorialShell;
let output: string[];
let latest: AlertStateDetail | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  adapter = new FakePtyAdapter();
  adapter.setScenario(PANE, { name: "none", chunks: [] });
  adapter.spawnPty(PANE);
  output = [];
  latest = undefined;
  adapter.onAlertState((detail) => { if (detail.id === PANE) latest = detail; });
  const send = (data: string) => {
    output.push(data);
    adapter.sendOutput(PANE, data);
  };
  shell = new TutorialShell(send, (name, args, onExit) => startAlertProgram(name, args, send, onExit));
});

afterEach(() => {
  shell.dispose();
  adapter.reset();
  vi.useRealTimers();
});

/** Typing into the pane: the adapter hears it as the playground's input path
 *  does, and with no xterm mounted here the shell takes the bytes directly. */
const type = (data: string) => {
  adapter.writePty(PANE, data, { userInput: true });
  shell.handleInput(data);
};
const lookAt = (id: string) => adapter.alertEngagement({ present: true, focusId: id });
const screen = () => output.join("");

describe("alert programs", () => {
  it("agent rings with its question as it asks, while the user is elsewhere", () => {
    lookAt(OTHER);
    type("agent\r");
    vi.advanceTimersByTime(TURN_MS);
    expect(screen()).toContain("\x1b]9;agent: Allow edit to README.md?\x07");
    expect(latest).toMatchObject({ status: "ALERT_RINGING", notification: { source: "OSC 9" } });
  });

  it("agent leaves a TODO, not a ring, when the user is watching its pane", () => {
    lookAt(PANE);
    type("agent\r");
    vi.advanceTimersByTime(TURN_MS + QUIET_MS);
    expect(latest).toMatchObject({ status: "WATCHING_DISABLED", todo: true, notification: { source: "OSC 9" } });
  });

  it("agent --quiet sends nothing and rings through the default agent rule", () => {
    adapter.alertSetWatchedCommands([...DEFAULT_WATCHED_COMMANDS]);
    lookAt(OTHER);
    type("agent --quiet\r");
    vi.advanceTimersByTime(TURN_MS + QUIET_MS);
    expect(screen()).not.toContain("\x1b]9;");
    expect(latest).toMatchObject({ status: "ALERT_RINGING", notification: { source: "WATCHING" } });
  });

  it("build rings on exit when the user started it and then looked away", () => {
    lookAt(PANE);
    type("build\r");
    lookAt(OTHER);
    vi.advanceTimersByTime(BUILD_MS - 1);
    expect(latest?.status).not.toBe("ALERT_RINGING");
    vi.advanceTimersByTime(1);
    expect(latest).toMatchObject({ status: "ALERT_RINGING", notification: { source: "COMMAND_EXIT", body: "build exited 0" } });
  });

  it.each(["agent", "build"])("%s quits on Ctrl-C", (name) => {
    type(`${name}\r`);
    type("\x03");
    expect(screen()).toContain("\x1b]633;D;130\x07");
  });

  it("agent takes another request after an answer", () => {
    lookAt(OTHER);
    type("agent\r");
    vi.advanceTimersByTime(TURN_MS);
    output.length = 0;
    type("y");
    expect(screen()).toContain("Edited README.md");
    type("fix the tests\r");
    vi.advanceTimersByTime(200);
    expect(screen()).toContain("Working on fix the tests");
  });
});
