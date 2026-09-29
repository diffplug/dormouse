import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LINK_LOOPBACK_HOSTS } from 'remote-lib-common';
// The build scripts read the `.mjs` and the Burrow service reads the `.ts`; the
// cases below are what keep them one fact.
import {
  DEFAULT_ONE_TIME_ORIGIN as BUILD_DEFAULT,
  MAX_ONE_TIME_ORIGIN_LENGTH as BUILD_MAX_LENGTH,
  ONE_TIME_LOOPBACK_HOSTS as BUILD_LOOPBACK_HOSTS,
  ONE_TIME_ORIGIN_PLACEHOLDER,
  assertOneTimeOriginBaked,
  resolveOneTimeOrigin,
} from '../../../../scripts/csp-defaults.mjs';
import { DEFAULT_REMOTE_CONNECT_SRC } from './connect-src';
import {
  DEFAULT_ONE_TIME_ORIGIN,
  MAX_ONE_TIME_ORIGIN_LENGTH,
  bakedOneTimeOrigin,
  oneTimeAvailability,
} from './one-time-origin';

/**
 * An `https://` origin of exactly `length` characters under `example`, built
 * from labels a real host could have, prepended until it fits.
 */
function originOfLength(length: number): string {
  let host = 'example';
  while (`https://${host}`.length < length) {
    const room = length - `https://${host}`.length;
    // A label and its dot, never leaving a single character over for the next.
    const size = room <= 51 ? room - 1 : Math.min(50, room - 3);
    host = `${'a'.repeat(size)}.${host}`;
  }
  return `https://${host}`;
}

/** Admits every origin these cases use, so only `origin-invalid` can refuse one. */
const ANY = 'https://*.example:* https://*.dormouse.sh:* http://localhost:* http://127.0.0.1:*';

describe('oneTimeAvailability', () => {
  it('offers the shipped rendezvous under the shipped allowlist', () => {
    expect(oneTimeAvailability(DEFAULT_ONE_TIME_ORIGIN, DEFAULT_REMOTE_CONNECT_SRC)).toBeNull();
    // With no define — the test runner's case — the baked value is that default.
    expect(bakedOneTimeOrigin()).toBe(DEFAULT_ONE_TIME_ORIGIN);
  });

  it('refuses an origin the allowlist does not admit', () => {
    expect(oneTimeAvailability('https://rendezvous.example', DEFAULT_REMOTE_CONNECT_SRC)).toBe(
      'origin-not-allowed',
    );
    // The bare domain is not under its own wildcard.
    expect(oneTimeAvailability('https://dormouse.sh', DEFAULT_REMOTE_CONNECT_SRC)).toBe(
      'origin-not-allowed',
    );
    expect(oneTimeAvailability('http://127.0.0.1:8787', DEFAULT_REMOTE_CONNECT_SRC)).toBe(
      'origin-not-allowed',
    );
  });

  it('admits the socket the runtime dials with the page, as one scheme', () => {
    // The page is `https://`, the socket `wss://`; a list naming either admits both.
    expect(oneTimeAvailability('https://rendezvous.example', 'wss://rendezvous.example')).toBeNull();
    expect(oneTimeAvailability('https://rendezvous.example', 'https://rendezvous.example')).toBeNull();
    expect(oneTimeAvailability('http://127.0.0.1:8787', 'ws://127.0.0.1:8787')).toBeNull();
    expect(oneTimeAvailability('http://127.0.0.1:8787', 'http://127.0.0.1:9999')).toBe(
      'origin-not-allowed',
    );
  });

  it('refuses what a link cannot carry, before the allowlist is read', () => {
    for (const origin of [
      'https://hosted.dormouse.sh/',
      'https://hosted.dormouse.sh/connect',
      'https://user@hosted.dormouse.sh',
      'https://hosted.dormouse.sh?x=1',
      'HTTPS://hosted.dormouse.sh',
      'http://hosted.dormouse.sh',
      'http://127.0.0.2:8787',
      'ws://127.0.0.1:8787',
      'wss://hosted.dormouse.sh',
      'not an origin',
      '',
      originOfLength(MAX_ONE_TIME_ORIGIN_LENGTH + 1),
    ]) {
      expect(oneTimeAvailability(origin, ANY), origin).toBe('origin-invalid');
    }
  });

  it('takes HTTPS, and HTTP on exactly the link loopback hosts', () => {
    for (const origin of [
      'https://hosted.dormouse.sh',
      'https://hosted.dormouse.sh:8443',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      originOfLength(MAX_ONE_TIME_ORIGIN_LENGTH),
    ]) {
      expect(oneTimeAvailability(origin, ANY), origin).toBeNull();
    }
    // A link may carry the IPv6 loopback; whether a build may reach it is the
    // allowlist's call, whose source grammar has no IPv6 literal.
    expect(oneTimeAvailability('http://[::1]:8787', ANY)).toBe('origin-not-allowed');
  });

  it('bounds the origin at what still fits a 256-character link', () => {
    expect(MAX_ONE_TIME_ORIGIN_LENGTH).toBe(167);
  });
});

describe('the build-time one-time origin', () => {
  it('keeps the same default, bound, and loopback hosts as the runtime', () => {
    expect(BUILD_DEFAULT).toBe(DEFAULT_ONE_TIME_ORIGIN);
    expect(BUILD_MAX_LENGTH).toBe(MAX_ONE_TIME_ORIGIN_LENGTH);
    expect([...BUILD_LOOPBACK_HOSTS].sort()).toEqual([...LINK_LOOPBACK_HOSTS].sort());
  });

  it('fails the build on exactly the overrides the runtime would call invalid', () => {
    // A copy that drifted would fail a build over an origin the Burrow takes,
    // or pass one whose button then reads unavailable.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const origin of [
      'https://hosted.dormouse.sh',
      'https://hosted.dormouse.sh/',
      'https://hosted.dormouse.sh/connect',
      'https://user@hosted.dormouse.sh',
      'http://hosted.dormouse.sh',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      'http://[::1]:8787',
      'http://127.0.0.2:8787',
      'wss://hosted.dormouse.sh',
      'hosted.dormouse.sh',
      originOfLength(MAX_ONE_TIME_ORIGIN_LENGTH),
      originOfLength(MAX_ONE_TIME_ORIGIN_LENGTH + 1),
    ]) {
      const invalid = oneTimeAvailability(origin, ANY) === 'origin-invalid';
      const resolve = () => resolveOneTimeOrigin({ DORMOUSE_ONE_TIME_ORIGIN: origin }, 'test');
      if (invalid) expect(resolve, origin).toThrow(/DORMOUSE_ONE_TIME_ORIGIN/);
      else expect(resolve(), origin).toBe(origin);
    }
    log.mockRestore();
  });

  it('passes an unset override through to the default', () => {
    expect(resolveOneTimeOrigin({}, 'test')).toBe(DEFAULT_ONE_TIME_ORIGIN);
    expect(resolveOneTimeOrigin({ DORMOUSE_ONE_TIME_ORIGIN: '  ' }, 'test')).toBe(
      DEFAULT_ONE_TIME_ORIGIN,
    );
  });

  it('fails a bundle the define did not reach', () => {
    const dir = mkdtempSync(join(tmpdir(), 'one-time-origin-'));
    try {
      const bundle = join(dir, 'bundle.js');
      writeFileSync(bundle, `const origin = ${ONE_TIME_ORIGIN_PLACEHOLDER};`);
      expect(() => assertOneTimeOriginBaked(bundle, DEFAULT_ONE_TIME_ORIGIN)).toThrow(/survived/);
      writeFileSync(bundle, 'const origin = "https://hosted.dormouse.sh";');
      expect(() => assertOneTimeOriginBaked(bundle, 'http://127.0.0.1:8787')).toThrow(
        /does not contain/,
      );
      expect(() => assertOneTimeOriginBaked(bundle, DEFAULT_ONE_TIME_ORIGIN)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
