import { renderToString } from "react-dom/server";
import { matchRoutes, type RouteObject } from "react-router";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { describe, expect, it } from "vitest";
import config from "../../react-router.config";
import routes from "../routes";
import NotFound, { meta } from "./NotFound";

const tree = (entries: RouteConfigEntry[]): RouteObject[] => entries.map(({ path, index, file, children }) =>
  index ? { index: true, id: file } : { path, id: file, children: children && tree(children) });

/** The module the router renders for `path`. */
function leaf(path: string): string | undefined {
  const matches = matchRoutes<RouteObject>([{ path: "/", children: tree(routes) }], path);
  return matches?.[matches.length - 1]?.route.id;
}

describe("NotFound", () => {
  it("is the route for a path no page has, and is prerendered for the host's 404.html", async () => {
    for (const path of ["/securty/", "/docs/guide", "/playground/desktop/extra"]) {
      expect(leaf(path)).toBe("./pages/NotFound.tsx");
    }
    expect(leaf("/changelog/after/1.0.0")).toBe("./pages/ChangelogAfter.tsx");
    const prerender = config.prerender as () => string[] | Promise<string[]>;
    expect(await prerender()).toContain("/404");
  });

  it("links home and claims no canonical", () => {
    expect(renderToString(<NotFound />)).toContain('href="/"');
    const tags = meta();
    expect(tags.some((tag) => "rel" in tag && tag.rel === "canonical")).toBe(false);
    expect(tags).toContainEqual({ name: "robots", content: "noindex, follow" });
  });
});
