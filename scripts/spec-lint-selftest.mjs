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
 * instead of for its check. Check 15 (a large spec needs a rationale file) is
 * a number, not a pattern, and cannot be planted without also tripping the
 * structural checks, so it is not here. `scripts/lint-kit.mjs` owns the
 * edit-and-restore. Valid-form cases also keep optional navigation maps
 * compatible with targeted implementation pointers.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeSelftest, readRepoFile, repoRoot } from './lint-kit.mjs';
import { countWords } from './spec-md.mjs';

const budgets = JSON.parse(readRepoFile('scripts/spec-word-budgets.json'));
const SPEC = readdirSync(join(repoRoot, 'docs/specs'))
  .filter((f) => f.endsWith('.md') && !f.endsWith('.rationale.md'))
  .map((f) => `docs/specs/${f}`)
  .filter((f) => existsSync(join(repoRoot, f.replace(/\.md$/, '.rationale.md'))))
  .filter((f) => !/^##\s+(?:\d+\.\s*)?Future\s*$/m.test(readRepoFile(f)))
  .map((f) => [f, budgets[f] - countWords(readRepoFile(f))])
  .sort((a, b) => b[1] - a[1])[0][0];
const RATIONALE = SPEC.replace(/\.md$/, '.rationale.md');
const SOURCE = 'standalone/scripts/clean-dev-sidecar.mjs'; // a comment appended here disturbs nothing
// Assembled at runtime so this file's own planted citations are invisible to
// the citation check, which scans every tracked source file, this one included.
const spec = (name) => ['docs/specs', name].join('/');

const CASES = [
  ['check 4: a repo path that does not exist', SPEC, '\nSee `lib/src/no-such-file.ts`.\n'],
  ['check 11: a (rationale) marker under a heading the rationale does not key', SPEC, '\n## Planted\n\nA rule (rationale).\n'],
  ['check 11: the marker as the last item of its parenthetical', SPEC, '\n## Planted\n\nA rule (see below; rationale).\n'],
  ['check 12: a bare file name in Source of truth', SPEC, '\nSource of truth: `lint-kit.mjs`.\n'],
  ['check 12: a bare file name under a punctuated lead-in', SPEC, '\nSource of truth, all in `lib/src/lib/`: `Wall.tsx`.\n'],
  ['check 12: a symbol the named file lacks', SPEC, '\nSource of truth: `noSuchSymbolXyz` in `scripts/lint-kit.mjs`.\n'],
  ['check 13: a quoted citation of a heading that does not exist', SOURCE, `\n// ${spec('layout.md')} -> "No Such Heading"\n`],
  ['check 13: an unquoted citation of a heading that does not exist', SOURCE, `\n// ${spec('layout.md')} -> No Such Heading Here.\n`],
  ['check 13: a numbered section that does not exist', SOURCE, `\n// ${spec('mouse-and-clipboard.md')} §8.99\n`],
  ['check 13: a citation of a spec that does not exist', SOURCE, `\n// ${spec('no-such-spec.md')} -> "Heading"\n`],
  ['check 13: an unbackticked citation of a missing spec, from a spec', SPEC, `\nSee ${spec('no-such-spec.md')} -> "Heading" for more.\n`],
  ['check 14: a rule stated in a rationale file', RATIONALE, '\n**Never plant rules here.**\n'],
];

const selftest = makeSelftest('spec-lint.mjs', '.spec-selftest.bak');

// A one-entry map deliberately omits the file named by the local pointer:
// maps are navigation aids, not exhaustive implementation inventories.
// Run both supported headings, and prove map paths still get checked.
const originalSpec = readRepoFile(SPEC);
const specPath = join(repoRoot, SPEC);
for (const heading of ['Files', 'Code Map']) {
  const map = `\n## ${heading}\n\n| Entrypoint | Role |\n|---|---|\n| \`scripts/lint-kit.mjs\` | Lint plumbing. |\n\n## Map pointer fixture\n\nSource of truth: \`countWords\` in \`scripts/spec-md.mjs\`.\n`;
  try {
    writeFileSync(specPath, originalSpec + map);
    execFileSync('node', [join(repoRoot, 'scripts/spec-lint.mjs')], { stdio: 'pipe' });
    writeFileSync(specPath, originalSpec + map.replace('scripts/lint-kit.mjs', 'scripts/no-such-map-entry.mjs'));
    const result = spawnSync('node', [join(repoRoot, 'scripts/spec-lint.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${heading}: a missing map path must fail lint`);
    assert.match(result.stdout + result.stderr, /path does not exist -> scripts\/no-such-map-entry\.mjs/, `${heading}: require the map path diagnostic`);
  } finally {
    writeFileSync(specPath, originalSpec);
  }
}
console.log('spec-lint-selftest: OK (Files / Code Map coexist with pointers; partial maps pass and missing paths fail)');

for (const [name, target, text] of CASES) {
  selftest.withAppended(target, text, `${name}\n      planting this in ${target} stays green — spec-lint cannot see it`);
}

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
