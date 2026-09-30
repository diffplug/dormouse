import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY_ORIGIN, MAX_RELAY_ORIGIN_LENGTH, bakedRelayMode, bakedRelayOrigin } from '../relay-origin';
import { oneTimeAvailability } from './one-time-origin';

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

describe('oneTimeAvailability', () => {
  it('offers the shipped rendezvous in the shipped build', () => {
    expect(oneTimeAvailability(DEFAULT_RELAY_ORIGIN, 'hosted')).toBeNull();
    // With no define — the test runner's case — the baked pair is that default.
    expect(oneTimeAvailability(bakedRelayOrigin(), bakedRelayMode())).toBeNull();
  });

  it('offers none in a self-host build, whatever its origin', () => {
    for (const origin of [
      'https://relay.example.ts.net',
      'http://localhost:3000',
      // Even Hosted's: a self-host build reaches nothing of Dormouse's.
      DEFAULT_RELAY_ORIGIN,
      'not an origin',
    ]) {
      expect(oneTimeAvailability(origin, 'self-host'), origin).toBe('self-host');
    }
  });

  it('refuses what a link cannot carry', () => {
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
      originOfLength(MAX_RELAY_ORIGIN_LENGTH + 1),
    ]) {
      expect(oneTimeAvailability(origin, 'hosted'), origin).toBe('origin-invalid');
    }
  });

  it('takes HTTPS, and HTTP on exactly the link loopback hosts — a dev build pointed at a local Hosted', () => {
    for (const origin of [
      'https://hosted.dormouse.sh',
      'https://hosted.dormouse.sh:8443',
      'https://preview.example',
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      'http://[::1]:8787',
      originOfLength(MAX_RELAY_ORIGIN_LENGTH),
    ]) {
      expect(oneTimeAvailability(origin, 'hosted'), origin).toBeNull();
    }
  });
});
