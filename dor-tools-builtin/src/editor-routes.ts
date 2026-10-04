/** The editor routes the Node file viewer (`file-viewer.ts`) and the website
 * playground's viewers both answer (docs/specs/dor-tools-builtin.md -> Editing
 * files, Markdown editor, Image editor): one route table per editor kind, over
 * an `EditorStore` that owns every filesystem check. Browser-safe. */
import { editorPage, imagePage, markdownPage } from './editor-page.js';
import type { FileFormat } from './file-viewer-format.js';
import {
  checkImageSave, EDIT_ROUTE, editableImageType, IMAGE_BOUND, IMAGE_CSP, IMAGE_SAVE_ROUTE, isImage, PASTE_ATTEMPTS, PASTE_BOUND,
  PASTE_EXHAUSTED_MESSAGE, pastedImageExtension, pastedImageName, type SizeBound, VERSION_HEADER,
} from './image-format.js';
import { HttpError, parseJsonBody, pathSegments } from './viewer-http.js';

export const TEXT_BOUND: SizeBound = { limit: 8 * 1024 * 1024, message: 'Text files are limited to 8 MiB.' };
/** A save whose revision is no longer the file's. */
export const STALE_MESSAGE = 'The file changed on disk. Your edits are safe here; compare or reload before saving.';
/** A save or read whose file is no longer at its path. */
export const PATH_CHANGED_MESSAGE = 'The file path changed. Reopen it before saving.';

/** Where an editor's files live. Paths are the store's own; each method
 * enforces its containment, and throws `HttpError` for a refusal. */
export interface EditorStore {
  /** A file's exact bytes and their sha256 revision; 413 with `bound.message` past `bound.limit`. */
  read(file: string, bound: SizeBound): Promise<{ bytes: Uint8Array; version: string }>;
  /** Replaces `file` with `encode` of its current bytes while its revision is
   * still `version` (409 `STALE_MESSAGE` otherwise), at most `bound.limit` bytes. */
  replace(file: string, version: string, bound: SizeBound, encode: (current: Uint8Array) => Uint8Array): Promise<{ version: string }>;
  /** The file at `segments` under the document's folder when it is an existing
   * file that may be replaced in place; else null. */
  editableImage(segments: string[]): Promise<string | null>;
  /** Writes `name` beside the document, never replacing; false when it exists. */
  create(name: string, bytes: Uint8Array): Promise<boolean>;
  /** Moves the file at `from` to `to`, both under the document's folder in
   * one directory, never replacing another file; false when `to` is taken. */
  rename(from: string[], to: string[]): Promise<boolean>;
}

/** One request to an editor, after its route was percent-decoded and passed `pathSegments`. */
export interface EditorRequest {
  method: string;
  route: string;
  query: URLSearchParams;
  /** The media type, as `mediaType` gives it. */
  contentType: string;
  /** The body's bytes; 413 with `bound.message` past `bound.limit`. */
  body(bound: SizeBound): Promise<Uint8Array>;
}

/** A 200 answer; a refusal throws `HttpError`. */
export interface EditorReply { body: string | Uint8Array; type: string; headers?: Record<string, string> }

export type EditorKind = 'text' | 'markdown' | 'image';

/** The editor `builtin:file` or `builtin:code` opens for `path` in `format`;
 * null when it only views it. */
export function editorKind(format: FileFormat, path: string): EditorKind | null {
  if (format.text) return format.markdown ? 'markdown' : 'text';
  return editableImageType(path) ? 'image' : null;
}

/** `route`, relative to the document's folder, as `/` segments when its
 * spelling stays inside that folder and names an image format; else 404. */
export function imageSegments(route: string): string[] {
  const segments = pathSegments(route, { strict: true });
  if (!segments || !isImage(route)) throw new HttpError(404);
  return segments;
}

/** Refuses a rename of `from` to `to` (as `imageSegments` gives them, so
 * without controls) unless `to` is in the same directory and not hidden. */
export function checkImageRename(from: string[], to: string[]): void {
  if (from.slice(0, -1).join('/') !== to.slice(0, -1).join('/') || to[to.length - 1].startsWith('.')) {
    throw new HttpError(400, 'Choose a new image name in the same folder.');
  }
}

/** The document as text and its revision; 415 unless UTF-8, whose BOM is
 * dropped here and restored by `saveText`. */
export async function readText(store: EditorStore, file: string): Promise<{ text: string; version: string }> {
  const { bytes, version } = await store.read(file, TEXT_BOUND);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), version }; }
  catch { throw new HttpError(415, 'This editor supports UTF-8 text. Open this file in another editor.'); }
}

/** Saves `text` over `file` at `version`, keeping the file's BOM and majority
 * line ending (mixed endings normalize to it; a file without line breaks keeps
 * `text`'s own). */
export function saveText(store: EditorStore, file: string, text: string, version: string): Promise<{ version: string }> {
  return store.replace(file, version, TEXT_BOUND, current => {
    let lines = 0, crlf = 0;
    for (let i = 0; i < current.length; i++) if (current[i] === 0x0a) { lines++; if (current[i - 1] === 0x0d) crlf++; }
    const body = !lines ? text : crlf * 2 > lines ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
    const bom = current[0] === 0xef && current[1] === 0xbb && current[2] === 0xbf;
    return new TextEncoder().encode((bom ? '﻿' : '') + body);
  });
}

/** Writes a pasted image beside the document as a new file, never replacing
 * one, and returns its name: `image-YYYYMMDD-HHMMSS[-N].<ext>`. */
export async function pasteImage(store: Pick<EditorStore, 'create'>, type: string, bytes: Uint8Array, now = new Date()): Promise<string> {
  const ext = pastedImageExtension(type, bytes);
  for (let n = 1; n <= PASTE_ATTEMPTS; n++) {
    const name = pastedImageName(now, n, ext);
    if (await store.create(name, bytes)) return name;
  }
  throw new HttpError(409, PASTE_EXHAUSTED_MESSAGE);
}

const json = (value: unknown): EditorReply => ({ body: JSON.stringify(value), type: 'application/json' });
/** An editable image's bytes, which never run as a document, and their revision. */
const image = ({ bytes, version }: { bytes: Uint8Array; version: string }, mime: string): EditorReply =>
  ({ body: bytes, type: mime, headers: { 'Content-Security-Policy': IMAGE_CSP, [VERSION_HEADER]: version } });

/** A POST's JSON body, as `parseJsonBody` reads it. */
const jsonBody = (request: EditorRequest, limit: number) =>
  parseJsonBody(request.contentType, limit, bound => request.body({ limit: bound, message: '' })) as Promise<Record<string, unknown> | null>;

/** The routes of one editor over `file`, the document it opened (titled
 * `name`); null for a route it does not answer, which the caller may. */
export function editorRoutes({ kind, file, name, store, onDirty }: {
  kind: EditorKind;
  file: string;
  name: string;
  store: EditorStore;
  onDirty(dirty: boolean): void;
}): (request: EditorRequest) => Promise<EditorReply | null> {
  const mime = editableImageType(file);
  let saving = false;
  /** One save at a time per editor. */
  const save = async <T>(write: () => Promise<T>): Promise<T> => {
    if (saving) throw new HttpError(409, 'Another save is in progress.');
    saving = true;
    try { return await write(); } finally { saving = false; }
  };
  /** A PNG or JPEG under the document's folder, replaceable in place. */
  const editableImage = async (route: string): Promise<{ path: string; mime: string }> => {
    const segments = imageSegments(route);
    const type = editableImageType(route);
    if (!type) throw new HttpError(415, 'Only PNG and JPEG images can be edited.');
    const path = await store.editableImage(segments);
    if (path === null) throw new HttpError(404);
    return { path, mime: type };
  };
  return async request => {
    const { route } = request;
    // An image save names the revision it replaces; its body is the image's bytes,
    // typed by Content-Type.
    const imageSave = async (target: () => Promise<{ path: string; mime: string }>) => {
      const bytes = await request.body(IMAGE_BOUND);
      const version = request.query.get('version');
      if (!version) throw new HttpError(400);
      return json(await save(async () => {
        const { path, mime } = await target();
        checkImageSave(mime, request.contentType, bytes);
        return store.replace(path, version, IMAGE_BOUND, () => bytes);
      }));
    };
    if (request.method === 'POST') {
      if (kind === 'markdown' && route === 'image') {
        const bytes = await request.body(PASTE_BOUND);
        return json({ name: await pasteImage(store, request.contentType, bytes) });
      }
      if (kind === 'markdown' && route === 'rename') {
        const data = await jsonBody(request, 64 * 1024);
        if (typeof data?.from !== 'string' || typeof data?.to !== 'string') throw new HttpError(400);
        const from = imageSegments(data.from);
        const to = imageSegments(data.to);
        checkImageRename(from, to);
        if (!await store.rename(from, to)) throw new HttpError(409, `${to[to.length - 1]} already exists.`);
        return json({});
      }
      if (kind === 'markdown' && route.startsWith(IMAGE_SAVE_ROUTE)) return imageSave(() => editableImage(route.slice(IMAGE_SAVE_ROUTE.length)));
      if (kind === 'image' && route === 'save') return imageSave(async () => ({ path: file, mime: mime! }));
      if (route !== 'save' && route !== 'state') throw new HttpError(404);
      // JSON escapes a byte as at most six (`\u00XX`).
      const data = await jsonBody(request, TEXT_BOUND.limit * 6 + 1024);
      if (route === 'state') {
        if (typeof data?.dirty !== 'boolean') throw new HttpError(400);
        onDirty(data.dirty);
        return json({});
      }
      if (typeof data?.text !== 'string' || typeof data?.version !== 'string') throw new HttpError(400);
      const { text, version } = data;
      return json(await save(() => saveText(store, file, text, version)));
    }
    if (route === 'view') {
      return { body: (kind === 'image' ? imagePage : kind === 'markdown' ? markdownPage : editorPage)(name), type: 'text/html; charset=utf-8' };
    }
    if (route === 'source') return kind === 'image' ? image(await store.read(file, IMAGE_BOUND), mime!) : json({ ...await readText(store, file), name });
    if (kind === 'markdown' && route.startsWith(EDIT_ROUTE)) {
      const { path, mime } = await editableImage(route.slice(EDIT_ROUTE.length));
      return image(await store.read(path, IMAGE_BOUND), mime);
    }
    return null;
  };
}
