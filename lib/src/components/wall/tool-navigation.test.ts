import { describe, expect, it } from 'vitest';
import { commitToolHistory, documentDirectory, toolHistory } from './tool-navigation';

const location = (target: string, top = 0) => ({ target, cwd: '/repo', handler: 'builtin:file', position: { top } });
describe('Tool document history', () => {
  it('captures reading positions, traverses locally, and drops the forward branch on a new visit', () => {
    const a = location('/repo/a.md', 100), b = location('/repo/b.md', 200), c = location('/repo/c.png');
    const ab = commitToolHistory(null, a, b);
    const back = commitToolHistory(ab, { ...b, position: { top: 250 } }, a, 0);
    expect(back.entries[1].position).toEqual({ top: 250 });
    const branch = commitToolHistory(back, a, c);
    expect(branch).toEqual({ entries: [a, c], index: 1 });
    expect(ab.entries[1]).toEqual(b);
  });
  it('bounds history and accepts only an in-range cursor', () => {
    let history = commitToolHistory(null, location('0'), location('1'));
    for (let i = 2; i < 120; i++) history = commitToolHistory(history, location(String(i - 1)), location(String(i)));
    expect(history.entries).toHaveLength(100);
    expect(history.index).toBe(99);
    expect(history.entries[0].target).toBe('20');
    expect(toolHistory({ toolHistory: { entries: [], index: 0 } })).toBeNull();
  });
  it('takes the document directory on either host platform, including filesystem roots', () => {
    expect(documentDirectory('/a.md')).toBe('/');
    expect(documentDirectory('/repo/docs/a.md')).toBe('/repo/docs');
    expect(documentDirectory('C:\\a.md')).toBe('C:\\');
    expect(documentDirectory('C:\\repo\\a.md')).toBe('C:\\repo');
  });
});
