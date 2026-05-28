import {
  index,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  index("./pages/Home.tsx"),
  route("playground", "./pages/Playground.tsx"),
  route("playground/desktop", "./pages/PlaygroundDesktop.tsx"),
  route("playground/pocket", "./pages/PocketPlayground.tsx"),
  route("pocket", "./pages/Pocket.tsx"),
  route("changelog", "./pages/Changelog.tsx"),
  route("changelog/after/:version", "./pages/ChangelogAfter.tsx"),
  route("supply-chain", "./pages/SupplyChain.tsx"),
] satisfies RouteConfig;
