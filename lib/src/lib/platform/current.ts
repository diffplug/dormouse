import type { PlatformAdapter } from './types';

/**
 * The installed adapter, apart from the adapters themselves, so a reader that
 * only needs whichever one is installed (the clipboard write) does not pull in
 * every adapter and the terminal stack behind them.
 */
let adapter: PlatformAdapter | null = null;

/** Set an externally-created platform adapter (e.g. TauriAdapter from standalone). */
export function setPlatform(a: PlatformAdapter): void {
  adapter = a;
}

export function getPlatform(): PlatformAdapter {
  if (!adapter) throw new Error('Platform not initialized — call initPlatform() or setPlatform() first');
  return adapter;
}

/** The adapter, or `null` when none is installed. For the readers that treat
 *  "no platform yet" as an ordinary answer — unit tests and the boot frames
 *  before `initPlatform()` — rather than as an error worth surfacing. */
export function getPlatformOrNull(): PlatformAdapter | null {
  return adapter;
}
