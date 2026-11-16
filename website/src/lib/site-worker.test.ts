import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_PAGE } from "./hosted-pricing";
import { POSTHOG_PROJECT_KEY } from "./site-analytics";

type SiteWorker = {
  HOSTED_ACCOUNT_ORIGIN: string;
  default: {
    fetch(
      request: Request,
      env: { ASSETS: { fetch(request: Request): Promise<Response> } },
      ctx?: { waitUntil(promise: Promise<unknown>): void },
    ): Promise<Response>;
  };
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

/**
 * Sends `request` through the site's Worker with `fetch` answering `upstream`,
 * and settles what it left to `waitUntil`.
 */
async function through(request: Request, upstream: Response | (() => Promise<Response>) = new Response("{}")) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    typeof upstream === "function" ? upstream() : upstream);
  vi.stubGlobal("fetch", fetch);
  const waited: Promise<unknown>[] = [];
  const response = await worker.default.fetch(request, { ASSETS }, { waitUntil: (promise) => waited.push(promise) });
  await Promise.all(waited);
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

describe("the site Worker's update-manifest count", () => {
  /** A check with `headers`, and what it told PostHog. */
  async function check(headers: Record<string, string>, upstream?: () => Promise<Response>) {
    const { response, fetch } = await through(new Request("https://dormouse.sh/standalone-latest.json", { headers }), upstream);
    expect(await response.text()).toBe("static");
    return fetch.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)), headers: [...new Headers(init?.headers).keys()] }));
  }

  it.each([
    ["an official version", "2.0.0", "2.0.0"],
    ["a modified build", "modified-2.0.0", "modified-2.0.0"],
    ["anything else as other", "modified-2.0.0 d080b4f5", "other"],
    ["no header as unreported", undefined, "unreported"],
  ])("counts %s, with nothing else of the request's", async (_case, header, build) => {
    const sent = await check({
      ...(header === undefined ? {} : { "dormouse-build": header }),
      "cf-connecting-ip": "203.0.113.9", "user-agent": "tauri", cookie: "a=b",
    });
    expect(sent).toEqual([{
      url: "https://us.i.posthog.com/i/v0/e/",
      headers: ["content-type"],
      body: {
        api_key: POSTHOG_PROJECT_KEY,
        event: "update check",
        distinct_id: "dormouse.sh update check",
        properties: { build, $process_person_profile: false, $geoip_disable: true },
      },
    }]);
  });

  it("serves the manifest when the count fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await check({ "dormouse-build": "2.0.0" }, async () => { throw new Error("offline"); })).toHaveLength(1);
  });
});
