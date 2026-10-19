/**
 * The desktop playground's stand-in for the built-in viewer processes
 * (docs/specs/tutorial.md -> Playground filesystem): the same pages and routes
 * `dor-tools-builtin/src/{file,folder,error}-viewer.ts` serve, answered from
 * the window's in-memory filesystem and reached through the `/playground-fs/`
 * service worker rather than a loopback port.
 */
import { EDITOR_CSP } from "dor-tools-builtin/editor-page";
import {
  editorKind, editorRoutes, imagesRoute, PATH_CHANGED_MESSAGE, STALE_MESSAGE, storePath,
  type EditorKind, type EditorReply, type EditorRequest, type EditorStore,
} from "dor-tools-builtin/editor-routes";
import { ERROR_CSP, errorViewerPage } from "dor-tools-builtin/error-viewer-page";
import { builtinHandler, editableImageType, fileViewerFormat, VIEW_ERROR_ARGV, viewerTitle } from "dor-tools-builtin/file-viewer-format";
import { FOLDER_BODY_LIMIT, FOLDER_CSP, folderViewerPage } from "dor-tools-builtin/folder-viewer-page";
import { imageEditability } from "dor-tools-builtin/image-editability";
import { IMAGE_CSP, type SizeBound } from "dor-tools-builtin/image-format";
import { HttpError, mediaType, parseJsonBody, pathSegments, viewerHeaders } from "dor-tools-builtin/viewer-http";
import { openSequence, stateSequence } from "dor-tools-lib/osc";
import { instrumentHtml } from "dormouse-lib/host/iframe-proxy-rewrite";
import { bytesOf, parentOf, type FileData, type VirtualFs } from "./vfs";

/** Every viewer URL starts here; the service worker's scope. */
export const VIEWER_SCOPE = "/playground-fs/";

/** One viewer request, as the service worker relays it. */
export interface ViewerRequest {
  method: string;
  /** The path after `/playground-fs/<token>/`, percent-decoded. */
  route: string;
  /** The request URL's query string (`url.search`), `?` included. */
  search: string;
  /** The request's `Content-Type` header, as sent. */
  contentType: string;
  /** The request body; empty for a GET. A `Blob` crosses to every window by reference. */
  body: Blob;
}

/** The answer the service worker turns into a `Response`. */
export interface ViewerResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Blob;
}

type Viewer = { terminalId: string } & (
  | { kind: "editor"; editor: EditorKind; root: string; routes: ReturnType<typeof editorRoutes> }
  | { kind: "folder"; root: string }
  | { kind: "error"; target: string; message: string }
);

const CSP: Record<Viewer["kind"], string> = { editor: EDITOR_CSP, folder: FOLDER_CSP, error: ERROR_CSP };

/** A started viewer: the token its URLs carry, and what `serveSequence` announces. */
export interface ViewerAnnouncement { token: string; path: string; target: string }

type Reply = EditorReply & { status: number };
const reply = (status: number, body: string | Uint8Array, type: string): Reply => ({ status, body, type });
const json = (value: unknown): Reply => reply(200, JSON.stringify(value), "application/json");
const html = (page: string): Reply => reply(200, page, "text/html; charset=utf-8");

/** The sha256 revision of `bytes`, as the Node viewers report it. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A request body's bytes; 413 with `message` past `limit`, as the Node viewers' `readBody`. */
async function bodyBytes(body: Blob, limit: number, message = ""): Promise<Uint8Array> {
  if (body.size > limit) throw new HttpError(413, message);
  return new Uint8Array(await body.arrayBuffer());
}

/** One window's viewers, keyed by an unguessable token in their URL. */
export class PlaygroundViewers {
  private readonly viewers = new Map<string, Viewer>();
  private readonly pasteListeners = new Set<() => void>();
  /** The revision of each stored value as hashed, so a save hashes only its new bytes;
   * a replaced buffer's entry goes with it. Strings are the stock tree's. */
  private readonly byteRevisions = new WeakMap<Uint8Array, string>();
  private readonly textRevisions = new Map<string, string>();

  constructor(
    private readonly fs: VirtualFs,
    /** Writes to a viewer's terminal as its process's stdout would. */
    private readonly write: (terminalId: string, data: string) => void,
    /** The Wall's origin, which the instrumented pages report to. */
    private readonly embedderOrigin: string,
  ) {}

  /** Calls `listener` each time a Markdown viewer accepts a pasted image. */
  subscribeToPastes(listener: () => void): () => void {
    this.pasteListeners.add(listener);
    return () => this.pasteListeners.delete(listener);
  }

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
    const bytes = editableImageType(target) ? this.fs.bytes(target) : null;
    const editor = editorKind(format, bytes && imageEditability(bytes.length, bytes));
    // The HTML, media, and view-only image routes are not served here.
    if (!editor) return new Error("the playground's file viewer shows only text and the PNG and JPEG files the image editor opens");
    const root = parentOf(target);
    const routes = editorRoutes({
      kind: editor, file: storePath(target), name: viewerTitle(target), store: this.store(root),
      onDirty: (dirty) => this.write(terminalId, stateSequence({ dirty })),
      openLink: (link, disposition) => {
        const path = link.path ? this.fs.resolve(root, link.path) : target;
        if (path === null) throw new HttpError(400, "Invalid document path");
        this.write(terminalId, openSequence({ path, disposition, fragment: link.fragment }));
      },
    });
    return this.add({ terminalId, kind: "editor", editor, root, routes }, "view", target);
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
  async handle(token: string, request: ViewerRequest): Promise<ViewerResponse | null> {
    const viewer = this.viewers.get(token);
    if (!viewer) return null;
    let answer: Reply;
    try {
      answer = viewer.kind === "editor" ? await this.editorRoute(viewer, request)
        : viewer.kind === "folder" ? await this.folderRoute(viewer, request)
        : request.method === "GET" && request.route === "" ? html(errorViewerPage(viewer.target, viewer.message))
        : reply(404, "", "text/plain; charset=utf-8");
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      answer = reply(error.status, error.message, "text/plain; charset=utf-8");
    }
    // A Blob copies the bytes once, so a stored file's bytes never leave the window.
    const body = typeof answer.body === "string" ? answer.body : new Blob([answer.body as Uint8Array<ArrayBuffer>]);
    return { status: answer.status, body, headers: { ...viewerHeaders(CSP[viewer.kind]), "Content-Type": answer.type, ...answer.headers } };
  }

  /** The editor's own routes (`editorRoutes`), then the Markdown editor's images. */
  private async editorRoute(viewer: Extract<Viewer, { kind: "editor" }>, { method, route, search, contentType, body }: ViewerRequest): Promise<Reply> {
    const request: EditorRequest = {
      method, route, query: new URLSearchParams(search), contentType: mediaType(contentType),
      body: (bound: SizeBound) => bodyBytes(body, bound.limit, bound.message),
    };
    const answer = await viewer.routes(request);
    if (answer) {
      const { body } = answer;
      return { status: 200, ...answer, body: typeof body === "string" && answer.type.startsWith("text/html") ? instrumentHtml(body, this.embedderOrigin) : body };
    }
    const segments = imagesRoute(viewer.editor, route);
    if (!segments) throw new HttpError(404);
    const path = [viewer.root, ...segments].join("/");
    const bytes = this.fs.bytes(path);
    if (!bytes) throw new HttpError(404);
    // An image the Markdown editor shows never runs as a document.
    return { ...reply(200, bytes, fileViewerFormat(path)!.mime), headers: { "Content-Security-Policy": IMAGE_CSP } };
  }

  /** The window's filesystem as an editor's store, for a document in `root`. */
  private store(root: string): EditorStore {
    const { fs } = this;
    const under = (segments: string[]) => [root, ...segments].join("/");
    /** `file`'s data and bytes, `missing` when it is gone, 413 past `bound`. */
    const current = (file: string, bound: SizeBound, missing: HttpError) => {
      const data = fs.data(file);
      if (data === null) throw missing;
      const bytes = bytesOf(data);
      if (bytes.length > bound.limit) throw new HttpError(413, bound.message);
      return { data, bytes };
    };
    return {
      read: async (file, bound) => {
        const { data, bytes } = current(file, bound, new HttpError(404));
        return { bytes, version: await this.revision(data, bytes) };
      },
      replace: async (file, version, bound, encode) => {
        const { data: before, bytes } = current(file, bound, new HttpError(409, PATH_CHANGED_MESSAGE));
        if (await this.revision(before, bytes) !== version) throw new HttpError(409, STALE_MESSAGE);
        const next = encode(bytes);
        if (next.length > bound.limit) throw new HttpError(413, bound.message);
        const nextVersion = await this.revision(next, next);
        // A save that landed while this one hashed wins; this one is now stale.
        if (fs.data(file) !== before) throw new HttpError(409, STALE_MESSAGE);
        fs.write(file, next);
        return { version: nextVersion };
      },
      create: async (name, bytes) => {
        if (fs.kind(under([name]))) return false;
        fs.write(under([name]), bytes);
        for (const listener of this.pasteListeners) listener();
        return true;
      },
      rename: async (from, to) => {
        const source = under(from), target = under(to);
        if (fs.kind(source) !== "file") throw new HttpError(404);
        if (source === target) return true;
        if (fs.kind(target)) return false;
        fs.rename(source, target);
        return true;
      },
    };
  }

  /** The sha256 revision of the stored `data`, whose bytes are `bytes`, hashed once per stored value. */
  private async revision(data: FileData, bytes: Uint8Array): Promise<string> {
    const cached = typeof data === "string" ? this.textRevisions.get(data) : this.byteRevisions.get(data);
    if (cached !== undefined) return cached;
    const version = await sha256(bytes);
    if (typeof data === "string") this.textRevisions.set(data, version);
    else this.byteRevisions.set(data, version);
    return version;
  }

  private async folderRoute(viewer: Extract<Viewer, { kind: "folder" }>, { method, route, search, contentType, body }: ViewerRequest): Promise<Reply> {
    if (method === "POST") {
      if (route !== "select" && route !== "activate") throw new HttpError(404);
      const data = await parseJsonBody(mediaType(contentType), FOLDER_BODY_LIMIT, (limit) => bodyBytes(body, limit));
      const path = (data as { path?: unknown } | null)?.path;
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
