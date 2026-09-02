#!/usr/bin/env node
/**
 * Executable tests for the installer decisions whose answer cannot be read off
 * the file: the searches over CLI output nobody bounds — is Tailscale Funnel
 * on, is the loopback port bound anywhere but 127.0.0.1, does an existing
 * Serve config already claim the root path — and the install's own reading of
 * a `config/server.env` that may be half-written. Runs from the repo root via
 * `pnpm test`.
 *
 * Why this exists: `deploy-lint.mjs` is textual, so it can say a control is
 * still present and nothing more. These are controls where "present" was not
 * the property that failed — each read the right string and reported the wrong
 * answer. Two ways that happened, both fail-open:
 *
 *   - Scope. `grep -q "127.0.0.1:$PORT"` is an unanchored substring match, so
 *     it matched `/api` on our port while `/` belonged to someone else, and
 *     matched `127.0.0.1:31000` when the port was 3100. On a three-line Serve
 *     config that skipped the `confirm` and repointed the operator's root.
 *   - Volume. `printf … | grep -q` under `set -o pipefail` returns 141 once
 *     `grep` exits early and the writer takes SIGPIPE, and 141 reads exactly
 *     like "no match". Only reachable past the pipe buffer (64 KiB), so it is
 *     much the narrower of the two, but it fails in the same direction.
 *
 * How: the functions are extracted from each installer — the real text, not a
 * copy — and driven under the same `set -euo pipefail` those scripts run
 * under. Extraction takes the LAST definition of a name, so it keeps working
 * if a helper ever exists twice — once in the installer body and once inside
 * the `MANAGE_EOF` heredoc. Today each is defined once: `funnel_state` and
 * `has_off_loopback` and `serve_proxies_root` in the heredoc (the `manage`
 * copy), `env_missing_keys`, `serve_state` and `serve_root_target` in the
 * installer body.
 *
 * Windows is not covered: `Invoke-Verify` and the Serve ladder both match
 * against strings they have already captured, and nothing in CI can run
 * PowerShell anyway (see `deploy-lint.mjs`).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** The `tailscale serve status` line shapes the conflict gate reads. */
const SERVE_ROOT_FOREIGN = '|-- / proxy http://127.0.0.1:9999';
const SERVE_ROOT_OURS = '|-- / proxy http://127.0.0.1:3100';
const SERVE_OTHER_PATH = '|-- /elsewhere proxy http://127.0.0.1:8888';
const SERVE_OUR_PORT_OTHER_PATH = '|-- /api proxy http://127.0.0.1:3100';
const SERVE_ROOT_PORT_PREFIX = '|-- / proxy http://127.0.0.1:31000';

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

/**
 * The env files `env_missing_keys` has to tell apart. `complete` is the shape
 * the installer writes; the rest are what a run killed partway through the
 * heredoc leaves behind, plus the operator edits that must not be mistaken for
 * one.
 */
const ENV_COMPLETE = [
  '# Dormouse selfhost server — installer-owned runtime configuration.',
  '# Generated 2026-01-01T00:00:00Z. Preserved byte-for-byte across updates.',
  'DORMOUSE_SETUP_PASSWORD=' + 'a'.repeat(64),
  'DORMOUSE_ORIGIN=https://laptop.tail.ts.net',
  'DORMOUSE_STATE_DIR=/home/me/.local/share/dormouse-server/state',
  'DORMOUSE_BIND_HOST=127.0.0.1',
  'PORT=3100',
  'NODE_ENV=production',
].join('\n');

function writeEnvFixtures(dir) {
  const head = ENV_COMPLETE.split('\n');
  const files = {
    complete: ENV_COMPLETE,
    // Created and never filled: `: > "$ENV_FILE"` and then the install died.
    empty: '',
    // Died inside the heredoc, at three points.
    headerOnly: head.slice(0, 2).join('\n'),
    throughPassword: head.slice(0, 3).join('\n'),
    throughBindHost: head.slice(0, 6).join('\n'),
    // A key present with no value is as absent as a missing line.
    emptyPassword: ENV_COMPLETE.replace(/^DORMOUSE_SETUP_PASSWORD=.*$/m, 'DORMOUSE_SETUP_PASSWORD='),
    // An operator's own addition is not a defect.
    extraKey: `${ENV_COMPLETE}\nDORMOUSE_LOG_LEVEL=debug`,
  };
  const paths = {};
  for (const [name, body] of Object.entries(files)) {
    paths[name] = join(dir, `${name}.env`);
    writeFileSync(paths[name], body === '' ? '' : `${body}\n`);
  }
  return paths;
}

/** `[label, body, expected]`, where `body` echoes exactly one word. */
function cases(platform, env) {
  const { loopback, offLoopback } = listenerFixtures[platform];
  return [
    [
      'funnel_state: ON in serve output, behind 1 MiB of funnel output',
      `funnel_state 0 "${FUNNEL_ON}" ${pad('some tailscale prose')}`,
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
      'has_off_loopback: 1 MiB of loopback only',
      `if has_off_loopback 3100 ${pad(loopback)}; then echo detected; else echo clean; fi`,
      'clean',
    ],
    // These three are the ONLY executable pin on `serve_proxies_root`'s root
    // scoping and port bound — the two controls this branch opened on. They
    // read like a restatement of `deploy-lint`'s pattern and are not: that
    // pattern holds the `<<<` spelling, and drops green when the scoping or
    // the `([^0-9]|$)` goes while the herestring stays. Deleting these as
    // redundant takes the pin off entirely.
    [
      'serve_proxies_root: a foreign root with our port on another path is not a pass',
      `if serve_proxies_root 3100 "$(printf '%s\\n%s\\n' "${SERVE_ROOT_FOREIGN}" "${SERVE_OUR_PORT_OTHER_PATH}")"; then echo pass; else echo fail; fi`,
      'fail',
    ],
    [
      'serve_proxies_root: a root on a port this one is a prefix of is not a pass',
      `if serve_proxies_root 3100 "${SERVE_ROOT_PORT_PREFIX}"; then echo pass; else echo fail; fi`,
      'fail',
    ],
    [
      'serve_proxies_root: the mapping the installer writes, with the origin header above it',
      `if serve_proxies_root 3100 "$(printf '%s\\n%s\\n' 'https://node.tailnet.ts.net (tailnet only)' "${SERVE_ROOT_OURS}")"; then echo pass; else echo fail; fi`,
      'pass',
    ],
    [
      'env_missing_keys: the file the installer writes is complete',
      `printf '[%s]\\n' "$(env_missing_keys '${env.complete}')"`,
      '[]',
    ],
    [
      'env_missing_keys: created and never filled',
      `printf '[%s]\\n' "$(env_missing_keys '${env.empty}')"`,
      '[ DORMOUSE_SETUP_PASSWORD DORMOUSE_ORIGIN DORMOUSE_STATE_DIR DORMOUSE_BIND_HOST PORT]',
    ],
    [
      'env_missing_keys: died after the comment header',
      `printf '[%s]\\n' "$(env_missing_keys '${env.headerOnly}')"`,
      '[ DORMOUSE_SETUP_PASSWORD DORMOUSE_ORIGIN DORMOUSE_STATE_DIR DORMOUSE_BIND_HOST PORT]',
    ],
    [
      'env_missing_keys: died after the password line',
      `printf '[%s]\\n' "$(env_missing_keys '${env.throughPassword}')"`,
      '[ DORMOUSE_ORIGIN DORMOUSE_STATE_DIR DORMOUSE_BIND_HOST PORT]',
    ],
    [
      'env_missing_keys: died one line from the end',
      `printf '[%s]\\n' "$(env_missing_keys '${env.throughBindHost}')"`,
      '[ PORT]',
    ],
    [
      'env_missing_keys: a key with no value is as absent as a missing line',
      `printf '[%s]\\n' "$(env_missing_keys '${env.emptyPassword}')"`,
      '[ DORMOUSE_SETUP_PASSWORD]',
    ],
    [
      "env_missing_keys: an operator's extra key is not a defect",
      `printf '[%s]\\n' "$(env_missing_keys '${env.extraKey}')"`,
      '[]',
    ],
    [
      "serve_state: a foreign root mapping, ahead of 1 MiB — the gate the confirm hangs off",
      `serve_state 3100 "$(printf '%s\\n' "${SERVE_ROOT_FOREIGN}"; awk 'BEGIN{for(i=0;i<20000;i++) print "${SERVE_OTHER_PATH}"}')"`,
      'conflict',
    ],
    [
      'serve_state: a foreign root with our own port on another path is still a conflict',
      `serve_state 3100 "$(printf '%s\\n%s\\n' "${SERVE_ROOT_FOREIGN}" "${SERVE_OUR_PORT_OTHER_PATH}")"`,
      'conflict',
    ],
    [
      'serve_state: our root mapping, with other paths around it',
      `serve_state 3100 "$(printf '%s\\n%s\\n' "${SERVE_ROOT_OURS}" "${SERVE_OTHER_PATH}")"`,
      'loopback',
    ],
    [
      'serve_state: a root on a port this one is a prefix of is not ours',
      `serve_state 3100 "${SERVE_ROOT_PORT_PREFIX}"`,
      'conflict',
    ],
    [
      'serve_state: 1 MiB of serve status with no root mapping at all',
      `serve_state 3100 ${pad(SERVE_OTHER_PATH)}`,
      'none',
    ],
    [
      'serve_root_target: names the first root target, over 1 MiB of matches',
      // Call-site shaped, but this pins the ANSWER, not an abort. A `| head -1`
      // in here raises 141 and nothing propagates it: `printf` is the
      // function's last command, so `$?` is 0 by the time it returns, and bash
      // carries no `errexit` into `$( )` without `inherit_errexit`, which
      // bash 3.2 does not have. Both facts are load-bearing and neither is
      // "it lives in a helper": end the function on the failing assignment, or
      // call it outside a substitution, and the 141 aborts again — see the
      // comment on `serve_root_target` itself.
      `serve="$(printf '%s\\n' "${SERVE_ROOT_FOREIGN}"; awk 'BEGIN{for(i=0;i<20000;i++) print "${SERVE_ROOT_FOREIGN}"}')"\n` +
        `if target="$(serve_root_target "$serve")"; then printf '[%s]\\n' "$target"; else echo aborted; fi`,
      '[http://127.0.0.1:9999]',
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

  const fixtureDir = mkdtempSync(join(tmpdir(), 'dormouse-installer-verify-'));
  const env = writeEnvFixtures(fixtureDir);
  try {
    for (const { platform, file } of PLATFORMS) {
      const text = readRepoFile(file);
      let helpers;
      try {
        helpers = [
          'funnel_state',
          'has_off_loopback',
          'env_missing_keys',
          'serve_state',
          'serve_root_target',
          'serve_proxies_root',
        ]
          .map((name) => extractFunction(text, name))
          .join('\n\n');
      } catch (err) {
        failures.push(`${platform}: ${err.message} in ${file}`);
        continue;
      }
      for (const [label, body, expected] of cases(platform, env)) {
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
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  return { failures, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, checked } = run();
  if (failures.length > 0) {
    console.error('installer-verify-test: an installer decision came out wrong\n');
    for (const f of failures) console.error(`  ${f}\n`);
    console.error(
      'The two verify verdicts must be taken over captured text, never a pipe into\n' +
        '`grep -q`: under `set -o pipefail` the early exit SIGPIPEs the writer and 141\n' +
        'reads as "no match" (SECURITY.md -> "Network posture (self-hosted)").\n' +
        '`env_missing_keys` must name every installer-owned key a half-written\n' +
        'config/server.env lacks, so the install says `rm` rather than "fix it"\n' +
        '(SECURITY.md -> "Credentials at rest").',
    );
    process.exit(1);
  }
  console.log(`installer-verify-test: OK (${checked} checks)`);
}
