import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrollmentOfferPath, readEnrollmentOffer } from './enroll-offer';

const OFFER = {
  origin: 'https://ned-mac.tail9c2f1.ts.net',
  token: 'a'.repeat(64),
  mintedAt: '2026-08-31T00:00:00.000Z',
};

const dirs: string[] = [];

/** A temp directory, cleaned up after the test that asked for one. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-offer-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('enrollmentOfferPath', () => {
  // The paths are the install roots the three installers pick
  // (`deploy/local/install-{macos,windows,linux}`). Nothing links the two sides
  // at build time, so a drift here is a one-click enrollment that silently
  // never appears.
  it('follows the macOS install root', () => {
    expect(enrollmentOfferPath('darwin', {}, '/Users/ned')).toBe(
      '/Users/ned/Library/Application Support/Dormouse Server/run/enroll-offer.json',
    );
  });

  it('follows %LOCALAPPDATA% on Windows, and has no answer without it', () => {
    const local = 'C:\\Users\\ned\\AppData\\Local';
    expect(enrollmentOfferPath('win32', { LOCALAPPDATA: local }, 'C:\\Users\\ned')).toContain(
      'Dormouse Server',
    );
    // The installer joins onto that variable, so without it the install root is
    // unknown — which reads as no offer, not as a guessed path.
    expect(enrollmentOfferPath('win32', {}, 'C:\\Users\\ned')).toBeNull();
  });

  it('honors XDG_DATA_HOME on Linux, treating empty as unset', () => {
    expect(enrollmentOfferPath('linux', { XDG_DATA_HOME: '/data' }, '/home/ned')).toBe(
      '/data/dormouse-server/run/enroll-offer.json',
    );
    expect(enrollmentOfferPath('linux', {}, '/home/ned')).toBe(
      '/home/ned/.local/share/dormouse-server/run/enroll-offer.json',
    );
    // `${XDG_DATA_HOME:-…}` in the installer: empty is unset, not the root.
    expect(enrollmentOfferPath('linux', { XDG_DATA_HOME: '' }, '/home/ned')).toBe(
      '/home/ned/.local/share/dormouse-server/run/enroll-offer.json',
    );
  });
});

describe('readEnrollmentOffer', () => {
  it('reads an offer the installer wrote', async () => {
    const dir = await tempDir();
    const file = join(dir, 'enroll-offer.json');
    await writeFile(file, JSON.stringify(OFFER));
    expect(await readEnrollmentOffer(file)).toEqual(OFFER);
  });

  it('is silently null for every failure', async () => {
    const dir = await tempDir();
    // The normal answer on almost every machine: no server installed.
    expect(await readEnrollmentOffer(join(dir, 'absent.json'))).toBeNull();
    // A path this platform has no answer for.
    expect(await readEnrollmentOffer(null)).toBeNull();
    // A half-written file, or one truncated by a crash mid-mint.
    const truncated = join(dir, 'truncated.json');
    await writeFile(truncated, '{"origin":');
    expect(await readEnrollmentOffer(truncated)).toBeNull();
    // Parses, but is not an offer — the shared guard is what rejects it, so a
    // malformed origin or a short token never reaches the enroll exchange.
    const wrong = join(dir, 'wrong.json');
    await writeFile(wrong, JSON.stringify({ ...OFFER, token: 'nope' }));
    expect(await readEnrollmentOffer(wrong)).toBeNull();
    // A directory where the file should be.
    expect(await readEnrollmentOffer(dir)).toBeNull();
  });
});
