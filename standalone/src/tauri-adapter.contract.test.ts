import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));
// As the macOS app, where `writeClipboardText` exists (`nativeClipboardWriter`).
vi.mock("dormouse-lib/lib/platform", async (original) => ({ ...await original<object>(), IS_MAC: true }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { adapterContract } from "dormouse-lib/lib/platform/adapter-contract-test-utils";
import { sidecarAnswer, sidecarSent } from "./sidecar-contract-test-utils";
import { TauriAdapter } from "./tauri-adapter";

/**
 * `TauriAdapter` under the shared contract, Rust played as the two Tauri
 * mocks: each sidecar event reaches the listener `init()` registered for it,
 * and a failing command rejects as Tauri rejects a command's `Err`, with its
 * string. Rust's own routing is not here: `cargo test` owns it.
 */
adapterContract("tauri", async () => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  vi.mocked(listen).mockImplementation((async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => {};
  }) as never);
  const calls: Array<[string, Record<string, any> | undefined]> = [];
  let failing = false;
  vi.mocked(invoke).mockImplementation((async (command: string, args?: Record<string, any>) => {
    calls.push([command, args]);
    return failing ? Promise.reject(`${command}: the sidecar answered an error`) : sidecarAnswer(command);
  }) as never);
  const adapter = new TauriAdapter();
  await adapter.init();
  const since = calls.length;
  const deliver = (event: string, payload: unknown) => listeners.get(event)!({ payload });
  return {
    adapter,
    data: (id, data, textData) => deliver("pty:data", { id, data, textData }),
    exit: (id, exitCode) => deliver("pty:exit", { id, exitCode }),
    list: (detail) => deliver("pty:list", detail),
    replay: (detail) => deliver("pty:replay", detail),
    sent: () => sidecarSent(calls.slice(since)),
    failRequests: () => { failing = true; },
    settle: (promise) => promise,
  };
});
