import type { RouteRecord } from "vite-react-ssg";

export const routes: RouteRecord[] = [
  {
    path: "/",
    lazy: () => import("./pages/Home"),
  },
  {
    path: "/playground",
    lazy: () => import("./pages/Playground"),
  },
  {
    path: "/playground/desktop",
    lazy: () => import("./pages/PlaygroundDesktop"),
  },
  {
    path: "/playground/pocket",
    lazy: () => import("./pages/PocketPlayground"),
  },
  {
    path: "/pocket",
    lazy: () => import("./pages/Pocket"),
  },
  {
    path: "/changelog",
    lazy: () => import("./pages/Changelog"),
  },
  {
    path: "/changelog/after/:version",
    lazy: () => import("./pages/Changelog"),
  },
  {
    path: "/dependencies",
    lazy: () => import("./pages/Dependencies"),
  },
];
