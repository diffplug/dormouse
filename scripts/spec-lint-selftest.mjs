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
 * edit-and-restore.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const SOURCE = 'scripts/free-dev-port.mjs'; // a comment appended here disturbs nothing
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

for (const [name, target, text] of CASES) {
  selftest.withAppended(target, text, `${name}\n      planting this in ${target} stays green — spec-lint cannot see it`);
}

// Check 16 is not an append: a second claim has to land inside a domain's scope
// block, so it is planted as the first bullet under `**Scope` in one prompt.
const DOMAIN = '.github/audit/supply-chain.md';
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
