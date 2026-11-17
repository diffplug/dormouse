import { afterEach, describe, expect, it } from "vitest";
import type { OpenPort } from "dormouse-lib/lib/platform/types";
import type { InteractiveProgram } from "./tutorial-shell";
import { startDevServer } from "./dev-server-program";

const ports = new Map<string, OpenPort[]>();
const reporter = { setOpenPorts: (id: string, open: OpenPort[]) => { ports.set(id, open); } };
const running: InteractiveProgram[] = [];

function launch(id: string, args = ["run", "dev"]) {
  let output = "";
  const exits: (number | undefined)[] = [];
  const program = startDevServer("npm", args, reporter, id, (data) => { output += data; }, (code) => exits.push(code))!;
  running.push(program);
  program.start();
  return { program, output: () => output, exits };
}

describe("npm run dev", () => {
  afterEach(() => {
    for (const program of running.splice(0)) program.dispose();
    ports.clear();
  });

  it("takes the first free port from 5173, as Vite does, and frees it on Ctrl-C", () => {
    const first = launch("a");
    const second = launch("b");
    expect(ports.get("a")).toEqual([expect.objectContaining({ port: 5173, address: "127.0.0.1" })]);
    expect(ports.get("b")).toEqual([expect.objectContaining({ port: 5174 })]);
    expect(first.output()).not.toContain("in use");
    expect(second.output()).toContain("Port 5173 is in use, trying another one...");

    first.program.handleInput("\x03");
    expect(first.exits).toEqual([130]);
    expect(ports.get("a")).toEqual([]);
    launch("c");
    expect(ports.get("c")).toEqual([expect.objectContaining({ port: 5173 })]);
  });

  it("runs only `npm run dev`, and no other program", () => {
    const install = launch("a", ["install"]);
    expect(install.exits).toEqual([1]);
    expect(install.output()).toContain("npm run dev");
    expect(ports.has("a")).toBe(false);
    expect(startDevServer("node", [], reporter, "a", () => {}, () => {})).toBeNull();
  });
});
