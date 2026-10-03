// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { serveSequence } from "dor-tools-lib/osc";
import { startPlaygroundDor } from "./dor";
import { createPlaygroundFs, PLAYGROUND_CWD } from "./snapshot";
import { playgroundToolControl } from "./tool-control";
import { PlaygroundViewers } from "./viewers";

interface ControlDetail { surfaceId: string; method: string; params: Record<string, unknown>; respond(result: unknown): void }

function harness(args: string[], relay: () => Promise<unknown> = () => Promise.resolve()) {
  const adapter = new FakePtyAdapter();
  adapter.spawnPty("t");
  // What the program writes, before the protocol parser strips its OSCs.
  let output = "";
  const send = adapter.sendOutput.bind(adapter);
  vi.spyOn(adapter, "sendOutput").mockImplementation((id, data) => { output += data; send(id, data); });
  const fs = createPlaygroundFs();
  const viewers = new PlaygroundViewers(fs, (id, data) => adapter.sendOutput(id, data), location.origin);
  const onExit = vi.fn();
  const program = startPlaygroundDor({
    adapter, terminalId: "t", args, cwd: PLAYGROUND_CWD, fs, viewers, relay, toolControl: playgroundToolControl(fs), onExit,
  });
  return { adapter, program, onExit, output: () => output };
}

/** Answers every control request with `result`, recording what was asked. */
function answerControl(result: unknown): ControlDetail[] {
  const requests: ControlDetail[] = [];
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ControlDetail>).detail;
    requests.push(detail);
    detail.respond({ ok: true, result });
  };
  window.addEventListener("dormouse:control-request", listener);
  stopListening = () => window.removeEventListener("dormouse:control-request", listener);
  return requests;
}
let stopListening = () => {};
afterEach(() => stopListening());

describe("playground dor open", () => {
  it("sends the real CLI's surface.tool request and prints its answer", () => {
    const requests = answerControl({ status: "takeover", surfaceRef: "surface:1", command: "dor __view-file /x" });
    const { program, onExit, output } = harness(["o", "--preview", "README.md"]);
    program.start();
    expect(requests).toMatchObject([{
      surfaceId: "t", method: "surface.tool",
      params: { file: "README.md", fresh: false, minimized: false, cwd: PLAYGROUND_CWD, preview: true },
    }]);
    expect(output()).toContain('takeover surface:1  "dor __view-file /x"\r\n');
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("refuses flags the real CLI refuses, without asking the host", () => {
    const requests = answerControl({});
    const { program, onExit, output } = harness(["open", "--preview", "--fresh", "x"]);
    program.start();
    expect(requests).toEqual([]);
    expect(output()).toContain("Error: --preview cannot be combined with --fresh");
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("names its verbs for anything else", () => {
    const { program, onExit, output } = harness(["split"]);
    program.start();
    expect(output()).toContain("Error: unknown command 'split'");
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe("playground dor __view-*", () => {
  it("reports its port before announcing it, and withdraws it on Ctrl+C", async () => {
    const { adapter, program, onExit, output } = harness(["__view-folder", PLAYGROUND_CWD]);
    program.start();
    await Promise.resolve();
    const [port] = await adapter.getOpenPorts("t");
    expect(port).toMatchObject({ protocol: "tcp", address: "127.0.0.1" });
    const path = /"path":"([^"]+)"/.exec(output())![1];
    expect(path).toMatch(/^\/playground-fs\/[0-9a-f-]{36}\/$/);
    expect(output()).toContain(`\x1b]2;dor-tools-lib\x07${serveSequence({ port: port.port, path })}`);
    program.handleInput("\x03");
    expect(await adapter.getOpenPorts("t")).toEqual([]);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("exits with the host's error for a file it cannot show", () => {
    const { program, onExit, output } = harness(["__view-file", "nope"]);
    program.start();
    expect(output()).toContain("Error: no such file or folder: nope");
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("exits when the service worker cannot start", async () => {
    const { program, onExit, output } = harness(["__view-file", "LICENSE"], () => Promise.reject(new Error("no service worker")));
    program.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output()).toContain("Error: no service worker");
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
