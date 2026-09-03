import {
  index,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";
import { DOCS_PAGES } from "./lib/docs-pages";

export default [
  index("./pages/Home.tsx"),
  route("playground", "./pages/Playground.tsx"),
  route("playground/desktop", "./pages/PlaygroundDesktop.tsx"),
  route("playground/pocket", "./pages/PocketPlayground.tsx"),
  route("pocket", "./pages/Pocket.tsx"),
  ...DOCS_PAGES.map((page) => route(page.path.slice(1), page.module)),
  // Not in the rail: the standalone updater deep-links it after an update
  // (standalone/src/updater.ts), so it is a parameterized view of the
  // changelog rather than a page of its own.
  route("changelog/after/:version", "./pages/ChangelogAfter.tsx"),
] satisfies RouteConfig;
