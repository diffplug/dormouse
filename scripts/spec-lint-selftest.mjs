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
 * Each planted text is a few words, well inside the target's word-budget
 * headroom, so a case cannot go red for the budget instead of for its check.
 * Check 15 (a large spec needs a rationale file) is a number, not a pattern,
 * and cannot be planted without also tripping the structural checks, so it is
 * not here. `scripts/lint-kit.mjs` owns the edit-and-restore.
 */

import { makeSelftest } from './lint-kit.mjs';

const SPEC = 'docs/specs/auto-update.md'; // small, has a rationale file, no ## Future
const RATIONALE = 'docs/specs/auto-update.rationale.md';
const SOURCE = 'scripts/free-dev-port.mjs'; // a comment appended here disturbs nothing
// Assembled at runtime so this file's own planted citations are invisible to
// the citation check, which scans every tracked source file, this one included.
const spec = (name) => ['docs/specs', name].join('/');

const CASES = [
  ['check 4: a repo path that does not exist', SPEC, '\nSee `lib/src/no-such-file.ts`.\n'],
  ['check 11: a (rationale) marker under a heading the rationale does not key', SPEC, '\n## Planted\n\nA rule (rationale).\n'],
  ['check 11: the marker as the last item of its parenthetical', SPEC, '\n## Planted\n\nA rule (see below; rationale).\n'],
  ['check 12: a bare file name in Source of truth', SPEC, '\nSource of truth: `updater.ts`.\n'],
  ['check 12: a symbol the named file lacks', SPEC, '\nSource of truth: `noSuchSymbolXyz` in `standalone/src/updater.ts`.\n'],
  ['check 13: a quoted citation of a heading that does not exist', SOURCE, `\n// ${spec('layout.md')} -> "No Such Heading"\n`],
  ['check 13: an unquoted citation of a heading that does not exist', SOURCE, `\n// ${spec('layout.md')} -> No Such Heading Here.\n`],
  ['check 13: a numbered section that does not exist', SOURCE, `\n// ${spec('mouse-and-clipboard.md')} §8.99\n`],
  ['check 14: a rule stated in a rationale file', RATIONALE, '\n**Never plant rules here.**\n'],
];

const selftest = makeSelftest('spec-lint.mjs', '.spec-selftest.bak');

for (const [name, target, text] of CASES) {
  selftest.withAppended(target, text, `${name}\n      planting this in ${target} stays green — spec-lint cannot see it`);
}

selftest.finish(
  'spec-lint-selftest',
  'Each case plants one defect a finding check in scripts/spec-lint.mjs exists to\n'
  + 'catch. A case that stays green means that check no longer matches the form it\n'
  + 'claims to, so the convention it enforces (AGENTS.md -> "Specs") is a reading,\n'
  + 'not a build failure.',
);
