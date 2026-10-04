#!/usr/bin/env node
/**
 * Proves the finding checks in `spec-lint.mjs` are load-bearing: plant one
 * defect per check in a real, tracked file and require the lint to go red.
 *
 * A finding check's characteristic failure is passing because its pattern no
 * longer matches what somebody wrote — a `(rationale)` marker spelled a new
 * way, a citation in a form the regex cannot see. A green run says nothing
 * about that; a planted defect that stays green does.
 *
 * The spec the cases plant into is chosen at run time: one with a rationale
 * file, no `## Future` (a planted heading must not land after the fold), and
 * the most room under its word budget, so a case cannot go red for the budget
 * instead of for its check. Check 17's case needs a spec that is *not* a
 * security spec, which headroom alone cannot promise, so it picks the same way
 * from the specs that qualify. Check 15 is a number rather than a pattern: its
 * case removes a paired rationale file instead of planting text.
 * `scripts/lint-kit.mjs` owns the edit-and-restore.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeSelftest, readRepoFile, repoRoot } from './lint-kit.mjs';
import { countWords } from './spec-md.mjs';

const budgets = JSON.parse(readRepoFile('scripts/spec-word-budgets.json'));
const BY_HEADROOM = readdirSync(join(repoRoot, 'docs/specs'))
  .filter((f) => f.endsWith('.md') && !f.endsWith('.rationale.md'))
  .map((f) => `docs/specs/${f}`)
  .filter((f) => existsSync(join(repoRoot, f.replace(/\.md$/, '.rationale.md'))))
  .filter((f) => !/^##\s+(?:\d+\.\s*)?Future\s*$/m.test(readRepoFile(f)))
  .map((f) => [f, budgets[f] - countWords(readRepoFile(f))])
  .sort((a, b) => b[1] - a[1])
  .map(([f]) => f);
const SPEC = BY_HEADROOM[0];
const NON_SECURITY_SPEC = BY_HEADROOM.find((f) => !/\/security[a-z-]*\.md$/.test(f));
assert.ok(NON_SECURITY_SPEC, 'check 17 needs a non-security spec to plant into');
const RATIONALE = SPEC.replace(/\.md$/, '.rationale.md');
// Check 15 pairs a root-level spec with a root-level rationale; removing that
// file is the only way to plant the defect it exists to catch. Asserted
// present first: deleting what is already gone would "hold" while proving
// nothing.
const ROOT_RATIONALE = 'SELF_HOST.rationale.md';
assert.ok(existsSync(join(repoRoot, ROOT_RATIONALE)), `check 15 needs ${ROOT_RATIONALE} to remove`);
const SOURCE = 'standalone/scripts/clean-dev-sidecar.mjs'; // a comment appended here disturbs nothing
// Assembled at runtime so this file's own planted citations are invisible to
// the citation check, which scans every tracked source file, this one included.
const spec = (name) => ['docs/specs', name].join('/');

const EXTERNAL_SPEC = ['docs', 'compatible-agents.md'].join('/');
const EXTERNAL_RATIONALE = EXTERNAL_SPEC.replace(/\.md$/, '.rationale.md');

const CASES = [
  ['check 4: a missing path in an external spec', EXTERNAL_SPEC, '\nSee `lib/src/no-such-file.ts`.\n'],
  ['check 8: an external rationale key with no heading', EXTERNAL_RATIONALE, '\n## No matching heading\n'],
  ['check 13: a missing heading in an external spec', SOURCE, `\n// ${EXTERNAL_SPEC} -> "No Such Heading"\n`],
  ['check 4: a repo path that does not exist', SPEC, '\nSee `lib/src/no-such-file.ts`.\n'],
  ['check 11: a (rationale) marker under a heading the rationale does not key', SPEC, '\n## Planted\n\nA rule (rationale).\n'],
  ['check 11: the marker as the last item of its parenthetical', SPEC, '\n## Planted\n\nA rule (see below; rationale).\n'],
  ['check 12: a bare file name in Source of truth', SPEC, '\nSource of truth: `lint-kit.mjs`.\n'],
  ['check 12: a bare file name under a punctuated lead-in', SPEC, '\nSource of truth, all in `lib/src/lib/`: `Wall.tsx`.\n'],
  ['check 12: a symbol the named file lacks', SPEC, '\nSource of truth: `noSuchSymbolXyz` in `scripts/lint-kit.mjs`.\n'],
  ['check 12: a symbol the named file lacks, in prose outside Source of truth', SPEC, '\nThe guard is `noSuchSymbolXyz` in `scripts/lint-kit.mjs`.\n'],
  ['check 13: a quoted citation of a heading that does not exist', SOURCE, `\n// ${spec('layout.md')} -> "No Such Heading"\n`],
  ['check 13: a later heading in a quoted list that does not exist', SOURCE, `\n// ${spec('layout.md')} -> "Modes", "Workspaces" and "No Such Heading"\n`],
  ['check 13: a quoted heading that wraps onto the next line and does not exist', SOURCE, `\n// ${spec('layout.md')} -> "No Such\n// Heading"\n`],
  ['check 13: an unquoted citation of a heading that does not exist', SOURCE, `\n// ${spec('layout.md')} -> No Such Heading Here.\n`],
  ['check 13: a numbered section that does not exist', SOURCE, `\n// ${spec('mouse-and-clipboard.md')} §8.99\n`],
  ['check 13: a citation of a spec that does not exist', SOURCE, `\n// ${spec('no-such-spec.md')} -> "Heading"\n`],
  ['check 13: an unbackticked citation of a missing spec, from a spec', SPEC, `\nSee ${spec('no-such-spec.md')} -> "Heading" for more.\n`],
  ['check 14: a rule stated in a rationale file', RATIONALE, '\n**Never plant rules here.**\n'],
  ['check 17: an audited rule outside a security spec', NON_SECURITY_SPEC, '\n- **FAIL IF** this rule is audited by nobody.\n'],
  ['check 18: a Future that opens without a named scope', SPEC, '\n## Future\n\nA wish nobody staged.\n'],
  ['check 18: a scope that lists nothing before the next heading', SPEC, '\n## Future\n\n**Scope: planted-empty**\n\n### Planted\n\nText.\n'],
  ['check 18: a scope whose lead introduces a list that is not there', SPEC, '\n## Future\n\n**Scope: planted-intro** — in order:\n\n**Scope: planted-next** — one item.\n'],
  ['check 9: a map beside a Source of truth pointer', SPEC, '\n## Files\n\n| Entrypoint | Role |\n|---|---|\n| `scripts/lint-kit.mjs` | Lint plumbing. |\n\nSource of truth: `countWords` in `scripts/spec-md.mjs`.\n'],
];

const selftest = makeSelftest('spec-lint.mjs', '.spec-selftest.bak');

// Check 9 must also pass a map alone: the fixture renames SPEC's own pointers
// out of the way, and runs each heading spelling the lint accepts. A missing
// map path must still fail check 4.
const originalSpec = readRepoFile(SPEC);
const specPath = join(repoRoot, SPEC);
const pointerless = originalSpec.replace(/Source of truth/g, 'Implemented in');
const runSpecLint = () => spawnSync('node', [join(repoRoot, 'scripts/spec-lint.mjs')], { encoding: 'utf8' });
for (const heading of ['## Files', '### Code map']) {
  const map = `\n${heading}\n\n| Entrypoint | Role |\n|---|---|\n| \`scripts/lint-kit.mjs\` | Lint plumbing. |\n`;
  try {
    writeFileSync(specPath, pointerless + map);
    let result = runSpecLint();
    assert.equal(result.status, 0, `${heading}: a map alone must pass lint\n${result.stdout}${result.stderr}`);
    writeFileSync(specPath, pointerless + map.replace('scripts/lint-kit.mjs', 'scripts/no-such-map-entry.mjs'));
    result = runSpecLint();
    assert.equal(result.status, 1, `${heading}: a missing map path must fail lint`);
    assert.match(result.stdout + result.stderr, /path does not exist -> scripts\/no-such-map-entry\.mjs/, `${heading}: require the map path diagnostic`);
  } finally {
    writeFileSync(specPath, originalSpec);
  }
}
console.log('spec-lint-selftest: OK (check 9 passes a map alone; a missing map path fails)');

for (const [name, target, text] of CASES) {
  selftest.withAppended(target, text, `${name}\n      planting this in ${target} stays green — spec-lint cannot see it`);
}

selftest.withMutation(
  EXTERNAL_SPEC,
  (path) => writeFileSync(path, readRepoFile(EXTERNAL_SPEC).replace(/^> (?:- )?See.*glossary[^\n]*\n/m, '')),
  'check 5: an external spec without its glossary front matter',
);

selftest.withMutation(
  ROOT_RATIONALE,
  (path) => rmSync(path, { force: true }),
  `check 15: a large root-level spec with no rationale file\n      removing ${ROOT_RATIONALE} stays green — spec-lint cannot see it`,
);

// Check 16's failures need separate mutations so one ownership diagnostic
// cannot hide another one regressing.
const DOMAIN = '.github/audit/supply-chain.md';
const PLANTED_DOMAIN = '.github/audit/planted-selftest.md';
selftest.withMutation(
  PLANTED_DOMAIN,
  (path) => writeFileSync(path, '# Planted domain with no scope\n'),
  `check 16: an audit domain with no **Scope line\n      planting ${PLANTED_DOMAIN} stays green — spec-lint cannot see it`,
);

selftest.withMutation(
  PLANTED_DOMAIN,
  (path) => writeFileSync(path, '# Planted empty domain\n\n**Scope — these specs, and no others:**\n'),
  `check 16: an audit domain whose scope names no spec\n      planting ${PLANTED_DOMAIN} stays green — spec-lint cannot see it`,
);

selftest.withMutation(
  DOMAIN,
  (path) => {
    const text = readFileSync(path, 'utf8');
    const planted = text.replace(/^([*-] `docs\/specs\/security-supply-chain\.md`\n)/m, '$1- `docs/specs/security-no-such-spec.md`\n');
    if (planted === text) throw new Error(`${DOMAIN}: no security spec claim to plant under`);
    writeFileSync(path, planted);
  },
  `check 16: an audit domain claims a security spec that does not exist\n      planting an unknown path in ${DOMAIN} stays green — spec-lint cannot see it`,
);

selftest.withMutation(
  '.github/audit/ci-and-secrets.md',
  (path) => {
    const text = readFileSync(path, 'utf8');
    const planted = text.replace(/^[*-] `docs\/specs\/security-ci\.md`\n/m, '');
    if (planted === text) throw new Error(`${path}: no security-ci claim to remove`);
    writeFileSync(path, planted);
  },
  'check 16: a security spec claimed by no audit domain\n      removing its sole claim stays green — spec-lint cannot see it',
);

selftest.withMutation(
  DOMAIN,
  (path) => {
    const text = readFileSync(path, 'utf8');
    const planted = text.replace(/^(\*\*Scope[^\n]*\n\n)/m, '$1- `docs/specs/security-ci.md`\n');
    if (planted === text) throw new Error(`${DOMAIN}: no "**Scope" line to plant under`);
    writeFileSync(path, planted);
  },
  `check 16: a security spec claimed by two audit domains\n      planting a second claim in ${DOMAIN} stays green — spec-lint cannot see it`,
);

selftest.finish(
  'spec-lint-selftest',
  'Each case plants one defect a finding check in scripts/spec-lint.mjs exists to\n'
  + 'catch. A case that stays green means that check no longer matches the form it\n'
  + 'claims to, so the convention it enforces (AGENTS.md -> "Specs") is a reading,\n'
  + 'not a build failure.',
);
