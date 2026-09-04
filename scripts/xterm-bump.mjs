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
 * It also prints the fork follow-up that `docs/specs/webgl-text.md`
 * ("Following upstream") requires: the upstream compare range since canopy's
 * fork base, whether that range touches `addons/addon-webgl/`, and the fork
 * version to cut. Reading that diff and judging the merge stays human work.
 *
 *   node scripts/xterm-bump.mjs [--dry-run]
 *   node scripts/xterm-bump.mjs --canopy 0.20.0-sdf301.1
 *
 * `--canopy <forkVersion>` repins canopy onto a fork release that has already
 * been cut: the tarball URL, the pristine upstream addon and core, all to the
 * commit that fork version encodes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = '@xterm/xterm';
const ADDONS = [
  '@xterm/addon-fit',
  '@xterm/addon-image',
  '@xterm/addon-unicode-graphemes',
  '@xterm/addon-webgl',
];
const FORK_ADDON = '@diffplug/xterm-addon-webgl-sdf';
const UPSTREAM_REPO = 'xtermjs/xterm.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const canopyFlag = args.indexOf('--canopy');
const canopyVersion = canopyFlag === -1 ? null : args[canopyFlag + 1] ?? '';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const betaOf = (v) => Number(/-beta\.(\d+)$/.exec(v)?.[1] ?? NaN);
// Upstream restarts the beta counter at 1 on every release line (5.4.0-beta.1..34,
// 5.5.0-beta.1..12, 5.6.0-beta.1..143, 6.1.0-beta.1..302), so betaOf alone neither
// orders nor identifies a version — four different versions answer to beta.12.
// Order and disambiguate on the whole tuple; betaOf is only for printing an sdf tag.
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

// --- canopy mode: repin onto an already-cut fork release ---------------------

if (canopyFlag !== -1) {
  const sdf = /-sdf(\d+)\.\d+$/.exec(canopyVersion);
  if (!sdf) {
    console.error(`--canopy expects <addon-version>-sdf<coreBeta>.<iteration>, got "${canopyVersion}"`);
    process.exit(1);
  }
  const coreBeta = Number(sdf[1]);
  const [core, webgl] = await Promise.all([betas(CORE), betas('@xterm/addon-webgl')]);
  // The -sdfNNN tag records only the counter, which repeats across release lines, so
  // registry order would hand back the OLDEST line carrying it. Take the newest, and
  // say so when the tag was ambiguous — the tag cannot prove which line it meant.
  const candidates = [...core.keys()].filter((v) => betaOf(v) === coreBeta).sort(newestFirst);
  const coreVersion = candidates[0];
  if (!coreVersion) {
    console.error(`no published ${CORE} at beta.${coreBeta} — is the fork version right?`);
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.log(
      `note: beta.${coreBeta} exists on ${candidates.length} release lines ` +
      `(${candidates.join(', ')}); assuming the newest. Confirm against the fork's base commit ` +
      'before trusting the pins below.\n',
    );
  }
  const head = core.get(coreVersion).gitHead;
  const webglVersion = [...webgl.entries()].find(([, m]) => m.gitHead === head)?.[0];
  if (!webglVersion) {
    console.error(
      `no @xterm/addon-webgl published from ${head.slice(0, 8)} (${coreVersion}) — canopy's ` +
      'UpstreamVsFork baseline must be the same commit as the fork base, so the fork should ' +
      'be rebased onto a commit that has one',
    );
    process.exit(1);
  }
  const url = `https://github.com/diffplug/xterm.js/releases/download/sdf-v${canopyVersion}/diffplug-xterm-addon-webgl-sdf-${canopyVersion}.tgz`;
  repin('canopy/package.json', { [FORK_ADDON]: url, '@xterm/addon-webgl': webglVersion, [CORE]: coreVersion });
  console.log(
    `canopy → fork ${canopyVersion}, ${CORE} ${coreVersion}, @xterm/addon-webgl ${webglVersion}` +
    (dryRun ? '  (--dry-run: no files written)' : ''),
  );
  console.log(`upstream base commit: ${head}`);
  console.log(
    '\nAlso update the version-correspondence comment at the UpstreamWebglAddon import in\n' +
    'canopy/src/GlTerminal.stories.tsx and the same triple in canopy/README.md, then run ' +
    '`pnpm install`.',
  );
  process.exit(0);
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
const changed = [CORE, ...ADDONS].filter((n) => current[n] !== chosen.set[n]);

console.log(`Coherent @xterm/* set from ${UPSTREAM_REPO}@${chosen.gitHead.slice(0, 8)}:\n`);
for (const name of [CORE, ...ADDONS]) {
  const now = current[name];
  const next = chosen.set[name];
  console.log(`  ${name.padEnd(32)} ${now === next ? `${next} (unchanged)` : `${now} → ${next}`}`);
}

if (changed.length === 0) {
  console.log('\nlib and standalone are already on the newest coherent set.');
} else {
  for (const rel of ['lib/package.json', 'standalone/package.json']) repin(rel, chosen.set);
  console.log(
    dryRun
      ? '\n--dry-run: no files written.'
      : '\nWrote lib/package.json and standalone/package.json. Run `pnpm install` next.',
  );
}

// --- fork follow-up ----------------------------------------------------------

const canopyCore = JSON.parse(read('canopy/package.json')).dependencies[CORE];
const forkBase = packuments.get(CORE).get(canopyCore)?.gitHead;
console.log(`\nFork (${FORK_ADDON}) — canopy is based on ${canopyCore}`);
if (!forkBase) {
  console.log(`  canopy pins ${canopyCore}, which the registry does not know — check by hand.`);
} else if (forkBase === chosen.gitHead) {
  console.log('  Already on the target commit; nothing to rebase.');
} else {
  const range = `${forkBase}...${chosen.gitHead}`;
  console.log(`  Upstream range: ${range}`);
  let files = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/compare/${range}`);
    if (res.ok) files = (await res.json()).files?.map((f) => f.filename) ?? [];
  } catch { /* offline or rate-limited — the command below is the fallback */ }
  if (files === null) {
    console.log(`  gh api repos/${UPSTREAM_REPO}/compare/${range} --jq '.files[].filename'`);
  } else {
    const ours = files.filter((f) => f.startsWith('addons/addon-webgl/'));
    console.log(
      ours.length > 0
        ? `  Touches the forked addon (${ours.length}/${files.length} files) — read them before merging:\n` +
          ours.map((f) => `    ${f}`).join('\n')
        : `  Does not touch addons/addon-webgl/ (${files.length} files changed) — the merge is mechanical.`,
    );
  }
  console.log(
    `\n  Rebase and release per FORK.md, then repin canopy:\n` +
    `    node scripts/xterm-bump.mjs --canopy 0.20.0-sdf${betaOf(chosen.set[CORE])}.0`,
  );
}
