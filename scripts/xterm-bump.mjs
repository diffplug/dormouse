#!/usr/bin/env node
/**
 * Derives a COHERENT `@xterm/*` set — core plus every addon built from the same
 * upstream commit — and writes it into `lib/` and `standalone/`.
 *
 * Renovate proposes the newest version of each package independently, which is
 * usually a set spanning two commits: the packages ship from one repo but
 * carry independent beta counters, and an addon is only published when its own
 * content changes. `scripts/xterm-lint.mjs` rejects such a set; this script
 * produces the one to replace it with.
 *
 *   node scripts/xterm-bump.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = '@xterm/xterm';
// Every addon lib pins: xterm-lint holds each one to the core, so a hand-kept
// list leaves a newly added addon on the old core.
const ADDONS = Object.keys(JSON.parse(readFileSync(join(ROOT, 'lib/package.json'), 'utf-8')).dependencies)
  .filter((name) => name.startsWith('@xterm/addon-'));
const UPSTREAM_REPO = 'xtermjs/xterm.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const betaOf = (v) => Number(/-beta\.(\d+)$/.exec(v)?.[1] ?? NaN);
// Upstream restarts the beta counter at 1 on every release line (5.4.0-beta.1..34,
// 5.5.0-beta.1..12, 5.6.0-beta.1..143, 6.1.0-beta.1..302), so betaOf alone neither
// orders nor identifies a version — four different versions answer to beta.12.
// Order and disambiguate on the whole tuple; betaOf only filters for betas.
const rankOf = (v) => (/^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(v)?.slice(1) ?? []).map(Number);
const newestFirst = (a, b) => {
  const [x, y] = [rankOf(a), rankOf(b)];
  for (let i = 0; i < 4; i++) if (y[i] !== x[i]) return y[i] - x[i];
  return 0;
};

/** version → { gitHead, peer } for every published beta of a package. */
async function betas(name) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  const { versions } = await res.json();
  return new Map(
    Object.entries(versions)
      .filter(([v, meta]) => Number.isFinite(betaOf(v)) && meta.gitHead)
      .map(([v, meta]) => [v, { gitHead: meta.gitHead, peer: meta.peerDependencies?.[CORE] }]),
  );
}

/** Rewrite exact dependency pins in a workspace package.json, in place. */
function repin(rel, pins) {
  const before = read(rel);
  let after = before;
  for (const [name, version] of Object.entries(pins)) {
    const re = new RegExp(`("${name.replace('/', '\\/')}"\\s*:\\s*)"[^"]*"`);
    if (!re.test(after)) throw new Error(`${rel}: no "${name}" dependency to repin`);
    after = after.replace(re, `$1"${version}"`);
  }
  if (after === before) return false;
  if (!dryRun) writeFileSync(join(ROOT, rel), after);
  return true;
}

// --- default mode: newest coherent set for lib + standalone ------------------

const packuments = new Map(
  await Promise.all([CORE, ...ADDONS].map(async (n) => [n, await betas(n)])),
);

const coreVersions = [...packuments.get(CORE).keys()].sort(newestFirst);
let chosen = null;
for (const version of coreVersions) {
  const { gitHead } = packuments.get(CORE).get(version);
  const set = { [CORE]: version };
  // Resolve every addon before judging the set — short-circuiting would make the
  // "missing" list below name addons that were simply never looked up.
  for (const name of ADDONS) {
    const hit = [...packuments.get(name).entries()].find(([, m]) => m.gitHead === gitHead);
    if (hit) set[name] = hit[0];
  }
  if (ADDONS.every((name) => name in set)) { chosen = { set, gitHead }; break; }
  if (version === coreVersions[0]) {
    const missing = ADDONS.filter((n) => !(n in set)).map((n) => n.replace('@xterm/', ''));
    console.log(
      `note: newest core ${version} has no matching publish of ${missing.join(', ')} — ` +
      'falling back to the newest commit that published every tracked package\n',
    );
  }
}
if (!chosen) {
  console.error('no upstream commit has every tracked package published — check the registry by hand');
  process.exit(1);
}

// The peer ranges are what xterm-lint checks; make sure the set we picked by
// gitHead also satisfies it, so a registry oddity can't produce a set that the
// linter then rejects.
for (const name of ADDONS) {
  const { peer } = packuments.get(name).get(chosen.set[name]);
  if (peer !== `^${chosen.set[CORE]}`) {
    console.error(
      `${name}@${chosen.set[name]} shares a gitHead with ${chosen.set[CORE]} but peers on ` +
      `${peer} — refusing to write a set xterm-lint would reject`,
    );
    process.exit(1);
  }
}

const current = JSON.parse(read('lib/package.json')).dependencies;
const standaloneCurrent = JSON.parse(read('standalone/package.json')).devDependencies;
// standalone pins only the subset its tests mock.
const standaloneSet = Object.fromEntries(Object.entries(chosen.set).filter(([n]) => n in standaloneCurrent));
const changed = [CORE, ...ADDONS].filter(
  (n) => current[n] !== chosen.set[n] || (n in standaloneSet && standaloneCurrent[n] !== chosen.set[n]),
);

console.log(`Coherent @xterm/* set from ${UPSTREAM_REPO}@${chosen.gitHead.slice(0, 8)}:\n`);
for (const name of [CORE, ...ADDONS]) {
  const now = current[name];
  const next = chosen.set[name];
  console.log(`  ${name.padEnd(32)} ${now === next ? `${next} (unchanged)` : `${now} → ${next}`}`);
}

if (changed.length === 0) {
  console.log('\nlib and standalone are already on the newest coherent set.');
} else {
  repin('lib/package.json', chosen.set);
  repin('standalone/package.json', standaloneSet);
  console.log(
    dryRun
      ? '\n--dry-run: no files written.'
      : '\nWrote lib/package.json and standalone/package.json. Run `pnpm install` next.',
  );
}

