import { constants } from 'node:fs';
import { copyFile, link, lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileViewerFormat } from './file-viewer-format.js';
import { imageSegments } from './editor-routes.js';
import { isImage } from './image-format.js';
import { HttpError, isInsideRoot, openRegularFile } from './viewer-server.js';

/** `segments`, relative to `root`, as an absolute path when it stays inside
 * `root` (a Windows drive-relative segment such as `D:x.png` leaves it); else 404. */
function under(root: string, segments: string[]): string {
  const path = resolve(root, ...segments);
  if (!isInsideRoot(root, path)) throw new HttpError(404);
  return path;
}

/** A regular image file at or under `root` (by realpath) for reading; the
 * caller closes it. A symlink whose target leaves `root` grants nothing. */
export async function openImage(root: string, route: string): Promise<{ file: FileHandle; mime: string }> {
  const canonical = await realpath(under(root, imageSegments(route))).catch(() => { throw new HttpError(404); });
  if (!isInsideRoot(root, canonical) || !isImage(canonical)) throw new HttpError(404);
  const file = await openRegularFile(canonical).catch(() => { throw new HttpError(404); });
  return { file, mime: fileViewerFormat(canonical)!.mime };
}

/** An image at or under `root` for replacement: its spelling stays under
 * `root` and must be its realpath, so no symlink below `root` is followed. */
export async function editableImageFile(root: string, segments: string[]): Promise<string | null> {
  const path = under(root, segments);
  return await realpath(path).catch(() => null) === path ? path : null;
}

/** Writes `name` in `root` exclusively; false when it exists. */
export async function createImage(root: string, name: string, bytes: Uint8Array): Promise<boolean> {
  let file: FileHandle;
  try { file = await open(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try { await file.writeFile(bytes); await file.sync(); }
  catch (error) { await file.close(); await unlink(join(root, name)).catch(() => {}); throw error; }
  await file.close();
  return true;
}

/** Renames a regular file at or under `root` to `to`'s name in `from`'s
 * directory, never replacing another file (false when taken); 404 when the
 * directory's realpath leaves `root` or the source is not a regular file. */
export async function renameImage(root: string, from: string[], to: string[]): Promise<boolean> {
  const source = under(root, from);
  const name = to[to.length - 1];
  const canonicalDir = await realpath(dirname(source)).catch(() => { throw new HttpError(404); });
  if (!isInsideRoot(root, canonicalDir)) throw new HttpError(404);
  const sourcePath = join(canonicalDir, basename(source));
  const targetPath = join(canonicalDir, name);
  const stat = await lstat(sourcePath).catch(() => { throw new HttpError(404); });
  if (!stat.isFile()) throw new HttpError(404); // a symlink is not renamed through
  if (sourcePath === targetPath) return true;
  const existing = await lstat(targetPath).catch(() => null);
  if (existing) {
    // A case-only rename on a case-insensitive volume names the same file.
    if (existing.dev !== stat.dev || existing.ino !== stat.ino) return false;
    await rename(sourcePath, targetPath);
    return true;
  }
  // link fails if the target appeared since; volumes without hard links copy exclusively.
  try { await link(sourcePath, targetPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EXDEV') throw error;
    try { await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL); }
    catch (copyError) { if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') return false; throw copyError; }
  }
  await unlink(sourcePath);
  return true;
}
