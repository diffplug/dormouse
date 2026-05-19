import {
  index,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  index("./pages/Home.tsx"),
  route("playground", "./pages/Playground.tsx"),
  route("tether", "./pages/Tether.tsx"),
  route("changelog", "./pages/Changelog.tsx"),
  route("changelog/after/:version", "./pages/Changelog.tsx", {
    id: "pages/ChangelogAfter",
  }),
  route("dependencies", "./pages/Dependencies.tsx"),
] satisfies RouteConfig;
