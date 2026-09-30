import { describe, expect, it } from 'vitest';
import { DEFAULT_HOSTED_ORIGIN, bakedHostedOrigin } from '../hosted-origin';
import { DEFAULT_REMOTE_CONNECT_SRC } from './connect-src';
import { MAX_ONE_TIME_ORIGIN_LENGTH, oneTimeAvailability } from './one-time-origin';

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
    expect(oneTimeAvailability(DEFAULT_HOSTED_ORIGIN, DEFAULT_REMOTE_CONNECT_SRC)).toBeNull();
    // With no define — the test runner's case — the baked value is that default.
    expect(bakedHostedOrigin()).toBe(DEFAULT_HOSTED_ORIGIN);
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
