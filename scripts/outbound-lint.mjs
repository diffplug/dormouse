#!/usr/bin/env node
/**
 * Mechanical check for the network-policy rules in `docs/specs/security-local.md`
 * ("Network policy"): Settings → Network → Nowhere promises that Dormouse opens
 * no connection on its own, and each other level that it opens only what its
 * connection list names. Runs from the repo root via `pnpm test` (see the root
 * package.json). Exits non-zero with a per-violation report.
 *
 * Why this exists: that promise was resting on an LLM reading the tree. The
 * audit is thorough but probabilistic, and a new `fetch` in a component, a CDN
 * in a CSP, or an HTTP plugin in the Tauri builder is one line in a diff. This
 * makes the cheap half deterministic, so adding one fails a build and makes its
 * author classify it here, in review.
 *
 * What it checks, over every tracked source file in the shipped directories
 * (`SHIPPED`; tests, stories, and test helpers left out):
 *
 *   1. Inventory. Every file that spells a network primitive in `FORMS` has an
 *      `OUTBOUND_SITES` entry giving its class and reason. A stale entry — a
 *      file gone, or one that no longer spells any form — fails, and so does
 *      an empty inventory: either means a pattern stopped seeing the code.
 *   2. Structure. The global `fetch` and `WebSocket` (and `ws`) appear in a
 *      `guarded:` file only where the choke point builds its guard; every
 *      other guarded file takes the guarded transport as a parameter.
 *      `new BurrowRuntime(` and `new OneTimeRuntime(` appear only in the
 *      Burrow service.
 *   3. Remote hosts. A literal `http(s)://` / `ws(s)://` host that is not
 *      loopback appears only in a file and host `REMOTE_LITERALS` names.
 *   4. CSP. Every source list in the Standalone CSP, the VS Code webview CSP,
 *      and the built-in viewers' CSP constants admits only this origin, IPC,
 *      `data:`/`blob:`, a nonce or hash, VS Code's `cspSource`, or loopback.
 *   5. Tauri. The builder registers exactly the shell and updater plugins; no
 *      Rust network client; no HTTP/WebSocket/upload/opener plugin or HTTP
 *      client crate in `[dependencies]`; `updater:` permissions only in
 *      `main-only.json`; no capability with a `remote` scope; no
 *      `withGlobalTauri`; the updater's endpoints exactly `UPDATER_ENDPOINTS`.
 *
 * Listeners — the other half of "phones can't reach it" — are
 * `scripts/loopback-lint.mjs`'s: a loopback bind must reference a guard, and a
 * shipped bind beyond loopback is refused there.
 *
 * What it deliberately does NOT do, so nobody mistakes it for the whole rule:
 *   - It is textual, on comment-stripped source. A primitive reached through a
 *     variable (`const f = globalThis['fe' + 'tch']`), a re-export, or a
 *     dependency's own code is invisible to it. A new network dependency adds
 *     its spelling to `FORMS`.
 *   - It classifies files, not calls. Whether a `user:` file's call really runs
 *     only on its trigger, or a `guarded:` file's every path really passes the
 *     choke point's check, is what `lib/src/host/remote/outbound.test.ts` and
 *     `vscode-ext/test/outbound.test.ts` run and the audit reads.
 *   - A `guarded:` file that binds `fetch` as a parameter may still reach the
 *     global elsewhere under another name; only the spellings in rule 2 are
 *     refused.
 *
 * `scripts/outbound-lint-selftest.mjs` plants one violation per form and per
 * rule and requires this lint to go red, and goes red itself on a form here it
 * has no fixture for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readRepoFile, repoRoot, trackedFiles } from './lint-kit.mjs';

/** The directories whose code reaches a user's machine or phone. */
const SHIPPED = [
  'lib/src/',
  'standalone/src/',
  'standalone/sidecar/',
  'vscode-ext/src/',
  'dor/src/',
  'dor-tools-builtin/src/',
  'dor-tools-builtin/viewer/',
  'dor-lib-common/src/',
  'remote-lib-common/src/',
];

/** Code that runs on the phone, never on the computer the policy governs. */
const PHONE = ['lib/src/remote/pocket-app/', 'lib/src/remote/one-time-app/', 'lib/src/remote/client/'];

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Tests, stories, and the helpers only tests import. */
const IS_TEST =
  /(?:\.test\.|\.spec\.|\.stories\.|(?:^|\/)(?:tests?|stories|__tests__)\/|(?:^|\/)test-[^/]*$|test-utils\.|-test-mock\.|(?:^|\/)test-ports\.|-fixtures\.)/;

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|ipc\.localhost)$/;

/**
 * Every network primitive this lint recognizes, one entry per spelling — the
 * inventory `docs/specs/security-local.md` -> "Network policy" points at.
 * `scripts/outbound-lint-selftest.mjs` reads these labels and goes red on any
 * form it has no fixture for. Matched on comment-stripped source.
 */
const FORMS = [
  { label: 'fetch call', re: /(?<![\w$.#])fetch\s*\(/ },
  { label: 'global fetch', re: /(?<!typeof\s+)\b(?:globalThis|window|self)\s*\.\s*fetch\b/ },
  { label: 'new WebSocket', re: /\bnew\s+WebSocket\s*\(/ },
  { label: 'global WebSocket', re: /(?<!typeof\s+)\b(?:globalThis|window|self)\s*\.\s*WebSocket\b/ },
  { label: 'ws module', re: /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"]ws['"]/ },
  { label: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { label: 'EventSource', re: /\bnew\s+EventSource\s*\(/ },
  { label: 'sendBeacon', re: /\bsendBeacon\s*\(/ },
  { label: 'http(s) request', re: /\bhttps?\s*\.\s*(?:request|get)\s*\(/ },
  {
    label: 'http(s) request import',
    re: /\bimport\s*\{[^}]*\b(?:request|get)\b[^}]*\}\s*from\s*['"](?:node:)?https?['"]/,
  },
  { label: 'https module', re: /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"](?:node:)?https['"]/ },
  { label: 'net connect', re: /\b(?:net|tls)\s*\.\s*(?:connect|createConnection)\s*\(|\bnew\s+(?:net\s*\.\s*)?Socket\s*\(/ },
  {
    label: 'net connect import',
    re: /\bimport\s*\{[^}]*\b(?:connect|createConnection|Socket)\b[^}]*\}\s*from\s*['"](?:node:)?net['"]/,
  },
  { label: 'tls or http2 module', re: /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"](?:node:)?(?:tls|http2)['"]/ },
  { label: 'dgram module', re: /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"](?:node:)?dgram['"]/ },
  { label: 'dns module', re: /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"](?:node:)?dns(?:\/promises)?['"]/ },
  { label: 'undici', re: /['"]undici['"]/ },
  { label: 'RTCPeerConnection', re: /\bRTCPeerConnection\s*\(/ },
  { label: 'node-datachannel', re: /['"]node-datachannel(?:\/[\w-]+)?['"]/ },
  { label: 'Tauri plugin', re: /['"]@tauri-apps\/plugin-[\w-]+['"]/ },
  { label: 'openExternal', re: /\bopenExternal\s*\(/ },
  { label: 'window.open', re: /\bwindow\s*\.\s*open\s*\(/ },
  { label: 'remote Worker', re: /\bnew\s+(?:Shared)?Worker\s*\(\s*(?!new\s+URL\s*\(\s*['"`]\.{1,2}\/)/ },
  { label: 'importScripts', re: /\bimportScripts\s*\(/ },
  { label: 'remote URL literal', re: null }, // see remoteHosts(); a form so its fixture is required
];

/**
 * Every file that spells a form, by class. The class is the claim the audit
 * reads back:
 *   - `guarded:<choke>` — reaches the network only through that choke point
 *     (`burrow-service`, `managed-voice`, `updater`), which refuses under
 *     Nothing (`docs/specs/remote-network.md` -> "Policy").
 *   - `user:<trigger>` — runs only on that trigger: a click, a command, or the
 *     user's own terminal, browser pane, or agent.
 *   - `loopback` — reaches only this machine over TCP.
 *   - `local-ipc` — the host bridge, a Unix socket, or a named pipe.
 *   - `phone` — runs on the phone (`PHONE`), never on this computer.
 *   - `dev-only` — loaded only by the dev harness; ships in no build.
 */
const OUTBOUND_SITES = {
  // --- guarded: the Burrow service ---
  'lib/src/host/remote/service.ts': {
    class: 'guarded:burrow-service',
    reason: 'The choke point itself: wraps the injected (or global) socket factory, fetch, and direct-peer factory in the transport guard that refuses under Nothing, unread, and disposed.',
  },
  'vscode-ext/src/burrow.ts': {
    class: 'guarded:burrow-service',
    reason: 'createRelaySocket is the socket factory VS Code injects into BurrowService, which calls it only through its transport guard.',
  },
  'lib/src/remote/burrow/burrow-fetch.ts': {
    class: 'guarded:burrow-service',
    reason: 'Calls only the fetch its caller passes — the service\'s guarded fetch, with no default.',
  },
  'lib/src/remote/burrow/enrollment.ts': {
    class: 'guarded:burrow-service',
    reason: 'The enrollment exchange calls only the fetch parameter, which the service passes as its guarded fetch.',
  },
  'lib/src/host/remote/native-direct-peer.ts': {
    class: 'guarded:burrow-service',
    reason: 'The direct-peer factory both hosts inject into BurrowService, which declines it under Nothing; it loads the addon only inside the first offer.',
  },
  'lib/src/host/relay-origin.ts': {
    class: 'guarded:burrow-service',
    reason: 'The baked relay, voice, and account origins: reached only through the service and the managed-voice host, the account origin only on a click.',
  },
  // --- guarded: managed voice ---
  'lib/src/host/managed-voice-host.ts': {
    class: 'guarded:managed-voice',
    reason: 'Asks networkAllowed before every speak and answers network-off without a request.',
  },
  // --- guarded: the updater ---
  'standalone/src/updater.ts': {
    class: 'guarded:updater',
    reason: 'runUpdateCheck calls check() only when the policy is not nothing and autoUpdate is on; Check now is a click; openUrl opens the changelog or an issue search on a click.',
  },
  // --- user: a click, a command, or the user's own terminal, pane, or agent ---
  'lib/src/components/ExternalLinkModalHost.tsx': {
    class: 'user:link-click',
    reason: 'Opens a link in the system browser after the user confirms it in the external-link modal.',
  },
  'lib/src/components/RemoteControlSection.tsx': {
    class: 'user:link-click',
    reason: 'The self-host guide link, opened only when the user clicks it.',
  },
  'lib/src/components/SettingsDialog.tsx': {
    class: 'user:link-click',
    reason: 'The Hosted voice page link, opened only when the user clicks it.',
  },
  'lib/src/lib/platform/fake-adapter.ts': {
    class: 'user:link-click',
    reason: 'The website playground\'s and Storybook\'s openExternal: window.open on the user\'s click.',
  },
  'lib/src/lib/platform/vscode-adapter.ts': {
    class: 'user:link-click',
    reason: 'openExternal posts the clicked link to the extension host, which hands it to VS Code.',
  },
  'vscode-ext/src/message-router.ts': {
    class: 'user:link-click',
    reason: 'dormouse:openExternal hands a normalized, clicked link to vscode.env.openExternal.',
  },
  'standalone/src/tauri-adapter.ts': {
    class: 'user:link-click',
    reason: 'openExternal opens a clicked link through the shell plugin; nothing else of the plugin is used.',
  },
  'lib/src/lib/themes/openvsx.ts': {
    class: 'user:theme-store-search',
    reason: 'Searches and downloads from OpenVSX only from the Theme Store dialog, which only a click on "Install theme from OpenVSX" opens and only the website playground offers.',
  },
  'lib/src/host/iframe-proxy.ts': {
    class: 'user:browser-pane',
    reason: 'Forwards a browser pane\'s requests to the one upstream its grant names — a URL the user, their terminal, or their agent opened.',
  },
  'dor/src/commands/agent-browser.ts': {
    class: 'user:printed-link',
    reason: 'Prints the agent-browser install page in an error; dor never requests it.',
  },
  'dor/src/commands/skill.ts': {
    class: 'user:printed-link',
    reason: 'The skill text names dormouse.sh for the agent reading it; dor never requests it.',
  },
  'dor/src/commands/split.ts': {
    class: 'user:printed-link',
    reason: 'A help-text example URL; dor never requests it.',
  },
  // --- loopback ---
  'lib/src/host/agent-browser-host.ts': {
    class: 'loopback',
    reason: 'Dials agent-browser\'s stream and the browser\'s CDP on 127.0.0.1 only (viewStream, askCdpEndpoint).',
  },
  'lib/src/host/browser-viewer.ts': {
    class: 'loopback',
    reason: 'The browser viewer\'s loopback WebSocketServer (noServer, upgraded from its own guarded listener); it dials nothing.',
  },
  'lib/src/components/wall/agent-browser-connection.ts': {
    class: 'loopback',
    reason: 'The webview\'s socket to the browser viewer listener, at the loopback URL the host hands it.',
  },
  'dor-tools-builtin/src/folder-viewer-page.ts': {
    class: 'loopback',
    reason: 'The folder viewer page\'s script fetches its own capability URL on the loopback listener that served it.',
  },
  'dor-tools-builtin/viewer/document-session.ts': {
    class: 'loopback',
    reason: 'The editor page fetches relative paths on the loopback viewer that served it; its CSP is connect-src \'self\'.',
  },
  'dor-tools-builtin/viewer/markdown.tsx': {
    class: 'loopback',
    reason: 'The Markdown editor posts a pasted image to the relative `image` route on its own loopback viewer.',
  },
  // --- local-ipc ---
  'dor/src/control-client.ts': {
    class: 'local-ipc',
    reason: 'Connects to the host\'s dor control socket — a Unix-domain socket or named pipe.',
  },
  'vscode-ext/src/peer-link.ts': {
    class: 'local-ipc',
    reason: 'The peer link between VS Code windows over a Unix-domain socket or named pipe.',
  },
  // --- phone ---
  'lib/src/remote/client/browser-direct-peer.ts': {
    class: 'phone',
    reason: 'The phone\'s RTCPeerConnection for the direct path.',
  },
  'lib/src/remote/one-time-app/OneTimeApp.tsx': {
    class: 'phone',
    reason: 'The one-time phone page\'s rendezvous socket.',
  },
  'lib/src/remote/pocket-app/App.tsx': {
    class: 'phone',
    reason: 'Pocket\'s fetch and relay socket, injected into PocketClient.',
  },
  'lib/src/remote/pocket-app/deployment.ts': {
    class: 'phone',
    reason: 'Pocket reads deployment.json from its own origin.',
  },
  // --- dev-only ---
  'standalone/src/browser-sidecar-adapter.ts': {
    class: 'dev-only',
    reason: 'Loaded only when the build bakes VITE_DORMOUSE_BROWSER_DEV_HOST (the browser-dev harness); talks to that loopback dev host.',
  },
  'standalone/src/browser-sidecar-host.ts': {
    class: 'dev-only',
    reason: 'The browser-dev harness\'s bridge to its loopback dev host, loaded with browser-sidecar-adapter.ts.',
  },
};

/**
 * Non-loopback hosts a file may spell, with why. Everything else is refused:
 * a host Dormouse reaches on its own comes from `lib/src/host/relay-origin.ts`,
 * the updater's endpoint, or `lib/src/remote/direct/ice-servers.ts`; a link the
 * user opens comes from a builder listed here.
 */
const REMOTE_LITERALS = {
  'lib/src/host/relay-origin.ts': {
    hosts: ['relay.dormouse.sh', 'voice.dormouse.sh', 'hosted.dormouse.sh'],
    reason: 'The baked relay origin\'s default and the fixed voice and account origins.',
  },
  'standalone/src/updater.ts': {
    hosts: ['github.com', 'dormouse.sh'],
    reason: 'The issue search and changelog links openUrl opens on a click; the update endpoint itself is in tauri.conf.json.',
  },
  'lib/src/components/RemoteControlSection.tsx': {
    hosts: ['dormouse.sh'],
    reason: 'The self-host guide link.',
  },
  'lib/src/components/SettingsDialog.tsx': {
    hosts: ['dormouse.sh'],
    reason: 'The Hosted voice page link.',
  },
  'lib/src/lib/themes/openvsx.ts': {
    hosts: ['open-vsx.org'],
    reason: 'The Theme Store\'s search API, reached only from the dialog a click opens.',
  },
  'dor/src/commands/agent-browser.ts': {
    hosts: ['agent-browser.dev'],
    reason: 'Printed install link.',
  },
  'dor/src/commands/skill.ts': {
    hosts: ['dormouse.sh'],
    reason: 'Printed skill text.',
  },
  'dor/src/commands/split.ts': {
    hosts: ['example.com'],
    reason: 'Printed help example.',
  },
};

/** Where the global transport may be named in a `guarded:` file: where the choke point builds its guard. */
const GUARD_BUILDERS = new Set([
  'lib/src/host/remote/service.ts',
  'lib/src/host/managed-voice-host.ts',
  'vscode-ext/src/burrow.ts',
]);

/** The only file that may construct the Burrow's runtimes. */
const RUNTIME_OWNER = 'lib/src/host/remote/service.ts';

const UPDATER_ENDPOINTS = ['https://dormouse.sh/standalone-latest.json'];

const CHOKES = new Set(['burrow-service', 'managed-voice', 'updater']);
const PLAIN_CLASSES = new Set(['loopback', 'local-ipc', 'phone', 'dev-only']);

// -----------------------------------------------------------------------------

/**
 * `src` with every comment blanked to spaces, newlines kept so line numbers
 * survive. Strings, template literals (with nested `${}`), and regex literals
 * are walked so a `//` inside one is not a comment. A string never spans a
 * line, so a stray quote in JSX text costs at most the rest of its line.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const templates = []; // brace depth at each open `${`
  let depth = 0;
  let prev = ''; // last significant code character
  let word = ''; // last identifier, for `return /re/`
  const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

  const scanTemplate = () => {
    // At a template's text: copy to the closing backtick or a `${`.
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        out += c;
        i += 1;
        prev = '`';
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        templates.push(depth);
        depth += 1;
        prev = '{';
        return;
      }
      out += c;
      i += 1;
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
      word = '';
      continue;
    }
    if (c === '`') {
      out += c;
      i += 1;
      scanTemplate();
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (templates.length > 0 && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth -= 1;
        out += c;
        i += 1;
        scanTemplate();
        continue;
      }
      depth -= 1;
    }
    if (c === '/' && (REGEX_AFTER.has(prev) || REGEX_WORDS.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = '/';
      word = '';
      continue;
    }
    out += c;
    i += 1;
    if (/[\w$]/.test(c)) {
      word = /[\w$]/.test(prev) ? word + c : c;
      prev = c;
    } else if (!/\s/.test(c)) {
      prev = c;
      word = '';
    }
  }
  return out;
}

/** Every non-loopback host spelled in a URL literal in `code`, with its line. */
function remoteHosts(code) {
  const hosts = [];
  for (const match of code.matchAll(/\b(?:https?|wss?):\/\/([^/\s'"`:?#)\\$]*)/g)) {
    const host = match[1];
    // A host built at runtime is the fetch form's to see, not this rule's.
    if (!/^(?:[\w-]+\.)*[\w-]+$|^\[[\da-f:.]+\]$/i.test(host)) continue;
    if (LOOPBACK_HOST.test(host)) continue;
    // An XML namespace names a vocabulary; nothing dereferences it.
    if (host === 'www.w3.org') continue;
    hosts.push({ host, line: code.slice(0, match.index).split('\n').length });
  }
  return hosts;
}

/**
 * `src` with comments blanked and type-only imports too: `import type … from
 * 'ws'` and `typeof import('ws')` name a module's types and load nothing.
 */
function codeOf(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return stripComments(src.replace(/\r\n/g, '\n'))
    .replace(/\bimport\s+type\b[^;]*?\bfrom\s*['"][^'"]+['"]/g, blank)
    .replace(/\btypeof\s+import\s*\(\s*['"][^'"]+['"]\s*\)/g, blank);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const problems = [];
const inventory = [];
const seenSites = new Set();

function shippedSourceFiles() {
  return trackedFiles().filter(
    (rel) => SOURCE_EXT.test(rel) && SHIPPED.some((dir) => rel.startsWith(dir)) && !IS_TEST.test(rel),
  );
}

function checkClass(rel, entry) {
  const cls = entry?.class;
  if (typeof cls !== 'string' || typeof entry.reason !== 'string' || entry.reason.length < 20) {
    problems.push(`${rel}: OUTBOUND_SITES entry needs a class and a reason a reviewer can check.`);
    return null;
  }
  const isPhone = PHONE.some((dir) => rel.startsWith(dir));
  if (cls === 'phone' && !isPhone) problems.push(`${rel}: classed phone, but is not under ${PHONE.join(', ')}.`);
  if (isPhone && cls !== 'phone') problems.push(`${rel}: phone code classed ${cls}; it runs on the phone.`);
  if (cls.startsWith('guarded:')) {
    if (!CHOKES.has(cls.slice('guarded:'.length))) problems.push(`${rel}: unknown choke point in ${cls}.`);
  } else if (cls.startsWith('user:')) {
    if (cls.length <= 'user:'.length) problems.push(`${rel}: a user: class names its trigger.`);
  } else if (!PLAIN_CLASSES.has(cls)) {
    problems.push(`${rel}: unknown class ${cls}.`);
  }
  return cls;
}

// --- Rules 1–3: the source inventory -------------------------------------------
const fileForms = FORMS.filter((form) => form.re);
for (const rel of shippedSourceFiles()) {
  if (!existsSync(join(repoRoot, rel))) continue;
  const code = codeOf(readFileSync(join(repoRoot, rel), 'utf8'));
  const hits = [];
  for (const form of fileForms) {
    const match = form.re.exec(code);
    if (match) hits.push({ label: form.label, line: lineOf(code, match.index) });
  }
  const hosts = remoteHosts(code);
  if (hosts.length > 0) hits.push({ label: 'remote URL literal', line: hosts[0].line });

  // Rule 2b holds whether or not the file is in the inventory.
  if (rel !== RUNTIME_OWNER) {
    const runtime = /\bnew\s+(?:BurrowRuntime|OneTimeRuntime)\s*\(/.exec(code);
    if (runtime) {
      problems.push(
        `${rel}:${lineOf(code, runtime.index)}: constructs a Burrow runtime outside ${RUNTIME_OWNER}.\n`
        + '      Only the Burrow service may: it hands each runtime its guarded transport\n'
        + '      and holds it under Nothing (docs/specs/remote-network.md -> "Policy").',
      );
    }
  }

  if (hits.length === 0) continue;
  inventory.push({ rel, hits });
  const entry = OUTBOUND_SITES[rel];
  if (!entry) {
    problems.push(
      `${rel}:${hits[0].line}: spells ${hits.map((h) => h.label).join(', ')} with no OUTBOUND_SITES entry.\n`
      + '      Every network primitive in shipped code is classified: say which choke point\n'
      + '      guards it, which user action triggers it, or that it reaches only this machine\n'
      + '      (docs/specs/security-local.md -> "Network policy").',
    );
    continue;
  }
  seenSites.add(rel);
  const cls = checkClass(rel, entry);

  // Rule 2a: a guarded file uses the guard, never the global.
  if (cls?.startsWith('guarded:') && !GUARD_BUILDERS.has(rel)) {
    const global = hits.find((h) => ['global fetch', 'new WebSocket', 'global WebSocket', 'ws module', 'undici'].includes(h.label));
    if (global) {
      problems.push(
        `${rel}:${global.line}: a ${cls} file names the global transport (${global.label}).\n`
        + '      Take the guarded fetch or socket factory as a parameter with no default;\n'
        + '      the global bypasses the network policy\'s choke point.',
      );
    }
    const bare = hits.find((h) => h.label === 'fetch call');
    if (bare && !/\bfetch\??\s*:\s*typeof\s+globalThis\.fetch\b/.test(code)) {
      problems.push(
        `${rel}:${bare.line}: a ${cls} file calls a fetch it does not take as a parameter.\n`
        + '      Bind `fetch: typeof globalThis.fetch` from the guard; a bare call is the global.',
      );
    }
  }

  // Rule 3: remote literal hosts.
  const allowedHosts = REMOTE_LITERALS[rel]?.hosts ?? [];
  for (const { host, line } of hosts) {
    if (allowedHosts.includes(host)) continue;
    problems.push(
      `${rel}:${line}: spells the remote host ${host}, which REMOTE_LITERALS does not admit here.\n`
      + '      A host Dormouse reaches on its own comes from lib/src/host/relay-origin.ts,\n'
      + '      the updater endpoint, or ice-servers.ts; a link the user opens, from a listed builder.',
    );
  }
}

for (const rel of Object.keys(OUTBOUND_SITES)) {
  if (seenSites.has(rel)) continue;
  problems.push(
    existsSync(join(repoRoot, rel))
      ? `${rel}: OUTBOUND_SITES entry no longer spells any form — drop it from scripts/outbound-lint.mjs.`
      : `${rel}: OUTBOUND_SITES entry names a file that does not exist — drop it from scripts/outbound-lint.mjs.`,
  );
}
for (const [rel, { hosts: allowed }] of Object.entries(REMOTE_LITERALS)) {
  const spelled = existsSync(join(repoRoot, rel)) ? remoteHosts(codeOf(readFileSync(join(repoRoot, rel), 'utf8'))) : [];
  for (const host of allowed) {
    if (!spelled.some((h) => h.host === host)) {
      problems.push(`${rel}: REMOTE_LITERALS admits ${host}, which the file no longer spells — drop it.`);
    }
  }
}
if (inventory.length === 0) {
  problems.push('no network primitive matched in any shipped file — FORMS has stopped seeing the code.');
}
for (const form of FORMS) {
  if (form.re === null && form.label !== 'remote URL literal') problems.push(`FORMS entry ${form.label} has no pattern.`);
}

// --- Rule 4: CSP --------------------------------------------------------------

/**
 * Whether one CSP source keeps the page on this machine: a keyword, a nonce or
 * hash, IPC, `data:`/`blob:`, VS Code's resource origin, or loopback.
 */
function localSource(source) {
  if (/^'(?:self|none|unsafe-inline|unsafe-eval|wasm-unsafe-eval|strict-dynamic|unsafe-hashes|report-sample)'$/.test(source)) return true;
  if (/^'(?:nonce|sha256|sha384|sha512)-[^']*'$/.test(source)) return true;
  if (['data:', 'blob:', 'ipc:', 'http://ipc.localhost', '${webview.cspSource}'].includes(source)) return true;
  return /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:\d+|\*))?$/.test(source);
}

function checkCsp(where, policy) {
  const directives = policy.split(';').map((d) => d.trim()).filter(Boolean);
  if (directives.length === 0) problems.push(`${where}: an empty CSP — the parse found nothing to check.`);
  for (const directive of directives) {
    const [name, ...sources] = directive.split(/\s+/);
    if (!/-src(?:-elem|-attr)?$/.test(name) && name !== 'form-action') continue;
    for (const source of sources) {
      if (localSource(source)) continue;
      problems.push(
        `${where}: ${name} admits ${source}.\n`
        + '      A webview or viewer page loads only from itself, IPC, data:/blob:, or loopback;\n'
        + '      anything else is a request the network policy never sees.',
      );
    }
  }
}

const tauriConf = JSON.parse(readRepoFile('standalone/src-tauri/tauri.conf.json'));
checkCsp('standalone/src-tauri/tauri.conf.json app.security.csp', tauriConf.app?.security?.csp ?? '');
if (tauriConf.app?.security?.devCsp) checkCsp('standalone/src-tauri/tauri.conf.json app.security.devCsp', tauriConf.app.security.devCsp);
if (tauriConf.app?.withGlobalTauri) {
  problems.push('standalone/src-tauri/tauri.conf.json: app.withGlobalTauri exposes the Tauri API to every script in the page.');
}
const endpoints = tauriConf.plugins?.updater?.endpoints ?? [];
if (JSON.stringify(endpoints) !== JSON.stringify(UPDATER_ENDPOINTS)) {
  problems.push(`standalone/src-tauri/tauri.conf.json: updater endpoints ${JSON.stringify(endpoints)} are not ${JSON.stringify(UPDATER_ENDPOINTS)}.`);
}

{
  const rel = 'vscode-ext/src/webview-html.ts';
  const text = readRepoFile(rel);
  const block = /const\s+csp\s*=\s*\[([\s\S]*?)\]\s*\.join\(\s*['"];\s*['"]\s*\)/.exec(text);
  const parts = block ? [...stripComments(block[1]).matchAll(/`([^`]*)`/g)].map((m) => m[1]) : [];
  if (parts.length === 0) problems.push(`${rel}: found no \`const csp = [...]\` directive list — the CSP moved and is unchecked.`);
  else checkCsp(rel, parts.join('; ').replace(/'nonce-\$\{nonce\}'/g, "'nonce-x'"));
}

{
  let viewerCsps = 0;
  for (const rel of trackedFiles().filter((f) => f.startsWith('dor-tools-builtin/src/') && SOURCE_EXT.test(f) && !IS_TEST.test(f))) {
    const text = readRepoFile(rel);
    for (const match of text.matchAll(/\bconst\s+(\w*CSP)\s*=\s*(['"`])((?:(?!\2).)*)\2/g)) {
      viewerCsps += 1;
      checkCsp(`${rel} ${match[1]}`, match[3]);
    }
  }
  if (viewerCsps === 0) problems.push('dor-tools-builtin/src: found no `const *CSP = "…"` — the viewer CSPs moved and are unchecked.');
}

// --- Rule 5: Tauri ------------------------------------------------------------
{
  const rel = 'standalone/src-tauri/src/lib.rs';
  const plugins = [...stripComments(readRepoFile(rel)).matchAll(/\.plugin\(\s*([\w:]+)/g)].map((m) => m[1].split('::')[0]).sort();
  const expected = ['tauri_plugin_shell', 'tauri_plugin_updater'];
  if (JSON.stringify(plugins) !== JSON.stringify(expected)) {
    problems.push(`${rel}: registers plugins ${JSON.stringify(plugins)}; exactly ${JSON.stringify(expected)} are allowed.`);
  }
  for (const file of trackedFiles().filter((f) => f.startsWith('standalone/src-tauri/src/') && f.endsWith('.rs'))) {
    const code = stripComments(readRepoFile(file));
    const hit = /\b(?:reqwest|ureq|hyper|TcpStream|TcpListener|UdpSocket|ToSocketAddrs)\b/.exec(code);
    if (hit) problems.push(`${file}:${lineOf(code, hit.index)}: names ${hit[0]}; the Rust host opens no socket of its own.`);
  }
  const cargo = readRepoFile('standalone/src-tauri/Cargo.toml');
  const deps = [...cargo.matchAll(/^\[([^\]]*dependencies)\]\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)]
    .filter((m) => !/dev-dependencies|build-dependencies/.test(m[1]))
    .flatMap((m) => [...m[2].matchAll(/^([\w-]+)\s*=/gm)].map((d) => d[1]));
  if (deps.length === 0) problems.push('standalone/src-tauri/Cargo.toml: found no [dependencies] — the parse is checking nothing.');
  for (const dep of deps) {
    if (/^tauri-plugin-(?:http|websocket|upload|opener)$|^(?:reqwest|ureq|hyper|hyper-util|isahc|attohttpc|curl|surf|tungstenite|tokio-tungstenite)$/.test(dep)) {
      problems.push(`standalone/src-tauri/Cargo.toml: depends on ${dep}, a network client the policy cannot see.`);
    }
  }
  const capabilities = trackedFiles().filter((f) => f.startsWith('standalone/src-tauri/capabilities/') && f.endsWith('.json'));
  if (capabilities.length === 0) problems.push('standalone/src-tauri/capabilities: no capability files found.');
  for (const file of capabilities) {
    const cap = JSON.parse(readRepoFile(file));
    if (cap.remote) problems.push(`${file}: a remote URL scope hands the Tauri API to a page off this machine.`);
    const perms = (cap.permissions ?? []).map((p) => (typeof p === 'string' ? p : p.identifier));
    if (!file.endsWith('/main-only.json') && perms.some((p) => /^updater:/.test(p))) {
      problems.push(`${file}: grants an updater permission outside main-only.json.`);
    }
    for (const p of perms) {
      if (/^(?:http|websocket|upload|opener):/.test(p)) problems.push(`${file}: grants ${p}, a network plugin.`);
    }
  }
}

// -----------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`outbound-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThe rules are in docs/specs/security-local.md ("Network policy").');
  process.exit(1);
}
console.log(`outbound-lint: OK (${inventory.length} classified files)\n`);
const byClass = new Map();
for (const { rel } of inventory) {
  const cls = OUTBOUND_SITES[rel].class;
  if (!byClass.has(cls)) byClass.set(cls, []);
  byClass.get(cls).push(rel);
}
for (const cls of [...byClass.keys()].sort()) {
  console.log(`  ${cls}:`);
  for (const rel of byClass.get(cls)) console.log(`    ${rel}`);
}
