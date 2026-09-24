/**
 * The crisp captures behind the viewer sockets (docs/specs/dor-browser.md →
 * "Viewer Socket"): one device-resolution JPEG of a browser per ask, which a
 * CLI writes into the host's private capture directory and the host reads
 * back and removes at once, so no frame waits on disk.
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
  /** Join none of `id`'s running captures, and give its next a fresh file,
   *  so one still running cannot overwrite it: its browser was closed or
   *  replaced. */
  forget(id: string): void;
  /** Drop the directory and every frame in it. */
  remove(): Promise<void>;
}

export function createBrowserCaptures(): BrowserCaptures {
  // Screenshots of the user's authenticated browser land here, written by an
  // external process under the ambient umask — which is why the private
  // directory, not the file mode, is the control.
  const dir = privateCaptureDir('dormouse-browser-');
  // One file per browser, so frames don't litter; one capture of it at a time
  // (below), so reusing the name is safe. The random name keeps it unguessable
  // from the session alone.
  const names = new Map<string, string>();
  // Surfaces can share a session, so a capture another viewer asks for
  // meanwhile joins rather than repeats.
  const inFlight = new Map<string, Promise<Uint8Array>>();

  async function file(id: string): Promise<string> {
    let name = names.get(id);
    if (name === undefined) names.set(id, name = randomBytes(12).toString('hex'));
    return path.join(await dir.get(), `shot-${name}.jpg`);
  }

  return {
    take(id, shoot) {
      const pending = inFlight.get(id);
      if (pending) return pending;
      // Joined whole, read and unlink included: a caller joining only the
      // capture would read a file the first caller has already removed.
      const taking: Promise<Uint8Array> = (async () => {
        const shot = await shoot(() => file(id));
        if ('bytes' in shot) return shot.bytes;
        const buffer = await fs.readFile(shot.path);
        await fs.unlink(shot.path).catch(() => {});
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      })().finally(() => { if (inFlight.get(id) === taking) inFlight.delete(id); });
      inFlight.set(id, taking);
      return taking;
    },
    forget(id) {
      inFlight.delete(id);
      names.delete(id);
    },
    async remove() {
      await dir.remove();
      names.clear();
    },
  };
}
