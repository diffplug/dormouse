#!/usr/bin/env node
/**
 * Proves `outbound-lint.mjs` is load-bearing: plant one violation per network
 * form and per rule, and require the lint to go red *naming that violation* —
 * a case that goes red for some other reason proves nothing about its rule.
 *
 * Why this exists rather than trusting a green run: the lint's job is to *find*
 * a primitive, and a finding check's characteristic failure is passing because
 * its pattern cannot see the spelling somebody used. `FORMS` in the lint is the
 * one list of what it looks for; this file keys a fixture to each label and
 * goes red on any form it has no fixture for.
 *
 * Each case edits one real, tracked file and restores it (`scripts/lint-kit.mjs`
 * owns the restore).
 */

import { appendText as append, makeSelftest, replaceText as replace } from './lint-kit.mjs';

const LINT = 'scripts/outbound-lint.mjs';

/**
 * A shipped component with no network form and no `OUTBOUND_SITES` entry, so a
 * form appended here is an unclassified one — the unguarded `fetch` in
 * `lib/src/components` the lint exists to stop.
 */
const TARGET = 'lib/src/components/HeaderActionButton.tsx';
/** A test file: a form there is out of scope, so the lint must stay green. */
const TEST_TARGET = 'lib/src/lib/feature-flags.test.ts';

/**
 * One fixture per form, keyed by the label the lint's `FORMS` carries, each
 * written to match that form alone. Several fixtures may share a label.
 */
const FIXTURES = [
  ['fetch call', "\nexport const __selftest = () => fetch('/x');\n"],
  ['global fetch', '\nexport const __selftest = globalThis.fetch;\n'],
  ['global fetch', '\nexport const __selftest = window.fetch;\n'],
  ['new WebSocket', '\nexport const __selftest = (u: string) => new WebSocket(u);\n'],
  ['global WebSocket', '\nexport const __selftest = globalThis.WebSocket;\n'],
  ['ws module', "\nexport const __selftest = require('ws');\n"],
  ['ws module', "\nimport { WebSocket as __Ws } from 'ws';\nexport const __selftest = __Ws;\n"],
  ['XMLHttpRequest', '\nexport const __selftest = () => new XMLHttpRequest();\n'],
  ['EventSource', '\nexport const __selftest = (u: string) => new EventSource(u);\n'],
  ['sendBeacon', '\nexport const __selftest = (u: string) => navigator.sendBeacon(u);\n'],
  ['http(s) request', '\nexport const __selftest = (h: any, u: string) => h.x(https.request(u));\n'],
  ['http(s) request', '\nexport const __selftest = (u: string) => http.get(u);\n'],
  ['http(s) request import', "\nimport { get as __get } from 'node:http';\nexport const __selftest = __get;\n"],
  ['https module', "\nimport * as __https from 'node:https';\nexport const __selftest = __https;\n"],
  ['net connect', "\nexport const __selftest = () => net.connect(443, 'h');\n"],
  ['net connect', "\nexport const __selftest = () => tls.connect(443, 'h');\n"],
  ['net connect', '\nexport const __selftest = () => new net.Socket();\n'],
  ['net connect import', "\nimport { createConnection as __c } from 'node:net';\nexport const __selftest = __c;\n"],
  ['tls or http2 module', "\nexport const __selftest = require('node:http2');\n"],
  ['dgram module', "\nexport const __selftest = require('dgram');\n"],
  ['dns module', "\nimport { lookup as __lookup } from 'node:dns/promises';\nexport const __selftest = __lookup;\n"],
  ['undici', "\nexport const __selftest = require('undici');\n"],
  ['RTCPeerConnection', '\nexport const __selftest = () => new RTCPeerConnection({});\n'],
  ['node-datachannel', "\nexport const __selftest = require('node-datachannel/polyfill');\n"],
  ['Tauri plugin', "\nexport const __selftest = () => import('@tauri-apps/plugin-http');\n"],
  ['openExternal', '\nexport const __selftest = (p: any, u: string) => p.openExternal(u);\n'],
  ['window.open', '\nexport const __selftest = (u: string) => window.open(u);\n'],
  ['remote Worker', '\nexport const __selftest = (u: string) => new Worker(u);\n'],
  ['importScripts', '\nexport const __selftest = (u: string) => importScripts(u);\n'],
  ['remote URL literal', "\nexport const __selftest = 'https://cdn.example.net/x.js';\n"],
  ['remote URL literal', '\nexport const __selftest = (p: string) => `wss://relay.example.net/${p}`;\n'],
];

const selftest = makeSelftest('outbound-lint.mjs', '.outbound-selftest.bak');
for (const [name, source] of FIXTURES) {
  selftest.withMutationReporting(
    TARGET,
    append(source),
    `spells ${name} with no OUTBOUND_SITES entry`,
    `${name}\n      adding this to ${TARGET} does not report it — outbound-lint cannot see the form`,
  );
}

// A form inside a comment opens nothing, and a test file is out of scope; both
// must stay green, or the lint pushes people to delete comments and tests.
selftest.withAppendedOutput(
  TARGET,
  "\n// fetch('https://cdn.example.net/x.js'); new WebSocket(u);\n/* globalThis.fetch */\n",
  'outbound-lint: OK',
  `${TARGET}\n      a network form inside a comment turns outbound-lint red`,
);
selftest.withAppendedOutput(
  TEST_TARGET,
  FIXTURES[0][1],
  'outbound-lint: OK',
  `${TEST_TARGET}\n      a network form in a test file turns outbound-lint red`,
);

// --- Structural rules ----------------------------------------------------------
const STRUCTURAL = [
  [
    'lib/src/remote/burrow/burrow-fetch.ts',
    append('\nexport const __selftest = (f?: typeof globalThis.fetch) => f ?? globalThis.fetch;\n'),
    'names the global transport (global fetch)',
    'a globalThis.fetch fallback in burrow-fetch',
  ],
  [
    'lib/src/remote/burrow/enrollment.ts',
    append('\nexport const __selftest = (u: string) => new WebSocket(u);\n'),
    'names the global transport (new WebSocket)',
    'a new WebSocket in a guarded file outside the service',
  ],
  [
    'lib/src/host/remote/native-direct-peer.ts',
    append("\nexport const __selftest = () => fetch('/x');\n"),
    'calls a fetch it does not take as a parameter',
    'a bare fetch in a guarded file that binds no fetch parameter',
  ],
  [
    TARGET,
    append('\nexport const __selftest = (o: any) => new BurrowRuntime(o);\n'),
    'constructs a Burrow runtime outside',
    'new BurrowRuntime outside the service',
  ],
  [
    'lib/src/host/remote/direct-peering.ts',
    append('\nexport const __selftest = (o: any) => new OneTimeRuntime(o);\n'),
    'constructs a Burrow runtime outside',
    'new OneTimeRuntime outside the service',
  ],
  [
    'lib/src/host/relay-origin.ts',
    append("\nexport const __selftest = 'https://relay.example.net';\n"),
    'spells the remote host relay.example.net',
    'an unlisted host in a file REMOTE_LITERALS covers',
  ],
  [
    'dor/src/commands/split.ts',
    replace('https://example.com', 'example.com'),
    'REMOTE_LITERALS admits example.com, which the file no longer spells',
    'a stale REMOTE_LITERALS host',
  ],
  [
    'lib/src/components/SettingsDialog.tsx',
    replace("'https://dormouse.sh/hosted/#voice'", "'/hosted/#voice'"),
    'OUTBOUND_SITES entry no longer spells any form',
    'a stale OUTBOUND_SITES entry',
  ],
  [
    LINT,
    replace("class: 'phone',\n    reason: 'The phone\\'s RTCPeerConnection", "class: 'loopback',\n    reason: 'The phone\\'s RTCPeerConnection"),
    'phone code classed loopback',
    'phone code given a desktop class',
  ],
  [
    LINT,
    replace("class: 'guarded:managed-voice'", "class: 'guarded:somewhere'"),
    'unknown choke point in guarded:somewhere',
    'a guarded class naming no choke point',
  ],
  [
    LINT,
    replace("class: 'dev-only',\n    reason: 'Loaded only when", "class: 'phone',\n    reason: 'Loaded only when"),
    'classed phone, but is not under',
    'desktop code classed phone',
  ],
];

// --- CSP -------------------------------------------------------------------------
const CSP = [
  [
    'standalone/src-tauri/tauri.conf.json',
    replace('connect-src ipc:', 'connect-src https://cdn.example.net ipc:'),
    'connect-src admits https://cdn.example.net',
    'a CDN in the Standalone connect-src',
  ],
  [
    'standalone/src-tauri/tauri.conf.json',
    replace("default-src 'self'; ", ''),
    'no default-src',
    'a Standalone CSP with no default-src fallback',
  ],
  [
    'standalone/src-tauri/tauri.conf.json',
    replace("script-src 'self'", "script-src 'self' https:"),
    'script-src admits https:',
    'a scheme source in the Standalone script-src',
  ],
  [
    'vscode-ext/src/webview-html.ts',
    replace('`img-src ${webview.cspSource} data: blob:`', '`img-src ${webview.cspSource} data: blob: https:`'),
    'img-src admits https:',
    'https: in the VS Code webview img-src',
  ],
  [
    'vscode-ext/src/webview-html.ts',
    replace('`frame-src http://127.0.0.1:* http://localhost:*`', '`frame-src http://127.0.0.1:* http://localhost:* *`'),
    'frame-src admits *',
    'a wildcard in the VS Code webview frame-src',
  ],
  [
    'dor-tools-builtin/src/editor-page.ts',
    replace("worker-src 'self'", "worker-src 'self' https://cdn.jsdelivr.net"),
    'worker-src admits https://cdn.jsdelivr.net',
    'a CDN in a built-in viewer CSP',
  ],
  [
    'dor-tools-builtin/src/file-viewer.ts',
    replace("img-src data:\"", "img-src data: https:\""),
    'img-src admits https:',
    'https: in the image viewer CSP',
  ],
];

// --- Tauri -----------------------------------------------------------------------
const TAURI = [
  [
    'standalone/src-tauri/src/lib.rs',
    replace(
      '.plugin(tauri_plugin_updater::Builder::new().build())',
      '.plugin(tauri_plugin_updater::Builder::new().build())\n        .plugin(tauri_plugin_http::init())',
    ),
    'registers plugins',
    'tauri_plugin_http registered',
  ],
  [
    'standalone/src-tauri/src/log_tail.rs',
    append('\n#[allow(dead_code)]\nfn __selftest() { let _ = std::net::TcpStream::connect("example.net:443"); }\n'),
    'names TcpStream',
    'a Rust TcpStream',
  ],
  [
    'standalone/src-tauri/Cargo.toml',
    replace('tauri-plugin-updater = "2"\n', 'tauri-plugin-updater = "2"\ntauri-plugin-http = "2"\n'),
    'depends on tauri-plugin-http',
    'tauri-plugin-http in [dependencies]',
  ],
  [
    'standalone/src-tauri/Cargo.toml',
    replace('getrandom = "0.4"\n', 'getrandom = "0.4"\nreqwest = "0.12"\n'),
    'depends on reqwest',
    'an HTTP client crate in [dependencies]',
  ],
  [
    'standalone/src-tauri/capabilities/default.json',
    replace('"windows": ["main", "ws-*"],', '"windows": ["main", "ws-*"],\n  "remote": { "urls": ["https://*.example.net"] },'),
    'a remote URL scope',
    'a capability with a remote scope',
  ],
  [
    'standalone/src-tauri/capabilities/default.json',
    replace('"shell:default"', '"shell:default",\n    "updater:default"'),
    'grants an updater permission outside main-only.json',
    'an updater permission outside main-only.json',
  ],
  [
    'standalone/src-tauri/tauri.conf.json',
    replace('"security": {', '"withGlobalTauri": true,\n    "security": {'),
    'withGlobalTauri',
    'withGlobalTauri enabled',
  ],
];

for (const [relative, mutate, expected, label] of [...STRUCTURAL, ...CSP, ...TAURI]) {
  selftest.withMutationReporting(
    relative,
    mutate,
    expected,
    `${label}\n      planting it in ${relative} does not report "${expected}"`,
  );
}

// Every form the lint declares needs a fixture above, or it is a claim nothing checks.
selftest.requireFixtures(LINT, FIXTURES.map(([name]) => name), 'form');

selftest.finish(
  'outbound-lint-selftest',
  'Each case plants one network primitive or rule violation. A case that stays green,\n'
  + 'or goes red without naming it, means scripts/outbound-lint.mjs does not enforce\n'
  + 'that line of docs/specs/security-local.md -> "Network policy". A form reported\n'
  + 'with no fixture is one nothing has ever matched. The comment and test-file\n'
  + 'cases must stay green.',
);
