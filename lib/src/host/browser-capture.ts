/**
 * The crisp captures behind the viewer sockets (docs/specs/dor-browser.md →
 * "Browser Host"): one device-resolution JPEG of a browser per ask, which a
 * CLI writes into the host's private capture directory and the host reads
 * back into memory and deletes, so no frame waits on disk.
 */
import { randomBytes } from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import { privateCaptureDir } from './private-capture-dir';

/** One capture by a provider: written to `file()` by a CLI, or its bytes. */
export type Shoot = (file: () => Promise<string>) => Promise<{ path: string } | { bytes: Uint8Array }>;

export interface BrowserCaptures {
  /** A JPEG of browser `id`, joining one of it already running. */
  take(id: string, shoot: Shoot): Promise<Uint8Array>;
  /** Join none of `id`'s running captures: its browser was closed or
   *  replaced, and one still running deletes its own file when it ends. */
  forget(id: string): void;
  /** Drop the directory and every frame in it. */
  remove(): Promise<void>;
}

export function createBrowserCaptures(): BrowserCaptures {
  // Screenshots of the user's authenticated browser land here, written by an
  // external process under the ambient umask — which is why the private
  // directory, not the file mode, is the control.
  const dir = privateCaptureDir('dormouse-browser-');
  // Surfaces can share a session, so a capture another viewer asks for
  // meanwhile joins rather than repeats.
  const inFlight = new Map<string, Promise<Uint8Array>>();

  return {
    take(id, shoot) {
      const pending = inFlight.get(id);
      if (pending) return pending;
      // Joined whole, read and delete included: every caller gets the bytes,
      // none a file another has already removed.
      const taking: Promise<Uint8Array> = (async () => {
        // A fresh random name per capture: unguessable, and never one a
        // capture still running writes.
        let written: string | undefined;
        try {
          const shot = await shoot(async () => (written = path.join(await dir.get(), `shot-${randomBytes(12).toString('hex')}.jpg`)));
          if ('bytes' in shot) return shot.bytes;
          const buffer = await fs.readFile(shot.path);
          return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } finally {
          // Read or not — a capture that failed or was killed may have
          // written it anyway — the frame never outlives its capture.
          if (written !== undefined) await fs.unlink(written).catch(() => {});
        }
      })().finally(() => { if (inFlight.get(id) === taking) inFlight.delete(id); });
      inFlight.set(id, taking);
      return taking;
    },
    forget(id) {
      inFlight.delete(id);
    },
    remove: () => dir.remove(),
  };
}
