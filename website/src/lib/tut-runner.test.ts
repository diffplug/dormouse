import { describe, expect, it } from "vitest";
import { FakePtyAdapter } from "mouseterm-lib/lib/platform/fake-adapter";
import { SECTIONS, type ItemId } from "./tut-items";
import { TutRunner } from "./tut-runner";
import { TutorialState } from "./tutorial-state";

const FRAME_RESET = "\x1b[H\x1b[2J";

function mountRunner(completedIds: ItemId[] = []) {
  const adapter = new FakePtyAdapter();
  const id = "test-pane";
  adapter.spawnPty(id);

  const frames: string[] = [];
  let exitCount = 0;
  adapter.onPtyData(({ data }) => frames.push(data));

  const state = new TutorialState();
  for (const itemId of completedIds) state.markComplete(itemId);

  const runner = new TutRunner({
    adapter,
    terminalId: id,
    state,
    onExit: () => {
      exitCount += 1;
    },
  });
  adapter.setInputHandler(id, (data) => runner.handleInput(data));
  runner.start();

  return {
    state,
    sendKeys: (data: string) => adapter.writePty(id, data),
    lastFrame: () => {
      const all = frames.join("");
      const i = all.lastIndexOf(FRAME_RESET);
      return i >= 0 ? all.slice(i) : all;
    },
    exitCount: () => exitCount,
    dispose: () => runner.dispose(),
  };
}

describe("TutRunner snapshots", () => {
  it("renders the top-level menu", () => {
    const { lastFrame, dispose } = mountRunner();
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Keyboard navigation with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys("\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Alert and TODO with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys("\x1b[B\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Copy paste with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys("\x1b[B\x1b[B\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Keyboard navigation with all items complete", () => {
    const allKeyboardIds = SECTIONS[0].items.map((i) => i.id);
    const { sendKeys, lastFrame, dispose } = mountRunner(allKeyboardIds);
    sendKeys("\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("backs out of a section with q before exiting from the menu", () => {
    const { sendKeys, lastFrame, exitCount, dispose } = mountRunner();
    sendKeys("\r");

    sendKeys("q");
    expect(lastFrame()).toContain("MouseTerm Playground Tutorial");
    expect(exitCount()).toBe(0);

    sendKeys("q");
    expect(exitCount()).toBe(1);
    dispose();
  });
});
