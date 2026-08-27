#!/usr/bin/env node
/**
 * Mechanical check for the loopback-listener invariant in `SECURITY.md`
 * ("Loopback Listeners"). Runs from the repo root via `pnpm test` (see the root
 * package.json). Exits non-zero with a per-violation report.
 *
 * Why this exists: a loopback bind is not an access control — the attacker that
 * matters is a page open in the user's own browser, which reaches `127.0.0.1`
 * as easily as our webview does, and an ephemeral port is not a secret. Two of
 * the three listeners we ship got that wrong at some point, and both were found
 * by an LLM audit rather than by CI. The audit is thorough but probabilistic;
 * this makes the cheap half of the rule deterministic, so a *fourth* listener
 * fails a build instead of waiting for the next audit to notice it.
 *
 * The check: any non-test source file that binds a TCP listener to loopback
 * must reference one of the guard modules — `lib/src/host/loopback-guard.ts`
 * for shipped code, `standalone/scripts/dev-host-guard.mjs` for the dev
 * harness — or sit on ALLOWED below with a stated reason.
 *
 * What it deliberately does NOT do, so nobody mistakes it for the whole rule:
 *   - It cannot tell whether the guard is actually *called* on every request,
 *     only that the file knows the guard exists. The audit still owns that.
 *   - It only matches `.listen(<port>, '127.0.0.1'|'localhost')`. A listener
 *     that binds every interface (`.listen(port)` with no host) is a different
 *     and larger problem, and `server/` does it deliberately from config, so
 *     flagging it here would be noise. Check 2 is what catches the pattern
 *     going stale.
 *   - Unix-domain sockets and named pipes are out of scope by design: no
 *     browser can reach one, which is why the `dor` control channel is bounded
 *     by socket permissions instead.
 *   - Test files are skipped. A fixture that stands up a loopback server is not
 *     a product listener.
 *
 * Scans `git ls-files`, not the working tree. Build output is exactly what must
 * not be scanned: `standalone/sidecar/iframe-proxy.cjs` is a bundle of the very
 * file this lint checks, so it inherits the guard reference and would pass for
 * a reason that says nothing about the source — while also making the count
 * depend on whether someone had run a build.
 *
 * Checks:
 *   1. Every matching listener references a guard module or is allowlisted.
 *   2. Every ALLOWED entry still names a real file that still matches — a stale
 *      allowlist silently exempts nothing, or worse, the next file to reuse
 *      that path.
 *   3. Finding no listeners at all is a failure, not a pass: it means the bind
 *      shape moved and this lint has quietly stopped checking anything.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that bind loopback without referencing a guard, each with the reason
 * that is acceptable. Adding an entry is a deliberate act that shows up in
 * review; forgetting the guard entirely does not.
 */
const ALLOWED = {
  'vscode-ext/src/agent-browser-host.ts':
    'The stream relay authenticates with a single-use 64-hex token (60s TTL, '
    + 'pinned to one target port) and drops Origin rather than rewriting it, so '
    + 'it vouches for no one. It skips the Host check on purpose: rebinding '
    + 'exists to make same-origin-looking requests, which buys nothing against '
    + 'an unguessable one-shot secret. See lib/src/host/loopback-guard.ts.',
};

const GUARD_REFERENCES = ['loopback-guard', 'dev-host-guard'];
// `.listen(<anything but a comma or close-paren>, '127.0.0.1' | 'localhost'`.
// The host argument is what distinguishes a TCP bind from a UDS/named-pipe
// listen, which passes a single path and must not match.
const LISTEN_RE = /\.listen\(\s*[^,)]+,\s*['"](?:127\.0\.0\.1|localhost)['"]/;

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const IS_TEST = /(?:\.test\.|\.spec\.|[\\/]tests?[\\/])/;
// This file documents the pattern it looks for, so it matches itself.
const SELF = 'scripts/loopback-lint.mjs';

/** Every tracked, non-test source file, as repo-relative POSIX paths. */
function sourceFiles() {
  // -z because a path may contain anything; git would otherwise quote it.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((rel) => (
    rel && rel !== SELF && SOURCE_EXT.test(rel) && !IS_TEST.test(rel)
  ));
}

const problems = [];
const listeners = [];
const matchedAllowed = new Set();

for (const rel of sourceFiles()) {
  // A tracked path can still be absent mid-rebase or in a sparse checkout.
  if (!existsSync(join(ROOT, rel))) continue;
  const text = readFileSync(join(ROOT, rel), 'utf-8');
  const lines = text.split('\n');
  const line = lines.findIndex((l) => LISTEN_RE.test(l));
  if (line === -1) continue;
  listeners.push(rel);

  if (rel in ALLOWED) {
    matchedAllowed.add(rel);
    continue;
  }
  if (GUARD_REFERENCES.some((g) => text.includes(g))) continue;

  problems.push(
    `${rel}:${line + 1}: binds a loopback listener without referencing a guard module.\n`
    + '      A loopback bind is not an access control: a page in the user\'s own browser\n'
    + '      reaches 127.0.0.1 too, and the port is not a secret. Check Host and\n'
    + '      authenticate the caller — see lib/src/host/loopback-guard.ts and\n'
    + '      SECURITY.md -> "Loopback Listeners" — or add an ALLOWED entry in this\n'
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
if (listeners.length === 0) {
  problems.push(
    'no loopback listeners matched at all — the bind shape has moved and LISTEN_RE\n'
    + '      in scripts/loopback-lint.mjs no longer matches anything. This lint is not\n'
    + '      passing, it has stopped looking.',
  );
}

// -----------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`loopback-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThe rule is in SECURITY.md ("Loopback Listeners").');
  process.exit(1);
}
console.log(
  `loopback-lint: OK (${listeners.length} loopback listeners, `
  + `${Object.keys(ALLOWED).length} allowlisted)`,
);
