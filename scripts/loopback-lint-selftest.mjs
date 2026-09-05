#!/usr/bin/env node
/**
 * Proves `loopback-lint.mjs` is load-bearing: add one unguarded loopback
 * listener, in each bind form the tree can express, and require the lint to go
 * red.
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
 * Each case appends a listener to one real, tracked, unguarded source file and
 * restores it afterwards (`scripts/lint-kit.mjs` owns the restore). The target
 * is deliberately a file with no listener and no guard reference of its own, so
 * a case that goes red went red for the bind and not for something already
 * there.
 */

import { makeSelftest, readRepoFile } from './lint-kit.mjs';

const LINT = 'scripts/loopback-lint.mjs';

/**
 * A tracked, non-test source file that binds nothing and names no guard.
 * Anything with those three properties works; this one is a small Windows-only
 * dev helper, so a mutation cannot disturb a build even if a run is killed
 * between the edit and the restore.
 */
const TARGET = 'scripts/free-dev-port.mjs';

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
  ['node, options object', "\nexport function __selftest(s) { s.listen({ port: 9999, host: '127.0.0.1' }); }\n"],
  ['@hono/node-server', "\nexport function __selftest(app) { serve({ fetch: app.fetch, port: 9999, hostname: '127.0.0.1' }); }\n"],
  ['ws, explicit loopback host', "\nexport function __selftest() { return new WebSocketServer({ host: '127.0.0.1' }); }\n"],
  ['ws, explicit loopback host', "\nexport function __selftest() { return new WebSocket.Server({ host: '127.0.0.1' }); }\n"],
  ['ws, port only', '\nexport function __selftest() { return new WebSocketServer({ port: 9999 }); }\n'],
  ['ws, port only', '\nexport function __selftest() { return new WebSocket.Server({ port: 9999 }); }\n'],
];

const selftest = makeSelftest('loopback-lint.mjs', '.loopback-selftest.bak');

for (const [name, source] of FIXTURES) {
  selftest.withAppended(
    TARGET,
    source,
    `${name}\n      adding this bind to ${TARGET} stays green — loopback-lint cannot see it`,
  );
}

// Every alternative the lint declares needs a fixture above, or it is a claim
// nothing checks — which is how a `WebSocket.Relay` branch that matched no real
// API rode along beside a working one. Read as text because `loopback-lint.mjs`
// runs its checks at module scope and exits, so it cannot be imported.
const declared = [...readRepoFile(LINT).matchAll(/^ *\{ label: '([^']+)'/gm)].map((m) => m[1]);
if (declared.length === 0) {
  selftest.weak.push(
    `no bind forms found in ${LINT}\n`
    + '      BIND_FORMS has moved, so this file is no longer checking its coverage',
  );
}
for (const label of declared) {
  if (FIXTURES.some(([name]) => name === label)) continue;
  selftest.weak.push(
    `${label}\n      ${LINT} declares this bind form and no fixture here exercises it`,
  );
}

selftest.finish(
  'loopback-lint-selftest',
  'Each fixture adds one unguarded loopback listener. A case that stays green means\n'
  + 'LISTEN_RE in scripts/loopback-lint.mjs does not match that bind form — and a form\n'
  + 'reported with no fixture is one nothing has ever matched. Either way the\n'
  + '"a new loopback bind that does not reference a guard module fails the build"\n'
  + 'clause in docs/specs/security-local.md -> "Loopback Listeners" is not true of it.',
);
