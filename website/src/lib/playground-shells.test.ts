import { describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "mouseterm-lib/lib/platform/fake-adapter";
import { PlaygroundShellRegistry } from "./playground-shells";
import type { InteractiveProgram } from "./tutorial-shell";

function createProgram(): InteractiveProgram {
  return {
    start: vi.fn(),
    handleInput: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("PlaygroundShellRegistry", () => {
  it("attaches a shell to each terminal id", () => {
    const adapter = new FakePtyAdapter();
    const output: Record<string, string[]> = { one: [], two: [] };
    adapter.onPtyData((detail) => output[detail.id]?.push(detail.data));
    adapter.spawnPty("one");
    adapter.spawnPty("two");

    const registry = new PlaygroundShellRegistry(adapter, () => createProgram());
    registry.ensureShell("one");
    registry.ensureShell("two");

    adapter.writePty("one", "\r");
    adapter.writePty("two", "\r");

    expect(output.one.join("")).toContain("user");
    expect(output.two.join("")).toContain("user");
    expect(output.one.join("")).toContain("$ ");
    expect(output.two.join("")).toContain("$ ");
  });

  it("starts interactive programs against the active terminal id", () => {
    const adapter = new FakePtyAdapter();
    const program = createProgram();
    const startProgram = vi.fn(() => program);
    adapter.spawnPty("two");

    const registry = new PlaygroundShellRegistry(adapter, startProgram);
    registry.ensureShell("two");
    adapter.writePty("two", "ascii-splash --no-mouse\r");

    expect(startProgram).toHaveBeenCalledWith("two", ["--no-mouse"], expect.any(Function));
    expect(program.start).toHaveBeenCalledTimes(1);
  });

  it("clears the adapter input handler when disposing a shell", () => {
    const adapter = new FakePtyAdapter();
    const output: string[] = [];
    adapter.onPtyData((detail) => output.push(detail.data));
    adapter.spawnPty("one");

    const registry = new PlaygroundShellRegistry(adapter, () => createProgram());
    registry.ensureShell("one");
    registry.disposeShell("one");

    adapter.writePty("one", "raw");

    expect(output).toEqual(["raw"]);
  });

  it("disposes shells when their PTY exits", () => {
    const adapter = new FakePtyAdapter();
    const program = createProgram();
    adapter.spawnPty("one");

    const registry = new PlaygroundShellRegistry(adapter, () => program);
    registry.ensureShell("one");
    adapter.writePty("one", "ascii-splash\r");

    adapter.killPty("one");

    expect(program.dispose).toHaveBeenCalledTimes(1);
  });
});
