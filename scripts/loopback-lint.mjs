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
 * shipped code, `dor-tools-builtin/src/file-viewer-loopback-guard.ts` for the built-in viewers,
 * `standalone/scripts/dev-host-guard.mjs` for the dev harness —
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
 *   - The `server`-block form scans past nested objects two levels deep, which
 *     reaches `fs`, `hmr`, `headers`, `watch` and a `proxy` route object. It
 *     stops there because no depth is the last one: a `proxy` route's own
 *     options nest again (`headers`, `cookieDomainRewrite`), and `configure`
 *     takes a function whose body carries braces of its own. A `host` written
 *     below one of those is a miss, and the audit is what covers it.
 *   - A positional port may wrap one call (`Number(process.env.PORT || 0)`);
 *     a port expression nesting parentheses deeper hides the bind.
 *   - Outside `ws`, checks 1–3 match only an explicit loopback host. A
 *     listener that binds every interface is check 4's, and only in the
 *     shipped directories: `relay/` does it deliberately from config. A host
 *     built at runtime (`.listen(port, hostVar)`) fails check 4 rather than
 *     passing it, since only a spelled-out loopback host passes; anything
 *     subtler is the ceiling of a textual check, and the audit covers above it.
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
 *   4. In the shipped directories, nothing binds beyond loopback —
 *      the inbound half of Settings → Network → Nowhere's "phones can't reach
 *      it" (`docs/specs/security-local.md` -> "Network policy"). Every
 *      `.listen(` or `serve({` is one of the loopback bind forms above or a
 *      `CHECK_4_EXCEPTIONS` call; no `0.0.0.0`, `::`, or `*` host; and a UDP
 *      socket (`createSocket(`, `RTCPeerConnection(`) only where
 *      `CHECK_4_EXCEPTIONS` says why. Its scope is `SHIPPED_DIRS` in
 *      `scripts/lint-kit.mjs`, phone code aside. `scripts/outbound-lint.mjs` owns the outbound half.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONE_DIRS, isShippedSource, lineOf, trackedFiles } from './lint-kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that bind loopback without referencing a guard, each with the reason
 * that is acceptable. Adding an entry is a deliberate act that shows up in
 * review; forgetting the guard entirely does not.
 */
const ALLOWED = {
  'scripts/dor-tool-qc/server.mjs':
    'Unshipped innerdogfood fixture serving generated test content only; no file, '
    + 'credential, or command API. Dirty/clean buttons only emit fixture state reports.',
  'standalone/scripts/dev-run.mjs':
    'The Vite dev server owns its own request path, so neither guard module can '
    + 'run on it. What stands in for them is pinned at the bind: cors: false, '
    + 'because the modules Vite serves carry the browser-dev bridge token and '
    + 'Vite\'s default admits every http://localhost:* origin to read them; and '
    + 'allowedHosts: [], the Host check that makes DNS rebinding fail. Dev-only '
    + 'and unbundled — it ships in nothing. Both controls are checked by '
    + 'standalone/scripts/dev-agent-browser.test.mjs; see '
    + 'standalone/scripts/dev-host-guard.mjs for the bridge beside it.',
};

const GUARD_REFERENCES = ['loopback-guard', 'dev-host-guard'];

/**
 * Check 4's exceptions, by file and by the exact call, each with why: a
 * `.listen(` that binds no TCP port (a Unix-domain socket or named pipe, which
 * no network reaches, or a method that only shares the name), and the one
 * socket that may bind beyond loopback. Keyed by call, not file, so a second
 * bind in the same file is not exempt with the first.
 */
const CHECK_4_EXCEPTIONS = {
  'standalone/sidecar/dor-control-server.js': {
    call: 'server.listen(effectiveSocketPath',
    reason: 'The dor control channel listens on a Unix-domain socket or named pipe path (resolveControlSocketPath), never a port.',
  },
  'vscode-ext/src/peer-link.ts': {
    call: 'nextServer.listen(path',
    reason: 'The peer link between VS Code windows listens on a Unix-domain socket or named pipe path, never a port.',
  },
  'dor/src/commands/open-picker.ts': {
    call: 'terminal.listen(onInput',
    reason: 'Subscribes to the picker\'s own keyboard input; no socket.',
  },
  'lib/src/host/remote/native-direct-peer.ts': {
    call: 'new native.polyfill.RTCPeerConnection(',
    reason: 'The direct path\'s UDP socket: it binds the one allowed address under Local '
      + 'networks, else every interface, and the level restricts the path, not the '
      + 'listener (docs/specs/remote-network.md -> "Local networks"). Built only '
      + 'through the Burrow service\'s guarded factory, which declines under Nothing.',
  },
};
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
// levels is where this stops, not where `server` keys stop — the header states
// what that leaves out.
const NESTED_KEYS = '(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*?';

/**
 * Every bind form `LISTEN_RE` looks for, one entry per alternative — the
 * inventory `docs/specs/security-local.md` -> "Loopback Listeners" points at
 * rather than repeats. `scripts/loopback-lint-selftest.mjs` reads these labels
 * and goes red on any form it has no fixture for: an alternative that nothing
 * exercises is a claim, not a check.
 */
const BIND_FORMS = [
  { label: 'node, positional', re: `\\.listen\\(\\s*(?:[^,()]|\\([^()]*\\))+,\\s*${LOOPBACK}` },
  { label: 'node, options object', re: `\\.listen\\(\\s*\\{[^}]*?host\\s*:\\s*${LOOPBACK}` },
  { label: '@hono/node-server', re: `\\bserve\\(\\s*\\{[^}]*?hostname\\s*:\\s*${LOOPBACK}` },
  { label: 'ws, explicit loopback host', re: `${WS_NEW}host\\s*:\\s*${LOOPBACK}` },
  { label: 'ws, port only', re: `${WS_NEW}port\\s*:` },
  // Vite binds from config rather than from a call argument: `createServer({
  // server: { host } })` then an argument-less `listen()`, so neither `.listen`
  // form can see it. Matched on the `server` block rather than on `createServer`
  // because the same block is what a `vite.config.ts` — or Vitest, or
  // Storybook's builder — passes to the same server. `NESTED_KEYS`, not
  // `[^}]*?`, because `fs`, `hmr`, `headers` and `watch` (one level) and a
  // `proxy` route object (two) are ordinary `server` keys, and any of them
  // written above `host` would otherwise end the scan. A route's own nested
  // options go deeper than the scan does — see this file's header.
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

// --- Check 4: nothing shipped binds beyond loopback ---------------------------
const WILDCARD_HOST = /(?:\b(?:host|hostname|address|bindAddress)\s*:\s*|\.listen\([^)]*?,\s*)['"](?:0\.0\.0\.0|::|\*)['"]/g;
const UDP_BIND = /\bcreateSocket\s*\(|\bRTCPeerConnection\s*\(/g;
const usedExceptions = new Set();
/** Whether the site at `index` lies inside `rel`'s excepted call. */
function excepted(rel, text, index) {
  const call = CHECK_4_EXCEPTIONS[rel]?.call;
  if (!call) return false;
  for (let at = text.indexOf(call); at >= 0; at = text.indexOf(call, at + 1)) {
    if (index >= at && index < at + call.length) {
      usedExceptions.add(rel);
      return true;
    }
  }
  return false;
}
for (const rel of sourceFiles().filter(isShippedSource)) {
  if (PHONE_DIRS.some((dir) => rel.startsWith(dir)) || SELF.has(rel)) continue;
  if (!existsSync(join(ROOT, rel))) continue;
  const text = readFileSync(join(ROOT, rel), 'utf-8');
  const loopbackAt = new Set([...text.matchAll(LISTEN_RE)].map((m) => m.index));
  for (const call of text.matchAll(/\.listen\(|\bserve\(\s*\{/g)) {
    if (loopbackAt.has(call.index) || excepted(rel, text, call.index)) continue;
    problems.push(
      `${rel}:${lineOf(text, call.index)}: a shipped listener with no spelled-out loopback host.\n`
      + '      With no host, Node binds every interface, and a phone on any network can\n'
      + '      reach it. Bind 127.0.0.1 — or, for a Unix socket or named pipe, add a\n'
      + '      CHECK_4_EXCEPTIONS entry in this script (docs/specs/security-local.md -> "Network policy").',
    );
  }
  for (const wildcard of text.matchAll(WILDCARD_HOST)) {
    problems.push(`${rel}:${lineOf(text, wildcard.index)}: binds every interface (${wildcard[0].trim()}); shipped listeners bind loopback.`);
  }
  for (const udp of text.matchAll(UDP_BIND)) {
    if (excepted(rel, text, udp.index)) continue;
    problems.push(
      `${rel}:${lineOf(text, udp.index)}: opens a UDP socket CHECK_4_EXCEPTIONS does not name.\n`
      + '      The direct path\'s socket is the one shipped bind beyond loopback; a new\n'
      + '      one needs an entry here saying what bounds it.',
    );
  }
}
for (const rel of Object.keys(CHECK_4_EXCEPTIONS)) {
  if (!usedExceptions.has(rel)) problems.push(`${rel}: CHECK_4_EXCEPTIONS entry no longer matches — drop it from scripts/loopback-lint.mjs.`);
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
