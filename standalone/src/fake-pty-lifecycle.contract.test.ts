import { afterEach } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { ptyLifecycleContract } from "./pty-lifecycle-contract-test-utils";

/**
 * `FakePtyAdapter` held to the real PTY lifecycle: each program is a scenario,
 * one timed chunk and the exit it ends with.
 */
let adapters: FakePtyAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters) adapter.reset();
  adapters = [];
});

ptyLifecycleContract("fake", () => {
  const adapter = new FakePtyAdapter();
  adapters.push(adapter);
  const output = new Map<string, string>();
  const exits = new Map<string, number[]>();
  adapter.onPtyData(({ id, data }) => void output.set(id, (output.get(id) ?? "") + data));
  adapter.onPtyExit(({ id, exitCode }) => void exits.set(id, [...(exits.get(id) ?? []), exitCode]));
  return {
    spawn: (id, { print, after = 0, exit }) => {
      adapter.setScenario(id, { name: id, chunks: print === undefined ? [] : [{ delay: after, data: print }], exitCode: exit });
      adapter.spawnPty(id);
    },
    kill: (id) => adapter.killPty(id),
    output: (id) => output.get(id) ?? "",
    exits: (id) => exits.get(id) ?? [],
  };
});
