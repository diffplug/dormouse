import { constants } from 'node:fs';
import { open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { saveFileOperations, type SaveFileOperations } from './atomic-save.js';
import { HttpError } from './viewer-server.js';

export const TEXT_LIMIT = 8 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const tooLarge = () => new HttpError(413, 'Text files are limited to 8 MiB.');
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The first `size + 1` bytes of `file`; a longer result than `size` means it grew. */
export async function readUpTo(file: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  return bytes.subarray(0, length);
}

/** Only the canonical, explicitly opened document can be written. Revalidate
 * the path and descriptor each time; a symlink substitution grants nothing. */
async function readEditableBytes(target: string) {
  if (await realpath(target) !== target) throw new HttpError(409, 'The file path changed. Reopen it before saving.');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new HttpError(409, 'Not a regular file.');
    if (stat.size > TEXT_LIMIT) throw tooLarge();
    const bytes = await readUpTo(file, stat.size);
    const after = await file.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new HttpError(409, 'The file changed while reading. Try again.');
    }
    return { bytes, version: revision(bytes), stat };
  } finally { await file.close(); }
}

/** The document as text (a UTF-8 BOM is dropped and restored on save) and its revision. */
export async function readEditableFile(target: string): Promise<{ text: string; version: string }> {
  const { bytes, version } = await readEditableBytes(target);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), version }; }
  catch { throw new HttpError(415, 'This editor supports UTF-8 text. Open this file in another editor.'); }
}

/** `text` with the majority line ending of the file's `bytes` (mixed endings
 * normalize to it); a file without line breaks keeps `text`'s own. */
function withLineEndings(text: string, bytes: Buffer): string {
  const disk = bytes.toString('latin1');
  const lines = disk.split('\n').length - 1;
  if (!lines) return text;
  return (disk.split('\r\n').length - 1) * 2 > lines ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

/** Optimistic concurrency: write and flush a sibling, recheck contents
 * and identity, then replace atomically. No arbitrary destination or force API.
 * Like other local editors, this cannot lock out an uncooperative writer. */
export async function saveEditableFile(target: string, text: string, version: string, operations: SaveFileOperations = saveFileOperations) {
  const current = await readEditableBytes(target);
  if (current.version !== version) throw new HttpError(409, 'The file changed on disk. Your edits are safe here; compare or reload before saving.');
  const bom = current.bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const bytes = Buffer.from((bom ? '﻿' : '') + withLineEndings(text, current.bytes), 'utf8');
  if (bytes.length > TEXT_LIMIT) throw tooLarge();
  // Check document write permission even if the directory permits replacement.
  const writable = await open(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await writable.stat();
    if (!stat.isFile() || stat.dev !== current.stat.dev || stat.ino !== current.stat.ino) throw new HttpError(409, 'The file changed on disk.');
  } finally { await writable.close(); }
  const name = join(dirname(target), `.dor-save-${randomBytes(16).toString('hex')}`);
  const temporary = `${name}.tmp`, backup = `${name}.orig`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let cleanup = true;
  try {
    try {
      await file.writeFile(bytes);
      await file.chmod(current.stat.mode & 0o777);
      await file.sync();
    } finally { await file.close(); }
    const latest = await readEditableBytes(target);
    if (latest.version !== version || latest.stat.dev !== current.stat.dev || latest.stat.ino !== current.stat.ino
      || latest.stat.mtimeMs !== current.stat.mtimeMs || latest.stat.ctimeMs !== current.stat.ctimeMs) {
      throw new HttpError(409, 'The file changed on disk. Reopen or reload it before saving.');
    }
    // Once native replacement starts, an error may mean a partial rename or
    // a committed save whose reply was lost. Keep every recovery byte until
    // replacement is confirmed; never delete a possible sole surviving copy.
    cleanup = false;
    try { await operations.replace(temporary, target, backup); }
    catch {
      const recovery = process.platform === 'win32' ? `${temporary} and ${backup}` : temporary;
      throw new HttpError(500, `The save could not be confirmed. Recovery files were kept at ${recovery}. Reload before saving again.`);
    }
    cleanup = true;
    return { version: revision(bytes) };
  } finally {
    if (cleanup) await Promise.all([temporary, backup].map(path => unlink(path).catch(() => {})));
  }
}
