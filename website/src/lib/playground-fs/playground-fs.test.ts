import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLDER_BODY_LIMIT } from "dor-tools-builtin/folder-viewer-page";
import { IMAGE_BOUND, IMAGE_CSP, VERSION_HEADER } from "dor-tools-builtin/image-format";
import { stateSequence } from "dor-tools-lib/osc";
import { parseToolFile } from "dormouse-lib/host/tool-registry";
import { createPlaygroundFs, PLAYGROUND_CWD, SNAPSHOT_FILES } from "./snapshot";
import { respond, type RelayMessage } from "./sw-relay";
import { playgroundIframeUrl, playgroundToolControl } from "./tool-control";
import { PlaygroundViewers, type ViewerRequest, type ViewerResponse } from "./viewers";
import { StockTree, USER_CONFIG, VirtualFs } from "./vfs";

const README = `${PLAYGROUND_CWD}/README.md`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_EDITED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6, 7]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
/** A PNG header declaring 9000 × 9000 pixels, past the image editor's bound. */
const HUGE_PNG = new Uint8Array([...PNG.subarray(0, 8), 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x23, 0x28, 0, 0, 0x23, 0x28, 8, 6, 0, 0, 0]);
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const get = (route: string, search = ""): ViewerRequest => ({ method: "GET", route, search, contentType: "", body: new Blob() });
const post = (route: string, body: unknown): ViewerRequest =>
  ({ method: "POST", route, search: "", contentType: "application/json", body: new Blob([JSON.stringify(body)]) });
const upload = (route: string, bytes: Uint8Array, contentType: string, search = ""): ViewerRequest =>
  ({ method: "POST", route, search, contentType, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
const text = async (response: ViewerResponse | null) => {
  const body = response!.body;
  return typeof body === "string" ? body : await body.text();
};
const bytes = async (response: ViewerResponse | null) => new Uint8Array(await (response!.body as Blob).arrayBuffer());

describe("the snapshot", () => {
  it("is exactly the tracked files of dor-tools-lib", () => {
    const tracked = execFileSync("git", ["ls-files", "dor-tools-lib"], { cwd: new URL("../../../../", import.meta.url), encoding: "utf8" })
      .trim().split("\n").map((path) => path.slice("dor-tools-lib/".length));
    expect(Object.keys(SNAPSHOT_FILES).sort()).toEqual(tracked.sort());
  });
});

describe("the playground's user config", () => {
  it("is mounted where a host reads it, and parses as a user Tool file without warnings", () => {
    const text = createPlaygroundFs().data(USER_CONFIG) as string;
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

  it("keeps writes, renames, and whiteouts in its overlay, merged into every listing", () => {
    const stock = new StockTree({ "/home/demo/p/a.md": "a", "/home/demo/p/b.png": "b" });
    const fs = new VirtualFs(stock);
    fs.write("/home/demo/p/a.md", "A");
    fs.write("/home/demo/p/new.png", new Uint8Array([1, 2]));
    fs.rename("/home/demo/p/b.png", "/home/demo/p/c.png");
    expect(fs.data("/home/demo/p/a.md")).toBe("A");
    expect(fs.bytes("/home/demo/p/new.png")).toEqual(new Uint8Array([1, 2]));
    expect(fs.kind("/home/demo/p/b.png")).toBeNull();
    expect(fs.data("/home/demo/p/c.png")).toBe("b");
    expect(fs.files("/home/demo/p")).toEqual(["a.md", "c.png", "new.png"]);
    fs.rename("/home/demo/p/c.png", "/home/demo/p/b.png");
    expect(fs.files("/home/demo/p")).toEqual(["a.md", "b.png", "new.png"]);
    expect(() => fs.write("/home/demo/nope/x", "x")).toThrow("no such directory");
    expect(() => fs.write("/home/demo/p", "x")).toThrow("is a directory");

    const fresh = new VirtualFs(stock);
    expect(fresh.data("/home/demo/p/a.md")).toBe("a");
    expect(fresh.files("/home/demo/p")).toEqual(["a.md", "b.png"]);
  });

  it("gives each playground filesystem its own overlay on the one snapshot", () => {
    const written = createPlaygroundFs();
    written.write(README, "# changed");
    expect(written.data(README)).toBe("# changed");
    expect(createPlaygroundFs().data(README)).toBe(SNAPSHOT_FILES["README.md"]);
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
  afterEach(() => { vi.useRealTimers(); });

  function harness() {
    const writes: [string, string][] = [];
    const fs = createPlaygroundFs();
    const viewers = new PlaygroundViewers(fs, (id, data) => writes.push([id, data]), "https://dormouse.sh");
    const open = (verb: string, args: string[], cwd = "/") => {
      const viewer = viewers.open("t1", verb, args, cwd);
      if (viewer instanceof Error) throw viewer;
      return { ...viewer, handle: (request: ViewerRequest) => viewers.handle(viewer.token, request) };
    };
    return { fs, viewers, writes, open };
  }

  it("serves the editor page instrumented under the editor policy, and the file as source at its sha256", async () => {
    const { open } = harness();
    const viewer = open("__view-file", [README]);
    expect(viewer.path).toBe(`/playground-fs/${viewer.token}/view`);
    expect(viewer.target).toBe(README);
    const page = (await viewer.handle(get("view")))!;
    expect(page.headers["Content-Security-Policy"]).toContain("worker-src 'self'");
    expect(page.body).toContain("assets/markdown.js");
    expect(page.body).toContain("<script>");
    expect(JSON.parse(await text(await viewer.handle(get("source")))))
      .toEqual({ text: SNAPSHOT_FILES["README.md"], version: sha256(SNAPSHOT_FILES["README.md"]), name: "README.md" });
  });

  it("saves text over its revision, refuses a stale one, and reports dirty state to the viewer's terminal", async () => {
    const { fs, open, writes } = harness();
    const viewer = open("__view-file", [README]);
    const { version } = JSON.parse(await text(await viewer.handle(get("source"))));
    const saved = await viewer.handle(post("save", { text: "# saved", version }));
    expect(saved).toMatchObject({ status: 200 });
    expect(JSON.parse(await text(saved))).toEqual({ version: sha256("# saved") });
    expect(fs.data(README)).toEqual(encode("# saved"));
    expect(await viewer.handle(post("save", { text: "# stale", version }))).toMatchObject({ status: 409 });
    expect(fs.data(README)).toEqual(encode("# saved"));
    expect(await viewer.handle(post("save", { text: 1, version }))).toMatchObject({ status: 400 });
    expect((await viewer.handle(post("state", { dirty: true })))!.status).toBe(200);
    expect(writes).toEqual([["t1", stateSequence({ dirty: true })]]);
  });

  it("names a pasted image as the Node viewer does, beside the document, and reports the paste", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 14, 5, 9));
    const { fs, viewers, open } = harness();
    const pastes = vi.fn();
    viewers.subscribeToPastes(pastes);
    const viewer = open("__view-file", [README]);
    const first = await viewer.handle(upload("image", PNG, "image/png"));
    const second = await viewer.handle(upload("image", JPEG, "Image/JPEG; charset=x"));
    expect(JSON.parse(await text(first))).toEqual({ name: "image-20261003-140509.png", width: null });
    expect(JSON.parse(await text(second))).toEqual({ name: "image-20261003-140509.jpg", width: null });
    expect(JSON.parse(await text(await viewer.handle(upload("image", PNG, "image/png"))))).toEqual({ name: "image-20261003-140509-2.png", width: null });
    expect(pastes).toHaveBeenCalledTimes(3);
    expect(fs.bytes(`${PLAYGROUND_CWD}/image-20261003-140509.png`)).toEqual(PNG);
    expect(fs.list(PLAYGROUND_CWD)!.map((entry) => entry.name)).toContain("image-20261003-140509-2.png");
    const shown = await viewer.handle(get("images/image-20261003-140509.png", "?v=2"));
    expect(await bytes(shown)).toEqual(PNG);
    expect(shown!.headers).toMatchObject({ "Content-Type": "image/png", "Content-Security-Policy": IMAGE_CSP });
  });

  it("refuses a paste whose bytes are not its type, an unknown type, an oversize body, and a non-Markdown viewer", async () => {
    const { fs, viewers, open } = harness();
    const pastes = vi.fn();
    viewers.subscribeToPastes(pastes);
    const viewer = open("__view-file", [README]);
    expect(await viewer.handle(upload("image", JPEG, "image/png"))).toMatchObject({ status: 415, body: "The pasted data is not a PNG image." });
    expect(await viewer.handle(upload("image", PNG, "text/plain"))).toMatchObject({ status: 415 });
    expect(await viewer.handle(upload("image", new Uint8Array(IMAGE_BOUND.limit + 1), "image/png"))).toMatchObject({ status: 413 });
    const code = open("__view-code", [README]);
    expect(await code.handle(upload("image", PNG, "image/png"))).toMatchObject({ status: 404 });
    expect(pastes).not.toHaveBeenCalled();
    expect(fs.files(PLAYGROUND_CWD).filter((name) => name.startsWith("image-"))).toEqual([]);
  });

  it("Markdown reads images but has no route that replaces their bytes", async () => {
    const { fs, open } = harness();
    fs.write(`${PLAYGROUND_CWD}/src/shot.png`, PNG);
    const viewer = open("__view-file", [README]);
    expect(await bytes(await viewer.handle(get("images/src/shot.png")))).toEqual(PNG);
    expect(await viewer.handle(get("edit/src/shot.png"))).toMatchObject({ status: 404 });
    expect(await viewer.handle(upload("image-save/src/shot.png", PNG_EDITED, "image/png", `?version=${sha256(PNG)}`))).toMatchObject({ status: 404 });
    expect(fs.bytes(`${PLAYGROUND_CWD}/src/shot.png`)).toEqual(PNG);
  });

  it("renames an image within its folder, never over another file", async () => {
    const { fs, open } = harness();
    fs.write(`${PLAYGROUND_CWD}/a.png`, PNG);
    fs.write(`${PLAYGROUND_CWD}/b.png`, JPEG);
    const viewer = open("__view-file", [README]);
    expect(await viewer.handle(post("rename", { from: "a.png", to: "b.png" }))).toMatchObject({ status: 409, body: "b.png already exists." });
    expect(await viewer.handle(post("rename", { from: "a.png", to: "src/a.png" }))).toMatchObject({ status: 400 });
    expect(await viewer.handle(post("rename", { from: "a.png", to: ".a.png" }))).toMatchObject({ status: 400 });
    expect(await viewer.handle(post("rename", { from: "a.png", to: "shot.png" }))).toMatchObject({ status: 200 });
    expect(fs.kind(`${PLAYGROUND_CWD}/a.png`)).toBeNull();
    expect(fs.bytes(`${PLAYGROUND_CWD}/shot.png`)).toEqual(PNG);
  });

  it("opens a PNG in the image editor, which saves over it, and refuses other binary formats", async () => {
    const { fs, open, writes } = harness();
    fs.write(`${PLAYGROUND_CWD}/shot.png`, PNG);
    fs.write(`${PLAYGROUND_CWD}/anim.gif`, new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    const viewer = open("__view-file", ["shot.png"], PLAYGROUND_CWD);
    expect(viewer.path).toBe(`/playground-fs/${viewer.token}/view`);
    expect((await viewer.handle(get("view")))!.body).toContain("assets/image.js");
    const source = await viewer.handle(get("source"));
    expect(await bytes(source)).toEqual(PNG);
    expect(source!.headers[VERSION_HEADER]).toBe(sha256(PNG));
    expect(await viewer.handle(upload("save", JPEG, "image/jpeg", `?version=${sha256(PNG)}`))).toMatchObject({ status: 415 });
    expect(await viewer.handle(upload("save", PNG_EDITED, "image/png", `?version=${sha256(PNG)}`))).toMatchObject({ status: 200 });
    expect(fs.bytes(`${PLAYGROUND_CWD}/shot.png`)).toEqual(PNG_EDITED);
    expect(await viewer.handle(upload("image", PNG, "image/png"))).toMatchObject({ status: 404 });
    expect((await viewer.handle(post("state", { dirty: false })))!.status).toBe(200);
    expect(writes).toEqual([["t1", stateSequence({ dirty: false })]]);
    expect(() => open("__view-file", ["anim.gif"], PLAYGROUND_CWD)).toThrow("PNG and JPEG files the image editor opens");
    fs.write(`${PLAYGROUND_CWD}/huge.png`, HUGE_PNG);
    expect(() => open("__view-file", ["huge.png"], PLAYGROUND_CWD)).toThrow("PNG and JPEG files the image editor opens");
  });

  it("hashes each stored value once: a save hashes only its new bytes", async () => {
    const { fs, open } = harness();
    fs.write(`${PLAYGROUND_CWD}/shot.png`, PNG);
    const viewer = open("__view-file", ["shot.png"], PLAYGROUND_CWD);
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const version = (await viewer.handle(get("source")))!.headers[VERSION_HEADER];
      expect(digest).toHaveBeenCalledTimes(1);
      expect(await viewer.handle(upload("save", PNG_EDITED, "image/png", `?version=${version}`))).toMatchObject({ status: 200 });
      expect(digest).toHaveBeenCalledTimes(2);
      expect((await viewer.handle(get("source")))!.headers[VERSION_HEADER]).toBe(sha256(PNG_EDITED));
      expect(digest).toHaveBeenCalledTimes(2);
    } finally {
      digest.mockRestore();
    }
  });

  it("lists a folder and sends select and activate as OSC 367 opens of absolute paths", async () => {
    const { fs, writes, open } = harness();
    fs.write(`${PLAYGROUND_CWD}/src/new.ts`, "");
    const viewer = open("__view-folder", ["."], PLAYGROUND_CWD);
    const listing = JSON.parse(await text(await viewer.handle(get("list", "?dir=src"))));
    expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(["frame.ts", "new.ts", "osc.ts", "protocol.ts", "sanitize.ts"]);
    expect((await viewer.handle(post("select", { path: "src/osc.ts" })))!.status).toBe(200);
    expect(writes[0][1]).toContain(`"path":"${PLAYGROUND_CWD}/src/osc.ts","preview":true`);
    // The same body rules as the Node folder viewer's.
    expect(await viewer.handle({ ...post("select", { path: "src/osc.ts" }), contentType: "text/plain" })).toMatchObject({ status: 415 });
    expect(await viewer.handle(post("select", { path: "x".repeat(FOLDER_BODY_LIMIT) }))).toMatchObject({ status: 413 });
    expect(await viewer.handle({ ...post("select", {}), body: new Blob(["{"]) })).toMatchObject({ status: 400 });
    expect(writes).toHaveLength(1);
    expect(await viewer.handle(get("list", "?dir=..%2F.."))).toMatchObject({ status: 403 });
  });

  it("answers nothing for a token it does not hold, or once closed", async () => {
    const { viewers, open } = harness();
    const viewer = open("__view-error", [README, "gone"]);
    expect(await text(await viewer.handle(get("")))).toContain("gone");
    viewers.close(viewer.token);
    expect(await viewer.handle(get(""))).toBeNull();
  });
});

describe("the window side of the viewer relay", () => {
  it("carries a Blob request body in and a Blob answer out, never the stored bytes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 14, 5, 9));
    const fs = createPlaygroundFs();
    const viewers = new PlaygroundViewers(fs, () => {}, "https://dormouse.sh");
    const viewer = viewers.open("t1", "__view-file", [README], "/");
    if (viewer instanceof Error) throw viewer;
    const ask = async (request: ViewerRequest) => {
      const { port1, port2 } = new MessageChannel();
      const answer = new Promise<ViewerResponse | null>((resolve) => { port2.onmessage = ({ data }) => resolve(data); });
      const message: RelayMessage = { type: "playground-fs-request", token: viewer.token, ...request };
      await respond(viewers, message, port1);
      try { return await answer; } finally { port1.close(); port2.close(); }
    };
    try {
      expect(JSON.parse(await text(await ask(upload("image", PNG, "image/png"))))).toEqual({ name: "image-20261003-140509.png", width: null });
      const shown = await ask(get("images/image-20261003-140509.png"));
      expect(shown!.body).toBeInstanceOf(Blob);
      expect(await bytes(shown)).toEqual(PNG);
      expect(fs.bytes(`${PLAYGROUND_CWD}/image-20261003-140509.png`)).toEqual(PNG);
      expect(await ask(get("images/missing.png"))).toMatchObject({ status: 404 });
    } finally {
      vi.useRealTimers();
    }
  });
});
