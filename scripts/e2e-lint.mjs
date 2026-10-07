#!/usr/bin/env node
/**
 * Mechanical check for the structural half of the end-to-end boundary in
 * `docs/specs/security-remote.md` ("Remote Control"), and of the Hosted rooms
 * that forward a one-time handshake and an account's relay frames in
 * `docs/specs/security-hosted.md` ("Rendezvous boundary", "Relay boundary"). Runs from the repo
 * root via `pnpm test` (see the root package.json). Exits non-zero with a
 * per-violation report naming the rule that was broken and the spec line it
 * enforces.
 *
 * Why this exists: the properties the trust boundary rests on are *absences* —
 * one Noise suite and no way to select another, no JavaScript curve, no
 * plaintext relay route, no legacy frame discriminant left to answer, no
 * Relay-side or Hosted-side view of protocol-v1 or of the direct path's
 * signaling, no ICE server but Cloudflare's STUN and no TURN at all, no
 * checked-in service worker shadowing the built one, no one-time frame the
 * Relay or `BurrowRuntime` could read, no parse in
 * the Hosted room that forwards one, no grant a one-time connection could
 * leave behind, no store a one-time phone could keep anything in, no presence
 * window anywhere but the Burrow, and no relayed application message a
 * Local-networks session would read. An
 * absence is exactly what a
 * reviewer stops noticing: nothing in a
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
 *     four all pass here. `remote-lib-common/test/noise.test.mjs`,
 *     `push-seal.test.mjs`, `security-guarantees.test.mjs`, and the
 *     malicious-relay harness own that, and so does the audit.
 *   - It reasons about spelled-out identifiers and string literals. A protocol
 *     name assembled at runtime, an algorithm chosen through a variable, or a
 *     dependency reached through a re-export is invisible to a regex and always
 *     will be.
 *   - Test files are out of scope for the discriminant rules on purpose:
 *     `lib/src/remote/burrow/burrow-runtime.test.ts` and
 *     `remote-lib-common/test/wire.test.mjs` name the retired tags precisely to
 *     assert they are *rejected*, and a lint that reddened on those would push
 *     someone to delete the regression tests.
 *
 * Every rule names the spec line it enforces, and that line is checked to
 * still exist — a rule whose prose was deleted is a rule nobody agreed to.
 * `scripts/e2e-lint-selftest.mjs` is what keeps the patterns honest: it
 * re-introduces each forbidden thing in turn and requires this lint to fail.
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRepoFile, repoRoot, trackedFiles } from './lint-kit.mjs';

/**
 * The one suite. Spelled here rather than imported, because importing the
 * constant from the module under test would make the rule self-satisfying:
 * renaming the suite would rename the expectation with it.
 */
const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';

/** The spec whose "Remote Control" lines the rules below pin, unless a rule names its own. */
export const SECURITY_SPEC = 'docs/specs/security-remote.md';

/** The spec whose "Rendezvous boundary" and "Relay boundary" lines the Hosted rooms' rules pin. */
export const HOSTED_SECURITY_SPEC = 'docs/specs/security-hosted.md';

/**
 * The modules that carry the end-to-end boundary. Scoped explicitly rather than
 * by directory, because the neighbours matter: `passkey.ts` and `ecdsa.ts` are
 * ES256 (`ECDSA` / `P-256`) by WebAuthn's mandatory-to-implement rule, and a
 * curve rule that swept the whole `security/` directory would flag the one
 * place those strings *belong*.
 */
const E2E_MODULES = [
  'remote-lib-common/src/security/noise.ts',
  'remote-lib-common/src/security/noise-transport.ts',
  'remote-lib-common/src/security/push-seal.ts',
  'remote-lib-common/src/security/e2e-ceremony.ts',
  'remote-lib-common/src/security/e2e-bounds.ts',
  'remote-lib-common/src/security/pairing-invitation.ts',
  'remote-lib-common/src/security/one-time-link.ts',
  'remote-lib-common/src/security/link-url.ts',
  // Presence *derives* a challenge and never verifies an assertion itself —
  // `passkey.ts` does, which is why that one is out of scope and this one is in.
  'remote-lib-common/src/security/presence.ts',
  'remote-lib-common/src/security/acl.ts',
  // The direct path carries the same promoted session onto a data channel, so
  // it is inside the boundary for the same reasons the transport is: one key
  // agreement, one AEAD, and no second construction reachable from either.
  'remote-lib-common/src/security/direct-path.ts',
  'lib/src/remote/direct/direct-endpoint.ts',
  'lib/src/remote/direct/direct-peer.ts',
  'remote-lib-common/src/remote/wire.ts',
  'remote-lib-common/src/remote/one-time-wire.ts',
  'lib/src/remote/burrow/burrow-runtime.ts',
  'lib/src/remote/burrow/established-session.ts',
  'lib/src/remote/burrow/one-time-runtime.ts',
  'lib/src/remote/burrow/push-delivery.ts',
  'lib/src/remote/client/pocket-client.ts',
  'lib/src/remote/client/session-core.ts',
  'lib/src/remote/client/one-time-client.ts',
  'lib/src/remote/one-time-rendezvous.ts',
  'lib/src/remote/pocket-app/sw.ts',
];

/** The two modules that own the Noise suite itself. */
const NOISE_MODULES = [
  'remote-lib-common/src/security/noise.ts',
  'remote-lib-common/src/security/noise-transport.ts',
];

/**
 * The files that decide what a relay or rendezvous frame is. A retired
 * discriminant anywhere here is a path something could still answer.
 */
const FRAME_MODULES = [
  'remote-lib-common/src/remote/wire.ts',
  'remote-lib-common/src/remote/one-time-wire.ts',
  'relay/src/relay.ts',
  'lib/src/remote/burrow/burrow-runtime.ts',
  'lib/src/remote/burrow/one-time-runtime.ts',
  'lib/src/remote/client/pocket-client.ts',
  'lib/src/remote/client/one-time-client.ts',
  'lib/src/remote/one-time-rendezvous.ts',
];

/** The paired Burrow's runtime, which holds a session to the direct path under Local networks. */
const BURROW_RUNTIME = 'lib/src/remote/burrow/burrow-runtime.ts';

/** The laptop's one-time runtime, which authorizes one session and writes nothing. */
const ONE_TIME_RUNTIME = 'lib/src/remote/burrow/one-time-runtime.ts';

/**
 * The rendezvous plumbing the runtime and the phone's client share, held to
 * both ends' rules: a grant or a store reached through it is reached through
 * each of them.
 */
const ONE_TIME_RENDEZVOUS = 'lib/src/remote/one-time-rendezvous.ts';

/**
 * The phone's one-time client, and the session core it shares with Pocket —
 * which is why the core is held to the same rule: a store reached through it
 * is reached through both.
 */
const ONE_TIME_PHONE_MODULES = [
  'lib/src/remote/client/one-time-client.ts',
  'lib/src/remote/client/session-core.ts',
  ONE_TIME_RENDEZVOUS,
];

/** The one-time phone page, served from an origin Hosted's accounts share: every module in it. */
const ONE_TIME_PAGE_TREE = 'lib/src/remote/one-time-app/';

/**
 * Every way a phone module could keep something past its page: the browser's
 * stores and its worker registry by name, or an import of Pocket's own —
 * the pinned records, the key wrapping, the passkeys, push, the worker, and
 * `PocketClient`, which holds all of them. Anchored on the import for the
 * modules, so prose may still name them.
 */
const PHONE_PERSISTENCE =
  /\b(?:indexedDB|localStorage|sessionStorage|serviceWorker)\b|\b(?:from|import)\s*\(?\s*['"][^'"]*\/(?:pocket-db|pocket-private-key|pocket-client|webauthn|push-subscribe|service-worker)(?:\.[cm]?[jt]s)?['"]/g;

/**
 * Every name through which a runtime could grant something that outlives its
 * session: the ACL and its store, a push delivery id, the presence verifier and
 * the proof it checks, and the enrollment that owns all of them.
 */
const GRANT_NAME =
  /\b(?:BurrowAcl\w*|loadBurrowAcl|loadAcl|saveAcl|deliveryId|DELIVERY_ID_\w+|verifyPresenceProof|PresenceProofV1|BurrowEnrollment)\b/g;

/**
 * Every spelling of the one-time family's names: its types and guards
 * (`OneTime…`, `isOneTime…`, `oneTime…`), its constants (`ONE_TIME_…`,
 * `WS_CLOSE_ONE_TIME_…`), and its frame tags as literals. Anchored on the quote
 * for the tags, since "one-time" is ordinary prose — the enrollment offer's
 * one-time token among it.
 */
const ONE_TIME_NAME = /[Oo]neTime|ONE_TIME_|['"`]one-time/g;

/** Hosted's per-account relay object (`docs/specs/hosted.md` -> "Relay sockets"). */
export const RELAY_ROOM = 'hosted/server/relay-room.ts';

/** The frame layer both Relays route through (`docs/specs/relay.md` -> "Routing"). */
export const RELAY_ROUTING = 'remote-lib-common/src/remote/relay-routing.ts';

/**
 * Everything {@link RELAY_ROOM} could keep, log, or read a frame through,
 * spelled out because it reaches frames only through {@link RELAY_ROUTING}:
 *
 * - the ciphertext's field name at all, a parse, or a decode — it never
 *   names `ct`, so a destructure or a computed key is a match too;
 * - `console` other than one method called with one plain string;
 * - `storage` other than the reads, the alarm, and the one write of the
 *   account id — an alias of it included;
 * - an attachment other than a connection (`conn`, `x.conn`) or a connection
 *   literal checked `satisfies` its type without a spread, and a connection
 *   field written other than the two routing writes.
 */
const RELAY_ROOM_LEAKS = new RegExp(
  [
    String.raw`\bct\b|\bJSON\.parse\b|\batob\b|\bBuffer\b|\bTextDecoder\b|[Bb]ase64`,
    String.raw`\bconsole\b(?!\.\w+\(\s*"[^"\\]*"\s*\))`,
    String.raw`\bstorage\b(?!\.(?:get|getAlarm|setAlarm|deleteAlarm)\b|\.put\(ACCOUNT_KEY, account\))`,
    String.raw`\bserializeAttachment\((?!(?:\w+\.)?conn\)|\{(?:(?!\.\.\.)[^{}()])*\}\s*satisfies\s+(?:BurrowConn|ClientConn)\))`,
    String.raw`\bconn\.(?!retired\b|burrowId\b)\w+\s*=(?!=)`,
  ].join('|'),
  'g',
);

/** The three shipped source trees, scanned whole for the dependency rules. */
const SOURCE_TREES = ['remote-lib-common/src/', 'lib/src/', 'relay/src/'];

/**
 * Every shipped tree that could hold a Burrow ACL writer: the shared ACL, both
 * hosts' Burrow code, the Relays, and `dor`.
 */
const ACL_WRITER_TREES = [...SOURCE_TREES, 'hosted/server/', 'vscode-ext/src/', 'standalone/src/', 'standalone/sidecar/', 'dor/src/'];

/** A class member's opening line in `BurrowRuntime`, which ends the one before it. */
const NOT_NEXT_MEMBER = String.raw`(?:(?!\n  (?:async |static )?[#\w]+\s*\()[\s\S])*?`;

/**
 * The two services that carry ciphertext they must not read: the Relay, and
 * Hosted, whose one-time room forwards a handshake.
 */
const ROUTING_TREES = ['relay/src/', 'hosted/server/'];

/**
 * The one ICE server URL shipped source may spell, and the one file that may
 * spell it, as `docs/specs/security-remote.md` -> "Direct path" names them.
 * Spelled here rather than imported, for the reason {@link NOISE_PROTOCOL_NAME}
 * is: importing the constant would let a change to it change the expectation.
 */
const CLOUDFLARE_STUN_URL = 'stun:stun.cloudflare.com:3478';
export const ICE_SERVER_MODULE = 'lib/src/remote/direct/ice-servers.ts';

/** The Burrow hosts' peer factory, whose STUN flag only the Burrow service chooses. */
export const NATIVE_PEER_FACTORY = 'lib/src/host/remote/native-direct-peer.ts';

/** The two peer factories, the only files that build an ICE server list. */
export const PEER_FACTORIES = [NATIVE_PEER_FACTORY, 'lib/src/remote/client/browser-direct-peer.ts'];

/**
 * The two files the AES-GCM ban excuses, as `docs/specs/security-remote.md` ->
 * "Credentials at rest" names them, each by exact path rather than dropped
 * from the scan, so a rename that leaves the cipher behind turns the rule red.
 * This one wraps Pocket's private key at rest.
 */
const AT_REST_KEY_WRAPPER = 'lib/src/remote/client/pocket-private-key.ts';

/**
 * And this one is the Hosted Relay's Web Push sender, whose
 * `aes128gcm` record RFC 8291 fixes as AES-128-GCM. It encrypts to a push
 * service's subscription key, outside the Noise channel, around an envelope
 * already sealed inside it.
 */
export const WEB_PUSH_SENDER = 'remote-lib-common/src/remote/web-push.ts';

/**
 * One entry per structural property. Every rule states the line it enforces in
 * `security`, which must still appear in its `spec` (`SECURITY_SPEC` when
 * omitted) — as a substring of the raw text, so the phrase has to sit on one
 * line: reflow the spec paragraph around it rather than let a hard wrap split it.
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
    violationFile: 'remote-lib-common/src/security/noise.ts',
    violation: "\nconst __selftest = 'Noise_XX_25519_AESGCM_SHA256';\n",
  },
  {
    rule: 'No generic pattern, suite, or protocol-name option on the handshake API',
    security: 'no negotiation, no cipher or pattern selector',
    kind: 'forbid',
    files: NOISE_MODULES,
    // Shaped as a TS member, object key, parameter, or type argument, so the
    // words may still be used in prose: a doc-comment line starts with `*`,
    // which breaks the anchor. `(` and `<` are in the class because a selector
    // does not have to arrive as a member — `deriveKey(pattern: string, …)` is
    // the same rule broken, and anchoring only on `{,;` left it invisible.
    pattern: /(?:^|[{,;(<])[ \t]*(?:readonly[ \t]+)?(?:pattern|suite|cipherSuite|protocolName|dhFunction|hashFunction)[ \t]*\??[ \t]*:/gm,
    violationFile: 'remote-lib-common/src/security/noise.ts',
    violation: '\nexport interface SelftestOptions {\n  readonly pattern: string;\n}\n',
  },
  {
    rule: 'No second AEAD outside Pocket at-rest key wrapping',
    security: 'AES-GCM appears in production source under `remote-lib-common/src/`',
    kind: 'forbid',
    trees: SOURCE_TREES,
    allow: (match, file) => file === AT_REST_KEY_WRAPPER || file === WEB_PUSH_SENDER,
    // The exceptions encrypt local private-key storage and a Web Push record,
    // never a Noise frame.
    // `AES-GCM` is the substitution the Noise suite exists to refuse: it *is* in
    // shipping WebCrypto, which is exactly what makes it the tempting one, and
    // the protocol name is part of the transcript so swapping it is a different
    // protocol rather than a configuration choice.
    pattern: /['"]AES-GCM['"]/g,
    violationFile: 'remote-lib-common/src/security/push-seal.ts',
    violation: "\nconst __selftest = { name: 'AES-GCM' };\n",
  },
  {
    rule: 'No ECDH, ECDSA, or named-curve primitive inside the e2e modules',
    security: 'no negotiation, no cipher or pattern selector',
    kind: 'forbid',
    files: E2E_MODULES,
    // Scoped to the e2e modules so WebAuthn's mandatory ES256 — `ECDSA` /
    // `P-256` in `passkey.ts`, `ecdsa.ts`, and the Relay's SPKI import — is
    // not swept up. Inside these files there is one key agreement (X25519) and
    // one signature scheme (none).
    pattern: /['"](?:ECDH|ECDSA|P-256|P-384|P-521|Ed25519)['"]|\bnamedCurve\b/g,
    violationFile: 'remote-lib-common/src/security/noise.ts',
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
    violationFile: 'remote-lib-common/src/security/noise.ts',
    violation: "\nimport { x25519 } from '@noble/curves/ed25519.js';\n",
  },
  {
    rule: 'Exactly two `@noble/ciphers` imports — the ChaChaPoly binding and nothing else',
    security: 'X25519 stays WebCrypto-only',
    kind: 'exactly',
    trees: SOURCE_TREES,
    pattern: /\bfrom\s+['"]@noble\/ciphers/g,
    count: 2,
    violationFile: 'remote-lib-common/src/security/push-seal.ts',
    violation: "\nimport { xchacha20poly1305 } from '@noble/ciphers/chacha.js';\n",
  },
  {
    rule: 'No legacy relay discriminant',
    security: 'no plaintext relay route, and no reader for any of the pre-cutover frames',
    kind: 'forbid',
    files: FRAME_MODULES,
    // The tags of the Relay-readable protocol this replaced. A reader for one
    // is a path a hostile relay could still drive; the shipped set is `e2e`,
    // `burrow-gone`, `error`, `client-gone`, and `policy`.
    pattern:
      /['"](?:pair|pair-status|connect|connect2|msg|pair-result|challenge|decision|setup-token-redeemed)['"]/g,
    violationFile: 'relay/src/relay.ts',
    violation: "\nconst __selftest = { t: 'connect2' };\n",
  },
  {
    rule: 'Neither the Relay nor Hosted names a protocol-v1 plaintext type',
    security: 'Relay-side type import from the protocol-v1 half',
    kind: 'forbid',
    trees: ROUTING_TREES,
    // Naming one is not itself a read, but it is the only reason a relay would
    // have to: the Relay and Hosted's one-time room route opaque frames, so a
    // file that knows what a `DirectoryEntry` is has started to care what it is
    // carrying.
    pattern:
      /\b(?:RemoteRequest|RemoteResponse|RemoteEventMsg|DirectoryEntry|DirectorySnapshot|TerminalDataEvent|TerminalClosedEvent|TerminalSemanticEvent|AttachParams|TerminalAttachResult|TerminalWriteParams|TerminalResizeParams|HelloParams|HelloResult|REMOTE_METHODS|REMOTE_EVENTS|MAX_TERMINAL_DIMENSION|clampTerminalDimension)\b/g,
    violationFile: 'relay/src/relay.ts',
    violation: "\nimport type { DirectoryEntry } from 'remote-lib-common';\n",
  },
  {
    rule: "No ICE server URL but Cloudflare's STUN, and that only in its constant's file — never TURN",
    security: 'the only `stun:`, `stuns:`, `turn:`, or `turns:` URL is exactly `stun:stun.cloudflare.com:3478`',
    kind: 'forbid',
    trees: [...SOURCE_TREES, 'hosted/server/'],
    // Anchored on the quote that opens the literal, because the bare scheme is
    // a substring of ordinary prose: `// ... early return:` and `Saturn:` both
    // contain `turn:`, and a rule that reddened on those would be deleted. The
    // match runs to the closing quote, so the allowance is the whole URL: a
    // TURN URL on Cloudflare's own host is still refused.
    pattern: /(?<=['"`])(?:stuns?|turns?):[^'"`\s]*/g,
    allow: (match, file) => file === ICE_SERVER_MODULE && match === CLOUDFLARE_STUN_URL,
    violationFile: 'lib/src/remote/pocket-app/App.tsx',
    violation: "\nconst __selftest = 'stun:stun.example.net:19302';\n",
  },
  {
    rule: '`iceServers` is named only in the two peer factories',
    security: '`iceServers` appears only in the two peer factories',
    kind: 'forbid',
    trees: [...SOURCE_TREES, 'hosted/server/'],
    // The word, not a key: a shorthand `{ iceServers }` or an assignment builds
    // a list as surely as a literal does, and every list must come from the
    // factory that takes it from the Burrow service or from who serves the page.
    pattern: /\biceServers\b/g,
    allow: (_match, file) => PEER_FACTORIES.includes(file),
    violationFile: 'lib/src/remote/pocket-app/App.tsx',
    violation: '\nconst __selftest = { iceServers: [] };\n',
  },
  {
    rule: '`CLOUDFLARE_STUN_URL` is named only in `ice-servers.ts`',
    security: 'listed only by `stunServers` there',
    kind: 'forbid',
    trees: [...SOURCE_TREES, 'hosted/server/'],
    // The name, not a list: a file that holds the constant can list it around
    // `stunServers` and its flag, so only the module that defines it may.
    pattern: /\bCLOUDFLARE_STUN_URL\b/g,
    allow: (_match, file) => file === ICE_SERVER_MODULE,
    violationFile: NATIVE_PEER_FACTORY,
    violation: "\nimport { CLOUDFLARE_STUN_URL } from '../../remote/direct/ice-servers';\n",
  },
  {
    rule: '`stunServers` is named only in the two peer factories',
    security: 'which only the two peer factories call',
    kind: 'forbid',
    trees: [...SOURCE_TREES, 'hosted/server/'],
    // The name, not a call: an aliased import reaches it as surely. Its own
    // definition is the one other spelling, matched with its `function` so a
    // call beside it in that module is still refused.
    pattern: /(?:\bfunction\s+)?\bstunServers\b/g,
    allow: (match, file) =>
      PEER_FACTORIES.includes(file) || (file === ICE_SERVER_MODULE && match.startsWith('function')),
    violationFile: 'lib/src/remote/pocket-app/App.tsx',
    violation: '\nconst __selftest = stunServers(false);\n',
  },
  {
    rule: 'The native peer factory never passes `stunServers` a literal `true`',
    security: 'the native one never with a literal `true`',
    kind: 'forbid',
    // Its flag comes from the Burrow service, which takes it from the level: a
    // literal would show Cloudflare this computer's address at every level.
    files: [NATIVE_PEER_FACTORY],
    pattern: /\bstunServers\s*\(\s*true\b/g,
    violationFile: NATIVE_PEER_FACTORY,
    violation: '\nconst __selftest = stunServers(true);\n',
  },
  {
    rule: 'Neither the Relay nor Hosted names a session control message or an SDP',
    security: 'any signaling leaves the ciphertext',
    kind: 'forbid',
    trees: ROUTING_TREES,
    // The signals and the Burrow's goodbye ride as `control` messages inside
    // the session, so the Relay and the one-time room route them without
    // knowing they exist. Naming one is the leading indicator that a route, a
    // guard, or a frame type has started to care — the same reasoning as the
    // protocol-v1 rule above.
    pattern:
      /\b(?:direct-offer|direct-answer|direct-decline|direct-switch|session-end|SessionEndV1|RTCPeerConnection|sdp)\b/gi,
    violationFile: 'relay/src/relay.ts',
    violation: "\nconst __selftest = { sdp: '' };\n",
  },
  {
    rule: "Hosted's one-time room never parses, decodes, stores, or logs a frame",
    spec: HOSTED_SECURITY_SPEC,
    security: 'parses, decodes, stores, or logs a forwarded frame',
    kind: 'forbid',
    files: ['hosted/server/one-time-room.ts'],
    // The room forwards a frame verbatim and bounds it by raw length and count
    // alone, so it has no reason to read one: a parse is the first step toward
    // a room that acts on what a handshake says, and a log or a stored frame
    // is handshake ciphertext kept past the handshake.
    pattern: /\bJSON\.parse\b|\bfromBase64Url\b|\batob\b|\bconsole\.|\bstorage\.(?:put|sql|kv)\b/g,
    violationFile: 'hosted/server/one-time-room.ts',
    violation: '\nconst __selftest = (frame: string) => JSON.parse(frame);\n',
  },
  {
    rule: "Hosted's RelayRoom never names, parses, decodes, logs, or stores a frame",
    spec: HOSTED_SECURITY_SPEC,
    security: 'stores, logs, or decodes a frame or its `ct`',
    kind: 'forbid',
    files: [RELAY_ROOM],
    // It reads a frame only through the shared frame layer, which hands back
    // the routing envelope and rebuilds it; everything that could keep, log,
    // or read one is in `RELAY_ROOM_LEAKS`.
    pattern: RELAY_ROOM_LEAKS,
    violationFile: RELAY_ROOM,
    violation: '\nconst __selftest = (frame: { ct: string }) => Buffer.from(frame.ct, "base64");\n',
  },
  {
    rule: 'The shared frame layer copies `ct` field by field and reads it nowhere',
    spec: HOSTED_SECURITY_SPEC,
    security: 'copies `ct` field by field and reads it nowhere else',
    kind: 'forbid',
    files: [RELAY_ROUTING],
    // Its one parse is of the raw frame, after which the guards bound every
    // field; `ct` appears only as the copy `ct: frame.ct,` into an envelope.
    pattern:
      /\bct: frame\.ct,|\bct\b|\bJSON\.parse\b(?!\(raw\))|\batob\b|\bBuffer\b|\bTextDecoder\b|\bfromBase64Url\b|\bconsole\b/g,
    allow: (match) => match === 'ct: frame.ct,',
    violationFile: RELAY_ROUTING,
    violation: '\nconst __selftest = (frame: { ct: string }) => atob(frame.ct);\n',
  },
  {
    rule: 'The Relay never names the one-time family',
    security: 'no one-time name may appear under `relay/src/`',
    kind: 'forbid',
    trees: ['relay/src/'],
    // A one-time room is Hosted's, and carries a handshake the Relay has no part
    // in. A Relay file that names a one-time frame, guard, or close code has
    // started to route one — the same leading-indicator reasoning as the
    // protocol-v1 rule above.
    pattern: ONE_TIME_NAME,
    violationFile: 'relay/src/relay.ts',
    violation: "\nconst __selftest = { t: 'one-time' };\n",
  },
  {
    rule: 'The relay envelope and `BurrowRuntime` never name the one-time family',
    security: 'no one-time name may appear under `relay/src/`',
    kind: 'forbid',
    // `wire.ts` is where the relay's frame unions live, so a one-time frame
    // added to one would reach the Relay without the Relay naming it.
    // `BurrowRuntime` is the ACL-holding runtime; a one-time connection is its
    // own runtime that imports nothing ACL or presence.
    files: ['remote-lib-common/src/remote/wire.ts', 'lib/src/remote/burrow/burrow-runtime.ts'],
    pattern: ONE_TIME_NAME,
    violationFile: 'lib/src/remote/burrow/burrow-runtime.ts',
    violation: "\nimport { isOneTimeClientFrame } from 'remote-lib-common';\n",
  },
  {
    rule: '`BurrowRuntime` makes a session direct-only exactly where the path policy is held',
    security: 'must derive `directOnly` from the path policy alone',
    kind: 'require',
    file: BURROW_RUNTIME,
    // Local networks' path policy checks the direct path; the relay is a path
    // it does not check, so a held policy is what makes a paired session
    // direct-only — never the level, a Client, or the Relay.
    pattern: /^    const directOnly = this\.#directPeering\.pathPolicy !== undefined;$/m,
  },
  {
    rule: '`BurrowRuntime` hands its session that derivation and no other',
    security: 'must derive `directOnly` from the path policy alone',
    kind: 'require',
    file: BURROW_RUNTIME,
    // `EstablishedE2eSession` owns every direct-only rule — the deadline, the
    // given-up attempt, the relayed application message — so what this
    // runtime decides is the one flag, as derived above.
    pattern: /^      directOnly,$/m,
  },
  {
    rule: '`OneTimeRuntime` makes its one session direct-only',
    security: 'must make its one session `directOnly`',
    kind: 'require',
    file: ONE_TIME_RUNTIME,
    // A one-time connection has no relayed fallback at all: the rendezvous
    // carries a handshake, never a session.
    pattern: /^        directOnly: true,$/m,
  },
  {
    rule: 'One call mints a Burrow ACL record',
    security: 'must have no caller but `BurrowRuntime.#approvePairing`',
    kind: 'exactly',
    trees: ACL_WRITER_TREES,
    // `BurrowAcl.approve` takes the approved client as an object literal; the
    // pairing request's own `approve(code)` takes a string and is not this.
    pattern: /\.approve\(\s*\{/g,
    count: 1,
    violationFile: 'lib/src/host/remote/service.ts',
    violation: '\nvoid acl.approve({});\n',
  },
  {
    rule: 'Two calls save a Burrow ACL: the runtime\'s approval and the service\'s wiring to its store',
    security: 'must have no caller but `BurrowRuntime.#approvePairing`',
    kind: 'exactly',
    trees: ACL_WRITER_TREES,
    pattern: /\.#?saveAcl\(/g,
    count: 2,
    violationFile: 'vscode-ext/src/burrow-store.ts',
    violation: "\nvoid store.saveAcl('burrow', []);\n",
  },
  {
    rule: 'The mint and its save sit in `#approvePairing`',
    security: 'must have no caller but `BurrowRuntime.#approvePairing`',
    kind: 'require',
    file: BURROW_RUNTIME,
    pattern: new RegExp(String.raw`^  #approvePairing\(${NOT_NEXT_MEMBER}\.approve\(\{${NOT_NEXT_MEMBER}this\.#saveAcl\(`, 'm'),
  },
  {
    rule: '`OneTimeRuntime` names nothing that grants or persists',
    security: 'must name no ACL, ACL store, delivery id, or presence verifier',
    kind: 'forbid',
    files: [ONE_TIME_RUNTIME, ONE_TIME_RENDEZVOUS],
    // A one-time connection authorizes one session and writes nothing. Naming
    // the ACL, its store, a delivery id, or the presence verifier is the leading
    // indicator that it has started to grant something that outlives the
    // session — the same reasoning as the Relay's rules above.
    pattern: GRANT_NAME,
    violationFile: ONE_TIME_RUNTIME,
    violation: "\nimport { BurrowAcl } from 'remote-lib-common';\n",
  },
  {
    rule: 'No presence window outside the Burrow',
    security: 'no presence window held or named outside the Burrow',
    kind: 'forbid',
    // A window waives a prompt, so it may open only on a proof the Burrow
    // verified. A Relay, Hosted, or one-time file that names one has started to
    // mint, extend, or redeem a waiver on someone else's word. The session core
    // is left out: Pocket shares it and rides windows.
    files: [
      ...sourceFilesUnder(ROUTING_TREES),
      ONE_TIME_RUNTIME,
      ONE_TIME_RENDEZVOUS,
      'lib/src/remote/client/one-time-client.ts',
      ...sourceFilesUnder([ONE_TIME_PAGE_TREE]),
    ],
    pattern: /\b[Pp]resenceWindow\w*|\bPRESENCE_WINDOW\w*|presence-window/g,
    violationFile: 'relay/src/relay.ts',
    violation: "\nimport { PresenceWindows } from 'remote-lib-common';\n",
  },
  {
    rule: 'The one-time phone, its page, and its session core name no store',
    security: 'may name no browser store or service worker',
    kind: 'forbid',
    files: [...ONE_TIME_PHONE_MODULES, ...sourceFilesUnder([ONE_TIME_PAGE_TREE])],
    // A one-time phone keeps nothing: its static is minted for one handshake
    // and dropped with the session, and its page persists nothing on an origin
    // it shares with accounts. A store or a Pocket module in any of these files
    // is the leading indicator that something has started to outlive it — the
    // same reasoning as the runtime's grant rule above.
    pattern: PHONE_PERSISTENCE,
    violationFile: 'lib/src/remote/client/one-time-client.ts',
    violation: "\nimport type { KnownBurrowStore } from './pocket-db';\n",
  },
  {
    rule: '`E2eKind` is exactly pairing and connection',
    security: 'must admit exactly `pairing` and `connection`',
    kind: 'require',
    file: 'remote-lib-common/src/remote/wire.ts',
    // Anchored on the semicolon, so a third member appended to the union stops
    // matching; `scripts/e2e-lint-selftest.mjs` proves that as well as the
    // deletion.
    pattern: /^export type E2eKind = 'pairing' \| 'connection';$/m,
  },
  {
    rule: '`isE2eKind` admits exactly pairing and connection',
    security: 'must admit exactly `pairing` and `connection`',
    kind: 'require',
    file: 'remote-lib-common/src/remote/wire.ts',
    // The whole function body, so neither a widened return nor a line added
    // before it keeps matching.
    pattern:
      /^export function isE2eKind\(value: unknown\): value is E2eKind \{\n  return value === 'pairing' \|\| value === 'connection';\n\}$/m,
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
      'remote-lib-common/src/remote/wire.ts',
      'remote-lib-common/src/remote/one-time-wire.ts',
      'remote-lib-common/src/security/e2e-ceremony.ts',
      'remote-lib-common/src/security/one-time-link.ts',
      'remote-lib-common/src/security/push-seal.ts',
    ],
    // Every one of these is load-bearing on every message that carries it, so
    // an optional spelling is a shape where a peer can simply omit the
    // authentication and have the type still check.
    //
    // `lib/src/remote/direct/direct-peer.ts` is deliberately not in this list,
    // even though it is an `E2E_MODULES` entry: its `readonly sdp?: string`
    // mirrors `RTCSessionDescriptionInit`, whose optionality is the W3C API's,
    // not ours. The signal that *does* carry an SDP over the wire keeps it
    // required — `DirectSignalV1` in
    // `remote-lib-common/src/security/direct-path.ts`, whose guard demands the
    // exact key set.
    pattern: /\b(?:ct|salt|sealed|handshakeHash|key|ciphertext|plaintext|proof|assertion)[ \t]*\?[ \t]*:/g,
    violationFile: 'remote-lib-common/src/security/push-seal.ts',
    violation: '\nexport interface SelftestSeal {\n  readonly ct?: string;\n}\n',
  },
  {
    rule: 'The worker assertion runs in `build:pocket`',
    security: 'the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one',
    kind: 'require',
    file: 'lib/package.json',
    // Anchored inside `build:pocket`, in its worker-checking form: `build:one-time`
    // runs the same script with `--one-time`, which checks a shell and no
    // worker, so a bare match stayed green after `build:pocket` dropped it.
    pattern: /"build:pocket":\s*"[^"]*&& node scripts\/assert-pocket-worker\.mjs"/,
  },
  {
    rule: 'The root build runs the Pocket build, so CI sees a real bundler output',
    security: 'the worker in `lib/src/remote/pocket-app/sw.ts` is the only thing that opens one',
    kind: 'require',
    file: 'package.json',
    // Anchored inside the `build` script, not on the command: `dev:relay`
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

  const specText = (spec) => (existsSync(join(repoRoot, spec)) ? read(spec) : '');

  for (const rule of RULES) {
    // A rule whose spec line is gone is a rule nobody agreed to. Checked first,
    // so a deleted invariant is reported as that rather than as whatever the
    // pattern happens to find.
    const spec = rule.spec ?? SECURITY_SPEC;
    if (!specText(spec).includes(rule.security)) {
      failures.push(
        `${rule.rule}\n    ${spec} no longer says "${rule.security}" — the rule and its prose must move together`,
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
      const hits = (text.match(rule.pattern) ?? []).filter((m) => !rule.allow?.(m, file));
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, checked } = check();
  if (failures.length > 0) {
    console.error(`e2e-lint: the end-to-end boundary no longer holds what ${SECURITY_SPEC} requires\n`);
    for (const failure of failures) console.error(`  ${failure}\n`);
    console.error(
      `Each line above maps to the "Remote Control" section of ${SECURITY_SPEC}, or to the\n` +
        `"Rendezvous boundary" or "Relay boundary" section of ${HOSTED_SECURITY_SPEC}. If a\n` +
        'control moved rather than disappeared, update the rule in scripts/e2e-lint.mjs\n' +
        'in the same commit — and add the self-test case that proves it load-bearing.',
    );
    process.exit(1);
  }
  console.log(`e2e-lint: OK (${RULES.length} rules, ${checked} checks)`);
}
