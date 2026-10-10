/**
 * The desktop playground's stand-in for the built-in viewer processes
 * (docs/specs/tutorial.md -> Playground filesystem): the same pages and routes
 * `dor-tools-builtin/src/{file,folder,error}-viewer.ts` serve, answered from
 * the read-only snapshot and reached through the `/playground-fs/` service
 * worker rather than a loopback port.
 */
import { EDITOR_CSP, editorPage, markdownPage } from "dor-tools-builtin/editor-page";
import { ERROR_CSP, errorViewerPage } from "dor-tools-builtin/error-viewer-page";
import { builtinHandler, VIEW_ERROR_ARGV, viewerTitle } from "dor-tools-builtin/file-viewer-format";
import { FOLDER_CSP, folderViewerPage } from "dor-tools-builtin/folder-viewer-page";
import { HttpError, pathSegments, viewerHeaders } from "dor-tools-builtin/viewer-http";
import { openSequence, stateSequence } from "dor-tools-lib/osc";
import { instrumentHtml } from "dormouse-lib/host/iframe-proxy-rewrite";
import { isRecord } from "dormouse-lib/lib/is-record";
import type { VirtualFs } from "./vfs";

/** Every viewer URL starts here; the service worker's scope. */
export const VIEWER_SCOPE = "/playground-fs/";

export const READ_ONLY_ERROR = "This playground's files are read-only.";

export interface ViewerRequest {
  method: string;
  /** The path after `/playground-fs/<token>/`, percent-decoded. */
  route: string;
  /** The request URL's query string (`url.search`), `?` included. */
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

const CSP: Record<Viewer["kind"], string> = { file: EDITOR_CSP, folder: FOLDER_CSP, error: ERROR_CSP };

/** A started viewer: the token its URLs carry, and what `serveSequence` announces. */
export interface ViewerAnnouncement { token: string; path: string; target: string }

type Reply = { status: number; body: string; type: string };
const reply = (status: number, body: string, type: string): Reply => ({ status, body, type });
const json = (value: unknown): Reply => reply(200, JSON.stringify(value), "application/json");
const html = (page: string): Reply => reply(200, page, "text/html; charset=utf-8");

/** One window's viewers, keyed by an unguessable token in their URL. */
export class PlaygroundViewers {
  private readonly viewers = new Map<string, Viewer>();

  constructor(
    private readonly fs: VirtualFs,
    /** Writes to a viewer's terminal as its process's stdout would. */
    private readonly write: (terminalId: string, data: string) => void,
    /** The Wall's origin, which the instrumented pages report to. */
    private readonly embedderOrigin: string,
  ) {}

  /** Starts the viewer `dor <verb> <args…>` runs in `terminalId`, or names why it cannot. */
  open(terminalId: string, verb: string, [input = "", message = ""]: string[], cwd: string): ViewerAnnouncement | Error {
    if (verb === VIEW_ERROR_ARGV) return this.add({ terminalId, kind: "error", target: input, message }, "", input);
    const handler = builtinHandler("argv", verb);
    const target = this.fs.resolve(cwd, input);
    const kind = target === null ? null : this.fs.kind(target);
    if (!handler || target === null || !kind) return new Error(`no such file or folder: ${input}`);
    if (handler.opens === "folder") {
      return kind === "dir" ? this.add({ terminalId, kind: "folder", root: target }, "", target) : new Error("not a directory");
    }
    if (kind !== "file") return new Error(`not a file: ${input}`);
    const format = handler.format(target);
    if (!format) return new Error("unsupported file format; configure a user Tool association");
    // The snapshot holds only text; the HTML, image, and media routes have nothing to serve.
    if (!format.text) return new Error("the playground's file viewer shows text files only");
    return this.add({ terminalId, kind: "file", target, markdown: !!format.markdown }, "view", target);
  }

  close(token: string): void {
    this.viewers.delete(token);
  }

  private add(viewer: Viewer, page: string, target: string): ViewerAnnouncement {
    const token = crypto.randomUUID();
    this.viewers.set(token, viewer);
    return { token, path: `${VIEWER_SCOPE}${token}/${page}`, target };
  }

  /** The answer for one request to `token`'s viewer, or null when this window has none. */
  handle(token: string, request: ViewerRequest): ViewerResponse | null {
    const viewer = this.viewers.get(token);
    if (!viewer) return null;
    let answer: Reply;
    try {
      answer = viewer.kind === "file" ? this.fileRoute(viewer, request)
        : viewer.kind === "folder" ? this.folderRoute(viewer, request)
        : request.method === "GET" && request.route === "" ? html(errorViewerPage(viewer.target, viewer.message))
        : reply(404, "", "text/plain; charset=utf-8");
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      answer = reply(error.status, error.message, "text/plain; charset=utf-8");
    }
    return { status: answer.status, body: answer.body, headers: { "Content-Type": answer.type, ...viewerHeaders(CSP[viewer.kind]) } };
  }

  private fileRoute(viewer: Extract<Viewer, { kind: "file" }>, { method, route, body }: ViewerRequest): Reply {
    const name = viewerTitle(viewer.target);
    if (method === "POST") {
      if (route === "state") {
        const dirty = parseJson(body)?.dirty;
        if (typeof dirty !== "boolean") throw new HttpError(400);
        this.write(viewer.terminalId, stateSequence({ dirty }));
        return json({});
      }
      if (route === "save" || (viewer.markdown && (route === "image" || route === "rename"))) {
        throw new HttpError(403, READ_ONLY_ERROR);
      }
      throw new HttpError(404);
    }
    if (route === "view") return html(instrumentHtml((viewer.markdown ? markdownPage : editorPage)(name), this.embedderOrigin));
    if (route === "source") return json({ text: this.fs.read(viewer.target), version: "snapshot", name });
    throw new HttpError(404);
  }

  private folderRoute(viewer: Extract<Viewer, { kind: "folder" }>, { method, route, search, body }: ViewerRequest): Reply {
    if (method === "POST") {
      if (route !== "select" && route !== "activate") throw new HttpError(404);
      const path = parseJson(body)?.path;
      if (typeof path !== "string" || !path) throw new HttpError(400);
      this.write(viewer.terminalId, openSequence({ path: this.inside(viewer.root, path), preview: route === "select" }));
      return json({ ok: true, status: "sent" });
    }
    if (route === "") return html(instrumentHtml(folderViewerPage(viewer.root), this.embedderOrigin));
    if (route !== "list") throw new HttpError(404);
    const dir = this.inside(viewer.root, new URLSearchParams(search).get("dir") ?? "");
    const entries = this.fs.list(dir);
    if (!entries) throw new HttpError(404, "not a directory");
    return json({
      entries: entries.map(({ name, kind }) => ({ name: kind === "dir" ? this.fs.compacted(dir, name) : name, kind, ignored: false })),
      truncated: false,
    });
  }

  /** The existing path the page-supplied POSIX `rel` names inside `root`. */
  private inside(root: string, rel: string): string {
    const parts = rel === "" ? [] : pathSegments(rel, { strict: true });
    if (!parts) throw new HttpError(403, "invalid path");
    const path = [root, ...parts].join("/");
    if (!this.fs.kind(path)) throw new HttpError(404, "no such entry");
    return path;
  }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
