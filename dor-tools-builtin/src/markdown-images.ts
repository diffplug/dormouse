import { constants } from 'node:fs';
import { copyFile, link, lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CONTROLS, fileViewerFormat } from './file-viewer-format.js';
import { IMAGE_BOUND, readEditableImage, saveEditableBytes } from './editable-file.js';
import { HttpError, isInsideRoot, openRegularFile, pathSegments } from './viewer-server.js';

/** A pasted image's type, its file extension, and the signature its bytes must open with. */
const PASTE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', magic: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', magic: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { ext: 'webp', magic: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

/** The `PASTE_TYPES` type whose signature `bytes` opens with, if any. */
export const imageKind = (bytes: Buffer): string | undefined =>
  Object.keys(PASTE_TYPES).find(type => PASTE_TYPES[type].magic(bytes));

/** The image types the image editor re-encodes; every other image is view-only. */
const EDITABLE_IMAGES = new Set(['image/png', 'image/jpeg']);
/** `path`'s type when its extension names an editable image (PNG or JPEG). */
export function editableImageType(path: string): string | undefined {
  const mime = fileViewerFormat(path)?.mime;
  return mime && EDITABLE_IMAGES.has(mime) ? mime : undefined;
}

const isImage = (path: string) => !!fileViewerFormat(path)?.mime.startsWith('image/');

/** `route`, a `/`-separated path relative to `root`, as an absolute path when
 * its spelling stays inside `root` and names an image format; else 404. */
function imagePath(root: string, route: string): string {
  if (!pathSegments(route, { strict: true }) || !isImage(route)) throw new HttpError(404);
  return resolve(root, ...route.split('/'));
}

/** A regular image file at or under `root` (by realpath) for reading; the
 * caller closes it. A symlink whose target leaves `root` grants nothing. */
export async function openImage(root: string, route: string): Promise<{ file: FileHandle; mime: string }> {
  const canonical = await realpath(imagePath(root, route)).catch(() => { throw new HttpError(404); });
  if (!isInsideRoot(root, canonical) || !isImage(canonical)) throw new HttpError(404);
  const file = await openRegularFile(canonical).catch(() => { throw new HttpError(404); });
  return { file, mime: fileViewerFormat(canonical)!.mime };
}

/** An editable image at or under `root` for replacement. `imagePath` keeps the
 * spelling under `root`, and the spelling must be the realpath, so no symlink
 * below `root` is followed; else 404. */
async function editableImagePath(root: string, route: string): Promise<{ path: string; mime: string }> {
  const path = imagePath(root, route);
  const mime = editableImageType(path);
  if (!mime) throw new HttpError(415, 'Only PNG and JPEG images can be edited.');
  if (await realpath(path).catch(() => null) !== path) throw new HttpError(404);
  return { path, mime };
}

/** The bytes, type, and revision of an editable image at or under `root`. */
export async function readImageInFolder(root: string, route: string): Promise<{ bytes: Buffer; version: string; mime: string }> {
  const { path, mime } = await editableImagePath(root, route);
  return { ...await readEditableImage(path), mime };
}

/** Saves `bytes` over `target`, an editable image of type `mime`, at revision
 * `version` when the request's `type` and the bytes' signature are both `mime`. */
export async function saveImageFile(target: string, mime: string, type: string, bytes: Buffer, version: string): Promise<{ version: string }> {
  if (type !== mime || imageKind(bytes) !== mime) throw new HttpError(415, `Save this image as ${mime === 'image/png' ? 'PNG' : 'JPEG'}.`);
  return saveEditableBytes(target, bytes, version, IMAGE_BOUND);
}

/** Replaces an editable image at or under `root` in place, as `saveImageFile`. */
export async function saveImageInFolder(root: string, route: string, type: string, bytes: Buffer, version: string): Promise<{ version: string }> {
  const { path, mime } = await editableImagePath(root, route);
  return saveImageFile(path, mime, type, bytes, version);
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Writes a pasted image beside the document as a new file, never replacing
 * one, and returns its name: `image-YYYYMMDD-HHMMSS[-N].<ext>`. */
export async function writePastedImage(root: string, type: string, bytes: Buffer, now = new Date()): Promise<string> {
  const kind = Object.prototype.hasOwnProperty.call(PASTE_TYPES, type) ? PASTE_TYPES[type] : undefined;
  if (!kind) throw new HttpError(415, 'Paste a PNG, JPEG, GIF, or WebP image.');
  if (!kind.magic(bytes)) throw new HttpError(415, `The pasted data is not a ${kind.ext.toUpperCase()} image.`);
  for (let n = 1; n <= 100; n++) {
    const name = `image-${stamp(now)}${n > 1 ? `-${n}` : ''}.${kind.ext}`;
    let file: FileHandle;
    try { file = await open(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    try { await file.writeFile(bytes); await file.sync(); }
    catch (error) { await file.close(); await unlink(join(root, name)).catch(() => {}); throw error; }
    await file.close();
    return name;
  }
  throw new HttpError(409, 'Too many images pasted this second.');
}

/** Renames an image at or under `root` within its own directory, never
 * replacing another file. `from` and `to` are `/`-separated relative paths
 * whose directories must match; both name image formats. */
export async function renameImage(root: string, from: string, to: string): Promise<void> {
  const source = imagePath(root, from);
  const target = imagePath(root, to);
  const name = basename(target);
  if (dirname(source) !== dirname(target) || CONTROLS.test(name) || name.startsWith('.')) throw new HttpError(400, 'Choose a new image name in the same folder.');
  const canonicalDir = await realpath(dirname(source)).catch(() => { throw new HttpError(404); });
  if (!isInsideRoot(root, canonicalDir)) throw new HttpError(404);
  const taken = () => new HttpError(409, `${name} already exists.`);
  const sourcePath = join(canonicalDir, basename(source));
  const targetPath = join(canonicalDir, name);
  const stat = await lstat(sourcePath).catch(() => { throw new HttpError(404); });
  if (!stat.isFile()) throw new HttpError(404); // a symlink is not renamed through
  if (sourcePath === targetPath) return;
  const existing = await lstat(targetPath).catch(() => null);
  if (existing) {
    // A case-only rename on a case-insensitive volume names the same file.
    if (existing.dev !== stat.dev || existing.ino !== stat.ino) throw taken();
    await rename(sourcePath, targetPath);
    return;
  }
  // link fails if the target appeared since; volumes without hard links copy exclusively.
  try { await link(sourcePath, targetPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw taken();
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EXDEV') throw error;
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL).catch(copyError => {
      throw (copyError as NodeJS.ErrnoException).code === 'EEXIST' ? taken() : copyError;
    });
  }
  await unlink(sourcePath);
}
