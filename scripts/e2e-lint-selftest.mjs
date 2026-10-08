#!/usr/bin/env node
/**
 * Proves `e2e-lint.mjs` is load-bearing: for every rule, re-introduce exactly
 * the thing it forbids and require the lint to fail.
 *
 * Why this exists: `deploy-lint-selftest.mjs` is mostly the other direction —
 * the installer lint mostly checks that controls are *present*, so removing one
 * is the test there (its `forbidden` rules mutate this way instead). Nearly
 * every rule here checks that something is *absent* (the `require` rules below
 * are the exception), and the
 * characteristic failure of an absence check is passing because the pattern
 * cannot see the thing it names — a regex anchored on a spelling nobody uses, a
 * scope that resolves to no files, a spec phrase that drifted. A green
 * `e2e-lint` says nothing about any of that. "The lint goes red when each
 * forbidden thing comes back" is the property that matters, and it is checkable.
 *
 * `RULES`' own doc in `e2e-lint.mjs` states what each kind's `violation` is; a
 * `forbid` or `exactly` case appends it inside the rule's own scope, which also
 * proves that scope resolves — a `trees` rule whose filter excluded every file
 * would stay green.
 *
 * Every rule also names a line of its spec (`SECURITY_SPEC` unless it names
 * another), and the lint checks that line still exists. That check is proved here too, by deleting the line: a rule
 * whose prose was removed is a rule nobody agreed to, and it must not go on
 * passing quietly. Once per *line*, not once per rule — several rules cite the
 * same sentence, and re-deleting it proves nothing new.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeSelftest, repoRoot } from './lint-kit.mjs';
import {
  filesFor,
  ICE_SERVER_MODULE,
  NATIVE_PEER_FACTORY,
  PEER_FACTORIES,
  RELAY_ROOM,
  RELAY_ROUTING,
  RULES,
  SECURITY_SPEC,
  WEB_PUSH_SENDER,
} from './e2e-lint.mjs';

const selftest = makeSelftest('e2e-lint.mjs');

for (const rule of RULES) {
  const name = rule.rule;

  if (rule.kind === 'require') {
    // The one kind whose violation is a deletion: the lint requires the text,
    // so removing it is what must redden.
    const original = readFileSync(join(repoRoot, rule.file), 'utf8');
    const match = original.match(rule.pattern);
    if (!match) {
      selftest.weak.push(`${name}\n      pattern does not match the pristine ${rule.file}`);
      continue;
    }
    selftest.withMutation(
      rule.file,
      (path) => writeFileSync(path, original.replace(match[0], '')),
      `${name}\n      removing ${match[0]} from ${rule.file} stays green`,
    );
    continue;
  }

  if (rule.kind === 'absent') {
    selftest.withAppended(
      rule.path,
      rule.violation,
      `${name}\n      creating ${rule.path} stays green — the lint is not looking where it says it is`,
    );
    continue;
  }

  // `forbid` and `exactly`: put the forbidden thing back. For `exactly` this is
  // one *extra* use, which is what makes the count a comparison rather than a
  // floor — a floor silently absorbs the next addition.
  if (!filesFor(rule).includes(rule.violationFile)) {
    selftest.weak.push(
      `${name}\n      the violation file ${rule.violationFile} is outside the rule's own scope — the case would prove nothing`,
    );
    continue;
  }
  selftest.withAppended(
    rule.violationFile,
    rule.violation,
    rule.kind === 'exactly'
      ? `${name}\n      an added use stays green — the count must compare exactly, not as a floor`
      : name,
  );
}

// The two `E2eKind` rules are `require` rules, so the loop above proves only
// that deleting the declaration reddens. What they exist to catch is a third
// kind, so widening each one — or guarding a third kind ahead of the shipped
// return — must redden too. The third kind is not a one-time name, so the
// one-time `forbid` rule on this file cannot be what goes red.
const WIRE = 'remote-lib-common/src/remote/wire.ts';
const wire = readFileSync(join(repoRoot, WIRE), 'utf8');
for (const [from, to, what] of [
  [
    "export type E2eKind = 'pairing' | 'connection';",
    "export type E2eKind = 'pairing' | 'connection' | 'rendezvous';",
    'a third member on the E2eKind union',
  ],
  [
    "  return value === 'pairing' || value === 'connection';",
    "  return value === 'pairing' || value === 'connection' || value === 'rendezvous';",
    'a third kind in isE2eKind',
  ],
  [
    "  return value === 'pairing' || value === 'connection';",
    "  if (value === 'rendezvous') return true;\n  return value === 'pairing' || value === 'connection';",
    'a third kind guarded ahead of the isE2eKind return',
  ],
]) {
  if (!wire.includes(from)) {
    selftest.weak.push(`${WIRE} no longer contains ${from} — the widening case proves nothing`);
    continue;
  }
  selftest.withMutation(
    WIRE,
    (path) => writeFileSync(path, wire.replace(from, to)),
    `${what} in ${WIRE} stays green`,
  );
}

// Each spelling of the one-time family must redden the Relay rule, not just the
// frame tag the loop appends: a constant or a camel-case helper is the same
// leak.
for (const violation of [
  "\nconst __selftest = WS_CLOSE_ONE_TIME_TAKEN;\n",
  '\nexport function oneTimeRoutes() {}\n',
  '\ntype __Selftest = OneTimeRoomFrame;\n',
  "\nconst __selftest = { t: 'one-time-room' };\n",
]) {
  selftest.withAppended(
    'relay/src/relay.ts',
    violation,
    `a one-time name in relay/src/relay.ts stays green: ${violation.trim()}`,
  );
}
// And the relay envelope's own file, the one the runtime rule's loop case does
// not append to.
selftest.withAppended(
  WIRE,
  '\nexport type __SelftestFrame = E2eClientFrame | OneTimeClientFrame;\n',
  `a one-time frame in the relay union in ${WIRE} stays green`,
);

// Every name the one-time runtime's grant rule lists must redden it on its
// own, not just the import the loop appends: a delivery id minted inline or a
// save through an injected store is the same grant.
for (const violation of [
  '\ntype __Selftest = BurrowAclRecord;\n',
  '\nconst __selftest = loadBurrowAcl;\n',
  '\nconst __selftest = { loadAcl: null };\n',
  '\nconst __selftest = { saveAcl: null };\n',
  '\nconst __selftest = { deliveryId: null };\n',
  '\nconst __selftest = DELIVERY_ID_BYTE_LENGTH;\n',
  '\nconst __selftest = verifyPresenceProof;\n',
  '\ntype __Selftest = PresenceProofV1;\n',
  '\ntype __Selftest = BurrowEnrollment;\n',
]) {
  selftest.withAppended(
    'lib/src/remote/burrow/one-time-runtime.ts',
    violation,
    `a grant name in lib/src/remote/burrow/one-time-runtime.ts stays green: ${violation.trim()}`,
  );
}

// The presence-window rule must redden in every scope it names, not just the
// Relay import the loop appends, and for each spelling: the constant, a
// private field, and the module path.
for (const [file, violation] of [
  ['hosted/server/relay-api.ts', '\nconst __selftest = PRESENCE_WINDOW;\n'],
  ['lib/src/remote/burrow/one-time-runtime.ts', '\nclass __Selftest { #presenceWindows = null; }\n'],
  ['lib/src/remote/one-time-rendezvous.ts', '\ntype __Selftest = PresenceWindowEntry;\n'],
  ['lib/src/remote/client/one-time-client.ts', "\nexport * from '../../../../remote-lib-common/src/security/presence-window';\n"],
  ['lib/src/remote/one-time-app/OneTimeApp.tsx', '\nconst __selftest = PRESENCE_WINDOW_IDLE_MS;\n'],
]) {
  selftest.withAppended(file, violation, `a presence window in ${file} stays green: ${violation.trim()}`);
}

// Every name the one-time phone's store rule lists must redden it on its own,
// in the client, in the session core it shares with Pocket, and in the page —
// the loop case appends one import to the client alone. A dynamic import and a
// re-export are the same reach. The page's cases also prove the rule's
// directory scope still resolves to its files.
const ONE_TIME_CLIENT = 'lib/src/remote/client/one-time-client.ts';
const SESSION_CORE = 'lib/src/remote/client/session-core.ts';
const ONE_TIME_PAGE = 'lib/src/remote/one-time-app/OneTimeApp.tsx';
const ONE_TIME_PAGE_ENTRY = 'lib/src/remote/one-time-app/main.tsx';
for (const [file, violation] of [
  [ONE_TIME_CLIENT, '\nconst __selftest = globalThis.indexedDB;\n'],
  [ONE_TIME_CLIENT, '\nconst __selftest = globalThis.localStorage;\n'],
  [ONE_TIME_CLIENT, '\nconst __selftest = globalThis.sessionStorage;\n'],
  [ONE_TIME_CLIENT, '\nconst __selftest = navigator.serviceWorker;\n'],
  [ONE_TIME_CLIENT, "\nimport { generateClientKeyPair } from './pocket-private-key';\n"],
  [ONE_TIME_CLIENT, "\nimport { PocketClient } from './pocket-client';\n"],
  [ONE_TIME_CLIENT, "\nimport type { WebAuthnClient } from './webauthn.ts';\n"],
  [ONE_TIME_CLIENT, "\nexport { subscribeToPush } from './push-subscribe';\n"],
  [ONE_TIME_CLIENT, "\nconst __selftest = import('../pocket-app/service-worker');\n"],
  [SESSION_CORE, "\nimport type { KnownBurrowStore } from './pocket-db';\n"],
  [SESSION_CORE, '\nconst __selftest = globalThis.indexedDB;\n'],
  [ONE_TIME_PAGE, '\nconst __selftest = globalThis.localStorage;\n'],
  [ONE_TIME_PAGE, "\nimport { indexedDbKnownBurrowStore } from '../client/pocket-db';\n"],
  [ONE_TIME_PAGE_ENTRY, "\nimport { registerPushServiceWorker } from '../pocket-app/service-worker';\n"],
  [ONE_TIME_PAGE_ENTRY, '\nconst __selftest = navigator.serviceWorker;\n'],
]) {
  selftest.withAppended(file, violation, `a store in ${file} stays green: ${violation.trim()}`);
}

// The goodbye is a control message like the signals, so naming it — as its
// tag or as its type — reddens the routing rule on its own, not just the SDP
// the loop appends.
for (const violation of [
  "\nconst __selftest = { v: 1, t: 'session-end' };\n",
  '\ntype __Selftest = SessionEndV1;\n',
]) {
  selftest.withAppended(
    'relay/src/relay.ts',
    violation,
    `the goodbye named in relay/src/relay.ts stays green: ${violation.trim()}`,
  );
}

// These rules reach Hosted's server as well as their own trees, and the loop
// above appends only inside those: each must redden in Hosted too. Named
// rather than derived from `trees`, so a rule narrowed back is reported.
const HOSTED_ROUTE = 'hosted/server/one-time.ts';
for (const name of [
  'Neither the Relay nor Hosted names a protocol-v1 plaintext type',
  'Neither the Relay nor Hosted names a session control message or an SDP',
  "No ICE server URL but Cloudflare's STUN, and that only in its constant's file — never TURN",
  '`iceServers` is named only in the two peer factories',
  '`CLOUDFLARE_STUN_URL` is named only in `ice-servers.ts`',
  '`stunServers` is named only in the two peer factories',
]) {
  const rule = RULES.find((rule) => rule.rule === name);
  if (!rule || !filesFor(rule).includes(HOSTED_ROUTE)) {
    selftest.weak.push(`${name}\n      no longer scans ${HOSTED_ROUTE}`);
    continue;
  }
  selftest.withAppended(HOSTED_ROUTE, rule.violation, `${name}\n      the same violation in ${HOSTED_ROUTE} stays green`);
}

// The ICE rules allow exactly one URL and its constant in one file, and
// `iceServers` and `stunServers` in two: each way past those allowances must
// redden, not just the stray STUN server, list, import, and call the loop
// appends. Cloudflare's own host under another scheme is not its STUN, the URL
// outside its constant is a second spelling, a factory that lists the constant
// itself ignores its flag, a call beside the definition or through an alias is
// a third caller, and the native factory's flag is the Burrow service's to
// choose.
for (const [file, violation] of [
  [ICE_SERVER_MODULE, "\nexport const __SELFTEST = 'turn:stun.cloudflare.com:3478';\n"],
  [ICE_SERVER_MODULE, "\nexport const __SELFTEST = 'turns:stun.cloudflare.com:5349';\n"],
  [ICE_SERVER_MODULE, "\nexport const __SELFTEST = 'stuns:stun.cloudflare.com:5349';\n"],
  [ICE_SERVER_MODULE, "\nexport const __SELFTEST = 'stun:stun.cloudflare.com:3478?transport=tcp';\n"],
  [ICE_SERVER_MODULE, '\nexport const __SELFTEST = (host: string) => `turn:${host}`;\n'],
  ...PEER_FACTORIES.flatMap((factory) => [
    [factory, "\nconst __selftest = 'stun:stun.cloudflare.com:3478';\n"],
    [factory, '\nconst __selftest = [{ urls: CLOUDFLARE_STUN_URL }];\n'],
  ]),
  [ONE_TIME_PAGE, '\nconst __selftest = (iceServers: string[]) => new RTCPeerConnection({ iceServers });\n'],
  [ICE_SERVER_MODULE, '\nexport const __SELFTEST = stunServers(true);\n'],
  [ONE_TIME_PAGE, "\nimport { stunServers as __selftest } from '../direct/ice-servers';\n"],
  [ONE_TIME_PAGE, "\nimport { CLOUDFLARE_STUN_URL as __selftest } from '../direct/ice-servers';\n"],
  [NATIVE_PEER_FACTORY, '\nconst __selftest = stunServers(\n  true,\n);\n'],
]) {
  selftest.withAppended(file, violation, `an ICE server past its allowance in ${file} stays green: ${violation.trim()}`);
}

// Every spelling the room rule names must redden it, not just the parse the
// loop appends: a decode, a log, or a stored frame is the same leak. The
// decodes are the relay room's set, a `Buffer` and a `TextDecoder` included.
for (const violation of [
  '\nconst __selftest = (ct: string) => fromBase64Url(ct);\n',
  '\nconst __selftest = (ct: string) => atob(ct);\n',
  '\nconst __selftest = (frame: string) => Buffer.from(frame, "base64");\n',
  '\nconst __selftest = (bytes: Uint8Array) => new TextDecoder().decode(bytes);\n',
  '\nconst __selftest = (frame: string) => Uint8Array.fromBase64(frame);\n',
  '\nconst __selftest = (decode: (s: string, e: string) => string, frame: string) => decode(frame, "base64");\n',
  '\nconst __selftest = (frame: string) => console.log(frame);\n',
  "\nconst __selftest = (frame: string) => this.#ctx.storage.put('frame', frame);\n",
  "\nconst __selftest = (frame: string) => this.#ctx.storage.sql.exec('SELECT ?', frame);\n",
]) {
  selftest.withAppended(
    'hosted/server/one-time-room.ts',
    violation,
    `a forbidden read in hosted/server/one-time-room.ts stays green: ${violation.trim()}`,
  );
}

// The same for the per-account relay object, which reaches frames only through
// the shared frame layer: every way of naming, reading, logging, or keeping one
// must redden, including the four a review found past the first version of the
// rule — a `Buffer` decode, a `TextDecoder`, a destructured `ct`, and a frame
// spread into an attachment.
for (const violation of [
  '\nconst __selftest = (frame: { ct: string }) => Buffer.from(frame.ct, "base64");\n',
  '\nconst __selftest = (bytes: Uint8Array) => new TextDecoder().decode(bytes);\n',
  '\nconst __selftest = (frame: object) => { const { ct } = frame as { ct: string }; return ct; };\n',
  '\nconst __selftest = (ws: WorkerWebSocket, conn: object, raw: string) => ws.serializeAttachment({ ...conn, last: raw });\n',
  '\nconst __selftest = (ws: WorkerWebSocket, raw: string) => ws.serializeAttachment({ role: "client", raw });\n',
  '\nconst __selftest = (conn: { last?: string }, raw: string) => { conn.last = raw; };\n',
  '\nconst __selftest = (frame: Record<string, string>) => frame["ct"];\n',
  '\nconst __selftest = (raw: string) => JSON.parse(raw);\n',
  '\nconst __selftest = (raw: string) => atob(raw);\n',
  '\nconst __selftest = (raw: string) => fromBase64Url(raw);\n',
  '\nconst __selftest = (frame: string) => console.log(frame);\n',
  '\nconst __selftest = (frame: string) => console.error("RelayRoom refused a request for another account", frame);\n',
  '\nconst __selftest = (frame: string) => console.error(`refused ${frame}`);\n',
  '\nconst __selftest = console.error;\n',
  "\nconst __selftest = (frame: string) => this.ctx.storage.put('frame', frame);\n",
  '\nconst __selftest = (frame: string) => this.ctx.storage.put(ACCOUNT_KEY, frame);\n',
  "\nconst __selftest = (frame: string) => this.ctx.storage.sql.exec('SELECT ?', frame);\n",
  '\nconst __selftest = (ctx: DurableObjectState) => ctx.storage;\n',
]) {
  selftest.withAppended(
    RELAY_ROOM,
    violation,
    `a forbidden read or write in ${RELAY_ROOM} stays green: ${violation.trim()}`,
  );
}

// The shared frame layer may copy the ciphertext and nothing else.
for (const violation of [
  '\nconst __selftest = (frame: { ct: string }) => { const { ct } = frame; return ct; };\n',
  '\nconst __selftest = (frame: { ct: string }) => frame.ct.length;\n',
  '\nconst __selftest = (frame: { ct: string }) => fromBase64Url(frame.ct);\n',
  '\nconst __selftest = (bytes: Uint8Array) => new TextDecoder().decode(bytes);\n',
  '\nconst __selftest = (text: string) => JSON.parse(text);\n',
  '\nconst __selftest = (raw: string) => console.log(raw);\n',
]) {
  selftest.withAppended(
    RELAY_ROUTING,
    violation,
    `a forbidden read in ${RELAY_ROUTING} stays green: ${violation.trim()}`,
  );
}

// A file-scoped storage exception must not become a directory-scoped escape.
selftest.withAppended(
  'lib/src/remote/client/pocket-db.ts',
  "\nconst __selftest = { name: 'AES-GCM' };\n",
  'AES-GCM in the module beside the at-rest wrapper stays green',
);
selftest.withAppended(
  'remote-lib-common/src/remote/relay-common.ts',
  "\nconst __selftest = { name: 'AES-GCM' };\n",
  `AES-GCM in the module beside ${WEB_PUSH_SENDER} stays green`,
);

const cited = new Map();
for (const rule of RULES) {
  const spec = rule.spec ?? SECURITY_SPEC;
  cited.set(`${spec}\0${rule.security}`, { spec, line: rule.security });
}
for (const { spec, line } of cited.values()) {
  const text = readFileSync(join(repoRoot, spec), 'utf8');
  if (!text.includes(line)) {
    selftest.weak.push(`${spec} does not contain the line a rule names: "${line}"`);
    continue;
  }
  selftest.withMutation(
    spec,
    (path) => writeFileSync(path, text.replace(line, '')),
    `deleting "${line}" from ${spec} stays green — a rule would outlive the prose`,
  );
}

selftest.finish(
  'e2e-lint-selftest',
  'A rule that stays green with the forbidden thing present is looking at the\n' +
    'wrong text, or at no files at all — check the pattern spelling and that the\n' +
    "rule's scope still resolves. For an added copy on an exact-count rule, the\n" +
    'fix is in e2e-lint.mjs, not the pattern.',
);
