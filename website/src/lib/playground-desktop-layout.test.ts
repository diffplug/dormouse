import { describe, expect, it } from "vitest";
import { layout } from "dormouse-lib/lib/lath/layout";
import { validate } from "dormouse-lib/lib/lath/model";
import { isLathPersistedLayout } from "dormouse-lib/lib/lath/persistence";
import { LATH_LAYOUT_OPTS } from "dormouse-lib/components/wall/lath-wall-store";
import { browserLeafMeta, terminalLeafMeta } from "dormouse-lib/components/wall/lath-wall-engine";
import {
  DESKTOP_PANES,
  DESKTOP_PLAYGROUND_LAYOUT,
  DESKTOP_VIDEO_PARAMS,
  DESKTOP_VIDEO_TITLE,
  PANE_BOXED,
  PANE_MAIN,
  PANE_SPLASH,
  PANE_VIDEO,
} from "./playground-desktop-layout";

const WALL = { x: 0, y: 0, width: 1200, height: 720 };
// The Wall's real opts, not a copy: a local literal would keep asserting a stale
// gap after the engine's changed.
const OPTS = LATH_LAYOUT_OPTS;

describe("desktop playground layout", () => {
  // The seed is only honored while `isLathPersistedLayout` accepts it. If it stops
  // (a schema/version bump), `Wall` falls through to `initialPaneIds` — which this
  // route no longer passes — and silently seeds ONE generated pane: no `tut-main`,
  // no auto-started runners, tutorial dead. Fail loudly here instead.
  it("is a layout the Wall's seed will actually accept", () => {
    expect(isLathPersistedLayout(DESKTOP_PLAYGROUND_LAYOUT)).toBe(true);
  });

  // The route spells its leafMeta out to keep the lib off the eager import path, so
  // pin it against the real builder here (the test bundles nothing).
  it("seeds the same leaf meta the engine builds for a terminal or browser", () => {
    for (const pane of DESKTOP_PANES) {
      expect(DESKTOP_PLAYGROUND_LAYOUT.leafMeta[pane.id]).toEqual(terminalLeafMeta(pane.title));
    }
    expect(DESKTOP_PLAYGROUND_LAYOUT.leafMeta[PANE_VIDEO]).toEqual(browserLeafMeta(DESKTOP_VIDEO_TITLE, DESKTOP_VIDEO_PARAMS));
  });

  it("puts the tutorial beside the video over ascii-splash and changelog side by side", () => {
    expect(validate(DESKTOP_PLAYGROUND_LAYOUT.tree)).toEqual([]);

    const frames = layout(DESKTOP_PLAYGROUND_LAYOUT.tree, WALL, OPTS);
    const main = frames.get(PANE_MAIN)!;
    const video = frames.get(PANE_VIDEO)!;
    const splash = frames.get(PANE_SPLASH)!;
    const boxed = frames.get(PANE_BOXED)!;

    expect(main).toMatchObject({ x: 0, y: 0, height: WALL.height });
    expect(main.width + OPTS.gap + video.width).toBe(WALL.width);
    expect(video.y).toBe(0);
    expect(splash.y).toBe(video.height + OPTS.gap);
    expect(boxed.y).toBe(splash.y);
    expect(video.height + OPTS.gap + splash.height).toBe(WALL.height);
    expect(splash.x).toBe(video.x);
    expect(splash.width + OPTS.gap + boxed.width).toBe(video.width);
  });
});
