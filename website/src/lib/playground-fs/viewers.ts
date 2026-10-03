/**
 * The desktop playground's stand-in for the built-in viewer processes
 * (docs/specs/tutorial.md -> Playground filesystem): the same pages and routes
 * `dor-tools-builtin/src/{file,folder,error}-viewer.ts` serve, answered from
 * the read-only snapshot and reached through the `/playground-fs/` service
 * worker rather than a loopback port.
 */
import { EDITOR_CSP, editorPage, markdownPage } from "dor-tools-builtin/editor-page";
import { ERROR_CSP, errorViewerPage } from "dor-tools-builtin/error-viewer-page";
import { FOLDER_CSP, folderViewerPage } from "dor-tools-builtin/folder-viewer-page";
import { viewerTitle, type FileFormat } from "dor-tools-builtin/file-viewer-format";
import { openSequence, stateSequence } from "dor-tools-lib/osc";
import { instrumentHtml } from "dormouse-lib/host/iframe-proxy-rewrite";
import type { VirtualFs } from "./vfs";

/** Every viewer URL starts here; the service worker's scope. */
export const VIEWER_SCOPE = "/playground-fs/";

export const READ_ONLY_ERROR = "This playground's files are read-only.";

export interface ViewerRequest {
  method: string;
  /** The path after `/playground-fs/<token>/`, percent-decoded. */
  route: string;
  /** `URLSearchParams` of the request URL. */
  search: string;
  body: string;
}

export interface ViewerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Viewer = { terminalId: string } & (
  | { kind: "file"; target: string; markdown: boolean }
  | { kind: "folder"; root: string }
  | { kind: "error"; target: string; message: string }
);

/** What `serveSequence` announces, and the title the real `announceViewer` prints. */
export interface ViewerAnnouncement { token: string; path: string; title: string }

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json";
const TEXT = "text/plain; charset=utf-8";

/** One window's viewers, keyed by an unguessable token in their URL. */
export class PlaygroundViewers {
  private readonly viewers = new Map<string, Viewer>();

  constructor(
    private readonly fs: VirtualFs,
    /** Writes to a viewer's terminal as its process's stdout would. */
    private readonly write: (terminalId: string, data: string) => void,
    /** The Wall's origin, which the instrumented pages report to. */
    private readonly embedderOrigin: () => string,
  ) {}

  /** Starts a file viewer on `target` with the handler's `format`, or names why it cannot. */
  openFile(terminalId: string, target: string, format: (path: string) => FileFormat | null): ViewerAnnouncement | Error {
    if (this.fs.kind(target) !== "file") return new Error(`no such file: ${target}`);
    const served = format(target);
    if (!served) return new Error("unsupported file format; configure a user Tool association");
    // The snapshot holds only text; the HTML, image, and media routes have nothing to serve.
    if (!served.text) return new Error("the playground's file viewer shows text files only");
    return this.add({ terminalId, kind: "file", target, markdown: !!served.markdown }, "view", target);
  }

  openFolder(terminalId: string, root: string): ViewerAnnouncement | Error {
    if (this.fs.kind(root) !== "dir") return new Error("not a directory");
    return this.add({ terminalId, kind: "folder", root }, "", root);
  }

  openError(terminalId: string, target: string, message: string): ViewerAnnouncement {
    return this.add({ terminalId, kind: "error", target, message }, "", target);
  }

  close(token: string): void {
    this.viewers.delete(token);
  }

  private add(viewer: Viewer, page: string, target: string): ViewerAnnouncement {
    const token = crypto.randomUUID();
    this.viewers.set(token, viewer);
    return { token, path: `${VIEWER_SCOPE}${token}/${page}`, title: viewerTitle(target) };
  }

  /** The answer for one request to `token`'s viewer, or null when this window has none. */
  handle(token: string, request: ViewerRequest): ViewerResponse | null {
    const viewer = this.viewers.get(token);
    if (!viewer) return null;
    try {
      switch (viewer.kind) {
        case "file": return this.fileRoute(viewer, request);
        case "folder": return this.folderRoute(viewer, request);
        case "error":
          if (request.method !== "GET" || request.route !== "") return reply(404, "", TEXT, ERROR_CSP);
          return reply(200, errorViewerPage(viewer.target, viewer.message), HTML, ERROR_CSP);
      }
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, error.message, TEXT, cspOf(viewer));
      throw error;
    }
  }

  private fileRoute(viewer: Extract<Viewer, { kind: "file" }>, { method, route, body }: ViewerRequest): ViewerResponse {
    const name = viewerTitle(viewer.target);
    if (method === "POST") {
      if (route === "state") {
        const dirty = parseJson(body)?.dirty;
        if (typeof dirty !== "boolean") throw new HttpError(400);
        this.write(viewer.terminalId, stateSequence({ dirty }));
        return reply(200, "{}", JSON_TYPE, EDITOR_CSP);
      }
      if (route === "save" || (viewer.markdown && (route === "image" || route === "rename"))) {
        throw new HttpError(403, READ_ONLY_ERROR);
      }
      throw new HttpError(404);
    }
    if (route === "view") {
      return reply(200, instrumentHtml((viewer.markdown ? markdownPage : editorPage)(name), this.embedderOrigin()), HTML, EDITOR_CSP);
    }
    if (route === "source") {
      const text = this.fs.read(viewer.target);
      if (text === null) throw new HttpError(404);
      return reply(200, JSON.stringify({ text, version: "snapshot", name }), JSON_TYPE, EDITOR_CSP);
    }
    throw new HttpError(404);
  }

  private folderRoute(viewer: Extract<Viewer, { kind: "folder" }>, { method, route, search, body }: ViewerRequest): ViewerResponse {
    if (method === "POST") {
      if (route !== "select" && route !== "activate") throw new HttpError(404);
      const path = parseJson(body)?.path;
      if (typeof path !== "string" || !path) throw new HttpError(400);
      const target = this.inside(viewer.root, path);
      this.write(viewer.terminalId, openSequence({ path: target, preview: route === "select" }));
      return reply(200, JSON.stringify({ ok: true, status: "sent" }), JSON_TYPE, FOLDER_CSP);
    }
    if (route === "") {
      return reply(200, instrumentHtml(folderViewerPage(viewer.root), this.embedderOrigin()), HTML, FOLDER_CSP);
    }
    if (route === "list") {
      const dir = this.inside(viewer.root, new URLSearchParams(search).get("dir") ?? "");
      const entries = this.fs.list(dir);
      if (!entries) throw new HttpError(404, "not a directory");
      return reply(200, JSON.stringify({
        entries: entries.map(({ name, kind }) => ({ name: kind === "dir" ? this.fs.compacted(dir, name) : name, kind, ignored: false })),
        truncated: false,
      }), JSON_TYPE, FOLDER_CSP);
    }
    throw new HttpError(404);
  }

  /** The existing path the page-supplied POSIX `rel` names inside `root`. */
  private inside(root: string, rel: string): string {
    const parts = rel === "" ? [] : rel.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) throw new HttpError(403, "invalid path");
    const path = [root, ...parts].join("/");
    if (!this.fs.kind(path)) throw new HttpError(404, "no such entry");
    return path;
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message = "") { super(message); }
}

const cspOf = (viewer: Viewer): string =>
  viewer.kind === "file" ? EDITOR_CSP : viewer.kind === "folder" ? FOLDER_CSP : ERROR_CSP;

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** With the headers every real viewer response carries (`viewer-server.ts`). */
function reply(status: number, body: string, contentType: string, csp: string): ViewerResponse {
  return {
    status,
    body,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": csp,
    },
  };
}
