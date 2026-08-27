import { describe, expect, it } from "vitest";
import { BrowserSidecarHost } from "./browser-sidecar-host";

// The dev bridge is an authenticated loopback control plane — `pty_spawn`
// reaches it with caller-supplied shell/args/env. `url()` is the single place
// that attaches the credential, so these guard that choke point rather than
// each call site.
describe("BrowserSidecarHost.url", () => {
  const BASE = "http://127.0.0.1:1422/?t=deadbeef";

  it("carries the base URL's token onto an absolute path", () => {
    // `new URL('/x', base)` drops the base query, which is the whole reason
    // the token is captured in the constructor instead of being resolved.
    const url = new BrowserSidecarHost(BASE).url("/__dormouse_dev_host/send");
    expect(url.pathname).toBe("/__dormouse_dev_host/send");
    expect(url.searchParams.get("t")).toBe("deadbeef");
  });

  it("attaches it to every endpoint, the SSE stream included", () => {
    const host = new BrowserSidecarHost(BASE);
    for (const path of ["/__dormouse_dev_host/events", "/__dormouse_dev_host/invoke", "/__dormouse_dev_host/console"]) {
      expect(host.url(path).searchParams.get("t")).toBe("deadbeef");
    }
  });

  it("stays clean when the base carries no token", () => {
    const url = new BrowserSidecarHost("http://127.0.0.1:1422").url("/__dormouse_dev_host/send");
    expect(url.searchParams.has("t")).toBe(false);
  });
});
