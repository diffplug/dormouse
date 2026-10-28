// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminMetrics, isAdminMetricsPath } from "./AdminMetrics";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Mounts the page with its read answering `response`. */
async function mount(response: () => Response) {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<AdminMetrics />));
  return fetch;
}

it("answers its path with or without the trailing slash, and no other", () => {
  expect(["/admin/metrics", "/admin/metrics/", "/admin", "/account"].map(isAdminMetricsPath)).toEqual([
    true,
    true,
    false,
    false,
  ]);
});

it("reads the counts as the page's own fetch, and shows each event", async () => {
  const fetch = await mount(() =>
    Response.json({
      days: 30,
      today: "2026-10-28",
      recent: [{ day: "2026-10-28", event: "push.sent", label: "", count: 1234 }],
      totals: [{ event: "push.sent", label: "", count: 1234 }],
    }),
  );
  expect(fetch).toHaveBeenCalledWith("/api/admin/metrics", expect.objectContaining({ credentials: "same-origin" }));
  expect(container.querySelector("h1")?.textContent).toBe("Metrics");
  expect(container.textContent).toContain("through 2026-10-28");
  const push = container.querySelector('section[aria-label="Push notifications delivered"]')!;
  expect(push.textContent).toContain("1,234");
});

it("asks a signed-out visitor to sign in, and tells anyone but the admin there is no page", async () => {
  await mount(() => Response.json({ message: "Sign in first." }, { status: 401 }));
  expect(container.querySelector('a[href="/login?signin"]')).not.toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount(() => Response.json({ message: "Not found." }, { status: 404 }));
  expect(container.querySelector("h1")?.textContent).toBe("Not found");
  expect(container.textContent).not.toContain("Metrics");
});

it("says an outage, and Retry reads again", async () => {
  const fetch = await mount(() => new Response(null, { status: 503 }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Metrics are temporarily unavailable");
  await act(async () => container.querySelector("button")!.click());
  expect(fetch).toHaveBeenCalledTimes(2);
});
