/**
 * This window's Surface id counter (docs/specs/vscode.md → "Surface id
 * minting"): every webview here reserves `surface-<n>` blocks from it.
 *
 * Its high-water mark lives in `surface-ids.json` as a ceiling no handed-out
 * number has reached, mirroring standalone's `ids.rs`. A reservation that would
 * reach it first re-reads the file — empty windows share `globalStorageUri`, and
 * another may have raised it — then raises it by a slack and writes it before
 * handing anything out, so a later run starting at the ceiling reuses nothing.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writeJsonAtomic } from '../../lib/src/host/atomic-json-file';
import { createSerialQueue } from '../../lib/src/host/remote/serial-queue';
import { log } from './log';

const FILE = 'surface-ids.json';
const VERSION = 1;
const SLACK = 1024;
const MAX_BLOCK = 64;

export interface SurfaceIdAllocator {
  /** `count` ids (clamped to 1..64), each numbered above `floor` and above every
   *  id this or an earlier run handed out. Never rejects. */
  reserve(count: number, floor: number): Promise<string[]>;
}

interface AllocatorLog { error(message: string): void }

/** A counter persisted under `dir`, or kept in memory alone when there is none. */
export function createSurfaceIdAllocator(dir: string | null, logger: AllocatorLog): SurfaceIdAllocator {
  const file = dir === null ? null : path.join(dir, FILE);
  /** The lowest number not yet handed out. */
  let next = 1;
  /** No number handed out reaches this; persisted before one would. */
  let ceiling = 0;
  // One at a time: a raise awaits the file, and the next reservation must see
  // the ceiling it wrote.
  const serialize = createSerialQueue();

  async function persistedCeiling(): Promise<number> {
    if (file === null) return 0;
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const { version, surface } = (parsed ?? {}) as { version?: unknown; surface?: unknown };
      if (version === VERSION && Number.isSafeInteger(surface) && (surface as number) >= 0) return surface as number;
      logger.error(`[surface-ids] ignoring ${file}: not a version ${VERSION} counter`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.error(`[surface-ids] read ${file}: ${String(error)}`);
    }
    return 0;
  }

  async function reserveNow(count: number, floor: number): Promise<string[]> {
    const n = Math.max(1, Math.min(MAX_BLOCK, Math.trunc(count) || 1));
    const above = Number.isSafeInteger(floor) && floor > 0 ? floor : 0;
    let first = Math.max(next, above + 1);
    if (first + n > ceiling) {
      // Numbers below a ceiling this counter did not write belong to another
      // window or an earlier run.
      const persisted = await persistedCeiling();
      if (persisted > ceiling) first = Math.max(first, persisted);
      ceiling = first + n + SLACK;
      if (file !== null) {
        try {
          await writeJsonAtomic(path.dirname(file), file, { version: VERSION, surface: ceiling });
        } catch (error) {
          logger.error(`[surface-ids] write ${file}: ${String(error)}; the counter stays in memory`);
        }
      }
    }
    next = first + n;
    return Array.from({ length: n }, (_, i) => `surface-${first + i}`);
  }

  return {
    reserve: (count, floor) => serialize(() => reserveNow(count, floor)),
  };
}

/** In memory until activation names this window's storage. */
let allocator = createSurfaceIdAllocator(null, log);

/** Activation: persist this window's counter under `dir`. */
export function initSurfaceIds(dir: string | null): void {
  allocator = createSurfaceIdAllocator(dir, log);
}

export function reserveSurfaceIds(count: number, floor: number): Promise<string[]> {
  return allocator.reserve(count, floor);
}
