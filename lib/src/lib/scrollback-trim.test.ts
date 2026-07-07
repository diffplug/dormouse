import { describe, it, expect } from 'vitest';
import { PERSISTED_SCROLLBACK_MAX_CHARS, trimPersistedScrollback } from './scrollback-trim';

describe('trimPersistedScrollback', () => {
  it('returns under-cap scrollback unchanged', () => {
    const scrollback = 'line one\nline two\n';
    expect(trimPersistedScrollback(scrollback)).toBe(scrollback);
  });

  it('returns scrollback unchanged at the exact boundary (length === maxChars)', () => {
    const scrollback = 'x'.repeat(10);
    expect(trimPersistedScrollback(scrollback, 10)).toBe(scrollback);
  });

  it('keeps the tail and preserves the original trailing newline', () => {
    const scrollback = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const result = trimPersistedScrollback(scrollback, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('\n')).toBe(true);
    expect(scrollback.endsWith(result)).toBe(true);
  });

  it('drops the partial first line at the cut boundary', () => {
    // length 15; slice(-12) starts one char into "aaaa", so the tail is
    // "a\nbbbb\ncccc\n" — a torn partial first line ("a"). The cut at the first
    // newline drops it, so the result starts on a clean line.
    const scrollback = 'aaaa\nbbbb\ncccc\n';
    const result = trimPersistedScrollback(scrollback, 12);
    expect(result.startsWith('a\n')).toBe(false);
    expect(result).toBe('bbbb\ncccc\n');
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it('hard-cuts a single line longer than the cap (no newline in tail)', () => {
    const scrollback = 'z'.repeat(100);
    const result = trimPersistedScrollback(scrollback, 20);
    expect(result).toBe('z'.repeat(20));
    expect(result.length).toBe(20);
    expect(result.length).toBeGreaterThan(0);
  });

  it('hard-cuts when the only newline in the tail is its last char', () => {
    // tail = slice(-6) = 'aaaaa\n'; indexOf('\n') === 5 === tail.length - 1, so
    // dropping through it would yield '' — keep the tail as a hard cut instead.
    const scrollback = 'x'.repeat(20) + '\n';
    const result = trimPersistedScrollback(scrollback, 6);
    expect(result).toBe('xxxxx\n');
    expect(result.length).toBe(6);
    expect(result.length).toBeGreaterThan(0);
  });

  it('never returns more than maxChars characters', () => {
    const cases = [
      'short\n',
      'a'.repeat(200),
      Array.from({ length: 100 }, (_, i) => `entry-${i}`).join('\n') + '\n',
      'first\n' + 'y'.repeat(200) + '\n',
    ];
    for (const scrollback of cases) {
      expect(trimPersistedScrollback(scrollback, 30).length).toBeLessThanOrEqual(30);
    }
  });

  it('caps at 100k chars by default', () => {
    expect(PERSISTED_SCROLLBACK_MAX_CHARS).toBe(100_000);
    const scrollback = ('busy output line\n').repeat(20_000); // ~340k chars
    const result = trimPersistedScrollback(scrollback);
    expect(result.length).toBeLessThanOrEqual(100_000);
    expect(result.endsWith('\n')).toBe(true);
    expect(scrollback.endsWith(result)).toBe(true);
  });
});
