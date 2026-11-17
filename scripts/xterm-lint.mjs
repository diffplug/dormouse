#!/usr/bin/env node
/**
 * Mechanical checks for the `@xterm/*` pinning invariants in
 * `docs/specs/layout.md` ("Renderer"). Runs from the
 * repo root via `pnpm test` (see the root package.json). Exits non-zero with a
 * per-violation report.
 *
 * Why this exists: the `@xterm/*` packages ship from one repo but carry
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
 *   1. Provenance: in every workspace, each addon pin's peer range equals
 *      `^<that workspace's @xterm/xterm pin>`.
 *   2. Exact pins: every `@xterm/*` specifier is a bare version, no range
 *      operator — these are commit-coupled, a caret would let them drift.
 *   3. standalone ⊆ lib: standalone pins only what its test mocks, and each
 *      pin must equal lib's, so a mock replaces the module lib's code loads.
 *   4. Format sanity: finding no `@xterm/*` entries at all is a failure, not a
 *      pass — it means the lockfile format moved.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

/** `@xterm/*` specifiers declared by a workspace. */
function xtermPins(dir) {
  const rel = `${dir}/package.json`;
  if (!existsSync(join(ROOT, rel))) return null;
  const pkg = JSON.parse(read(rel));
  const pins = {};
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith('@xterm/')) pins[name] = spec;
    }
  }
  return Object.keys(pins).length > 0 ? { rel, pins } : null;
}

/**
 * `'<name>@<version>'` → its declared `@xterm/xterm` peer range, scanned out of
 * the lockfile's top-level `packages:` block. Entries there carry
 * only metadata (resolution/engines/peerDependencies/…); the resolved
 * dependency graph lives in `snapshots:`, which this deliberately skips.
 * pnpm 12 prepends a `---` document pinning pnpm itself, with its own
 * `packages:` block, so every document's block is scanned rather than the first.
 */
function peerRanges() {
  const out = new Map();
  let inPackages = false;
  let key = null;
  let inPeers = false;
  for (const line of read('pnpm-lock.yaml').split('\n')) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (/^\S/.test(line)) { inPackages = false; key = null; continue; } // any other top-level key ends the block
    if (!inPackages) continue;
    const entry = /^ {2}'?(@xterm\/[a-z0-9-]+)@(.+?)'?:\s*$/.exec(line);
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

// --- Check 4: format sanity (first — everything else rests on it) ------------
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
    const shown = `${name}@${pins[name]}`;
    const range = peers.get(shown);
    if (range === undefined) {
      problems.push(`pnpm-lock.yaml: no entry for ${shown} (pinned by ${rel}) — run \`pnpm install\``);
      continue;
    }
    if (range !== `^${core}`) {
      problems.push(
        `${rel}: ${shown} was built against @xterm/xterm ${range}, ` +
        `but ${dir} pins ${core}. They are from different upstream commits; ` +
        'run `node scripts/xterm-bump.mjs` for a coherent set',
      );
    }
  }
}

// --- Check 3: standalone ⊆ lib -----------------------------------------------
const lib = workspaces.find((w) => w.dir === 'lib');
const standalone = workspaces.find((w) => w.dir === 'standalone');
if (lib && standalone) {
  for (const name of Object.keys(standalone.pins).sort()) {
    if (lib.pins[name] !== standalone.pins[name]) {
      problems.push(
        `lib and standalone disagree on ${name}: ${lib.pins[name] ?? '(absent)'} vs ` +
        `${standalone.pins[name]} — standalone's tests mock the modules lib's code ` +
        'imports, so each pin must resolve to the same release',
      );
    }
  }
}

// -----------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`xterm-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nThe pinning rules are in docs/specs/layout.md ("Renderer"). ' +
    '`node scripts/xterm-bump.mjs --dry-run` shows the newest coherent set.',
  );
  process.exit(1);
}
console.log(
  `xterm-lint: OK (${workspaces.length} workspaces, ` +
  `${peers.size} @xterm/* lockfile entries checked)`,
);
