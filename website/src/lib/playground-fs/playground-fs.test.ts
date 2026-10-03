import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { stateSequence } from "dor-tools-lib/osc";
import { parseToolFile } from "dormouse-lib/host/tool-registry";
import { createPlaygroundFs, PLAYGROUND_CWD, SNAPSHOT_FILES } from "./snapshot";
import { playgroundIframeUrl, playgroundToolControl } from "./tool-control";
import { READ_ONLY_ERROR, PlaygroundViewers, type ViewerRequest } from "./viewers";
import { USER_CONFIG, VirtualFs } from "./vfs";

const README = `${PLAYGROUND_CWD}/README.md`;
const get = (route: string, search = ""): ViewerRequest => ({ method: "GET", route, search, body: "" });
const post = (route: string, body: unknown): ViewerRequest => ({ method: "POST", route, search: "", body: JSON.stringify(body) });

describe("the snapshot", () => {
  it("is exactly the tracked files of dor-tools-lib", () => {
    const tracked = execFileSync("git", ["ls-files", "dor-tools-lib"], { cwd: new URL("../../../../", import.meta.url), encoding: "utf8" })
      .trim().split("\n").map((path) => path.slice("dor-tools-lib/".length));
    expect(Object.keys(SNAPSHOT_FILES).sort()).toEqual(tracked.sort());
  });
});

describe("the playground's user config", () => {
  it("is mounted where a host reads it, and parses as a user Tool file without warnings", () => {
    const text = createPlaygroundFs().read(USER_CONFIG)!;
    const file = parseToolFile(text, { path: USER_CONFIG, dir: "/home/demo/.config/dormouse", scope: "user" });
    expect(file.warnings).toEqual([]);
    expect([...file.tools.keys()]).toEqual(["storybook", "csv"]);
    expect(file.open.map((rule) => rule.tool)).toEqual(["csv"]);
  });
});

describe("VirtualFs", () => {
  const fs = new VirtualFs({ "/home/demo/p/a/b/c.txt": "c", "/home/demo/p/Z.md": "z", "/home/demo/p/y": "y" });

  it("resolves relative, home, and file: paths, and nothing else", () => {
    expect(fs.resolve("/home/demo/p", "../p/./a//b")).toBe("/home/demo/p/a/b");
    expect(fs.resolve("/home/demo/p", "~/p")).toBe("/home/demo/p");
    expect(fs.resolve("/", "../../..")).toBe("/");
    expect(fs.resolve("/", "file:///home/demo/p/Z.md")).toBe("/home/demo/p/Z.md");
    expect(fs.resolve("/", "file://elsewhere/home")).toBeNull();
    expect(fs.resolve("/", "https://example.com/")).toBeNull();
  });

  it("lists directories first, then case-folded names, and compacts one-directory chains", () => {
    expect(fs.list("/home/demo/p")).toEqual([{ name: "a", kind: "dir" }, { name: "y", kind: "file" }, { name: "Z.md", kind: "file" }]);
    expect(fs.compacted("/home/demo/p", "a")).toBe("a/b");
    expect(fs.files("/home/demo/p")).toEqual(["a/b/c.txt", "y", "Z.md"]);
    expect(fs.list("/home/demo/p/y")).toBeNull();
  });
});

describe("playgroundToolControl", () => {
  const control = playgroundToolControl(createPlaygroundFs());

  it("opens a file or folder with the default built-in", async () => {
    expect(await control({ op: "open", target: "README.md", cwd: PLAYGROUND_CWD })).toMatchObject({
      status: "ok", name: "file", scope: "builtin", run: ["dor", "__view-file", README], key: [README], target: README, port: "announced",
    });
    expect(await control({ op: "open", target: "file:///home/demo/dor-tools-lib/src", cwd: "/" }))
      .toMatchObject({ status: "ok", name: "folder", run: ["dor", "__view-folder", `${PLAYGROUND_CWD}/src`] });
  });

  it("answers the host's errors", async () => {
    expect(await control({ op: "open", target: "nope", cwd: PLAYGROUND_CWD })).toEqual({ status: "error", message: "no such file or folder: nope" });
    expect(await control({ op: "open", target: "src", cwd: PLAYGROUND_CWD, tool: "builtin:file" }))
      .toMatchObject({ status: "error", message: expect.stringContaining("cannot open the folder") });
    expect(await control({ op: "open", target: "LICENSE", cwd: PLAYGROUND_CWD, tool: "mine" }))
      .toMatchObject({ status: "error", message: expect.stringContaining("no user Tool 'mine'") });
  });

  it("offers each built-in that supports a file", async () => {
    expect(await control({ op: "open-handlers", target: "README.md", cwd: PLAYGROUND_CWD })).toMatchObject({
      status: "open-handlers",
      handlers: { handlers: [{ tool: "builtin:file", reason: "built-in; no open rule matches" }, { tool: "builtin:code", reason: "built-in" }] },
    });
  });
});

describe("playgroundIframeUrl", () => {
  it("frames an announced viewer at this origin and refuses every other page", async () => {
    vi.stubGlobal("location", { origin: "https://dormouse.sh" });
    try {
      expect(await playgroundIframeUrl("http://localhost:40000/playground-fs/t/view?x=1"))
        .toEqual({ ok: true, url: "https://dormouse.sh/playground-fs/t/view?x=1" });
      expect(await playgroundIframeUrl("http://localhost:5173/")).toMatchObject({ ok: false, reason: "scheme" });
      expect(await playgroundIframeUrl("http://example.com/playground-fs/t/view")).toMatchObject({ ok: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("PlaygroundViewers", () => {
  function harness() {
    const writes: [string, string][] = [];
    const viewers = new PlaygroundViewers(createPlaygroundFs(), (id, data) => writes.push([id, data]), "https://dormouse.sh");
    return { viewers, writes };
  }

  it("serves the editor page instrumented under the editor policy, and the file as source", () => {
    const { viewers } = harness();
    const viewer = viewers.open("t1", "__view-file", [README], "/");
    if (viewer instanceof Error) throw viewer;
    expect(viewer.path).toBe(`/playground-fs/${viewer.token}/view`);
    expect(viewer.target).toBe(README);
    const page = viewers.handle(viewer.token, get("view"))!;
    expect(page.headers["Content-Security-Policy"]).toContain("worker-src 'self'");
    expect(page.body).toContain("assets/markdown.js");
    expect(page.body).toContain("<script>");
    expect(JSON.parse(viewers.handle(viewer.token, get("source"))!.body))
      .toEqual({ text: SNAPSHOT_FILES["README.md"], version: "snapshot", name: "README.md" });
  });

  it("refuses every write and reports dirty state to the viewer's terminal", () => {
    const { viewers, writes } = harness();
    const viewer = viewers.open("t1", "__view-file", [README], "/");
    if (viewer instanceof Error) throw viewer;
    for (const route of ["save", "image", "rename"]) {
      expect(viewers.handle(viewer.token, post(route, { text: "x", version: "snapshot" }))).toMatchObject({ status: 403, body: READ_ONLY_ERROR });
    }
    expect(viewers.handle(viewer.token, post("state", { dirty: true }))!.status).toBe(200);
    expect(writes).toEqual([["t1", stateSequence({ dirty: true })]]);
  });

  it("lists a folder and sends select and activate as OSC 367 opens of absolute paths", () => {
    const { viewers, writes } = harness();
    const viewer = viewers.open("t2", "__view-folder", ["."], PLAYGROUND_CWD);
    if (viewer instanceof Error) throw viewer;
    const listing = JSON.parse(viewers.handle(viewer.token, get("list", "?dir=src"))!.body);
    expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(["frame.ts", "osc.ts", "protocol.ts", "sanitize.ts"]);
    expect(viewers.handle(viewer.token, post("select", { path: "src/osc.ts" }))!.status).toBe(200);
    expect(writes[0][1]).toContain(`"path":"${PLAYGROUND_CWD}/src/osc.ts","preview":true`);
    expect(viewers.handle(viewer.token, get("list", "?dir=..%2F..")))!.toMatchObject({ status: 403 });
  });

  it("answers nothing for a token it does not hold, or once closed", () => {
    const { viewers } = harness();
    const viewer = viewers.open("t3", "__view-error", [README, "gone"], "/");
    if (viewer instanceof Error) throw viewer;
    expect(viewers.handle(viewer.token, get(""))!.body).toContain("gone");
    viewers.close(viewer.token);
    expect(viewers.handle(viewer.token, get(""))).toBeNull();
  });
});
