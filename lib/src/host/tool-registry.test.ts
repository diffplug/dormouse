import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TOOL_DESCRIPTION_LIMIT,
  ToolFileError,
  parseToolFile,
  resolveDedupeKey,
} from './tool-registry';

const REPO = { path: '/repo/dormouse.yml', dir: '/repo', scope: 'repo' as const };
const USER = { path: '/home/me/.config/dormouse/tools.yml', dir: '/home/me/.config/dormouse', scope: 'user' as const };

function parse(text: string, opts = REPO) {
  return parseToolFile(text, opts);
}

describe('Tool descriptions', () => {
  const descriptions = (text: string) => new Map([...parse(text).tools.values()].map(entry => [entry.name, entry.description]));

  const TEXT = `# About this file, not a Tool.
tools:
  # The first entry's comment, which yaml hangs on the map.
  # Second line.
  first:
    run: echo 1
    # A field comment describes the field, not the Tool.
    port: auto

  # A later entry's, on its key.
  second:
    run: echo 2
  third:
    run: echo 3
`;

  it('takes the comment block directly above each entry', () => {
    expect(Object.fromEntries(descriptions(TEXT))).toEqual({
      first: "The first entry's comment, which yaml hangs on the map.\nSecond line.",
      second: "A later entry's, on its key.",
      third: null,
    });
  });

  it('turns tabs into spaces and bounds the length, leaving escaping to the printer', () => {
    const found = descriptions(`tools:\n  # a\tb \u009b31m c\n  x:\n    run: echo\n  # ${'y'.repeat(TOOL_DESCRIPTION_LIMIT + 10)}\n  z:\n    run: echo\n`);
    expect(found.get('x')).toBe('a b \u009b31m c');
    expect(found.get('z')).toHaveLength(TOOL_DESCRIPTION_LIMIT);
    expect(found.get('z')!.endsWith('…')).toBe(true);
  });
});

describe('parseToolFile', () => {
  it.each([REPO, USER])('reserves builtin: tool names in $scope configuration', opts => {
    for (const name of ['builtin:file', 'builtin:other']) {
      expect(() => parse(`tools:\n  ${name}:\n    run: [viewer]\n`, opts)).toThrow(/'builtin:' prefix is reserved/);
    }
  });

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
      render: 'iframe',
      port: 'announced',
      dedupeTemplate: ['storybook', '$PROJECT_ROOT'],
      description: null,
    });
  });

  it('reads an agent-browser-screencast renderer, the one that makes a tool agent-drivable', () => {
    const file = parse('tools:\n  harness:\n    run: pnpm dev\n    render: agent-browser-screencast\n');
    expect(file.tools.get('harness')?.render).toBe('agent-browser-screencast');
  });

  it('defaults port selection to announced, so nothing guesses unless asked', () => {
    expect(parse('tools:\n  t:\n    run: x\n').tools.get('t')?.port).toBe('announced');
  });

  it('reads autobind', () => {
    expect(parse('tools:\n  t:\n    run: x\n    port: auto\n').tools.get('t')?.port).toBe('auto');
  });

  it('rejects an unknown port mode', () => {
    expect(() => parse('tools:\n  t:\n    run: x\n    port: 6006\n')).toThrow(/'port' must be one of/);
    expect(() => parse('tools:\n  t:\n    run: x\n    port: first\n')).toThrow(/'port' must be one of/);
  });

  it('rejects an unknown renderer', () => {
    expect(() => parse('tools:\n  t:\n    run: x\n    render: canvas\n')).toThrow(/'render' must be one of/);
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

  it('warns when different target files would reuse one Tool', () => {
    const file = parse('tools:\n  viewer:\n    run: [viewer, --file=$TARGET]\n    prespawn_dedupe: [viewer]\n', USER);
    expect(file.warnings).toEqual([expect.stringContaining('no $TARGET')]);
    expect(file.tools.get('viewer')?.dedupeTemplate).toEqual(['viewer']);
  });

  it.each([
    '    prespawn_dedupe: [viewer, file=$TARGET]\n',
    '',
  ])('does not warn for target-aware reuse or a fresh Tool: %s', (dedupe) => {
    expect(parse('tools:\n  viewer:\n    run: [viewer, $TARGET]\n' + dedupe, USER).warnings).toEqual([]);
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

  // Each field the trust prompt shows or a shell receives: the text shown must
  // be the text that runs (`docs/specs/security-local.md` -> Dor Tool configuration).
  const HIDDEN = [
    ['DEL', '\\x7f'], ['C0', '\\x15'], ['newline', '\\n'], ['tab', '\\t'], ['C1', '\\u009b'],
    ['right-to-left override', '\\u202e'], ['isolate', '\\u2067'], ['right-to-left mark', '\\u200f'],
    ['zero-width space', '\\u200b'], ['byte order mark', '\\ufeff'],
  ];
  it.each(HIDDEN)('refuses %s in a string run, an argument, a name, and a key', (_, escape) => {
    expect(() => parse(`tools:\n  t:\n    run: "echo \\"${escape}hi\\""\n`)).toThrow(/run cannot contain terminal control characters or invisible formatting/);
    expect(() => parse(`tools:\n  t:\n    run: [echo, "a${escape}b"]\n`, USER)).toThrow(/run cannot contain/);
    expect(() => parse(`tools:\n  "t${escape}":\n    run: echo\n`)).toThrow(/tool names cannot contain/);
    expect(() => parse(`tools:\n  t:\n    run: echo\n    prespawn_dedupe: [t, "a${escape}b"]\n`)).toThrow(/prespawn_dedupe cannot contain/);
  });

  it('keeps a string run that only YAML line folding ends with a newline', () => {
    expect(parse('tools:\n  t:\n    run: |\n      pnpm dev\n').tools.get('t')?.run).toBe('pnpm dev');
  });

  it('reports malformed YAML as a ToolFileError naming the file', () => {
    expect(() => parse('tools:\n  - [\n')).toThrow(ToolFileError);
    expect(() => parse('tools:\n  - [\n')).toThrow(/\/repo\/dormouse\.yml:/);
  });
});

describe('resolveDedupeKey', () => {
  const entry = (dedupeTemplate: string[] | null) =>
    ({ name: 't', run: 'x', render: 'iframe' as const, port: 'announced' as const, dedupeTemplate });

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
    expect(a).not.toEqual(b);
  });

  it('throws rather than emitting a literal $PROJECT_ROOT when none is defined', () => {
    expect(() => resolveDedupeKey(entry(['t', '$PROJECT_ROOT']), { projectRoot: null, cwd: '/x' })).toThrow(
      /\$PROJECT_ROOT is not defined/,
    );
  });
});

describe("this repo's own dormouse.yml", () => {
  // Pins the file shipped at the repo root against the parser, so a typo in a
  // substitution or a stray field fails here rather than at `dor tool` time.
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const file = parseToolFile(readFileSync(join(repoRoot, 'dormouse.yml'), 'utf-8'), {
    path: 'dormouse.yml',
    dir: repoRoot,
    scope: 'repo',
  });

  it('parses with no warnings', () => {
    expect(file.warnings).toEqual([]);
  });

  it('declares the shipped tools', () => {
    expect([...file.tools.keys()].sort()).toEqual([
      'hosted',
      'innerdogfood',
      'one-time',
      'relay',
      'storybook',
      'website',
    ]);
    expect(file.tools.get('storybook')?.run).toBe('pnpm storybook');
    expect(file.tools.get('innerdogfood')?.run).toBe('pnpm innerdogfood');
    // Every Tool is agent-drivable, and the Relay and Hosted sign-ins need the
    // cookies an iframe drops.
    for (const name of ['storybook', 'innerdogfood', 'website', 'relay', 'hosted', 'one-time']) {
      expect(file.tools.get(name)?.render).toBe('agent-browser-screencast');
    }
    // innerdogfood announces, because its dev bridge binds before vite, and
    // one-time because Wrangler's inspector binds beside its Worker; the rest
    // autobind the one port they open.
    for (const name of ['innerdogfood', 'one-time']) {
      expect(file.tools.get(name)?.port).toBe('announced');
    }
    for (const name of ['storybook', 'website', 'relay', 'hosted']) {
      expect(file.tools.get(name)?.port).toBe('auto');
    }
  });

  it('documents every Tool with the comment `dor tool --list` shows', () => {
    for (const entry of file.tools.values()) expect(entry.description, entry.name).toBeTruthy();
  });

  it('scopes every key to the checkout, so parallel worktrees stay distinct', () => {
    for (const entry of file.tools.values()) {
      const a = resolveDedupeKey(entry, { projectRoot: '/w/one', cwd: '/w/one' });
      const b = resolveDedupeKey(entry, { projectRoot: '/w/two', cwd: '/w/two' });
      expect(a).not.toBeNull();
      expect(a).not.toEqual(b);
    }
  });
});

it('rejects a shell command with a target-only dedupe key at declaration time', () => {
  expect(() => parse('tools:\n  viewer:\n    run: view\n    prespawn_dedupe: [$TARGET]\n'))
    .toThrow('$TARGET in prespawn_dedupe requires an argument-list run');
});

it('keeps project associations inert and validates user associations at declaration time', () => {
  expect(parse('open: malformed-but-inert\n').warnings).toEqual([expect.stringContaining('project open rules are ignored')]);
  expect(() => parse('open: nope\n', USER)).toThrow("'open' must be an ordered list");
  expect(() => parse('open:\n  - {match: "*.md", tool: missing}\n', USER))
    .toThrow('defined in this user file');
  expect(() => parse('tools:\n  viewer:\n    run: [viewer]\nopen:\n  - {match: "*.md", tool: viewer, extra: true}\n', USER))
    .toThrow("unknown field 'extra'");
  expect(() => parse('tools:\n  viewer:\n    run: viewer\nopen:\n  - {match: "*.md", tool: viewer}\n', USER))
    .toThrow("open rule for 'viewer' needs an argument-list run");
});

it('rejects an explicit empty tools block while allowing an absent block', () => {
  expect(() => parse('tools:\nopen: []\n', USER)).toThrow("'tools' must be a mapping");
  expect(parse('open: []\n', USER).tools.size).toBe(0);
});

it('names unknown fields on built-in file associations', () => {
  expect(() => parse('open:\n  - {match: "*.md", tool: "builtin:file", extra: true}\n', USER))
    .toThrow("open rule for 'builtin:file' has an unknown field 'extra' (known: match, tool, preview)");
});

describe('folder rules and preview handlers', () => {
  const VIEWER = 'tools:\n  viewer:\n    run: [viewer]\n  shell:\n    run: viewer\n';
  const rules = (...lines: string[]) => parse(`${VIEWER}open:\n${lines.map(line => `  - ${line}\n`).join('')}`, USER).open;

  it('accepts the built-in handler of each rule\'s kind, for its tool and its preview', () => {
    expect(rules('{match: "*.📁", tool: "builtin:folder", preview: viewer}', '{match: "*.md", tool: viewer, preview: "builtin:file"}', '{match: "*.html", tool: "builtin:code"}')).toEqual([
      { match: '*.📁', tool: 'builtin:folder', preview: 'viewer' },
      { match: '*.md', tool: 'viewer', preview: 'builtin:file' },
      { match: '*.html', tool: 'builtin:code' },
    ]);
  });

  it.each([
    ['{match: "*.📁", tool: "builtin:file"}', "open rule '*.📁' names builtin:file as its tool, which opens files, but a pattern ending in .📁 matches only folders"],
    ['{match: "*.📁", tool: viewer, preview: "builtin:file"}', "open rule '*.📁' names builtin:file as its preview"],
    ['{match: "*.📁", tool: "builtin:code"}', "open rule '*.📁' names builtin:code as its tool, which opens files"],
    ['{match: "*", tool: "builtin:folder"}', "open rule '*' names builtin:folder as its tool, which opens folders, but only a pattern ending in .📁 matches folders"],
    ['{match: "*.md", tool: viewer, preview: "builtin:folder"}', "open rule '*.md' names builtin:folder as its preview"],
  ])('rejects a built-in handler of the other kind: %s', (rule, message) => {
    expect(() => rules(rule)).toThrow(message);
  });

  it('validates preview as it validates tool', () => {
    expect(() => rules('{match: "*.md", tool: viewer, preview: missing}')).toThrow("open rule '*.md' needs a preview defined in this user file");
    expect(() => rules('{match: "*.md", tool: viewer, preview: shell}')).toThrow("open rule for 'shell' needs an argument-list run");
    expect(() => rules('{match: "*.md", tool: viewer, preview: 3}')).toThrow('needs a preview defined');
  });
});
