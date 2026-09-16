#!/usr/bin/env node
/**
 * Mechanical check for the loopback-listener invariant in `docs/specs/security-local.md`
 * ("Loopback Listeners"). Runs from the repo root via `pnpm test` (see the root
 * package.json). Exits non-zero with a per-violation report.
 *
 * Why this exists: a loopback bind is not an access control — the attacker that
 * matters is a page open in the user's own browser, which reaches `127.0.0.1`
 * as easily as our webview does, and an ephemeral port is not a secret. Two
 * listeners got that wrong at some point, and both were found
 * by an LLM audit rather than by CI. The audit is thorough but probabilistic;
 * this makes the cheap half of the rule deterministic, so a new listener
 * fails a build instead of waiting for the next audit to notice it.
 *
 * The check scans every tracked JavaScript and TypeScript file and prints every
 * bind it recognizes. Test files and this lint's own fixtures are reported
 * separately; every other file that binds a TCP listener to loopback must
 * reference one of the guard modules — `lib/src/host/loopback-guard.ts` for
 * shipped code, `standalone/scripts/dev-host-guard.mjs` for the dev harness —
 * or sit on ALLOWED below with a stated reason.
 *
 * `scripts/loopback-lint-selftest.mjs` proves each bind form is load-bearing by
 * adding one and requiring this lint to go red, and goes red itself on a form in
 * BIND_FORMS it has no fixture for.
 *
 * What it deliberately does NOT do, so nobody mistakes it for the whole rule:
 *   - It cannot tell whether the guard is actually *called* on every request,
 *     only that the file knows the guard exists. The audit still owns that.
 *   - It knows the bind forms listed at BIND_FORMS and no others. A library
 *     nobody has added yet spells its bind some way this file has never seen,
 *     so adding a server dependency means adding its spelling here.
 *   - Outside `ws`, it matches only an explicit loopback host. A listener that
 *     binds every interface (`.listen(port)` with no host) is a different and
 *     larger problem, and `relay/` does it deliberately from config, so
 *     flagging it here would be noise. A host built at runtime
 *     (`.listen(port, hostVar)`, `serve({ hostname: bindHost })`) is invisible
 *     to a regex and always will be — that is the ceiling of a textual check,
 *     and the audit is what covers above it.
 *   - Unix-domain sockets and named pipes are out of scope by design: no
 *     browser can reach one, which is why the `dor` control channel is bounded
 *     by socket permissions instead.
 *   - Test files and this lint's own fixtures are reported, but need no guard.
 *     A fixture that stands up a loopback server is not a product listener.
 *
 * Scans `git ls-files`, not the working tree. Build output is exactly what must
 * not be scanned: `standalone/sidecar/iframe-proxy.cjs` is a bundle of the very
 * file this lint checks, so it inherits the guard reference and would pass for
 * a reason that says nothing about the source — while also making the count
 * depend on whether someone had run a build.
 *
 * Checks:
 *   1. Every matching non-test listener references a guard module or is allowlisted.
 *   2. Every ALLOWED entry still names a real file that still matches — a stale
 *      allowlist silently exempts nothing, or worse, the next file to reuse
 *      that path.
 *   3. Finding no non-test listeners at all is a failure, not a pass: it means
 *      the bind shape moved and this lint has quietly stopped checking anything.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles } from './lint-kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that bind loopback without referencing a guard, each with the reason
 * that is acceptable. Adding an entry is a deliberate act that shows up in
 * review; forgetting the guard entirely does not.
 */
const ALLOWED = {
  'standalone/scripts/dev-run.mjs':
    'The Vite dev server owns its own request path, so neither guard module can '
    + 'run on it. What stands in for them is pinned at the bind: cors: false, '
    + 'because the modules Vite serves carry the browser-dev bridge token and '
    + 'Vite\'s default admits every http://localhost:* origin to read them; and '
    + 'allowedHosts: [], the Host check that makes DNS rebinding fail. Dev-only '
    + 'and unbundled — it ships in nothing. Both controls are checked by '
    + 'standalone/scripts/dev-agent-browser.test.mjs; see '
    + 'standalone/scripts/dev-host-guard.mjs for the bridge beside it.',
  'vscode-ext/src/agent-browser-host.ts':
    'The stream relay authenticates with a single-use 64-hex token (60s TTL, '
    + 'pinned to one target port) and drops Origin rather than rewriting it, so '
    + 'it vouches for no one. It skips the Host check on purpose: rebinding '
    + 'exists to make same-origin-looking requests, which buys nothing against '
    + 'an unguessable one-shot secret. See lib/src/host/loopback-guard.ts.',
};

const GUARD_REFERENCES = ['loopback-guard', 'dev-host-guard'];
// A TCP listener is not only `.listen(`. Every library in this tree that can
// bind one gets its own spelling, because a check that sees one API is a check
// an author leaves by picking another — which is what an audit found: `ws` and
// `@hono/node-server` binds were invisible here while `docs/specs/security-local.md` claimed a
// new loopback bind fails the build.
//
// For `.listen` the host argument is what separates a TCP bind from a
// UDS/named-pipe listen, which passes a single path and must not match. `ws` is
// the exception: a `WebSocketServer` given a `port` binds every interface,
// loopback included, and it is the one API `docs/specs/security-local.md`'s "HTTP **and
// WebSocket**" names — so it matches on the port alone, while the `noServer`
// form (no port, no bind) does not match. Applied to the whole file rather than
// line by line: a bind is routinely wrapped across lines, and the `\s*` /
// `[^}]*?` spans already cross newlines.
const LOOPBACK = "['\"](?:127\\.0\\.0\\.1|localhost)['\"]";
// One branch for both `ws` spellings, not one each: a per-spelling branch is a
// branch that can rot alone, which is how `WebSocket\.Relay` sat here matching
// nothing while the `WebSocketServer` branch beside it kept the lint green.
const WS_NEW = '\\bnew\\s+WebSocket\\.?Server\\(\\s*\\{[^}]*?';
// Keys of one options object, allowing nested objects up to two levels deep
// between the opening brace and the key being looked for. `[^}]*?` stops at the
// first `}`, so a form that uses it only matches while its key precedes every
// nested object — fine for a call's flat options, wrong for a `vite.config.ts`
// `server` block, where a nested key above `host` is the common shape. Two
// levels is as deep as a `server` key goes; deeper is the regex ceiling this
// file's header already disclaims.
const NESTED_KEYS = '(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*?';

/**
 * Every bind form `LISTEN_RE` looks for, one entry per alternative — the
 * inventory `docs/specs/security-local.md` -> "Loopback Listeners" points at
 * rather than repeats. `scripts/loopback-lint-selftest.mjs` reads these labels
 * and goes red on any form it has no fixture for: an alternative that nothing
 * exercises is a claim, not a check.
 */
const BIND_FORMS = [
  { label: 'node, positional', re: `\\.listen\\(\\s*[^,)]+,\\s*${LOOPBACK}` },
  { label: 'node, options object', re: `\\.listen\\(\\s*\\{[^}]*?host\\s*:\\s*${LOOPBACK}` },
  { label: '@hono/node-server', re: `\\bserve\\(\\s*\\{[^}]*?hostname\\s*:\\s*${LOOPBACK}` },
  { label: 'ws, explicit loopback host', re: `${WS_NEW}host\\s*:\\s*${LOOPBACK}` },
  { label: 'ws, port only', re: `${WS_NEW}port\\s*:` },
  // Vite binds from config rather than from a call argument: `createServer({
  // server: { host } })` then an argument-less `listen()`, so neither `.listen`
  // form can see it. Matched on the `server` block rather than on `createServer`
  // because the same block is what a `vite.config.ts` — or Vitest, or
  // Storybook's builder — passes to the same server. `NESTED_KEYS`, not
  // `[^}]*?`, because `fs`, `hmr`, `headers` and `watch` (one level) and
  // `proxy` (two: a target object per route) are ordinary `server` keys, and
  // any of them written above `host` would otherwise end the scan.
  { label: 'vite, server.host', re: `\\bserver\\s*:\\s*\\{${NESTED_KEYS}host\\s*:\\s*${LOOPBACK}` },
];

const LISTEN_RE = new RegExp(BIND_FORMS.map((form) => form.re).join('|'), 'gs');

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IS_TEST = /(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/;
// These two files spell out the pattern this lint looks for — one documenting
// it, one adding each form to prove it is load-bearing — so they can match
// themselves. Report those matches as fixtures rather than listeners.
const SELF = new Set([
  'scripts/loopback-lint.mjs',
  'scripts/loopback-lint-selftest.mjs',
]);

/** Every tracked JavaScript and TypeScript file, as a repo-relative POSIX path. */
function sourceFiles() {
  return trackedFiles().filter((rel) => SOURCE_EXT.test(rel));
}

const problems = [];
const nonTestListeners = [];
const testListeners = [];
const selfTestFixtures = [];
const matchedAllowed = new Set();

for (const rel of sourceFiles()) {
  // A tracked path can still be absent mid-rebase or in a sparse checkout.
  if (!existsSync(join(ROOT, rel))) continue;
  const text = readFileSync(join(ROOT, rel), 'utf-8');
  const matches = [...text.matchAll(LISTEN_RE)];
  if (matches.length === 0) continue;
  const sites = matches.map((match) => ({
    rel,
    line: text.slice(0, match.index).split('\n').length,
  }));
  if (SELF.has(rel)) {
    selfTestFixtures.push(...sites);
    continue;
  }
  if (IS_TEST.test(rel)) {
    testListeners.push(...sites);
    continue;
  }
  nonTestListeners.push(...sites);

  if (rel in ALLOWED) {
    matchedAllowed.add(rel);
    continue;
  }
  if (GUARD_REFERENCES.some((g) => text.includes(g))) continue;

  problems.push(
    `${rel}:${sites[0].line}: binds a loopback listener without referencing a guard module.\n`
    + '      A loopback bind is not an access control: a page in the user\'s own browser\n'
    + '      reaches 127.0.0.1 too, and the port is not a secret. Check Host and\n'
    + '      authenticate the caller — see lib/src/host/loopback-guard.ts and\n'
    + '      docs/specs/security-local.md -> "Loopback Listeners" — or add an ALLOWED entry in this\n'
    + '      script saying why this one is safe without them.',
  );
}

// --- Check 2: no stale allowlist entries -------------------------------------
for (const rel of Object.keys(ALLOWED)) {
  if (matchedAllowed.has(rel)) continue;
  problems.push(
    existsSync(join(ROOT, rel))
      ? `${rel}: ALLOWED entry no longer binds a loopback listener — drop it from scripts/loopback-lint.mjs.`
      : `${rel}: ALLOWED entry names a file that does not exist — drop it from scripts/loopback-lint.mjs.`,
  );
}

// --- Check 3: the pattern still finds something ------------------------------
if (nonTestListeners.length === 0) {
  problems.push(
    'no non-test loopback listeners matched at all — the bind shape has moved and LISTEN_RE\n'
    + '      in scripts/loopback-lint.mjs no longer matches anything. This lint is not\n'
    + '      passing, it has stopped looking.',
  );
}

// -----------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`loopback-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThe rule is in docs/specs/security-local.md ("Loopback Listeners").');
  process.exit(1);
}
console.log(`loopback-lint: OK (${Object.keys(ALLOWED).length} allowlisted)\n`);
for (const [label, sites] of [
  ['non-test listeners', nonTestListeners],
  ['test listeners (no audit needed)', testListeners],
  ['self-test fixtures', selfTestFixtures],
]) {
  console.log(`  ${label}:`);
  for (const { rel, line } of sites) console.log(`    ${rel}:${line}`);
}
