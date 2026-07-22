import type { LathPersistedLayout } from "dormouse-lib/lib/lath/persistence";

export const PANE_MAIN = "tut-main";
export const PANE_BOXED = "tut-boxed";
export const PANE_SPLASH = "tut-splash";

export interface DesktopPaneSpec {
  id: string;
  command: string;
  title: string;
}

export const DESKTOP_PANES: readonly DesktopPaneSpec[] = [
  { id: PANE_MAIN, command: "tut", title: "tutorial" },
  { id: PANE_BOXED, command: "changelog", title: "changelog" },
  { id: PANE_SPLASH, command: "ascii-splash", title: "ascii-splash" },
];

/** Deterministic L-shape for the desktop tutorial: one vertical divider, then
 * one horizontal divider in the right-hand column. A route-owned seed avoids
 * depending on geometry that is not available during Wall's synchronous fresh
 * multi-pane seed. */
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
              { node: { kind: "leaf", id: PANE_BOXED }, weight: 0.5 },
              { node: { kind: "leaf", id: PANE_SPLASH }, weight: 0.5 },
            ],
          },
          weight: 0.5,
        },
      ],
    },
  },
  // Spelled out rather than built with the lib's `terminalLeafMeta`: this module is
  // imported eagerly by the route, while PlaygroundDesktop deliberately defers the
  // whole lib (Wall, terminal-registry, platform) behind dynamic imports. Reaching
  // into `lath-wall-engine` for these three fields would put a static edge into the
  // subsystem the page is code-splitting away. `playground-desktop-layout.test.ts`
  // pins the shape against the real engine instead.
  leafMeta: Object.fromEntries(
    DESKTOP_PANES.map((pane) => [
      pane.id,
      { component: "terminal", tabComponent: "terminal", title: pane.title },
    ]),
  ),
};
