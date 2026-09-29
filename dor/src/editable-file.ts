import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { HttpError } from './viewer-server.js';

export const EDITOR_LIMIT = 8 * 1024 * 1024;
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Only the canonical, explicitly opened document can be written. Revalidate
 * the path and descriptor each time; a symlink substitution grants nothing. */
export async function readEditableFile(target: string) {
  if (await realpath(target) !== target) throw new HttpError(409, 'The file path changed. Reopen it before saving.');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new HttpError(409, 'Not a regular file.');
    if (stat.size > EDITOR_LIMIT) throw new HttpError(413, 'Text files are limited to 8 MiB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > EDITOR_LIMIT) throw new HttpError(413, 'Text files are limited to 8 MiB.');
    const after = await file.stat();
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new HttpError(409, 'The file changed while reading. Try again.');
    }
    const contents = bytes.subarray(0, size);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
    catch { throw new HttpError(415, 'This editor supports UTF-8 text. Open this file in another editor.'); }
    return { text, version: revision(contents), bom: contents.subarray(0, 3).equals(Buffer.from([239, 187, 191])), stat };
  } finally { await file.close(); }
}

/** Optimistic concurrency: write and flush a private sibling, recheck contents
 * and identity, then replace atomically. No arbitrary destination or force API.
 * Like other local editors, this cannot lock out an uncooperative writer. */
export async function saveEditableFile(target: string, text: string, version: string) {
  const current = await readEditableFile(target);
  if (current.version !== version) throw new HttpError(409, 'The file changed on disk. Your edits are safe here; compare or reload before saving.');
  const bytes = Buffer.from((current.bom ? '\uFEFF' : '') + text, 'utf8');
  if (bytes.length > EDITOR_LIMIT) throw new HttpError(413, 'Text files are limited to 8 MiB.');
  // Check document write permission even if the directory permits replacement.
  const writable = await open(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await writable.stat();
    if (!stat.isFile() || stat.dev !== current.stat.dev || stat.ino !== current.stat.ino) throw new HttpError(409, 'The file changed on disk.');
  } finally { await writable.close(); }
  const temporary = join(dirname(target), `.dor-save-${randomBytes(16).toString('hex')}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let closed = false;
  try {
    await file.writeFile(bytes);
    await file.chmod(current.stat.mode & 0o777);
    await file.sync();
    await file.close(); closed = true;
    const latest = await readEditableFile(target);
    if (latest.version !== version || latest.stat.dev !== current.stat.dev || latest.stat.ino !== current.stat.ino
      || latest.stat.mtimeMs !== current.stat.mtimeMs || latest.stat.ctimeMs !== current.stat.ctimeMs) {
      throw new HttpError(409, 'The file changed on disk. Reopen or reload it before saving.');
    }
    await rename(temporary, target);
    return { version: revision(bytes) };
  } finally {
    if (!closed) await file.close();
    await unlink(temporary).catch(() => {});
  }
}
