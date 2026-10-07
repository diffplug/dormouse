#!/usr/bin/env node
/**
 * Executable tests for the installer decisions whose answer cannot be read off
 * the file: the searches over CLI output nobody bounds — whether the loopback
 * port is bound anywhere but 127.0.0.1 and whether an existing Serve config
 * already claims the root path — plus the install's reading of a possibly
 * half-written `config/relay.env`, credential ownership, and exclusive release
 * staging. Env-reader cases also execute the shipped wrapper parser. Runs
 * from the repo root via `pnpm test`. `--help` is checked the same way: its
 * output is a behavior of the extraction the script runs, not of the header it
 * is supposed to reproduce.
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
 * the `MANAGE_EOF` heredoc. Today `env_file_value` and `serve_origin_root`
 * are defined twice, and each pair is checked identical. `owner_only`,
 * `has_off_loopback` and `serve_proxies_root` are in the heredoc (the
 * `manage` copy); `create_release_stage`, `env_missing_keys` and
 * `serve_state` are in the installer body.
 *
 * Windows is not run: nothing in CI can run PowerShell, so its Serve reader
 * and gate — the same reading over the same text — are pinned textually by
 * `deploy-lint.mjs` instead.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRepoFile, repoRoot } from './lint-kit.mjs';

/**
 * The script's own header comment, de-commented: every line after the shebang
 * down to the first that is not a comment. Derived here rather than read off
 * the installer's own `--help`, which is the thing under test.
 */
function headerComment(text) {
  const lines = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.startsWith('#')) break;
    lines.push(`${line.replace(/^# ?/, '')}\n`);
  }
  return lines.join('');
}

/**
 * One shell function, taken from `text` by name. The last definition wins: a
 * helper the installer body and the `manage` heredoc both define is tested as
 * the installed copy.
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

/**
 * `tailscale serve status` text, in the shapes Tailscale's own printer emits
 * (`printServeStatusTrees` and `printWebStatusTree` in its
 * `cmd/tailscale/cli/serve_status.go` and `serve_legacy.go`): one header line
 * per listener — `https://<host>` for :443, `https://<host>:<port>` for any
 * other, `(tailnet only)` or `(Funnel on)` after it, `(svc:<name>)` after that
 * for a Service — then one `|-- <mount> <type> <target>` line per handler.
 * Mounts are padded to the longest and `<type>` to five columns, so `path` and
 * `text` carry two spaces before the target. A blank line ends each listener.
 */
const ORIGIN = 'https://node.tailnet.ts.net';
const listener = (header, ...handlers) => [header, ...handlers, ''].join('\n');
const SERVE_ROOT_FOREIGN = '|-- / proxy http://127.0.0.1:9999';
const SERVE_ROOT_OURS = '|-- / proxy http://127.0.0.1:3100';
const SERVE_ROOT_PATH = '|-- / path  /Users/me/site';
const SERVE_ROOT_TEXT = '|-- / text  "hello from elsewhere"';
const SERVE_OTHER_PATH = '|-- /elsewhere proxy http://127.0.0.1:8888';
const SERVE_OUR_PORT_OTHER_PATH = '|-- /api proxy http://127.0.0.1:3100';
const SERVE_ROOT_PORT_PREFIX = '|-- / proxy http://127.0.0.1:31000';
const AT_443 = `${ORIGIN} (tailnet only)`;
const AT_443_FUNNEL = `${ORIGIN} (Funnel on)`;
const AT_8443 = `${ORIGIN}:8443 (tailnet only)`;
const AT_SERVICE = 'https://web.tailnet.ts.net (tailnet only) (svc:web)';
const SERVE_STATUS = {
  ours: listener(AT_443, SERVE_ROOT_OURS),
  oursPadded: listener(AT_443, '|-- /    proxy http://127.0.0.1:3100', '|-- /api proxy http://127.0.0.1:8888'),
  oursUnderFunnel: [
    '',
    '# Funnel on:',
    `#     - ${ORIGIN}`,
    '',
    listener(AT_443_FUNNEL, SERVE_ROOT_OURS),
  ].join('\n'),
  foreignProxy: listener(AT_443, SERVE_ROOT_FOREIGN),
  foreignPath: listener(AT_443, SERVE_ROOT_PATH),
  foreignText: listener(AT_443, SERVE_ROOT_TEXT),
  foreignPathPadded: listener(AT_443, '|-- /         path  /Users/me/site', SERVE_OTHER_PATH),
  foreignWithOurPortElsewhere: listener(AT_443, SERVE_ROOT_FOREIGN, SERVE_OUR_PORT_OTHER_PATH),
  portPrefix: listener(AT_443, SERVE_ROOT_PORT_PREFIX),
  // Ours on another listener, someone else's at the origin: Tailscale sorts
  // listeners by host:port, so :443 prints first, but the reading must not
  // depend on the order.
  oursOn8443ForeignOn443: [listener(AT_443, SERVE_ROOT_FOREIGN), listener(AT_8443, SERVE_ROOT_OURS)].join('\n'),
  oursOn8443PathOn443: [listener(AT_8443, SERVE_ROOT_OURS), listener(AT_443, SERVE_ROOT_PATH)].join('\n'),
  oursOn8443Only: listener(AT_8443, SERVE_ROOT_OURS),
  oursOnServiceOnly: listener(AT_SERVICE, SERVE_ROOT_OURS),
  foreignOn8443OursOn443: [listener(AT_443, SERVE_ROOT_OURS), listener(AT_8443, SERVE_ROOT_FOREIGN)].join('\n'),
  noRootAtOrigin: listener(AT_443, SERVE_OUR_PORT_OTHER_PATH),
  noConfig: 'No serve config',
};

/** `printf '%s'` of one fixture, safe inside a double-quoted shell word. */
const shellText = (text) => `$(printf '%s\\n' ${text.split('\n').map((l) => `'${l.replaceAll("'", "'\\''")}'`).join(' ')})`;

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
  '# Dormouse selfhost Relay — installer-owned runtime configuration.',
  '# Generated 2026-01-01T00:00:00Z. Preserved byte-for-byte across updates.',
  'DORMOUSE_ORIGIN=https://laptop.tail.ts.net',
  'DORMOUSE_STATE_DIR=/home/me/.local/share/dormouse-relay/state',
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
    throughOrigin: head.slice(0, 3).join('\n'),
    throughBindHost: head.slice(0, 5).join('\n'),
    // A key present with no value is as absent as a missing line.
    emptyOrigin: ENV_COMPLETE.replace(/^DORMOUSE_ORIGIN=.*$/m, 'DORMOUSE_ORIGIN='),
    // An operator's own addition is not a defect.
    extraKey: `${ENV_COMPLETE}\nDORMOUSE_LOG_LEVEL=debug`,
    duplicateBinding: `${ENV_COMPLETE}\nDORMOUSE_BIND_HOST=0.0.0.0`,
    emptyLastBinding: `${ENV_COMPLETE}\nDORMOUSE_BIND_HOST=`,
    quotedBinding: `${ENV_COMPLETE}\nDORMOUSE_BIND_HOST="127.0.0.1"`,
    unmatchedQuote: `${ENV_COMPLETE}\nDORMOUSE_BIND_HOST="127.0.0.1`,
    duplicateOrigin: `${ENV_COMPLETE}\nDORMOUSE_ORIGIN=https://another.tail.ts.net`,
    duplicatePort: `${ENV_COMPLETE}\nPORT=31000`,
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
  const ownerCases = [
    ['700 fixture-owner', 'pass', 'private path owned by this account'],
    ['755 fixture-owner', 'fail', 'world-readable mode'],
    ['700 another-owner', 'fail', 'private path owned by another account'],
    ['', 'fail', 'stat failed or path missing'],
  ].map(([metadata, expected, label]) => [
    `owner_only: ${label}`,
    `pass() { echo pass; }; fail() { echo fail; }; id() { echo fixture-owner; }; stat() { printf '%s' '${metadata}'; }; owner_only /unused 700 secret`,
    expected,
  ]);
  const configCases = [
    ['duplicateBinding', 'DORMOUSE_BIND_HOST', '0.0.0.0'],
    ['emptyLastBinding', 'DORMOUSE_BIND_HOST', ''],
    ['quotedBinding', 'DORMOUSE_BIND_HOST', '127.0.0.1'],
    ['unmatchedQuote', 'DORMOUSE_BIND_HOST', '"127.0.0.1'],
    ['duplicateOrigin', 'DORMOUSE_ORIGIN', 'https://another.tail.ts.net'],
    ['duplicatePort', 'PORT', '31000'],
  ].map(([fixture, key, value]) => [
    `env_file_value: ${fixture} agrees with the shipped wrapper`,
    `ENV_FILE='${env[fixture]}'; load_runtime_env; printf '[%s|%s]\\n' "$(env_file_value "$ENV_FILE" ${key})" "$${key}"`,
    `[${value}|${value}]`,
  ]);
  return [
    ...ownerCases,
    ...configCases,
    [
      'env_missing_keys: a later empty assignment overrides the earlier value',
      `printf '[%s]\\n' "$(env_missing_keys '${env.emptyLastBinding}')"`,
      '[ DORMOUSE_BIND_HOST]',
    ],
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
    // The only pin that RUNS `serve_proxies_root`, and the only one that
    // catches a weakening which keeps the spelling: a fallback match beside the
    // scoped one leaves `deploy-lint`'s textual counts green while the negative
    // cases below go red.
    ...[
      ['ours', 'pass'],
      ['oursPadded', 'pass'],
      ['oursUnderFunnel', 'pass'],
      ['foreignWithOurPortElsewhere', 'fail'],
      ['portPrefix', 'fail'],
      ['oursOn8443ForeignOn443', 'fail'],
      ['oursOn8443Only', 'fail'],
      ['oursOnServiceOnly', 'fail'],
      ['foreignOn8443OursOn443', 'pass'],
      ['noConfig', 'fail'],
    ].map(([fixture, expected]) => [
      `serve_proxies_root: ${fixture}`,
      `if serve_proxies_root 3100 '${ORIGIN}' "${shellText(SERVE_STATUS[fixture])}"; then echo pass; else echo fail; fi`,
      expected,
    ]),
    [
      'serve_proxies_root: no origin recorded is never a pass',
      `if serve_proxies_root 3100 '' "${shellText(SERVE_STATUS.ours)}"; then echo pass; else echo fail; fi`,
      'fail',
    ],
    [
      'env_missing_keys: the file the installer writes is complete',
      `printf '[%s]\\n' "$(env_missing_keys '${env.complete}')"`,
      '[]',
    ],
    [
      'env_missing_keys: created and never filled',
      `printf '[%s]\\n' "$(env_missing_keys '${env.empty}')"`,
      '[ DORMOUSE_ORIGIN DORMOUSE_STATE_DIR DORMOUSE_BIND_HOST PORT]',
    ],
    [
      'env_missing_keys: died after the comment header',
      `printf '[%s]\\n' "$(env_missing_keys '${env.headerOnly}')"`,
      '[ DORMOUSE_ORIGIN DORMOUSE_STATE_DIR DORMOUSE_BIND_HOST PORT]',
    ],
    [
      'env_missing_keys: died after the origin line',
      `printf '[%s]\\n' "$(env_missing_keys '${env.throughOrigin}')"`,
      '[ DORMOUSE_STATE_DIR DORMOUSE_BIND_HOST PORT]',
    ],
    [
      'env_missing_keys: died one line from the end',
      `printf '[%s]\\n' "$(env_missing_keys '${env.throughBindHost}')"`,
      '[ PORT]',
    ],
    [
      'env_missing_keys: a key with no value is as absent as a missing line',
      `printf '[%s]\\n' "$(env_missing_keys '${env.emptyOrigin}')"`,
      '[ DORMOUSE_ORIGIN]',
    ],
    [
      "env_missing_keys: an operator's extra key is not a defect",
      `printf '[%s]\\n' "$(env_missing_keys '${env.extraKey}')"`,
      '[]',
    ],
    // The gate the confirm hangs off: `conflict` is the only answer that asks
    // before repointing the operator's `/`, so every foreign root handler must
    // reach it, and a root on any other listener must not answer `loopback`.
    ...[
      ['ours', 'loopback'],
      ['oursPadded', 'loopback'],
      ['oursUnderFunnel', 'loopback'],
      ['foreignOn8443OursOn443', 'loopback'],
      ['foreignProxy', 'conflict'],
      ['foreignPath', 'conflict'],
      ['foreignText', 'conflict'],
      ['foreignPathPadded', 'conflict'],
      ['foreignWithOurPortElsewhere', 'conflict'],
      ['portPrefix', 'conflict'],
      ['oursOn8443ForeignOn443', 'conflict'],
      ['oursOn8443PathOn443', 'conflict'],
      ['oursOn8443Only', 'none'],
      ['oursOnServiceOnly', 'none'],
      ['noRootAtOrigin', 'none'],
      ['noConfig', 'none'],
    ].map(([fixture, expected]) => [
      `serve_state: ${fixture}`,
      `serve_state 3100 '${ORIGIN}' "${shellText(SERVE_STATUS[fixture])}"`,
      expected,
    ]),
    [
      'serve_state: a foreign root mapping, ahead of 1 MiB',
      `serve_state 3100 '${ORIGIN}' "$(printf '%s\\n%s\\n' '${AT_443}' '${SERVE_ROOT_FOREIGN}'; awk 'BEGIN{for(i=0;i<20000;i++) print "${SERVE_OTHER_PATH}"}')"`,
      'conflict',
    ],
    [
      'serve_state: 1 MiB of serve status with no root mapping at all',
      `serve_state 3100 '${ORIGIN}' "$(printf '%s\\n' '${AT_443}'; awk 'BEGIN{for(i=0;i<20000;i++) print "${SERVE_OTHER_PATH}"}')"`,
      'none',
    ],
    ...[
      ['foreignProxy', '[proxy http://127.0.0.1:9999]'],
      ['foreignPath', '[path  /Users/me/site]'],
      ['foreignText', '[text  "hello from elsewhere"]'],
      ['oursOn8443ForeignOn443', '[proxy http://127.0.0.1:9999]'],
    ].map(([fixture, expected]) => [
      `serve_origin_root: names the origin's root handler for the confirm (${fixture})`,
      `printf '[%s]\\n' "$(serve_origin_root '${ORIGIN}' "${shellText(SERVE_STATUS[fixture])}")"`,
      expected,
    ]),
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
  const protectedDir = join(fixtureDir, 'protected');
  const publicDir = join(fixtureDir, 'public');
  mkdirSync(protectedDir, { mode: 0o700 });
  mkdirSync(publicDir);
  chmodSync(publicDir, 0o755);
  try {
    for (const { platform, file } of PLATFORMS) {
      const text = readRepoFile(file);
      let helpers;
      try {
        helpers = [
          'create_release_stage',
          'env_file_value',
          'owner_only',
          'has_off_loopback',
          'env_missing_keys',
          'serve_origin_root',
          'serve_state',
          'serve_proxies_root',
        ]
          .map((name) => extractFunction(text, name))
          .join('\n\n');
        const parser = text.match(/while IFS= read -r line[^]*?done < "\$ENV_FILE"/);
        if (!parser) throw new Error('missing wrapper env parser');
        helpers += `\nload_runtime_env() {\n${parser[0]}\n}\n`;
        for (const name of ['env_file_value', 'serve_origin_root']) {
          const copies = [...text.matchAll(new RegExp(`\\n${name}\\(\\) \\{[^]*?\\n\\}`, 'g'))];
          if (copies.length !== 2 || copies[0][0] !== copies[1][0]) {
            throw new Error(`installer and manage copies of ${name}() differ`);
          }
        }
      } catch (err) {
        failures.push(`${platform}: ${err.message} in ${file}`);
        continue;
      }
      // `--help` reprints this script's own header comment. A control that names
      // the header's LAST LINE goes stale the moment the header grows, silently
      // and only in the part that grew: the Linux range still ended where the
      // header did before `DORMOUSE_INSTALL_ORIGIN` was documented, so `--help`
      // never mentioned the one variable only that installer has. Compared
      // against the header read out of the file, so either side drifting reddens.
      checked += 1;
      const help = spawnSync('bash', [join(repoRoot, file), '--help'], {
        encoding: 'utf8',
        // Emptied rather than inherited: the installer rejects these two before
        // it reaches the argument loop unless test mode is on, so a developer
        // who exported them would see this check fail for the wrong reason.
        env: { ...process.env, DORMOUSE_INSTALL_ROOT: '', DORMOUSE_INSTALL_ORIGIN: '' },
      });
      const printedHelp = help.stdout ?? '';
      const header = headerComment(text);
      if (help.status !== 0 || printedHelp !== header) {
        const missing = header
          .split('\n')
          .filter((line) => line.trim() && !printedHelp.includes(line))
          .slice(0, 3);
        failures.push(
          `${platform.padEnd(6)} --help does not reprint the whole header comment of ${file}` +
            (help.status === 0 ? '' : ` (bash exited ${help.status}: ${(help.stderr ?? '').trim()})`) +
            (missing.length ? `\n    first missing line(s): ${missing.join(' / ')}` : ''),
        );
      }

      const allCases = cases(platform, env);
      const stagePath = join(fixtureDir, `stage-${platform}`);
      const quotedStage = "'" + stagePath.replaceAll("'", "'\\''") + "'";
      allCases.push([
        'create_release_stage: collision preserves an existing release',
        `create_release_stage ${quotedStage}; printf keep > ${quotedStage}/marker; if create_release_stage ${quotedStage} 2>/dev/null; then echo overwritten; else cat ${quotedStage}/marker; fi`,
        'keep',
      ]);
      if ((platform === 'macOS' && process.platform === 'darwin') ||
          (platform === 'Linux' && process.platform === 'linux')) {
        for (const [path, expected] of [[protectedDir, 'pass'], [publicDir, 'fail']]) {
          const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
          allCases.push([
            `owner_only: native stat on ${expected === 'pass' ? '0700' : '0755'} directory`,
            `pass() { echo pass; }; fail() { echo fail; }; owner_only ${quoted} 700 secret`,
            expected,
          ]);
        }
      }
      for (const [label, body, expected] of allCases) {
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, checked } = run();
  if (failures.length > 0) {
    console.error('installer-verify-test: an installer decision came out wrong\n');
    for (const f of failures) console.error(`  ${f}\n`);
    console.error(
      'The listener verdict must be taken over captured text, never a pipe into\n' +
        '`grep -q`: under `set -o pipefail` the early exit SIGPIPEs the writer and 141\n' +
        'reads as "no match" (docs/specs/security-remote.md -> "Network posture (self-hosted)").\n' +
        '`env_missing_keys` must name every installer-owned key a half-written\n' +
        'config/relay.env lacks, so the install says `rm` rather than "fix it"\n' +
        '(docs/specs/security-remote.md -> "Credentials at rest").\n' +
        '`--help` must print the whole header comment, derived from the file rather\n' +
        'than a hardcoded last line, so documenting a new option cannot silently\n' +
        'leave it out of the help text.',
    );
    process.exit(1);
  }
  console.log(`installer-verify-test: OK (${checked} checks)`);
}
