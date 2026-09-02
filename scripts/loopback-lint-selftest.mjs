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
 * lint stayed green on both, while `SECURITY.md` claimed a new loopback bind
 * fails the build. A green `loopback-lint` said nothing about that.
 *
 * Each case appends a listener to one real, tracked, unguarded source file and
 * restores it afterwards (`scripts/lint-kit.mjs` owns the restore). The target
 * is deliberately a file with no listener and no guard reference of its own, so
 * a case that goes red went red for the bind and not for something already
 * there.
 */

import { makeSelftest } from './lint-kit.mjs';

/**
 * A tracked, non-test source file that binds nothing and names no guard.
 * Anything with those three properties works; this one is a small Windows-only
 * dev helper, so a mutation cannot disturb a build even if a run is killed
 * between the edit and the restore.
 */
const TARGET = 'scripts/free-dev-port.mjs';

/**
 * One case per bind form `LISTEN_RE` claims to see. Written as code rather than
 * a comment: the lint is textual and would match either, but a comment would
 * not survive someone deciding to parse instead of scan.
 */
const BIND_FORMS = [
  ['node, positional', "\nexport function __selftest(s) { s.listen(9999, '127.0.0.1'); }\n"],
  ['node, options object', "\nexport function __selftest(s) { s.listen({ port: 9999, host: '127.0.0.1' }); }\n"],
  ['@hono/node-server', "\nexport function __selftest(app) { serve({ fetch: app.fetch, port: 9999, hostname: '127.0.0.1' }); }\n"],
  ['ws, explicit loopback host', "\nexport function __selftest(W) { return new WebSocketServer({ host: '127.0.0.1', port: 9999 }); }\n"],
  ['ws, port only (binds every interface, loopback included)', '\nexport function __selftest() { return new WebSocketServer({ port: 9999 }); }\n'],
];

const selftest = makeSelftest('loopback-lint.mjs', '.loopback-selftest.bak');

for (const [name, source] of BIND_FORMS) {
  selftest.withAppended(
    TARGET,
    source,
    `${name}\n      adding this bind to ${TARGET} stays green — loopback-lint cannot see it`,
  );
}

selftest.finish(
  'loopback-lint-selftest',
  'Each case adds one unguarded loopback listener. A case that stays green means\n'
  + 'LISTEN_RE in scripts/loopback-lint.mjs does not match that bind form, so the\n'
  + '"a new loopback bind that does not reference a guard module fails the build"\n'
  + 'clause in SECURITY.md -> "Loopback Listeners" is not true of it.',
);
