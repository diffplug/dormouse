import { describe, expect, it } from "vitest";
import { BrowserSidecarHost } from "./browser-sidecar-host";

// The dev bridge is an authenticated loopback control plane — `pty_spawn`
// reaches it with caller-supplied shell/args/env. `url()` is the single place
// that attaches the credential, so these guard that choke point rather than
// each call site.
describe("BrowserSidecarHost.url", () => {
  const BASE = "http://127.0.0.1:1422/?t=deadbeef";

  it("carries the base URL's token onto every endpoint, the SSE stream included", () => {
    const host = new BrowserSidecarHost(BASE);
    for (const path of [
      "/__dormouse_dev_host/events",
      "/__dormouse_dev_host/send",
      "/__dormouse_dev_host/invoke",
      "/__dormouse_dev_host/console",
    ]) {
      const url = host.url(path);
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("t")).toBe("deadbeef");
    }
  });

  it("stays clean when the base carries no token", () => {
    const url = new BrowserSidecarHost("http://127.0.0.1:1422").url("/__dormouse_dev_host/send");
    expect(url.searchParams.has("t")).toBe(false);
    expect(url.pathname).toBe("/__dormouse_dev_host/send");
  });
});
