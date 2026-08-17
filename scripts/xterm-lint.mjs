#!/usr/bin/env node
/**
 * Mechanical checks for the `@xterm/*` pinning invariants in
 * `docs/specs/webgl-text.md` ("Fork pipeline" → Distribution). Runs from the
 * repo root via `pnpm test` (see the root package.json). Exits non-zero with a
 * per-violation report.
 *
 * Why this exists: the four `@xterm/*` packages ship from one repo but carry
 * INDEPENDENT beta counters, and each addon's
 * `peerDependencies['@xterm/xterm']` is exactly `^<the core version published
 * from the same commit>`. So "latest of each" is routinely a set built from two
 * different commits — and because `^6.1.0-beta.301` happily admits
 * `6.1.0-beta.302`, npm and pnpm say nothing. The addons compile against core
 * internals, so that mismatch is real. Equality of the peer range against the
 * core pin is the check; `semver.satisfies` would not catch it.
 *
 * Reads `pnpm-lock.yaml` and the workspace package.json files only — no
 * network, no `node_modules`, so it works in a clean checkout.
 *
 * Checks:
 *   1. Provenance: in every workspace, each `@xterm/addon-*` pin's peer range
 *      equals `^<that workspace's @xterm/xterm pin>`.
 *   2. Exact pins: every `@xterm/*` specifier is a bare version, no range
 *      operator — these are commit-coupled, a caret would let them drift.
 *   3. lib ≡ standalone: the two hand-maintained pin sets must be identical.
 *   4. canopy fork lockstep: the `-sdf<NNN>.<M>` in the
 *      `@diffplug/xterm-addon-webgl-sdf` release-tarball URL must match
 *      canopy's `@xterm/xterm` pin `…-beta.<NNN>`, and the release tag and the
 *      .tgz filename in that URL must agree. Renovate cannot see tarball URLs
 *      (canopy/README.md), so this is the only thing holding them together.
 *   5. Format sanity: finding no `@xterm/*` entries at all is a failure, not a
 *      pass — it means the lockfile format moved.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FORK_ADDON = '@diffplug/xterm-addon-webgl-sdf';
const problems = [];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

// --- Inputs ------------------------------------------------------------------

/** Workspace dirs, from pnpm-workspace.yaml's `packages:` list. */
function workspaceDirs() {
  const out = [];
  let inPackages = false;
  for (const line of read('pnpm-workspace.yaml').split('\n')) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break;
    const m = inPackages && /^\s+-\s+(\S+)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** `@xterm/*` + fork-tarball specifiers declared by a workspace. */
function xtermPins(dir) {
  const rel = `${dir}/package.json`;
  if (!existsSync(join(ROOT, rel))) return null;
  const pkg = JSON.parse(read(rel));
  const pins = {};
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith('@xterm/') || name === FORK_ADDON) pins[name] = spec;
    }
  }
  return Object.keys(pins).length > 0 ? { rel, pins } : null;
}

/**
 * `'@xterm/<name>@<version>'` → its declared `@xterm/xterm` peer range, scanned
 * out of the lockfile's top-level `packages:` block. Entries there carry only
 * metadata (resolution/engines/peerDependencies/…); the resolved dependency
 * graph lives in `snapshots:`, which this deliberately stops before.
 */
function peerRanges() {
  const out = new Map();
  let inPackages = false;
  let key = null;
  let inPeers = false;
  for (const line of read('pnpm-lock.yaml').split('\n')) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break; // next top-level key (`snapshots:`) ends the block
    const entry = /^ {2}'?(@xterm\/[a-z0-9-]+)@([^']+?)'?:\s*$/.exec(line);
    if (entry) { key = `${entry[1]}@${entry[2]}`; inPeers = false; continue; }
    if (!key) continue;
    if (/^ {4}\S/.test(line)) inPeers = /^ {4}peerDependencies:\s*$/.test(line);
    const peer = inPeers && /^ {6}'@xterm\/xterm':\s*(\S+)\s*$/.exec(line);
    if (peer) out.set(key, peer[1]);
  }
  return out;
}

const peers = peerRanges();
const workspaces = workspaceDirs()
  .map((dir) => ({ dir, ...(xtermPins(dir) ?? {}) }))
  .filter((w) => w.pins);

// --- Check 5: format sanity (first — everything else rests on it) ------------
if (peers.size === 0) {
  problems.push(
    'pnpm-lock.yaml: no @xterm/* entries found under `packages:` — either the ' +
    'dependency is gone or the lockfile format changed and this linter is blind',
  );
}

for (const { dir, rel, pins } of workspaces) {
  const core = pins['@xterm/xterm'];

  // --- Check 2: exact pins ---------------------------------------------------
  for (const [name, spec] of Object.entries(pins)) {
    if (name === FORK_ADDON) continue; // a tarball URL, checked below
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) {
      problems.push(
        `${rel}: ${name} is pinned as "${spec}" — @xterm/* pins must be exact ` +
        'versions, because an addon only matches the core commit it was built from',
      );
    }
  }

  // --- Check 1: provenance ---------------------------------------------------
  const addons = Object.keys(pins).filter((n) => n.startsWith('@xterm/addon-'));
  if (addons.length > 0 && !core) {
    problems.push(`${rel}: declares ${addons.join(', ')} but no @xterm/xterm pin to check them against`);
  }
  for (const name of addons) {
    if (!core) break;
    const range = peers.get(`${name}@${pins[name]}`);
    if (range === undefined) {
      problems.push(
        `pnpm-lock.yaml: no entry for ${name}@${pins[name]} (pinned by ${rel}) — run \`pnpm install\``,
      );
      continue;
    }
    if (range !== `^${core}`) {
      problems.push(
        `${rel}: ${name}@${pins[name]} was built against @xterm/xterm ${range}, ` +
        `but ${dir} pins ${core}. They are from different upstream commits; ` +
        'run `node scripts/xterm-bump.mjs` for a coherent set',
      );
    }
  }
}

// --- Check 3: lib ≡ standalone -----------------------------------------------
const lib = workspaces.find((w) => w.dir === 'lib');
const standalone = workspaces.find((w) => w.dir === 'standalone');
if (lib && standalone) {
  const names = [...new Set([...Object.keys(lib.pins), ...Object.keys(standalone.pins)])].sort();
  for (const name of names) {
    if (lib.pins[name] !== standalone.pins[name]) {
      problems.push(
        `lib and standalone disagree on ${name}: ${lib.pins[name] ?? '(absent)'} vs ` +
        `${standalone.pins[name] ?? '(absent)'} — standalone bundles dormouse-lib, ` +
        'so the two must render through the same xterm',
      );
    }
  }
}

// --- Check 4: canopy fork lockstep -------------------------------------------
const canopy = workspaces.find((w) => w.dir === 'canopy');
if (canopy) {
  const url = canopy.pins[FORK_ADDON];
  const core = canopy.pins['@xterm/xterm'];
  const m = url && /\/releases\/download\/sdf-v([^/]+)\/diffplug-xterm-addon-webgl-sdf-(.+)\.tgz$/.exec(url);
  if (!m) {
    problems.push(
      `canopy/package.json: ${FORK_ADDON} must be a diffplug/xterm.js release-asset URL ` +
      '(.../releases/download/sdf-v<version>/diffplug-xterm-addon-webgl-sdf-<version>.tgz)',
    );
  } else {
    const [, tagVersion, fileVersion] = m;
    if (tagVersion !== fileVersion) {
      problems.push(
        `canopy/package.json: fork tarball URL names tag sdf-v${tagVersion} but asset ${fileVersion}.tgz`,
      );
    }
    const sdf = /-sdf(\d+)\.\d+$/.exec(tagVersion);
    const beta = core && /-beta\.(\d+)$/.exec(core);
    if (!sdf) {
      problems.push(
        `canopy/package.json: fork version "${tagVersion}" does not encode its upstream base ` +
        '(expected <addon-version>-sdf<coreBeta>.<iteration>, see FORK.md)',
      );
    } else if (!beta) {
      problems.push(
        `canopy/package.json: @xterm/xterm is pinned to "${core}", which carries no -beta.N ` +
        'suffix, so the fork-base lockstep cannot be checked — teach this check the new ' +
        'version shape (scripts/xterm-lint.mjs, check 4)',
      );
    } else if (sdf[1] !== beta[1]) {
      problems.push(
        `canopy/package.json: fork release ${tagVersion} was built from @xterm/xterm ` +
        `6.1.0-beta.${sdf[1]}, but canopy pins ${core}. The addon bundles core internals — ` +
        'both move together (docs/specs/webgl-text.md → Following upstream)',
      );
    }
  }
}

// -----------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`xterm-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nThe pinning rules are in docs/specs/webgl-text.md ("Fork pipeline", ' +
    '"Following upstream"). `node scripts/xterm-bump.mjs --dry-run` shows the ' +
    'newest coherent set.',
  );
  process.exit(1);
}
console.log(
  `xterm-lint: OK (${workspaces.length} workspaces, ` +
  `${peers.size} @xterm/* lockfile entries checked)`,
);
