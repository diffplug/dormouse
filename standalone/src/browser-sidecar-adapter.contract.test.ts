import { afterEach, vi } from "vitest";
import { adapterContract } from "dormouse-lib/lib/platform/adapter-contract-test-utils";
import { BrowserSidecarAdapter } from "./browser-sidecar-adapter";
import { BrowserSidecarHost, type BrowserSidecarEvent } from "./browser-sidecar-host";
import { sidecarAnswer, sidecarSent } from "./sidecar-contract-test-utils";

// As on macOS, where `writeClipboardText` exists (`nativeClipboardWriter`).
vi.mock("dormouse-lib/lib/platform", async (original) => ({ ...await original<object>(), IS_MAC: true }));

/**
 * `BrowserSidecarAdapter` under the shared contract, its dev bridge played at
 * the `BrowserSidecarHost` seam: events arrive on the one stream, and a failing
 * request rejects as `invoke` does on a bridge `{ ok: false }`. The bridge's
 * own forwarding (`standalone/scripts/dev-agent-browser.mjs`) is a script, not
 * played here.
 */
afterEach(() => void vi.restoreAllMocks());

adapterContract("harness", async () => {
  const host = new BrowserSidecarHost("http://127.0.0.1:1/?t=contract");
  const calls: Array<[string, Record<string, any> | undefined]> = [];
  let emit: (event: BrowserSidecarEvent) => void = () => {};
  let failing = false;
  let finishInput: (result: unknown) => void = () => {};
  vi.spyOn(host, "init").mockResolvedValue(undefined);
  vi.spyOn(host, "onReconnect").mockReturnValue(() => {});
  vi.spyOn(host, "onEvent").mockImplementation((listener) => { emit = listener; return () => {}; });
  vi.spyOn(host, "send").mockImplementation((command, args) => void calls.push([command, args]));
  vi.spyOn(host, "invoke").mockImplementation(async (command, args) => {
    calls.push([command, args]);
    if (command === "pty_send_input") return new Promise(resolve => { finishInput = resolve; }) as never;
    if (failing) throw new Error(`${command}: the sidecar answered an error`);
    return sidecarAnswer(command) as never;
  });
  // Claim the console-forwarder flag, so init() leaves the shared jsdom console alone.
  (window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean }).__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;
  const adapter = new BrowserSidecarAdapter(host);
  await adapter.init();
  const since = calls.length;
  const deliver = (event: string, data: unknown) => emit({ event, data });
  return {
    adapter,
    completeInput: (error) => finishInput(error ? { error } : { delivered: true }),
    data: (id, data, textData) => deliver("pty:data", { id, data, textData }),
    exit: (id, exitCode) => deliver("pty:exit", { id, exitCode }),
    list: (detail) => deliver("pty:list", detail),
    replay: (detail) => deliver("pty:replay", detail),
    sent: () => sidecarSent(calls.slice(since)),
    failRequests: () => { failing = true; },
    settle: (promise) => promise,
  };
});
