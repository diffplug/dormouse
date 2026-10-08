#!/usr/bin/env node
/**
 * Proves `loopback-lint.mjs` is load-bearing: add one unguarded loopback
 * listener, in each bind form the tree can express and in a source extension the
 * other fixtures do not reach, and require the lint to go red. Also add one to a
 * test file and require the lint to report it separately without failing.
 *
 * Why this exists rather than trusting a green run: the lint's whole job is to
 * *find* a bind, and the characteristic failure of a finding check is passing
 * because the pattern cannot see the API somebody used. That is not
 * hypothetical — an audit added a `serve({ hostname: '127.0.0.1' })` and a
 * `new WebSocketServer({ host: '127.0.0.1' })` to a throwaway repo and this
 * lint stayed green on both, while `docs/specs/security-local.md` claimed a new loopback bind
 * fails the build. A green `loopback-lint` said nothing about that.
 *
 * The lint's `BIND_FORMS` is the one list of what it looks for; this file keys
 * its fixtures to those labels and goes red on any form it has no fixture for,
 * so an alternative can no longer ride along unmatched the way a corrupted
 * `WebSocket.Relay` branch did beside a working one.
 *
 * Each case appends a listener to one real, tracked, unguarded source file in a
 * sandbox copy of the tree (`scripts/lint-kit.mjs` owns the sandbox). The target
 * is deliberately a file with no listener and no guard reference of its own, so
 * a case that goes red went red for the bind and not for something already
 * there.
 */

import { appendText, makeSelftest } from './lint-kit.mjs';

const LINT = 'scripts/loopback-lint.mjs';

/**
 * A tracked, non-test source file that binds nothing and names no guard.
 * Anything with those three properties works; this one is a small Windows-only
 * dev helper.
 */
const TARGET = 'standalone/scripts/clean-dev-sidecar.mjs';
const TEST_TARGET = 'lib/src/lib/feature-flags.test.ts';

/**
 * A tracked file in a source extension `TARGET` does not exercise. `SOURCE_EXT`
 * decides which files are read at all, so a narrowed extension list exempts a
 * whole language variant silently — the failure the bind-form fixtures cannot
 * see, because they only ever appear in a `.mjs` file.
 */
const EXT_TARGET = 'vscode-ext/vitest.smoketest.config.mts';

/**
 * A fixture per bind form, keyed by the label the lint's own `BIND_FORMS`
 * carries. Written as code rather than a comment: the lint is textual and would
 * match either, but a comment would not survive someone deciding to parse
 * instead of scan. Several fixtures may share a label — the two `ws` spellings
 * are one alternative — and each must exercise its form *alone*, so the
 * loopback-host cases pass no `port`, which would match the port-only form.
 */
const FIXTURES = [
  ['node, positional', "\nexport function __selftest(s) { s.listen(9999, '127.0.0.1'); }\n"],
  // A port computed by a call — `Number(process.env.PORT || 0)` — whose inner
  // `)` ends a scan that stops at the first one.
  ['node, positional', "\nexport function __selftest(s) { s.listen(Number(process.env.PORT || 0), '127.0.0.1'); }\n"],
  ['node, options object', "\nexport function __selftest(s) { s.listen({ port: 9999, host: '127.0.0.1' }); }\n"],
  ['@hono/node-server', "\nexport function __selftest(app) { serve({ fetch: app.fetch, port: 9999, hostname: '127.0.0.1' }); }\n"],
  ['ws, explicit loopback host', "\nexport function __selftest() { return new WebSocketServer({ host: '127.0.0.1' }); }\n"],
  ['ws, explicit loopback host', "\nexport function __selftest() { return new WebSocket.Server({ host: '127.0.0.1' }); }\n"],
  ['ws, port only', '\nexport function __selftest() { return new WebSocketServer({ port: 9999 }); }\n'],
  ['ws, port only', '\nexport function __selftest() { return new WebSocket.Server({ port: 9999 }); }\n'],
  ['vite, server.host', "\nexport const __selftest = { server: { host: '127.0.0.1', strictPort: true } };\n"],
  // A nested `server` key above `host` — the shape a real `vite.config.ts` has
  // and the one a first-brace-terminated scan misses.
  ['vite, server.host', "\nexport const __selftest = { server: { fs: { allow: ['.'] }, host: '127.0.0.1' } };\n"],
  // `proxy` nests a target object per route — two levels, the deepest the form
  // reaches. A route option that nests again (`headers`, `configure`) is past
  // the ceiling `scripts/loopback-lint.mjs` states.
  ['vite, server.host', "\nexport const __selftest = { server: { proxy: { '/api': { target: 'http://up' } }, host: '127.0.0.1' } };\n"],
];

const selftest = makeSelftest('loopback-lint.mjs');

for (const [name, source] of FIXTURES) {
  selftest.withAppended(
    TARGET,
    source,
    `${name}\n      adding this bind to ${TARGET} stays green — loopback-lint cannot see it`,
  );
}

// `.mts` and `.cts` are TypeScript too, and the spec, the audit prompt and this
// lint's own header all say it scans every tracked JavaScript and TypeScript
// file. Without this case that claim rests on an extension list nothing reads.
selftest.withAppended(
  EXT_TARGET,
  FIXTURES[0][1],
  `${EXT_TARGET}\n      adding this bind stays green — SOURCE_EXT in scripts/loopback-lint.mjs skips this extension`,
);

// Test listeners belong in the live inventory but do not need a product guard.
// Mutate a test that has no loopback bind of its own: this must stay green and
// print the path under the test heading.
selftest.withAppendedOutput(
  TEST_TARGET,
  FIXTURES[0][1],
  `${TEST_TARGET}:`,
  `${TEST_TARGET}\n      a test listener is not reported separately by loopback-lint`,
);

// Check 4: a shipped listener binds loopback. Planted in a shipped host module
// with no listener of its own; each must be reported as check 4's, not as a
// missing guard.
const SHIPPED_TARGET = 'lib/src/host/git-info.ts';
const BEYOND_LOOPBACK = [
  ['.listen(0) with no host', '\nexport function __selftest(s: any) { s.listen(0); }\n', 'no spelled-out loopback host'],
  ['.listen(port, callback)', '\nexport function __selftest(s: any, cb: () => void) { s.listen(9999, cb); }\n', 'no spelled-out loopback host'],
  ['.listen({ port }) with no host', '\nexport function __selftest(s: any) { s.listen({ port: 0 }); }\n', 'no spelled-out loopback host'],
  ['.listen(port, host variable)', '\nexport function __selftest(s: any, h: string) { s.listen(0, h); }\n', 'no spelled-out loopback host'],
  ['serve({ port }) with no hostname', '\nexport function __selftest(app: any) { serve({ fetch: app.fetch, port: 0 }); }\n', 'no spelled-out loopback host'],
  ['a 0.0.0.0 host', "\nexport const __selftest = { host: '0.0.0.0' };\n", 'binds every interface'],
  ["a '::' host passed to listen", "\nexport function __selftest(s: any) { s.listen(0, '::'); }\n", 'binds every interface'],
  ['a dgram socket', "\nexport const __selftest = (d: any) => d.createSocket('udp4');\n", 'opens a UDP socket CHECK_4_EXCEPTIONS does not name'],
  ['a second RTCPeerConnection', '\nexport const __selftest = () => new RTCPeerConnection({});\n', 'opens a UDP socket CHECK_4_EXCEPTIONS does not name'],
];
for (const [name, source, expected] of BEYOND_LOOPBACK) {
  selftest.withMutationReporting(
    SHIPPED_TARGET,
    appendText(source),
    expected,
    `${name}\n      adding this to ${SHIPPED_TARGET} does not report "${expected}" — check 4 cannot see it`,
  );
}
// An exception covers its one call, not the file: a TCP bind beside the peer
// link's Unix-socket listen is still a bind.
selftest.withMutationReporting(
  'vscode-ext/src/peer-link.ts',
  appendText('\nexport function __selftest(s: any) { s.listen(0); }\n'),
  'no spelled-out loopback host',
  'a second listen in a file CHECK_4_EXCEPTIONS names\n      the exception covers the whole file, not its one call',
);

// Every alternative the lint declares needs a fixture above, or it is a claim
// nothing checks — which is how a `WebSocket.Relay` branch that matched no real
// API rode along beside a working one.
selftest.requireFixtures(LINT, FIXTURES.map(([name]) => name), 'bind form');

selftest.finish(
  'loopback-lint-selftest',
  'Each fixture adds one unguarded loopback listener. A case that stays green means\n'
  + 'LISTEN_RE in scripts/loopback-lint.mjs does not match that bind form — and a form\n'
  + 'reported with no fixture is one nothing has ever matched. Either way the\n'
  + '"A new non-test listener without a guard reference fails the build"\n'
  + 'clause in docs/specs/security-local.md -> "Loopback Listeners" is not true of it.\n'
  + 'A green extension case means SOURCE_EXT does not read that file type, so the\n'
  + '"all tracked JavaScript and TypeScript" scope is narrower than it claims.\n'
  + 'The test case must stay green and appear under the test heading. A green\n'
  + 'check-4 case is a shipped bind beyond loopback the lint cannot see.',
);
