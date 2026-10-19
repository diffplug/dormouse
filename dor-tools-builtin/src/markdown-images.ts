import { constants } from 'node:fs';
import { copyFile, link, lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileViewerFormat } from './file-viewer-format.js';
import { isImage } from './image-format.js';
import { HttpError, isInsideRoot, openRegularFile, resolveInside } from './viewer-server.js';

/** `resolveInside`, or 404. */
function under(root: string, segments: string[]): string {
  const path = resolveInside(root, segments);
  if (path === null) throw new HttpError(404);
  return path;
}

/** A regular image file at `segments` (as `imagesRoute` gives them) at or
 * under `root` (by realpath) for reading; the caller closes it. A symlink
 * whose target leaves `root` grants nothing. */
export async function openImage(root: string, segments: string[]): Promise<{ file: FileHandle; mime: string }> {
  const canonical = await realpath(under(root, segments)).catch(() => { throw new HttpError(404); });
  if (!isInsideRoot(root, canonical) || !isImage(canonical)) throw new HttpError(404);
  const file = await openRegularFile(canonical).catch(() => { throw new HttpError(404); });
  return { file, mime: fileViewerFormat(canonical)!.mime };
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
