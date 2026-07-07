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
    // length 15; the last 12 chars start one char into "aaaa", so the tail is
    // "a\nbbbb\ncccc\n" — the cut at its first newline drops the torn "a".
    expect(trimPersistedScrollback('aaaa\nbbbb\ncccc\n', 12)).toBe('bbbb\ncccc\n');
  });

  it('hard-cuts a single line longer than the cap (no newline in tail)', () => {
    expect(trimPersistedScrollback('z'.repeat(100), 20)).toBe('z'.repeat(20));
  });

  it('hard-cuts when the only newline in the tail is its last char', () => {
    // tail = 'aaaaa\n' — dropping through its only newline would yield ''.
    expect(trimPersistedScrollback('x'.repeat(20) + '\n', 6)).toBe('xxxxx\n');
  });

  it('passes null through', () => {
    expect(trimPersistedScrollback(null)).toBeNull();
  });

  it('caps at 100k chars by default', () => {
    expect(PERSISTED_SCROLLBACK_MAX_CHARS).toBe(100_000);
    const scrollback = ('busy output line\n').repeat(20_000); // ~340k chars
    expect(trimPersistedScrollback(scrollback).length).toBeLessThanOrEqual(100_000);
  });
});
