/** The editor routes the Node file viewer (`file-viewer.ts`) and the website
 * playground's viewers both answer (docs/specs/dor-tools-builtin.md -> Editing
 * files, Markdown editor, Image editor): one route table per editor kind, over
 * an `EditorStore` that owns every filesystem check. Browser-safe. */
import { editorPage, imagePage, markdownPage } from './editor-page.js';
import { editableImageType, type FileFormat } from './file-viewer-format.js';
import type { Editability } from './image-editability.js';
import { defaultDisplayWidth } from './image-resolution.js';
import {
  checkImageSave, IMAGE_BOUND, IMAGE_CSP, IMAGES_ROUTE, isImage, PASTE_ATTEMPTS, PASTE_BOUND,
  PASTE_EXHAUSTED_MESSAGE, pastedImageExtension, pastedImageName, type SizeBound, VERSION_HEADER,
} from './image-format.js';
import { HttpError, parseJsonBody, pathSegments } from './viewer-http.js';
import { markdownLink } from './markdown-links.js';

export const TEXT_BOUND: SizeBound = { limit: 8 * 1024 * 1024, message: 'Text files are limited to 8 MiB.' };
/** A save whose revision is no longer the file's. */
export const STALE_MESSAGE = 'The file changed on disk. Your edits are safe here; compare or reload before saving.';
/** A save or read whose file is no longer at its path. */
export const PATH_CHANGED_MESSAGE = 'The file path changed. Reopen it before saving.';
/** A path an `EditorStore` reads or replaces, which only `storePath` mints. */
export type StorePath = string & { readonly __storePath: unique symbol };
/** Mints a `StorePath` for the document a host opened. Never a page-supplied
 * path, so writes reach nothing else. */
export const storePath = (path: string): StorePath => path as StorePath;

/** The opened file and bounded image creation/rename operations beside it. */
export interface EditorStore {
  /** A file's exact bytes and their sha256 revision; 413 with `bound.message` past `bound.limit`. */
  read(file: StorePath, bound: SizeBound): Promise<{ bytes: Uint8Array; version: string }>;
  /** Replaces `file` with `encode` of its current bytes while its revision is
   * still `version` (409 `STALE_MESSAGE` otherwise), at most `bound.limit` bytes. */
  replace(file: StorePath, version: string, bound: SizeBound, encode: (current: Uint8Array) => Uint8Array): Promise<{ version: string }>;
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

/** The editor `builtin:file` or `builtin:code` opens for a file in `format`,
 * whose `imageEditability` is `image` when it is a PNG or JPEG; null when it
 * only views it, as it does an image `image` leaves view-only, which streams
 * instead. */
export function editorKind(format: FileFormat, image: Editability | null): EditorKind | null {
  if (format.text) return format.markdown ? 'markdown' : 'text';
  return image && 'ok' in image ? 'image' : null;
}

/** `route`, relative to the document's folder, as `/` segments when its
 * spelling stays inside that folder and names an image format; else 404. */
function imageSegments(route: string): string[] {
  const segments = pathSegments(route, { strict: true });
  if (!segments || !isImage(route)) throw new HttpError(404);
  return segments;
}

/** The image segments of the Markdown editor's `images/` route, which each
 * host serves itself; null for any other route or editor. */
export function imagesRoute(kind: EditorKind | null, route: string): string[] | null {
  return kind === 'markdown' && route.startsWith(IMAGES_ROUTE) ? imageSegments(route.slice(IMAGES_ROUTE.length)) : null;
}

/** The document as text and its revision; 415 unless UTF-8, whose BOM is
 * dropped here and restored by `saveText`. */
export async function readText(store: EditorStore, file: StorePath): Promise<{ text: string; version: string }> {
  const { bytes, version } = await store.read(file, TEXT_BOUND);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), version }; }
  catch { throw new HttpError(415, 'This editor supports UTF-8 text. Open this file in another editor.'); }
}

/** Saves `text` over `file` at `version`, keeping the file's BOM and majority
 * line ending (mixed endings normalize to it; a file without line breaks keeps
 * `text`'s own). */
export function saveText(store: EditorStore, file: StorePath, text: string, version: string): Promise<{ version: string }> {
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
const image = ({ bytes, version }: { bytes: Uint8Array; version: string }, type: string): EditorReply =>
  ({ body: bytes, type, headers: { 'Content-Security-Policy': IMAGE_CSP, [VERSION_HEADER]: version } });

/** A POST's JSON body, as `parseJsonBody` reads it. */
const jsonBody = (request: EditorRequest, limit: number) =>
  parseJsonBody(request.contentType, limit, bound => request.body({ limit: bound, message: '' })) as Promise<Record<string, unknown> | null>;

/** The routes of one editor over `file`, the document it opened (titled
 * `name`); null for a route it does not answer, which the caller may. */
export function editorRoutes({ kind, file, name, store, onDirty, openLink }: {
  kind: EditorKind;
  file: StorePath;
  name: string;
  store: EditorStore;
  onDirty(dirty: boolean): void;
  openLink?(link: { path: string; fragment?: string }, disposition: 'current' | 'other'): void;
}): (request: EditorRequest) => Promise<EditorReply | null> {
  /** The image editor's own document's type. */
  const imageType = kind === 'image' ? editableImageType(file) : undefined;
  let saving = false;
  /** One save at a time per editor. */
  const save = async <T>(write: () => Promise<T>): Promise<T> => {
    if (saving) throw new HttpError(409, 'Another save is in progress.');
    saving = true;
    try { return await write(); } finally { saving = false; }
  };
  /** Replaces the image with the request's body, typed by its Content-Type, at
   * the revision its `version` query names. */
  const imageSave = async (request: EditorRequest, mime: string): Promise<EditorReply> => {
    const bytes = await request.body(IMAGE_BOUND);
    const version = request.query.get('version');
    if (!version) throw new HttpError(400);
    return json(await save(() => {
      checkImageSave(mime, request.contentType, bytes);
      return store.replace(file, version, IMAGE_BOUND, () => bytes);
    }));
  };
  return async request => {
    const { route } = request;
    if (request.method === 'POST') {
      if (kind === 'markdown' && route === 'open' && openLink) {
        const data = await jsonBody(request, 8192);
        const link = typeof data?.href === 'string' ? markdownLink(data.href) : null;
        if (!link || (data?.disposition !== 'current' && data?.disposition !== 'other')) throw new HttpError(400, 'Not a supported relative document link.');
        try { openLink(link, data.disposition); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Cannot open this link.'); }
        return json({ status: 'sent' });
      }
      if (kind === 'markdown' && route === 'image') {
        // With the width the page inserts it at, read from the whole file, as a
        // JPEG's frame header may sit behind any amount of EXIF or ICC.
        const bytes = await request.body(PASTE_BOUND);
        return json({ name: await pasteImage(store, request.contentType, bytes), width: defaultDisplayWidth(bytes) });
      }
      if (kind === 'markdown' && route === 'rename') {
        const data = await jsonBody(request, 64 * 1024);
        if (typeof data?.from !== 'string' || typeof data?.to !== 'string') throw new HttpError(400);
        const from = imageSegments(data.from);
        const to = imageSegments(data.to);
        // Within its own directory, and never to a hidden name.
        if (from.slice(0, -1).join('/') !== to.slice(0, -1).join('/') || to[to.length - 1].startsWith('.')) {
          throw new HttpError(400, 'Choose a new image name in the same folder.');
        }
        if (!await store.rename(from, to)) throw new HttpError(409, `${to[to.length - 1]} already exists.`);
        return json({});
      }
      if (imageType && route === 'save') return imageSave(request, imageType);
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
    if (route === 'source') return imageType ? image(await store.read(file, IMAGE_BOUND), imageType) : json({ ...await readText(store, file), name });
    return null;
  };
}
