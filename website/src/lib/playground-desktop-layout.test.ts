import { describe, expect, it } from "vitest";
import { layout } from "dormouse-lib/lib/lath/layout";
import { validate } from "dormouse-lib/lib/lath/model";
import { LATH_LAYOUT_OPTS } from "dormouse-lib/components/wall/lath-wall-store";
import {
  DESKTOP_PLAYGROUND_LAYOUT,
  PANE_BOXED,
  PANE_MAIN,
  PANE_SPLASH,
} from "./playground-desktop-layout";

const WALL = { x: 0, y: 0, width: 1200, height: 720 };
// The Wall's real opts, not a copy: a local literal would keep asserting a stale
// gap after the engine's changed.
const OPTS = LATH_LAYOUT_OPTS;

describe("desktop playground layout", () => {
  it("is one vertical split with one horizontal split on the right", () => {
    expect(validate(DESKTOP_PLAYGROUND_LAYOUT.tree)).toEqual([]);

    const frames = layout(DESKTOP_PLAYGROUND_LAYOUT.tree, WALL, OPTS);
    const main = frames.get(PANE_MAIN)!;
    const boxed = frames.get(PANE_BOXED)!;
    const splash = frames.get(PANE_SPLASH)!;

    expect(main).toMatchObject({ x: 0, y: 0, height: WALL.height });
    expect(boxed.x).toBe(splash.x);
    expect(boxed.width).toBe(splash.width);
    expect(boxed.y).toBe(0);
    expect(splash.y).toBe(boxed.height + OPTS.gap);
    expect(boxed.height + OPTS.gap + splash.height).toBe(WALL.height);
    expect(main.width + OPTS.gap + boxed.width).toBe(WALL.width);
  });
});
