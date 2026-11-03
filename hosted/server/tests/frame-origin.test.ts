import { describe, expect, test } from "vitest";
import { frameOriginResponse } from "../frame-origin";

const asked: string[] = [];
const env = {
  CLIENT_ORIGINS: "https://relay.dormouse.sh https://connect.dormouse.sh",
  ASSETS: {
    fetch: async (request: Request) => {
      asked.push(new URL(request.url).pathname);
      return new Response("file");
    },
  },
};
const at = (path: string, init?: RequestInit) =>
  frameOriginResponse(new Request(`https://abc.frames.example${path}`, init), env);

describe("frameOriginResponse", () => {
  test("serves its three files, framed only by the Client", async () => {
    for (const [path, type] of [
      ["/__dormouse-frame-sw.js", "text/javascript"],
      ["/__dormouse-frame/bootstrap.js", "text/javascript"],
      ["/__dormouse-frame/bootstrap.html", "text/html"],
    ] as const) {
      const response = await at(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
      expect(response.headers.get("content-security-policy")).toMatch(
        /frame-ancestors https:\/\/relay\.dormouse\.sh https:\/\/connect\.dormouse\.sh$/,
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("strict-transport-security")).toContain("includeSubDomains");
      expect(await response.text()).toBe("file");
    }
  });

  test("asks its assets for the page by the name they serve it under", async () => {
    asked.length = 0;
    await at("/__dormouse-frame/bootstrap.html");
    expect(asked).toEqual(["/__dormouse-frame/bootstrap"]);
  });

  test("answers anything else 404, setting nothing and asking its assets for nothing", async () => {
    asked.length = 0;
    for (const response of [
      await at("/"),
      await at("/index.html"),
      await at("/__dormouse-frame/other.js"),
      await at("/constructor"),
      await at("/__dormouse-frame-sw.js", { method: "POST", body: "x" }),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  test("answers HEAD with no body", async () => {
    const response = await at("/__dormouse-frame-sw.js", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
