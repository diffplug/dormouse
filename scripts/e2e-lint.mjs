#!/usr/bin/env node
/**
 * Mechanical check for the structural half of the end-to-end boundary in
 * `SECURITY.md` ("Remote Control"). Runs from the repo root via `pnpm test`
 * (see the root package.json). Exits non-zero with a per-violation report
 * naming the rule that was broken and the `SECURITY.md` line it enforces.
 *
 * Why this exists: the properties the trust boundary rests on are *absences* —
 * one Noise suite and no way to select another, no JavaScript curve, no
 * plaintext relay route, no legacy frame discriminant left to answer, no
 * Server-side view of protocol-v1, no checked-in service worker shadowing the
 * built one. An absence is exactly what a reviewer stops noticing: nothing in a
 * diff says "a second cipher suite is now reachable", and the nightly audit is
 * thorough but probabilistic. This makes the cheap half deterministic, so
 * re-introducing any of them fails a build.
 *
 * The check is *textual* on purpose — the same ceiling `loopback-lint.mjs` and
 * `deploy-lint.mjs` state about themselves. What it deliberately does NOT do:
 *
 *   - It cannot tell whether a construction is *correct*, only that a forbidden
 *     one is absent. A handshake that mixes in the wrong order, a seal that
 *     reuses a salt, or an ACL conjunction checking three fields instead of
 *     four all pass here. `server-lib-common/test/noise.test.mjs`,
 *     `push-seal.test.mjs`, `security-guarantees.test.mjs`, and the
 *     malicious-relay harness own that, and so does the audit.
 *   - It reasons about spelled-out identifiers and string literals. A protocol
 *     name assembled at runtime, an algorithm chosen through a variable, or a
 *     dependency reached through a re-export is invisible to a regex and always
 *     will be.
 *   - Test files are out of scope for the discriminant rules on purpose:
 *     `lib/src/remote/host/remote-host.test.ts` and
 *     `server-lib-common/test/wire.test.mjs` name the retired tags precisely to
 *     assert they are *rejected*, and a lint that reddened on those would push
 *     someone to delete the regression tests.
 *
 * Every rule names the `SECURITY.md` line it enforces, and that line is checked
 * to still exist — a rule whose prose was deleted is a rule nobody agreed to.
 * `scripts/e2e-lint-selftest.mjs` is what keeps the patterns honest: it
 * re-introduces each forbidden thing in turn and requires this lint to fail.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readRepoFile, repoRoot, trackedFiles } from './lint-kit.mjs';

/**
 * The one suite. Spelled here rather than imported, because importing the
 * constant from the module under test would make the rule self-satisfying:
 * renaming the suite would rename the expectation with it.
 */
const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';

/**
 * The modules that carry the end-to-end boundary. Scoped explicitly rather than
 * by directory, because the neighbours matter: `passkey.ts` and `ecdsa.ts` are
 * ES256 (`ECDSA` / `P-256`) by WebAuthn's mandatory-to-implement rule, and a
 * curve rule that swept the whole `security/` directory would flag the one
 * place those strings *belong*.
 */
const E2E_MODULES = [
  'server-lib-common/src/security/noise.ts',
  'server-lib-common/src/security/noise-transport.ts',
  'server-lib-common/src/security/push-seal.ts',
  'server-lib-common/src/security/e2e-ceremony.ts',
  'server-lib-common/src/security/e2e-bounds.ts',
  'server-lib-common/src/security/pairing-invitation.ts',
  'server-lib-common/src/security/acl.ts',
  'server-lib-common/src/remote/wire.ts',
  'lib/src/remote/host/remote-host.ts',
  'lib/src/remote/host/push-delivery.ts',
  'lib/src/remote/client/pocket-client.ts',
  'lib/src/remote/pocket-app/sw.ts',
];

/** The two modules that own the Noise suite itself. */
const NOISE_MODULES = [
  'server-lib-common/src/security/noise.ts',
  'server-lib-common/src/security/noise-transport.ts',
];

/**
 * The four files that decide what a relay frame is. A retired discriminant
 * anywhere here is a path something could still answer.
 */
const FRAME_MODULES = [
  'server-lib-common/src/remote/wire.ts',
  'server/src/relay.ts',
  'lib/src/remote/host/remote-host.ts',
  'lib/src/remote/client/pocket-client.ts',
];

/** The three shipped source trees, scanned whole for the dependency rules. */
const SOURCE_TREES = ['server-lib-common/src/', 'lib/src/', 'server/src/'];

/**
 * One entry per structural property. Every rule states the `SECURITY.md` line
 * it enforces in `security`, which must still appear in that file.
 *
 * Rule kinds:
 *   - `forbid`   — the pattern must not match in any file of `files`. `allow`
 *                  exempts individual matches (the suite's own name).
 *   - `absent`   — `path` must not exist.
 *   - `require`  — the pattern must match in `file`, at least once.
 *   - `exactly`  — the pattern must match across `files` exactly `count` times,
 *                  in both directions: fewer means a control went missing, more
 *                  means a site was added and the count must be bumped
 *                  deliberately in the same commit.
 *
 * `violation` is the text `scripts/e2e-lint-selftest.mjs` puts back — appended
 * to `violationFile`, or written as `path` for an `absent` rule — to prove the
 * rule load-bearing. A `require` rule needs none: its violation is deleting
 * whatever the pattern matched.
 */
export const RULES = [
  {
    rule: 'One Noise suite — no protocol name but the one',
    security: 'There is exactly one channel and no other path',
    kind: 'forbid',
    trees: SOURCE_TREES,
    // Every Noise protocol name, in the wire spelling. The allow-list is the
    // single suite; anything else is a second protocol, whatever it is called.
    pattern: /\bNoise_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*/g,
    allow: (match) => match === NOISE_PROTOCOL_NAME,
    violationFile: 'server-lib-common/src/security/noise.ts',
    violation: "\nconst __selftest = 'Noise_XX_25519_AESGCM_SHA256';\n",
  },
  {
    rule: 'No generic pattern, suite, or protocol-name option on the handshake API',
    security: 'no negotiation, no cipher or pattern selector',
    kind: 'forbid',
    files: NOISE_MODULES,
    // Shaped as a TS member or object key, so the words may still be used in
    // prose: a doc-comment line starts with `*`, which breaks the anchor.
    pattern: /(?:^|[{,;])[ \t]*(?:readonly[ \t]+)?(?:pattern|suite|cipherSuite|protocolName|dhFunction|hashFunction)[ \t]*\??[ \t]*:/gm,
    violationFile: 'server-lib-common/src/security/noise.ts',
    violation: '\nexport interface SelftestOptions {\n  readonly pattern: string;\n}\n',
  },
  {
    rule: 'No second AEAD anywhere in the shipped source',
    security: 'no negotiation, no cipher or pattern selector',
    kind: 'forbid',
    trees: SOURCE_TREES,
    // `AES-GCM` is the substitution the Noise suite exists to refuse: it *is* in
    // shipping WebCrypto, which is exactly what makes it the tempting one, and
    // the protocol name is part of the transcript so swapping it is a different
    // protocol rather than a configuration choice.
    pattern: /['"]AES-GCM['"]/g,
    violationFile: 'server-lib-common/src/security/push-seal.ts',
    violation: "\nconst __selftest = { name: 'AES-GCM' };\n",
  },
  {
    rule: 'No ECDH, ECDSA, or named-curve primitive inside the e2e modules',
    security: 'no negotiation, no cipher or pattern selector',
    kind: 'forbid',
    files: E2E_MODULES,
    // Scoped to the e2e modules so WebAuthn's mandatory ES256 — `ECDSA` /
    // `P-256` in `passkey.ts`, `ecdsa.ts`, and the Server's SPKI import — is
    // not swept up. Inside these files there is one key agreement (X25519) and
    // one signature scheme (none).
    pattern: /['"](?:ECDH|ECDSA|P-256|P-384|P-521|Ed25519)['"]|\bnamedCurve\b/g,
    violationFile: 'server-lib-common/src/security/noise.ts',
    violation: "\nconst __selftest = { name: 'ECDH', namedCurve: 'P-256' };\n",
  },
  {
    rule: 'No JavaScript curve or NaCl implementation in production source',
    security: 'X25519 stays WebCrypto-only',
    kind: 'forbid',
    trees: SOURCE_TREES,
    // Anchored on the import, not the package name, so the module header may go
    // on explaining why `@noble/ciphers` is the one exception.
    pattern:
      /\bfrom\s+['"](?:@noble\/curves|@noble\/hashes|@noble\/ed25519|@noble\/secp256k1|tweetnacl|libsodium|libsodium-wrappers|sodium-native|elliptic|js-nacl|micro-ed25519)/g,
    violationFile: 'server-lib-common/src/security/noise.ts',
    violation: "\nimport { x25519 } from '@noble/curves/ed25519.js';\n",
  },
  {
    rule: 'Exactly two `@noble/ciphers` imports — the ChaChaPoly binding and nothing else',
    security: 'X25519 stays WebCrypto-only',
    kind: 'exactly',
    trees: SOURCE_TREES,
    pattern: /\bfrom\s+['"]@noble\/ciphers/g,
    count: 2,
    violationFile: 'server-lib-common/src/security/push-seal.ts',
    violation: "\nimport { xchacha20poly1305 } from '@noble/ciphers/chacha.js';\n",
  },
  {
    rule: 'No legacy relay discriminant',
    security: 'no plaintext relay route, and no reader for any of the pre-cutover frames',
    kind: 'forbid',
    files: FRAME_MODULES,
    // The tags of the Server-readable protocol this replaced. A reader for one
    // is a path a hostile relay could still drive; the shipped set is `e2e`,
    // `host-gone`, `error`, and `client-gone`.
    pattern:
      /['"](?:pair|pair-status|connect|connect2|msg|pair-result|challenge|decision|setup-token-redeemed)['"]/g,
    violationFile: 'server/src/relay.ts',
    violation: "\nconst __selftest = { t: 'connect2' };\n",
  },
  {
    rule: 'The Server never names a protocol-v1 plaintext type',
    security: 'Server-side type import from the protocol-v1 half',
    kind: 'forbid',
    trees: ['server/src/'],
    // Naming one is not itself a read, but it is the only reason a relay would
    // have to: the Server routes an opaque envelope, so a file that knows what
    // a `DirectoryEntry` is has started to care what it is carrying.
    pattern:
      /\b(?:RemoteRequest|RemoteResponse|RemoteEventMsg|DirectoryEntry|DirectorySnapshot|TerminalDataEvent|TerminalClosedEvent|TerminalSemanticEvent|AttachParams|TerminalAttachResult|TerminalWriteParams|TerminalResizeParams|HelloParams|HelloResult|REMOTE_METHODS|REMOTE_EVENTS|MAX_TERMINAL_DIMENSION|clampTerminalDimension)\b/g,
    violationFile: 'server/src/relay.ts',
    violation: "\nimport type { DirectoryEntry } from 'server-lib-common';\n",
  },
  {
    rule: 'No checked-in service worker beside the built one',
    security: 'the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one',
    kind: 'absent',
    // `lib/pocket/public/` is copied verbatim into `dist-pocket/`, *after* the
    // worker build writes `dist-pocket/sw.js` — so a file here would silently
    // replace the bundle that decrypts sealed pushes with whatever it contains.
    path: 'lib/pocket/public/sw.js',
    violation: '// selftest\n',
  },
  {
    rule: 'The worker registers as a classic script',
    security: 'the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one',
    kind: 'forbid',
    files: ['lib/src/remote/pocket-app/service-worker.ts'],
    // A module worker installs on nothing in the browsers Pocket ships to, and
    // push is the one feature no desktop exercises, so the failure is invisible
    // until a phone does not buzz.
    pattern: /\btype\s*:\s*['"]module['"]/g,
    violationFile: 'lib/src/remote/pocket-app/service-worker.ts',
    violation: "\nconst __selftest = { type: 'module' };\n",
  },
  {
    rule: 'No optional ciphertext, key, or transcript field on a wire or ceremony type',
    security: 'a route that could read a payload is one that was handed plaintext',
    kind: 'forbid',
    files: [
      'server-lib-common/src/remote/wire.ts',
      'server-lib-common/src/security/e2e-ceremony.ts',
      'server-lib-common/src/security/push-seal.ts',
    ],
    // Every one of these is load-bearing on every message that carries it, so
    // an optional spelling is a shape where a peer can simply omit the
    // authentication and have the type still check.
    pattern: /\b(?:ct|salt|sealed|handshakeHash|key|ciphertext|plaintext|proof|assertion)[ \t]*\?[ \t]*:/g,
    violationFile: 'server-lib-common/src/security/push-seal.ts',
    violation: '\nexport interface SelftestSeal {\n  readonly ct?: string;\n}\n',
  },
  {
    rule: 'The worker assertion runs in `build:pocket`',
    security: 'the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one',
    kind: 'require',
    file: 'lib/package.json',
    pattern: /node scripts\/assert-pocket-worker\.mjs/,
  },
  {
    rule: 'The root build runs the Pocket build, so CI sees a real bundler output',
    security: 'the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one',
    kind: 'require',
    file: 'package.json',
    // Anchored inside the `build` script, not on the command: `dev:pocket-server`
    // runs the same line, so a bare match stayed green after `build` stopped
    // building the worker at all.
    pattern: /"build":\s*"[^"]*pnpm --filter dormouse-lib build:pocket/,
  },
];

/**
 * Every tracked source file under one of `trees`, excluding tests.
 *
 * The test exclusion covers the three shapes this repo actually uses: a
 * `.test.` infix, a `test/` directory, and the `test-*.ts` helpers that live in
 * `lib/src/remote/` beside the code they drive.
 */
function sourceFilesUnder(trees) {
  return trackedFiles().filter(
    (file) =>
      trees.some((tree) => file.startsWith(tree)) &&
      /\.(?:ts|tsx|mjs|js)$/.test(file) &&
      !/\.test\./.test(file) &&
      !/(?:^|\/)tests?\//.test(file) &&
      !/(?:^|\/)test-[^/]*$/.test(file) &&
      !/-test-utils\.[a-z]+$/.test(file),
  );
}

/** The files a rule scans: an explicit list, or every source file under its trees. */
export function filesFor(rule) {
  return rule.files ?? sourceFilesUnder(rule.trees);
}

export function check() {
  const failures = [];
  let checked = 0;
  // One read per file for the whole run: four rules scan the same three trees,
  // so without this the same ~300 files are read four times over.
  const texts = new Map();
  const read = (relative) => {
    let text = texts.get(relative);
    if (text === undefined) texts.set(relative, (text = readRepoFile(relative)));
    return text;
  };

  const security = existsSync(join(repoRoot, 'SECURITY.md')) ? read('SECURITY.md') : '';

  for (const rule of RULES) {
    // A rule whose SECURITY.md line is gone is a rule nobody agreed to. Checked
    // first, so a deleted invariant is reported as that rather than as whatever
    // the pattern happens to find.
    if (!security.includes(rule.security)) {
      failures.push(
        `${rule.rule}\n    SECURITY.md no longer says "${rule.security}" — the rule and its prose must move together`,
      );
    }

    if (rule.kind === 'absent') {
      checked += 1;
      if (existsSync(join(repoRoot, rule.path))) {
        failures.push(`${rule.rule}\n    ${rule.path} exists and must not`);
      }
      continue;
    }

    if (rule.kind === 'require') {
      checked += 1;
      let text;
      try {
        text = read(rule.file);
      } catch {
        failures.push(`${rule.rule}\n    ${rule.file}: missing`);
        continue;
      }
      if (!rule.pattern.test(text)) {
        failures.push(`${rule.rule}\n    ${rule.file} no longer matches ${rule.pattern}`);
      }
      continue;
    }

    const files = filesFor(rule);
    if (files.length === 0) {
      failures.push(`${rule.rule}\n    matched no files — the scope moved and this rule checks nothing`);
      continue;
    }

    let total = 0;
    for (const file of files) {
      checked += 1;
      let text;
      try {
        text = read(file);
      } catch {
        failures.push(`${rule.rule}\n    ${file}: missing`);
        continue;
      }
      const hits = (text.match(rule.pattern) ?? []).filter((m) => !rule.allow?.(m));
      total += hits.length;
      if (rule.kind === 'forbid' && hits.length > 0) {
        failures.push(`${rule.rule}\n    ${file}: ${[...new Set(hits)].join(', ')}`);
      }
    }

    if (rule.kind === 'exactly' && total !== rule.count) {
      failures.push(
        total < rule.count
          ? `${rule.rule}\n    found ${total}, expected exactly ${rule.count} — a use went missing`
          : `${rule.rule}\n    found ${total}, expected exactly ${rule.count} — if a site was added on purpose, bump the count in the same commit`,
      );
    }
  }

  return { failures, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, checked } = check();
  if (failures.length > 0) {
    console.error('e2e-lint: the end-to-end boundary no longer holds what SECURITY.md requires\n');
    for (const failure of failures) console.error(`  ${failure}\n`);
    console.error(
      'Each line above maps to the "Remote Control" section of SECURITY.md. If a\n' +
        'control moved rather than disappeared, update the rule in scripts/e2e-lint.mjs\n' +
        'in the same commit — and add the self-test case that proves it load-bearing.',
    );
    process.exit(1);
  }
  console.log(`e2e-lint: OK (${RULES.length} rules, ${checked} checks)`);
}
