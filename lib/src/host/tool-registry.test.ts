import { describe, expect, it } from 'vitest';
import {
  ToolFileError,
  dedupeKeysEqual,
  parseToolFile,
  resolveDedupeKey,
} from './tool-registry';

const REPO = { path: '/repo/dormouse.yml', dir: '/repo', scope: 'repo' as const };
const USER = { path: '/home/me/.config/dormouse/tools.yml', dir: '/home/me/.config/dormouse', scope: 'user' as const };

function parse(text: string, opts = REPO) {
  return parseToolFile(text, opts);
}

describe('parseToolFile', () => {
  it('reads an entry with a key template', () => {
    const file = parse(`
tools:
  storybook:
    run: pnpm storybook
    prespawn_dedupe: [storybook, $PROJECT_ROOT]
`);
    expect(file.warnings).toEqual([]);
    expect(file.tools.get('storybook')).toEqual({
      name: 'storybook',
      run: 'pnpm storybook',
      dedupeTemplate: ['storybook', '$PROJECT_ROOT'],
    });
  });

  it('treats an absent prespawn_dedupe as no identity at all', () => {
    const file = parse('tools:\n  once:\n    run: echo hi\n');
    expect(file.tools.get('once')?.dedupeTemplate).toBeNull();
  });

  it('accepts a bare scalar as a one-element key', () => {
    const file = parse('tools:\n  clock:\n    run: tock\n    prespawn_dedupe: clock\n', USER);
    expect(file.tools.get('clock')?.dedupeTemplate).toEqual(['clock']);
  });

  it('treats an empty file and a file with no tools as empty, not broken', () => {
    expect(parse('').tools.size).toBe(0);
    expect(parse('# just a comment\n').tools.size).toBe(0);
    expect(parse('other: 1\n').tools.size).toBe(0);
  });

  it('rejects an unknown substitution rather than keeping it as a literal', () => {
    expect(() => parse('tools:\n  t:\n    run: x\n    prespawn_dedupe: [t, $PROJECTROOT]\n')).toThrow(
      /unknown substitution '\$PROJECTROOT'/,
    );
  });

  it('rejects $PROJECT_ROOT in a user-global file', () => {
    expect(() => parse('tools:\n  t:\n    run: x\n    prespawn_dedupe: [t, $PROJECT_ROOT]\n', USER)).toThrow(
      /only defined for a repo-local/,
    );
  });

  it('rejects an unknown reserved prespawn_* field', () => {
    expect(() => parse('tools:\n  t:\n    run: x\n    prespawn_port: true\n')).toThrow(
      /unknown reserved field 'prespawn_port'/,
    );
  });

  it('warns but keeps going for an unknown non-reserved field', () => {
    const file = parse('tools:\n  t:\n    run: x\n    colour: blue\n');
    expect(file.tools.has('t')).toBe(true);
    expect(file.warnings).toEqual([expect.stringContaining("ignoring unknown field 'colour'")]);
  });

  it('warns on a repo-local key with no project scope', () => {
    const file = parse('tools:\n  t:\n    run: x\n    prespawn_dedupe: [t]\n');
    expect(file.warnings).toEqual([expect.stringContaining('no $PROJECT_ROOT')]);
    expect(file.tools.get('t')?.dedupeTemplate).toEqual(['t']);
  });

  it('does not warn about project scope for a user-global key', () => {
    expect(parse('tools:\n  t:\n    run: x\n    prespawn_dedupe: [t]\n', USER).warnings).toEqual([]);
  });

  it('requires a non-empty run', () => {
    expect(() => parse('tools:\n  t:\n    prespawn_dedupe: [t]\n')).toThrow(/'run' is required/);
    expect(() => parse('tools:\n  t:\n    run: "   "\n')).toThrow(/'run' is required/);
  });

  it('rejects structurally wrong documents with the file path in the message', () => {
    expect(() => parse('- a\n- b\n')).toThrow(/\/repo\/dormouse\.yml: expected a mapping/);
    expect(() => parse('tools: 3\n')).toThrow(/'tools' must be a mapping/);
    expect(() => parse('tools:\n  t: 3\n')).toThrow(/entry must be a mapping/);
    expect(() => parse('tools:\n  t:\n    run: x\n    prespawn_dedupe: []\n')).toThrow(/cannot be empty/);
    expect(() => parse('tools:\n  t:\n    run: x\n    prespawn_dedupe: [{a: 1}]\n')).toThrow(/must be strings/);
  });

  it('reports malformed YAML as a ToolFileError naming the file', () => {
    expect(() => parse('tools:\n  - [\n')).toThrow(ToolFileError);
    expect(() => parse('tools:\n  - [\n')).toThrow(/\/repo\/dormouse\.yml:/);
  });
});

describe('resolveDedupeKey', () => {
  const entry = (dedupeTemplate: string[] | null) => ({ name: 't', run: 'x', dedupeTemplate });

  it('is null when the entry declared no template', () => {
    expect(resolveDedupeKey(entry(null), { projectRoot: '/repo', cwd: '/repo/lib' })).toBeNull();
  });

  it('substitutes the project root and the caller cwd', () => {
    expect(
      resolveDedupeKey(entry(['t', '$PROJECT_ROOT', '$CWD']), { projectRoot: '/repo', cwd: '/repo/lib' }),
    ).toEqual(['t', '/repo', '/repo/lib']);
  });

  it('substitutes inside a larger string', () => {
    expect(resolveDedupeKey(entry(['tool@$PROJECT_ROOT']), { projectRoot: '/repo', cwd: '/x' })).toEqual([
      'tool@/repo',
    ]);
  });

  it('keeps two worktrees distinct — the case the list shape exists for', () => {
    const template = ['storybook', '$PROJECT_ROOT'];
    const a = resolveDedupeKey(entry(template), { projectRoot: '/repo', cwd: '/repo' });
    const b = resolveDedupeKey(entry(template), { projectRoot: '/repo.phase-b', cwd: '/repo.phase-b' });
    expect(dedupeKeysEqual(a, b)).toBe(false);
  });

  it('throws rather than emitting a literal $PROJECT_ROOT when none is defined', () => {
    expect(() => resolveDedupeKey(entry(['t', '$PROJECT_ROOT']), { projectRoot: null, cwd: '/x' })).toThrow(
      /\$PROJECT_ROOT is not defined/,
    );
  });
});

describe('dedupeKeysEqual', () => {
  it('matches element-wise', () => {
    expect(dedupeKeysEqual(['a', '/r'], ['a', '/r'])).toBe(true);
    expect(dedupeKeysEqual(['a', '/r'], ['a', '/s'])).toBe(false);
    expect(dedupeKeysEqual(['a'], ['a', '/r'])).toBe(false);
  });

  it('never matches a null key against anything, including another null', () => {
    expect(dedupeKeysEqual(null, ['a'])).toBe(false);
    expect(dedupeKeysEqual(['a'], null)).toBe(false);
    expect(dedupeKeysEqual(null, null)).toBe(false);
  });
});
