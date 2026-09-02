#!/usr/bin/env node
/**
 * Executable tests for the two `manage verify` checks whose verdict is a text
 * search over CLI output nobody bounds: is Tailscale Funnel on, and is the
 * loopback port bound anywhere but 127.0.0.1. Runs from the repo root via
 * `pnpm test`.
 *
 * Why this exists: `deploy-lint.mjs` is textual, so it can say a control is
 * still present and nothing more. These two are the controls where "present"
 * was not the property that failed — both read the right string and reported
 * the wrong answer, because `printf … | grep -q` under `set -o pipefail`
 * returns 141 when `grep` exits early and the writer takes SIGPIPE, and 141
 * reads exactly like "no match". The direction is the bad one: a Funnel that
 * is ON, and a socket bound off-loopback, both report clean. It only shows
 * above the pipe buffer (64 KiB), so every hand-run of `manage verify` on a
 * small tailnet passes, and nothing here is provable by reading the file.
 *
 * How: the functions are extracted from the generated `manage` inside each
 * installer — the real text, not a copy — and driven under the same
 * `set -euo pipefail` that `manage` runs under. Extraction takes the LAST
 * definition of a name, because several helpers exist twice in these files,
 * once in the installer body and once inside the `MANAGE_EOF` heredoc.
 *
 * The last case in each platform's list is a witness rather than a test of
 * shipped code: it runs the old piped idiom over the same input and requires
 * it to get the answer wrong. If that one ever fails, the bug stopped being
 * reachable on this platform — delete the witness, keep the fix.
 *
 * Windows is not covered: PowerShell has no pipeline that can take SIGPIPE
 * here, `Invoke-Verify` matches against strings it has already captured, and
 * nothing in CI can run PowerShell anyway (see `deploy-lint.mjs`).
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { readRepoFile } from './lint-kit.mjs';

/**
 * One shell function, taken from `text` by name. The last definition wins: the
 * installer body and the `manage` heredoc both define several of these, and
 * the one under test is always the installed copy.
 */
function extractFunction(text, name) {
  const lines = text.split('\n');
  const open = `${name}() {`;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === open) start = i;
  if (start < 0) throw new Error(`no definition of ${name}()`);
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`unterminated ${name}()`);
}

/** ~1 MiB of `line`, well past any pipe buffer, built inside the shell. */
const pad = (line) =>
  `"$(awk 'BEGIN{for(i=0;i<20000;i++) print "${line}"}')"`;

const FUNNEL_ON = 'Funnel on for laptop.tail.ts.net (tcp 443)';

/**
 * `lsof` and `ss` print different shapes, and each platform's check reads its
 * own: macOS matches the whole line, Linux matches column 4.
 */
const listenerFixtures = {
  macOS: {
    loopback: 'node 501 me 22u IPv4 0x1 0t0 TCP 127.0.0.1:3100 (LISTEN)',
    offLoopback: 'node 501 me 22u IPv4 0x1 0t0 TCP *:3100 (LISTEN)',
  },
  Linux: {
    loopback: 'LISTEN 0 511 127.0.0.1:3100 0.0.0.0:*',
    offLoopback: 'LISTEN 0 511 0.0.0.0:3100 0.0.0.0:*',
  },
};

/** `[label, body, expected]`, where `body` echoes exactly one word. */
function cases(platform) {
  const { loopback, offLoopback } = listenerFixtures[platform];
  return [
    [
      'funnel_state: ON in serve output, behind 1 MiB of funnel output',
      `funnel_state 0 "${FUNNEL_ON}" ${pad('some tailscale prose')}`,
      'on',
    ],
    [
      'funnel_state: ON in funnel output, ahead of 1 MiB of it',
      `funnel_state 0 "" "$(printf '%s\\n' "${FUNNEL_ON}"; awk 'BEGIN{for(i=0;i<20000;i++) print "trailing prose"}')"`,
      'on',
    ],
    ['funnel_state: 1 MiB of output, no Funnel', `funnel_state 0 "" ${pad('trailing prose')}`, 'off'],
    ['funnel_state: no Tailscale CLI', 'funnel_state 127 "" ""', 'unknown'],
    ['funnel_state: funnel status errored, serve output still names it', `funnel_state 1 "${FUNNEL_ON}" ""`, 'on'],
    ['funnel_state: funnel status errored, nothing else says', 'funnel_state 2 "no serve config" ""', 'unknown'],
    [
      'has_off_loopback: off-loopback first, 1 MiB of loopback after',
      `if has_off_loopback 3100 "$(printf '%s\\n' "${offLoopback}"; awk 'BEGIN{for(i=0;i<20000;i++) print "${loopback}"}')"; then echo detected; else echo clean; fi`,
      'detected',
    ],
    [
      'has_off_loopback: off-loopback last, after 1 MiB of loopback',
      `if has_off_loopback 3100 "$(awk 'BEGIN{for(i=0;i<20000;i++) print "${loopback}"}'; printf '%s\\n' "${offLoopback}")"; then echo detected; else echo clean; fi`,
      'detected',
    ],
    [
      'has_off_loopback: 1 MiB of loopback only',
      `if has_off_loopback 3100 ${pad(loopback)}; then echo detected; else echo clean; fi`,
      'clean',
    ],
    [
      'witness: the piped form reports a live Funnel as off (this is the bug)',
      `if printf '%s\\n%s' "${FUNNEL_ON}" ${pad('some tailscale prose')} | grep -qi 'funnel on'; then echo on; else echo off; fi`,
      'off',
    ],
  ];
}

const PLATFORMS = [
  { platform: 'macOS', file: 'deploy/local/install-macos.sh' },
  { platform: 'Linux', file: 'deploy/local/install-linux.sh' },
];

export function run() {
  const failures = [];
  let checked = 0;

  const bash = spawnSync('bash', ['-c', 'exit 0']);
  if (bash.error) {
    console.log('installer-verify-test: skipped (no bash on PATH)');
    return { failures, checked };
  }

  for (const { platform, file } of PLATFORMS) {
    const text = readRepoFile(file);
    let helpers;
    try {
      helpers = ['funnel_state', 'has_off_loopback']
        .map((name) => extractFunction(text, name))
        .join('\n\n');
    } catch (err) {
      failures.push(`${platform}: ${err.message} in ${file}`);
      continue;
    }
    for (const [label, body, expected] of cases(platform)) {
      checked += 1;
      // The same options `manage` sets. `pipefail` is not incidental here: it
      // is the setting that turns an early `grep -q` into a wrong answer.
      const script = `set -euo pipefail\n${helpers}\n${body}\n`;
      const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const got = (res.stdout ?? '').trim();
      if (res.status !== 0 || got !== expected) {
        failures.push(
          `${platform.padEnd(6)} ${label}\n    expected ${expected}, got ${got || '(nothing)'}` +
            (res.status === 0 ? '' : ` (bash exited ${res.status}: ${(res.stderr ?? '').trim()})`),
        );
      }
    }
  }

  return { failures, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, checked } = run();
  if (failures.length > 0) {
    console.error('installer-verify-test: a `manage verify` check answered wrongly\n');
    for (const f of failures) console.error(`  ${f}\n`);
    console.error(
      'These verdicts must be taken over captured text, never a pipe into `grep -q`:\n' +
        'under `set -o pipefail` the early exit SIGPIPEs the writer and 141 reads as\n' +
        '"no match" (SECURITY.md -> "Network posture (self-hosted)").',
    );
    process.exit(1);
  }
  console.log(`installer-verify-test: OK (${checked} checks)`);
}
