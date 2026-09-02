import { describe, expect, it } from 'vitest';
import { isLoopbackHost, isOwnOrigin } from './loopback-guard';

describe('isLoopbackHost', () => {
  it('accepts either spelling of its own loopback address', () => {
    expect(isLoopbackHost('127.0.0.1:4000', 4000)).toBe(true);
    expect(isLoopbackHost('localhost:4000', 4000)).toBe(true);
    expect(isLoopbackHost('LOCALHOST:4000', 4000)).toBe(true);
  });

  it('refuses a rebound name, another port, and a missing header', () => {
    expect(isLoopbackHost('evil.example:4000', 4000)).toBe(false);
    expect(isLoopbackHost('127.0.0.1:4001', 4000)).toBe(false);
    expect(isLoopbackHost('127.0.0.1', 4000)).toBe(false);
    expect(isLoopbackHost(undefined, 4000)).toBe(false);
    expect(isLoopbackHost('', 4000)).toBe(false);
  });

  it('is not fooled by a hostile name that merely contains loopback', () => {
    expect(isLoopbackHost('127.0.0.1:4000.evil.example', 4000)).toBe(false);
    expect(isLoopbackHost('localhost:4000@evil.example', 4000)).toBe(false);
  });
});

describe('isOwnOrigin', () => {
  it('accepts the origin of a page this listener served', () => {
    expect(isOwnOrigin('http://127.0.0.1:4000', 4000)).toBe(true);
    expect(isOwnOrigin('http://localhost:4000', 4000)).toBe(true);
  });

  it('refuses a foreign origin, a wrong port, and https on loopback', () => {
    expect(isOwnOrigin('https://evil.example', 4000)).toBe(false);
    expect(isOwnOrigin('http://127.0.0.1:4001', 4000)).toBe(false);
    // A different scheme is a different origin, so it is not a page we served.
    expect(isOwnOrigin('https://127.0.0.1:4000', 4000)).toBe(false);
  });

  it('treats absent, empty, and unparseable as not-own rather than throwing', () => {
    // Callers decide what absence means for them; this never guesses.
    expect(isOwnOrigin(undefined, 4000)).toBe(false);
    expect(isOwnOrigin('', 4000)).toBe(false);
    expect(isOwnOrigin('null', 4000)).toBe(false);
    expect(isOwnOrigin('not a url', 4000)).toBe(false);
  });

  it('is not fooled by loopback appearing elsewhere in the authority', () => {
    expect(isOwnOrigin('http://127.0.0.1.evil.example:4000', 4000)).toBe(false);
    expect(isOwnOrigin('http://evil.example:4000/?x=http://127.0.0.1:4000', 4000)).toBe(false);
  });
});
