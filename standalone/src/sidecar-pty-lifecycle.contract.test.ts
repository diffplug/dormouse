// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import { createSidecarHost, type SidecarHost, type SidecarHostPtyManager } from "dormouse-lib/host/remote/sidecar-entry";
import { sliceSince } from "dormouse-lib/host/replay-buffer";
import { ptyLifecycleContract } from "./pty-lifecycle-contract-test-utils";

/**
 * The real PTY lifecycle the fake is held to: the sidecar as `sidecar/main.js`
 * composes it, over the pinned node-pty, minus Rust and the webview (as
 * `sidecar-flow-control.test.ts`). Each program is `node` running a fixture,
 * so it runs on Windows too; every PTY is killed after its test.
 */
const sidecarRequire = createRequire(fileURLToPath(new URL("../sidecar/package.json", import.meta.url)));
const { create } = sidecarRequire("./pty-core.js") as {
  create(send: (event: string, data: unknown) => void, pty: unknown, options: unknown): SidecarHostPtyManager & { killAll(): void };
};
const nodePty = sidecarRequire("node-pty");

/** `print` (`-` for none) after `after` ms, then `exit` with that code, or `stay`. */
const PROGRAM = `const [print, exit, after] = process.argv.slice(2);
setTimeout(() => {
  if (print !== '-') process.stdout.write(print);
  if (exit === 'stay') setInterval(() => {}, 1 << 30);
  else setTimeout(() => process.exit(Number(exit)), 50);
}, Number(after));
`;

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.reverse()) {
    try { step(); } catch { /* best effort */ }
  }
  cleanup = [];
  vi.restoreAllMocks();
});

ptyLifecycleContract("sidecar", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dormouse-lifecycle-"));
  const script = path.join(dir, "program.js");
  writeFileSync(script, PROGRAM);
  // pty-core logs each spawn, and the Burrow's memory-only store says so once.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const output = new Map<string, string>();
  const exits = new Map<string, number[]>();
  const send = (event: string, data: unknown) => {
    const { id, data: text, exitCode } = data as { id: string; data?: string; exitCode?: number };
    if (event === "pty:data") output.set(id, (output.get(id) ?? "") + text);
    if (event === "pty:exit") exits.set(id, [...(exits.get(id) ?? []), exitCode ?? -1]);
  };
  // Wired as main.js wires them: every pty-core event through the host's tap,
  // and only non-data events forwarded raw.
  let host: SidecarHost | null = null;
  const mgr = create((event, data) => {
    host!.onPtyEvent(event, data);
    if (event !== "data") send(`pty:${event}`, data);
  }, nodePty, { replay: true, sliceSince });
  const live = host = createSidecarHost({ send, mgr });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  cleanup.push(() => live.dispose());
  cleanup.push(() => mgr.killAll());
  const spawn = (id: string, shell: string, args: string[]) =>
    live.handleCommand("pty:spawn", { id, options: { shell, args, cwd: dir, cols: 80, rows: 24 } });
  return {
    spawn: (id, { print, after = 0, exit }) =>
      spawn(id, process.execPath, [script, print ?? "-", exit === undefined ? "stay" : String(exit), String(after)]),
    spawnMissing: (id) => spawn(id, path.join(dir, "no-such-shell"), []),
    kill: (id) => live.handleCommand("pty:kill", { id }),
    output: (id) => output.get(id) ?? "",
    exits: (id) => exits.get(id) ?? [],
  };
});
