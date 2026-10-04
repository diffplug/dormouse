/**
 * The desktop playground's stand-in for the built-in viewer processes
 * (docs/specs/tutorial.md -> Playground filesystem): the same pages and routes
 * `dor-tools-builtin/src/{file,folder,error}-viewer.ts` serve, answered from
 * the window's in-memory filesystem and reached through the `/playground-fs/`
 * service worker rather than a loopback port.
 */
import { EDITOR_CSP, editorPage, imagePage, markdownPage } from "dor-tools-builtin/editor-page";
import { ERROR_CSP, errorViewerPage } from "dor-tools-builtin/error-viewer-page";
import { builtinHandler, CONTROLS, fileViewerFormat, VIEW_ERROR_ARGV, viewerTitle } from "dor-tools-builtin/file-viewer-format";
import { FOLDER_CSP, folderViewerPage } from "dor-tools-builtin/folder-viewer-page";
import {
  checkImageSave, editableImageType, IMAGE_CSP, IMAGE_LIMIT, IMAGE_LIMIT_MESSAGE, isImage, PASTE_ATTEMPTS,
  PASTE_EXHAUSTED_MESSAGE, PASTE_LIMIT_MESSAGE, pastedImageExtension, pastedImageName, VERSION_HEADER,
} from "dor-tools-builtin/image-format";
import { HttpError, pathSegments, viewerHeaders } from "dor-tools-builtin/viewer-http";
import { openSequence, stateSequence } from "dor-tools-lib/osc";
import { instrumentHtml } from "dormouse-lib/host/iframe-proxy-rewrite";
import { isRecord } from "dormouse-lib/lib/is-record";
import type { FileData, VirtualFs } from "./vfs";

/** Every viewer URL starts here; the service worker's scope. */
export const VIEWER_SCOPE = "/playground-fs/";

/** One viewer request, as the service worker relays it. */
export interface ViewerRequest {
  method: string;
  /** The path after `/playground-fs/<token>/`, percent-decoded. */
  route: string;
  /** `URLSearchParams` of the request URL. */
  search: string;
  /** The request's `Content-Type` header, as sent. */
  contentType: string;
  /** The request body's bytes; empty for a GET. */
  body: ArrayBuffer;
}

/** The answer the service worker turns into a `Response`; a binary body is
 * an `ArrayBuffer` the window may transfer. */
export interface ViewerResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

type Viewer = { terminalId: string } & (
  | { kind: "file"; target: string; markdown: boolean }
  | { kind: "image"; target: string; mime: string }
  | { kind: "folder"; root: string }
  | { kind: "error"; target: string; message: string }
);

const CSP: Record<Viewer["kind"], string> = { file: EDITOR_CSP, image: EDITOR_CSP, folder: FOLDER_CSP, error: ERROR_CSP };

/** A started viewer: the token its URLs carry, and what `serveSequence` announces. */
export interface ViewerAnnouncement { token: string; path: string; target: string }

type Reply = { status: number; body: string | Uint8Array; type: string; headers?: Record<string, string> };
const reply = (status: number, body: string | Uint8Array, type: string): Reply => ({ status, body, type });
const json = (value: unknown): Reply => reply(200, JSON.stringify(value), "application/json");
const html = (page: string): Reply => reply(200, page, "text/html; charset=utf-8");
/** An image's bytes, which never run as a document, with their revision when editable. */
const image = (bytes: Uint8Array, mime: string, version?: string): Reply =>
  ({ ...reply(200, bytes, mime), headers: { "Content-Security-Policy": IMAGE_CSP, ...version && { [VERSION_HEADER]: version } } });

const STALE = "The file changed on disk. Your edits are safe here; compare or reload before saving.";

/** The sha256 revision of `data` as its bytes, as the Node viewers report it. */
async function revision(data: FileData): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One window's viewers, keyed by an unguessable token in their URL. */
export class PlaygroundViewers {
  private readonly viewers = new Map<string, Viewer>();
  private readonly pasteListeners = new Set<() => void>();

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
    if (format.text) return this.add({ terminalId, kind: "file", target, markdown: !!format.markdown }, "view", target);
    const mime = editableImageType(target);
    // The HTML, media, and view-only image routes are not served here.
    if (!mime) return new Error("the playground's file viewer shows text, PNG, and JPEG files only");
    return this.add({ terminalId, kind: "image", target, mime }, "view", target);
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
      answer = viewer.kind === "file" ? await this.fileRoute(viewer, request)
        : viewer.kind === "image" ? await this.imageRoute(viewer, request)
        : viewer.kind === "folder" ? this.folderRoute(viewer, request)
        : request.method === "GET" && request.route === "" ? html(errorViewerPage(viewer.target, viewer.message))
        : reply(404, "", "text/plain; charset=utf-8");
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      answer = reply(error.status, error.message, "text/plain; charset=utf-8");
    }
    // A copy, so transferring the answer never detaches a file's stored bytes.
    const body = typeof answer.body === "string" ? answer.body : answer.body.slice().buffer;
    return { status: answer.status, body, headers: { ...viewerHeaders(CSP[viewer.kind]), "Content-Type": answer.type, ...answer.headers } };
  }

  /** `POST state`, which every editor reports its dirty state through. */
  private state(viewer: { terminalId: string }, body: ArrayBuffer): Reply {
    const dirty = parseJson(body)?.dirty;
    if (typeof dirty !== "boolean") throw new HttpError(400);
    this.write(viewer.terminalId, stateSequence({ dirty }));
    return json({});
  }

  private async fileRoute(viewer: Extract<Viewer, { kind: "file" }>, { method, route, search, contentType, body }: ViewerRequest): Promise<Reply> {
    const name = viewerTitle(viewer.target);
    const root = parentOf(viewer.target);
    if (method === "POST") {
      if (route === "state") return this.state(viewer, body);
      if (route === "save") {
        const data = parseJson(body);
        if (typeof data?.text !== "string" || typeof data?.version !== "string") throw new HttpError(400);
        return json(await this.replace(viewer.target, data.version, data.text));
      }
      if (!viewer.markdown) throw new HttpError(404);
      if (route === "image") return json({ name: this.paste(root, mediaType(contentType), bounded(body, PASTE_LIMIT_MESSAGE)) });
      if (route === "rename") {
        const data = parseJson(body);
        if (typeof data?.from !== "string" || typeof data?.to !== "string") throw new HttpError(400);
        this.renameImage(root, data.from, data.to);
        return json({});
      }
      if (route.startsWith("image-save/")) {
        const { path, mime } = this.editableImageIn(root, route.slice("image-save/".length));
        return json(await this.saveImage(path, mime, contentType, body, search));
      }
      throw new HttpError(404);
    }
    if (route === "view") return html(instrumentHtml((viewer.markdown ? markdownPage : editorPage)(name), this.embedderOrigin));
    if (route === "source") {
      const data = this.fs.data(viewer.target);
      if (data === null) throw new HttpError(404);
      return json({ text: utf8(data), version: await revision(data), name });
    }
    if (viewer.markdown && route.startsWith("edit/")) {
      const { path, mime } = this.editableImageIn(root, route.slice("edit/".length));
      const bytes = this.fs.bytes(path)!;
      return image(bytes, mime, await revision(bytes));
    }
    if (viewer.markdown && route.startsWith("images/")) {
      const path = this.imageIn(root, route.slice("images/".length));
      if (this.fs.kind(path) !== "file") throw new HttpError(404);
      return image(this.fs.bytes(path)!, fileViewerFormat(path)!.mime);
    }
    throw new HttpError(404);
  }

  /** The standalone image editor's page, its pixels, and their save. */
  private async imageRoute(viewer: Extract<Viewer, { kind: "image" }>, { method, route, search, contentType, body }: ViewerRequest): Promise<Reply> {
    if (method === "POST") {
      if (route === "state") return this.state(viewer, body);
      if (route === "save") return json(await this.saveImage(viewer.target, viewer.mime, contentType, body, search));
      throw new HttpError(404);
    }
    if (route === "view") return html(instrumentHtml(imagePage(viewerTitle(viewer.target)), this.embedderOrigin));
    if (route === "source") {
      const bytes = this.fs.bytes(viewer.target);
      if (!bytes) throw new HttpError(404);
      return image(bytes, viewer.mime, await revision(bytes));
    }
    throw new HttpError(404);
  }

  /** Replaces `path` with `next` when its revision is still `version`. */
  private async replace(path: string, version: string, next: FileData): Promise<{ version: string }> {
    const before = this.fs.data(path);
    if (before === null) throw new HttpError(409, "The file path changed. Reopen it before saving.");
    if (await revision(before) !== version) throw new HttpError(409, STALE);
    const nextVersion = await revision(next);
    // A save that landed while this one hashed wins; this one is now stale.
    if (this.fs.data(path) !== before) throw new HttpError(409, STALE);
    this.fs.write(path, next);
    return { version: nextVersion };
  }

  /** An image save: the editable image's own bytes, typed by Content-Type, over `?version=`. */
  private saveImage(path: string, mime: string, contentType: string, body: ArrayBuffer, search: string): Promise<{ version: string }> {
    const bytes = bounded(body, IMAGE_LIMIT_MESSAGE);
    const version = new URLSearchParams(search).get("version");
    if (!version) throw new HttpError(400);
    checkImageSave(mime, mediaType(contentType), bytes);
    return this.replace(path, version, bytes);
  }

  /** Writes a pasted image beside the document as a new file, as `writePastedImage` names it. */
  private paste(root: string, type: string, bytes: Uint8Array): string {
    const ext = pastedImageExtension(type, bytes);
    const now = new Date();
    for (let n = 1; n <= PASTE_ATTEMPTS; n++) {
      const name = pastedImageName(now, n, ext);
      if (this.fs.kind(`${root}/${name}`)) continue;
      this.fs.write(`${root}/${name}`, bytes);
      for (const listener of this.pasteListeners) listener();
      return name;
    }
    throw new HttpError(409, PASTE_EXHAUSTED_MESSAGE);
  }

  /** `route`, relative to `root`, as a path when its spelling stays inside `root` and names an image; else 404. */
  private imageIn(root: string, route: string): string {
    if (!pathSegments(route, { strict: true }) || !isImage(route)) throw new HttpError(404);
    return `${root}/${route}`;
  }

  /** An existing PNG or JPEG at or under `root`. */
  private editableImageIn(root: string, route: string): { path: string; mime: string } {
    const path = this.imageIn(root, route);
    const mime = editableImageType(path);
    if (!mime) throw new HttpError(415, "Only PNG and JPEG images can be edited.");
    if (this.fs.kind(path) !== "file") throw new HttpError(404);
    return { path, mime };
  }

  /** Renames an image within its own directory, never replacing another file, as `renameImage`. */
  private renameImage(root: string, from: string, to: string): void {
    const source = this.imageIn(root, from);
    const target = this.imageIn(root, to);
    const name = target.slice(target.lastIndexOf("/") + 1);
    if (parentOf(source) !== parentOf(target) || CONTROLS.test(name) || name.startsWith(".")) {
      throw new HttpError(400, "Choose a new image name in the same folder.");
    }
    if (this.fs.kind(source) !== "file") throw new HttpError(404);
    if (source === target) return;
    if (this.fs.kind(target)) throw new HttpError(409, `${name} already exists.`);
    this.fs.rename(source, target);
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

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** A Content-Type without parameters, lowercased, as `contentType` in `viewer-server.ts`. */
const mediaType = (header: string) => header.split(";")[0].trim().toLowerCase();

/** `body` as bytes, or 413 past one image's bound. */
function bounded(body: ArrayBuffer, message: string): Uint8Array {
  if (body.byteLength > IMAGE_LIMIT) throw new HttpError(413, message);
  return new Uint8Array(body);
}

/** A file's contents as text; 415 when stored bytes are not UTF-8, as `readEditableFile`. */
function utf8(data: FileData): string {
  if (typeof data === "string") return data;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { throw new HttpError(415, "This editor supports UTF-8 text. Open this file in another editor."); }
}

function parseJson(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
