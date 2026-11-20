import type { LathPersistedLayout } from "dormouse-lib/lib/lath/persistence";
import { YOUTUBE_MUSIC_VIDEO, youtubeEmbedUrl } from "./youtube";

export const PANE_MAIN = "tut-main";
export const PANE_BOXED = "tut-boxed";
export const PANE_SPLASH = "tut-splash";
export const PANE_VIDEO = "tut-video";

export interface DesktopPaneSpec {
  id: string;
  command: string;
  title: string;
}

/** The seed's terminal panes; `PANE_VIDEO` is the one browser pane. */
export const DESKTOP_PANES: readonly DesktopPaneSpec[] = [
  { id: PANE_MAIN, command: "tutorial", title: "tutorial" },
  { id: PANE_BOXED, command: "changelog", title: "changelog" },
  { id: PANE_SPLASH, command: "ascii-splash", title: "ascii-splash" },
];

export const DESKTOP_VIDEO_TITLE = "music video";
export const DESKTOP_VIDEO_PARAMS = {
  surfaceType: "browser",
  renderMode: "iframe",
  url: youtubeEmbedUrl(YOUTUBE_MUSIC_VIDEO),
};

/** Deterministic layout for the desktop tutorial: the tutorial beside a column
 * of the music video over `ascii-splash` and `changelog` side by side. A
 * route-owned seed avoids depending on geometry that is not available during
 * Wall's synchronous fresh multi-pane seed. */
export const DESKTOP_PLAYGROUND_LAYOUT: LathPersistedLayout = {
  version: 1,
  tree: {
    root: {
      kind: "split",
      dir: "row",
      children: [
        { node: { kind: "leaf", id: PANE_MAIN }, weight: 0.5 },
        {
          node: {
            kind: "split",
            dir: "col",
            children: [
              { node: { kind: "leaf", id: PANE_VIDEO }, weight: 0.5 },
              {
                node: {
                  kind: "split",
                  dir: "row",
                  children: [
                    { node: { kind: "leaf", id: PANE_SPLASH }, weight: 0.5 },
                    { node: { kind: "leaf", id: PANE_BOXED }, weight: 0.5 },
                  ],
                },
                weight: 0.5,
              },
            ],
          },
          weight: 0.5,
        },
      ],
    },
  },
  // Spelled out rather than built with the lib's `terminalLeafMeta` and
  // `browserLeafMeta`: this module is imported eagerly by the route, while
  // PlaygroundDesktop deliberately defers the whole lib (Wall, terminal-registry,
  // platform) behind dynamic imports. Reaching into `lath-wall-engine` for these
  // fields would put a static edge into the subsystem the page is code-splitting
  // away. `playground-desktop-layout.test.ts` pins the shape against the real
  // engine instead.
  leafMeta: {
    ...Object.fromEntries(
      DESKTOP_PANES.map((pane) => [
        pane.id,
        { component: "terminal", tabComponent: "terminal", title: pane.title },
      ]),
    ),
    [PANE_VIDEO]: { component: "browser", tabComponent: "surface", title: DESKTOP_VIDEO_TITLE, params: DESKTOP_VIDEO_PARAMS },
  },
};
