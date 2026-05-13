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
    path: "/tether",
    lazy: () => import("./pages/Tether"),
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
