import { describe, expect, it } from 'vitest';
import { frameSalt } from './frame-salt';

function memory() {
  const held = new Map<string, string>();
  return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value), held };
}

describe('frameSalt', () => {
  it('keeps one salt on this device', () => {
    const storage = memory();
    const first = frameSalt(storage);
    expect(first).toHaveLength(32);
    expect(frameSalt(storage)).toEqual(first);
  });

  it('replaces what it cannot read, and still answers with nowhere to keep it', () => {
    const storage = memory();
    storage.setItem('dormouse.pocket.frame-salt', 'short');
    expect(frameSalt(storage)).toHaveLength(32);
    const refusing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(frameSalt(refusing)).toHaveLength(32);
    expect(frameSalt(null)).toHaveLength(32);
  });
});
