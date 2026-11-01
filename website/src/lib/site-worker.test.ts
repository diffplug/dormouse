import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_PAGE } from "./hosted-pricing";

type SiteWorker = {
  HOSTED_ACCOUNT_ORIGIN: string;
  default: { fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> };
};
// Plain JavaScript Pages runs as is (`website/public/_worker.js`); a path
// held in a variable keeps the type checker from asking for its declarations.
const WORKER_PATH = "../../public/_worker.js";
const worker = (await import(/* @vite-ignore */ WORKER_PATH)) as SiteWorker;

const ASSETS = { fetch: vi.fn(async () => new Response("static")) };

afterEach(() => {
  vi.unstubAllGlobals();
  ASSETS.fetch.mockClear();
});

/** Sends `request` through the site's Worker with `fetch` answering `upstream`. */
async function through(request: Request, upstream = new Response("{}")) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstream);
  vi.stubGlobal("fetch", fetch);
  const response = await worker.default.fetch(request, { ASSETS });
  return { response, fetch };
}

describe("the site Worker's /api/hosted/ forward", () => {
  it("goes to the account Worker the checkout links name", () => {
    expect(worker.HOSTED_ACCOUNT_ORIGIN).toBe(new URL(CHECKOUT_PAGE).origin);
  });

  it("forwards a read's path with nothing of the reader's", async () => {
    const { response, fetch } = await through(
      new Request("https://dormouse.sh/api/hosted/cohorts?who=me", {
        headers: { cookie: "a=b", authorization: "Bearer x", "cf-connecting-ip": "203.0.113.9", accept: "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://hosted.dormouse.sh/api/hosted/cohorts");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect([...new Headers(init?.headers).entries()]).toEqual([["accept", "application/json"]]);
    expect(ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("brings back the body and its type, never a cookie", async () => {
    const { response } = await through(
      new Request("https://dormouse.sh/api/hosted/founders/ab"),
      new Response("png", {
        status: 404,
        headers: { "content-type": "image/png", "cache-control": "no-store", "set-cookie": "s=1", "x-other": "1" },
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("png");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-other")).toBeNull();
  });

  it("refuses anything but a read", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const { response, fetch } = await through(new Request("https://dormouse.sh/api/hosted/cohorts", { method, body: "{}" }));
      expect(response.status, method).toBe(405);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("leaves every other path to the static site", async () => {
    const { response, fetch } = await through(new Request("https://dormouse.sh/api/other"));
    expect(await response.text()).toBe("static");
    expect(fetch).not.toHaveBeenCalled();
  });
});
