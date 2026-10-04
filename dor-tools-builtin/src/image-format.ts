/** The image half of the editor routes (`editor-routes.ts`): the formats,
 * signatures, pasted names, bounds, and route names the editor pages, the
 * Node viewers, and the website playground's viewers share. Browser-safe. */
import { fileViewerFormat } from './file-viewer-format.js';
import { HttpError } from './viewer-http.js';

/** A size bound and the 413 message past it. */
export interface SizeBound { limit: number; message: string }
/** Bound on one image's bytes: a read for editing, or a save. */
export const IMAGE_BOUND: SizeBound = { limit: 32 * 1024 * 1024, message: 'Images are limited to 32 MiB.' };
/** `IMAGE_BOUND`, for a paste. */
export const PASTE_BOUND: SizeBound = { limit: IMAGE_BOUND.limit, message: 'Pasted images are limited to 32 MiB.' };
/** The response header carrying an editable image's revision, which its save
 * echoes as the `version` query parameter. */
export const VERSION_HEADER = 'X-Dor-Version';
/** The Markdown editor's image routes, each followed by the image's `/`-separated
 * path relative to the document's folder: read to edit (with `VERSION_HEADER`),
 * save in place, and show. */
export const EDIT_ROUTE = 'edit/';
export const IMAGE_SAVE_ROUTE = 'image-save/';
export const IMAGES_ROUTE = 'images/';
// An image the Markdown editor shows can be opened directly; it never runs as a document there.
export const IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A pasted image's type, its file extension, and the signature its bytes must open with. */
const PASTE_TYPES: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  'image/png': { ext: 'png', magic: b => PNG_SIGNATURE.every((byte, i) => b[i] === byte) },
  'image/jpeg': { ext: 'jpg', magic: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: b => /^GIF8[79]a/.test(ascii(b, 0, 6)) },
  'image/webp': { ext: 'webp', magic: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
};

/** The `PASTE_TYPES` type whose signature `bytes` opens with, if any. */
export const imageKind = (bytes: Uint8Array): string | undefined =>
  Object.keys(PASTE_TYPES).find(type => PASTE_TYPES[type].magic(bytes));

/** The image types the image editor re-encodes; every other image is view-only. */
const EDITABLE_IMAGES = new Set(['image/png', 'image/jpeg']);
/** `path`'s type when its extension names an editable image (PNG or JPEG). */
export function editableImageType(path: string): string | undefined {
  const mime = fileViewerFormat(path)?.mime;
  return mime && EDITABLE_IMAGES.has(mime) ? mime : undefined;
}

/** Whether `path`'s extension names an image format. */
export const isImage = (path: string): boolean => !!fileViewerFormat(path)?.mime.startsWith('image/');

/** The file extension for a paste of Content-Type `type` whose bytes carry
 * that type's signature; else 415. */
export function pastedImageExtension(type: string, bytes: Uint8Array): string {
  const kind = Object.prototype.hasOwnProperty.call(PASTE_TYPES, type) ? PASTE_TYPES[type] : undefined;
  if (!kind) throw new HttpError(415, 'Paste a PNG, JPEG, GIF, or WebP image.');
  if (!kind.magic(bytes)) throw new HttpError(415, `The pasted data is not a ${kind.ext.toUpperCase()} image.`);
  return kind.ext;
}

/** How many names a paste tries within one second before giving up. */
export const PASTE_ATTEMPTS = 100;
export const PASTE_EXHAUSTED_MESSAGE = 'Too many images pasted this second.';

const pad = (n: number) => String(n).padStart(2, '0');
/** The `n`th candidate name (from 1) for an image pasted at `now`: `image-YYYYMMDD-HHMMSS[-N].<ext>`. */
export function pastedImageName(now: Date, n: number, ext: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `image-${stamp}${n > 1 ? `-${n}` : ''}.${ext}`;
}

/** Refuses a save over an editable image of type `mime` unless the request's
 * Content-Type `type` and the bytes' signature are both `mime`. */
export function checkImageSave(mime: string, type: string, bytes: Uint8Array): void {
  if (type !== mime || imageKind(bytes) !== mime) throw new HttpError(415, `Save this image as ${mime === 'image/png' ? 'PNG' : 'JPEG'}.`);
}
