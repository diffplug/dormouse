/**
 * The one thing this helper exists for is failing safely: `fs.watch` can refuse
 * up front or die later, and a later death that nobody listens for is rethrown
 * and takes the extension host down. Both callers treat their watcher as an
 * accelerator over a timer, so both failures have to end as "no watcher".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { removeDir, tempStorageDir } from './helpers';
import { watchDirFile } from '../src/watch-dir-file';

let dir: string;

beforeEach(async () => {
  dir = await tempStorageDir();
});

afterEach(async () => {
  await removeDir(dir);
});

describe('watchDirFile', () => {
  it('reports nothing to watch instead of throwing', () => {
    expect(watchDirFile(join(dir, 'missing'), 'file.json', () => {}, () => {})).toBe(null);
  });

  it('closes an asynchronously failing watcher and reports it once', () => {
    const errors: Error[] = [];
    const watcher = watchDirFile(dir, 'file.json', () => {}, (error) => errors.push(error));
    expect(watcher).not.toBe(null);
    const close = vi.spyOn(watcher!, 'close');

    // What the kernel does when it invalidates an inotify handle. Unheard, this
    // is an uncaught exception in the extension host.
    const failure = new Error('watch resources exhausted');
    watcher!.emit('error', failure);

    expect(close).toHaveBeenCalledOnce();
    expect(errors).toEqual([failure]);
    // And the hazard itself, for the record: with the closed watcher's listener
    // spent, a further error is rethrown — an uncaught exception in the
    // extension host, which is why nothing may watch without this.
    expect(() => watcher!.emit('error', new Error('unheard'))).toThrow('unheard');
  });
});
