# Remote Security Model

The trust model for remote control, built on two independent security
primitives between the Client (Dormouse Pocket), Host (Dormouse Terminal), and
coordinating Server:

* **Passkeys verify fresh user presence.** Fresh presence is required by both
  the Server and the Host. A passkey authenticates the user; it never
  independently grants host access.
* **Each Client device completes an explicit one-to-one pairing ceremony with
  each Host.** The Host maintains its own local ACL of approved Clients,
  identified by an asymmetric device keypair generated in the browser and
  stored locally as a non-extractable WebCrypto key.

The separation is what makes account-level compromise insufficient for host
access: the Host rejects any client that has not been locally paired (see
[Security Guarantees](#security-guarantees) for the full list and its one
qualification).

`SECURITY.md` -> "Remote Control" is this model's audited face: it names the
subset of the properties below that are load-bearing enough to be checked
nightly, and states plainly which risks are accepted (the setup password's
minimal hardening) and which gaps are open (revocation, the audit trail).

The primitives — assertion verification, device signatures, challenges, the
ACL, the ceremony — live in `server-lib-common/src/security/`: runtime-agnostic
modules shared verbatim by the Server, the Host module in `lib`, and the Pocket
client, so the three sides cannot disagree on what a valid credential is. The
concrete pairing and connect message sequences live in `docs/specs/server.md`
(Relay); this spec defines what those sequences must establish.

## Goals

Dormouse enables a user to control a Host (Dormouse Terminal) from a Client
(Dormouse Pocket) using only web technologies.

Primary goals:

* No native mobile application required
* Strong protection against account compromise
* Strong protection against newly-added credentials
* Strong protection against server compromise
* Explicit host-controlled authorization
* Long-lived trusted client devices
* Modern passkey-based authentication

Non-goals:

* Defending against a fully compromised browser runtime
* Defending against a compromised operating system
* Preventing users from intentionally clearing browser data
* Providing permanent device identity guarantees across browser resets
* **End-to-end confidentiality from the Server.** The relay terminates TLS and
  forwards cleartext terminal bytes, so whoever operates the Server can read
  every keystroke and every byte of output. Self-hosted ships first precisely
  because that operator is the user. (The PRF-derived session key that would
  change this is in [Future](#future).)
* **Availability.** The shipped self-host deployment is a per-login user agent,
  so the relay is down whenever the machine is (`docs/specs/server.md`).

## Terminology

* **Client (Dormouse Pocket)** — a browser or installed PWA used to initiate
  remote-control sessions. It authenticates with passkeys, maintains a local
  device keypair, and signs Host challenges.
* **Host (Dormouse Terminal)** — the machine being remotely controlled. It
  maintains the local ACL, verifies Client authorization and fresh user
  presence, and establishes/terminates control sessions. **The Host is the
  final authority for access decisions.**
* **Server** — the coordinating service: account management, passkey
  registration, WebAuthn challenge generation, and signaling/rendezvous. The
  Server is not the final authority for Host access. (Revocation today is
  local state editing plus a Host restart — see `docs/specs/server.md`
  Guardrails; Server-pushed revocation propagation is staged in
  [Future](#future).)

## Trust Model

Dormouse separates:

| Layer      | Responsibility             |
| ---------- | -------------------------- |
| Passkey    | Fresh user presence        |
| Device Key | Long-lived client identity |
| Host ACL   | Authorization              |
| Host       | Final access decision      |

**No single layer is sufficient to gain access** — a successful connection
requires all four to agree.

## Passkeys

Passkeys verify fresh user presence: every connection requires a fresh
WebAuthn assertion, validated by **both** the Server and the Host.

Passkeys are frequently *synchronized* credentials — iCloud Keychain, Google
Password Manager, platform authenticators — so a single passkey may appear on
multiple physical devices:

> Passkeys are treated as user credentials, not device identities. A passkey
> authenticates a user account; it grants access to no Host.

**Presence, or verification.** The default demand is the authenticator's
user-*presence* flag. A deployment raises it to user *verification* (biometric
or PIN) with `DORMOUSE_REQUIRE_USER_VERIFICATION=true`; the Server mirrors the
flag into every Host's enrollment response, and the Host copies it into its
`ConnectionPolicy`. **Both verifiers must demand the same thing** — they
evaluate the same assertion, so a Server demanding UV while the Host does not
leaves the weaker verifier deciding, which inverts "the Host is the final
authority". Pocket asks for `userVerification: 'preferred'` either way, so
platform authenticators prompt for biometrics in practice even where neither
side requires it; that is convention, not a guarantee, which is why the flag
exists.

**The Host stores only a hash of each paired passkey's public key.** The Client
presents the full key at connection time and the Host checks it against the
stored hash, so a compromised Server cannot substitute a different passkey; the
Server likewise verifies against its own *stored* key, never against the one
the request carries.

Source of truth: `verifyPasskeyAssertion` / `hashPasskeyPublicKey` in
`server-lib-common/src/security/passkey.ts` — the same assertion verifier runs
on the Server (`Handshake.checkConnect2` in `server/src/handshake.ts`) and the
Host (`authorizeConnection`); `HostEnrollment.requireUserVerification` in
`lib/src/remote/host/enrollment.ts` carries the mirrored flag. Only ES256
(ECDSA P-256 / SHA-256) is accepted, the mandatory-to-implement WebAuthn
algorithm.

## Device Keys

Device keys establish long-lived Client identity — the capability the Host
actually authorizes. This prevents newly-added passkeys from inheriting Host
access, synced passkeys from automatically becoming trusted devices, and
Server-only compromise from granting Host access.

Implementation: each Client generates a non-extractable ECDSA P-256 signing
keypair with WebCrypto (`DEVICE_KEY_ALGORITHM` / `generateDeviceKeyPair` in
`server-lib-common/src/security/deviceKey.ts`). The base64url raw public
point is the Client identifier. Device signatures are domain-separated
(`DEVICE_AUTH_DOMAIN`) so a signed challenge cannot be replayed in another
protocol context. The `CryptoKey` objects are persisted directly in IndexedDB
— never exported — by `getOrCreateDeviceKey` /
`indexedDbDeviceKeyStore` in `lib/src/remote/client/device-key.ts` (the
IndexedDB wrapper is DOM-dependent, so it lives in `lib`, not
`server-lib-common`).

Security properties — strengths: durable across browser restarts and page
reloads, non-extractable through normal browser APIs, fully web-native.
Limitations: active XSS can *use* the key, browser or OS compromise defeats
the model, and clearing browser data destroys the key. Device-key loss is a
recoverable event (see [Device Key Loss](#device-key-loss)).

Sign-in returns the asserted passkey's **public** key, so any browser profile
holding a synced passkey can build pair and connect requests rather than only
the one that registered it. Not a weakening: the key is public, the Host
receives it in every `ConnectionRequest` regardless, and a Client that signs in
has merely asked — it reaches nothing until the Host's local approval adds *its
own device key* to the ACL.

The device key has one use outside connection establishment: a Client signs its
Web Push subscription with it, binding that subscription to the same identity
the Host's ACL records ([server.md](./server.md) -> Web Push). That signature
carries its own domain tag (`PUSH_SUBSCRIBE_DOMAIN` in
`server-lib-common/src/security/push.ts`) rather than `DEVICE_AUTH_DOMAIN`,
because the Server sees Host-issued challenges in transit during `connect` —
sharing one domain would let a challenge captured in one protocol be presented
to the other. **A push subscription authorizes nothing:** it is a delivery
address, and losing or forging one cannot move a Client across the ACL
boundary.

## Host Authorization

Each Host maintains a local authorization list. **The ACL is authoritative**;
the Server cannot unilaterally grant access.

`HostAclRecord` binds the Host and account to one passkey credential and public
key hash, one device public key, approval metadata, and nullable revocation
time. Its canonical schema and behavior live in
`server-lib-common/src/security/acl.ts`; the Host service persists it through
`HostStateStore` — a 0600 file in standalone, `globalState` in VS Code — never
on the Server (`docs/specs/server.md`).

A record authorizes the *pair* of a passkey credential and a device key:
`HostAcl` reports a miss (`passkey-not-paired`, `device-not-paired`,
`pairing-mismatch`) unless both halves match one active record.

Every store reads its records back as `unknown[]`, so `isHostAclRecord` +
`filterAclRecords` (`lib/src/remote/host/acl.ts`) drop anything malformed or
belonging to another `hostId` before it can reach `authorizeConnection`. That
is hygiene, not authorization — every field is attacker-choosable by anything
that can write the store at all; the local approval that minted the record is
the authorization.

## Pairing Ceremony

Pairing establishes trust between one Client and one Host, and local approval
on the Host is the only path that *mints* an ACL record. A newly-added passkey
is *not* automatically trusted — the Client must still complete Host pairing.
(Records can be *carried* rather than minted, by the one-shot `adopt` migration
from builds that kept the Host in webview `localStorage`; that path is bounded
separately — `SECURITY.md` -> "Remote Control".)

What the ceremony establishes, in order:

1. The Client authenticates with a passkey and presents its device public key.
2. The Host displays local approval UI (the pairing modal, same pattern as
   KillConfirm — `docs/specs/server.md`, Host side).
3. The user approves locally on the Host.
4. The Host writes the `HostAclRecord` binding the passkey credential identity
   to the device public key.

The Client is now trusted by that Host and no other.

**The approval is only as good as what the modal lets a human check.** The
ceremony verifies no assertion, so the person at the Host *is* the control —
and every field of a `PairingRequest` is chosen by whoever composed it. The one
checkable field is the device-key fingerprint: the Host's modal and Pocket's
Hosts screen both render `pairingFingerprint` from
`server-lib-common/src/security/pairing.ts` — the same helper on both ends,
precisely so they cannot drift into showing different slices of the same key —
so a substituted or injected request, the thing a compromised Server could
otherwise time to arrive exactly when one is expected, shows the wrong eight
characters. Without that comparison the prompt asks the user to recognize a key
they have never seen. `requestedLabel` and `accountId` are attacker-chosen free
text, reduced by `boundedPairingLabel` / `boundedPairingAccount` before display,
so neither can overflow the dialog or carry bidi overrides that make it read as
something else.

**A setup proof collapses approval to one confirm.** A Host's QR carries two
secrets with two verifiers: the Server's single-use setup token, redeemed at
`/api/setup/*`, and a **setup nonce the Host mints itself**, which travels
laptop screen → phone camera and never through the Server. A phone set up that
way returns `PairingRequest.setupProof` —
`HMAC-SHA256(key = nonce, message = domain || devicePublicKey)` — which the Host
recomputes against each nonce it still holds. Displaying the QR *is* the
local-presence act, so a verified modal names what proved the device rather than
asking the user to vouch for it.

- **Must bind the proof to the key being authorized.** A Server substituting its
  own `devicePublicKey` into a relayed request would need a MAC over that key,
  and so a nonce it has never seen: it relays a key-bound proof and nothing more.
- **Never an error to miss.** Absent, unknown, expired or spent, the pairing
  keeps the fingerprint compare — still the control for every proofless one.
- **Verification does not consume; approval does.** A proof result surfaces
  only while its request and nonce remain current; minting the ACL record
  spends it and re-mirrors other pairings on it as unverified.
- **The webview is told `verified`, never the proof** — `MirroredPairingRequest`
  has no such field.
- **A photographed QR inside its 5-minute window is accepted risk**, bounded by
  display-on-request, the TTL, and single use at approval.

Source of truth: `RemoteHost.#onPair` / `#matchSetupNonce` / `#consumeSetupNonce`
and `server-lib-common/src/security/setup-proof.ts`.

**The Host validates the request's shape itself** (`isPairingRequest`), never
relying on the Server having done so: the Server is not trusted, and an
unvalidated relayed object reaching the approval UI is both a crash surface and
a route to a malformed ACL record.

**Each displayed approval is bound to the ceremony ticket's immutable
`pairingId`.** If a Client replaces its pending request while the old modal or
its click command is still in flight, the Host rejects that stale action; it
never selects a request by mutable `clientId` alone. Source of truth:
`RemoteHostService.#pendingPairing` in `lib/src/host/remote/service.ts` and the
service/webview contract in `lib/src/host/remote/service-protocol.ts`.

**Presence for pairing is server-attested plus Host-approved.** The Server
relays a pairing request only while the session's last server-verified
passkey assertion is within `PAIRING_PRESENCE_WINDOW_MS` (30 seconds; sign-in,
re-auth, and a verified `connect2` all refresh the stamp — `checkPair` /
`checkConnect2` in `server/src/handshake.ts`). A stale session is answered with
`PAIRING_STALE_PRESENCE_ERROR`; the Client re-asserts with one WebAuthn prompt
(`/api/reauth/begin` + `/api/reauth/finish`, refreshing the same session and
relay socket) and retries. The Host does not re-verify an assertion at pairing
time — its stronger control is the mandatory local approval, which connect
lacks (there `authorizeConnection` verifies presence itself). Under Server
compromise, a forged freshness stamp gets an attacker no further than the
human staring at the approval modal.

**Pending pairings are bounded.** A `pair` frame allocates in three places —
the ceremony's ticket map, the Host's per-`clientId` client map, and the
service's queue mirrored to the webview — under a `clientId` the relay chooses,
and only a `client-gone` removes one. All three are capped
(`MAX_PENDING_TICKETS`, `MAX_PENDING_PAIRINGS`), oldest evicted first, because
anything that can sign in can send these and a queue that only grows wedges the
process that owns every PTY. The controller answers its own eviction with a
`pair-result` denial and drops the whole client *record*, not just the request
it held — clearing the payload while keeping the map slot would bound only what
`PAIRING_FIELD_LIMIT` already bounds and leave the relay-chosen key, which is
why `MAX_CLIENT_ID_LENGTH` also caps `clientId` at the frame boundary, before
any map is touched.

That bounds the *pairing* path only. `connect` creates a client entry by
another route (`#resetAuthorization`); those carry no pending request, and the
pairing counter neither sees nor evicts them, since dropping an entry that may
be `established` is a different act from denying a pending request. They are
cleared wholesale when the relay socket drops.

Source of truth: `PairingRequest` / `PairingTicket` / `PairingCeremony` /
`PAIRING_PRESENCE_WINDOW_MS` / `PAIRING_FIELD_LIMIT` / `MAX_PENDING_PAIRINGS`
in `server-lib-common/src/security/pairing.ts`, and `MAX_CLIENT_ID_LENGTH` /
`RemoteHost.#evictOldestPairingIfFull` in
`lib/src/remote/host/remote-host.ts`
(tickets are single-use with a `DEFAULT_PAIRING_TTL_MS` = 5-minute TTL;
approval after expiry fails without touching the ACL — the presence window
gates the *request*, not the approver's deliberation). The wire sequence —
who relays what — is the pairing diagram in `docs/specs/server.md`.

## Connection Establishment

A connection succeeds only if **all** of the following hold:

1. The passkey proves fresh user presence.
2. The Server recognizes the account.
3. The Host recognizes the passkey credential.
4. The Host recognizes the device key.
5. The Client signs a fresh Host challenge with its device key.

The Host makes the final decision — `authorizeConnection` in
`server-lib-common/src/security/connection.ts` evaluates the assertion, the
device signature, and the ACL against the Host's `ConnectionPolicy`
(origin/rpId/UV), and returns a `ConnectionDecision` regardless of what the
Server claims to have already checked. It never short-circuits: every layer is
evaluated and every failure is reported.

Host challenges are 32-byte, single-use, TTL-bounded values from
`HostChallengeIssuer` (`server-lib-common/src/security/challenge.ts`, default
2-minute TTL). `authorizeConnection` consumes the challenge *before* any other
work, so it can never be presented twice whatever the rest of the decision
does. Minting one also reclaims the expired challenges ahead of it, so a flow
that mints before it can authenticate the caller — `POST /api/signin/begin` —
retains only what a caller can mint inside one TTL window, rather than
accumulating for the process's lifetime.

**Every new `connect` / `connect2` closes that Client's established message
gate** and disposes its prior control session before this evaluation, and only
the newest evaluation may re-open that gate: each attempt carries an
authorization generation, and one superseded while it awaited verification sends
no decision at all — otherwise an older `allowed` landing last would re-open the
gate its successor had just closed. A structurally malformed request from the
relay is contained as a denied decision rather than an async failure in the Node
Host process. Source of truth: `RemoteHost.#onConnect` / `RemoteHost.#onConnect2`
in `lib/src/remote/host/remote-host.ts`.

One host challenge feeds both the passkey assertion and the device-key
signature, so connecting costs the user a single biometric prompt per
connection. The concrete sequence is the connect diagram in
`docs/specs/server.md`.

## Storage Durability

The device key lives in browser-managed storage, and durability differs by
platform:

* **iOS browser tab** — weakest; storage may be evicted after inactivity.
  **Never treat it as permanent.**
* **Android browser tab** — generally durable.
* **Installed PWA** — the preferred mode on both, strongest on Android.

Today Pocket generates the device key at boot, in whatever context it runs —
the install advice on the auth screen ([pocket-app.md](./pocket-app.md))
precedes only the passkey; storage-persistence hardening is staged
(see [Future](#future)). Eviction is recoverable, not catastrophic: see
[Device Key Loss](#device-key-loss).

## Device Key Loss

Device-key loss is expected — browser reset, site-data clearing, device
replacement, PWA removal. Recovery is a re-run of the normal flows:

1. User authenticates with a passkey.
2. Client generates a new device key.
3. Host performs a new pairing ceremony.
4. The previous device key's record may be revoked (`revokedAt`).

No security compromise occurs: the lost key authorized nothing without its
paired passkey, and the new key starts unauthorized everywhere.

## Security Guarantees

Each property below is established in its own section above; this is the
enumeration the section heading promises — the checklist an auditor or a
change reviewer verifies against:

* Adding a new passkey does not grant Host access.
* Compromising the Server does not let it *create* an authorized Client.
* Passkey synchronization does not automatically create trusted Clients.
* Every trusted Client must be explicitly paired with every Host.
* Every connection requires fresh user presence.
* Every access decision is ultimately made by the Host.

**Server compromise cannot create an authorized Client, but it can act through
an authorized session already open.** After a decision the Host gates `msg` frames on
`established` for a `clientId` the relay itself minted, and there is no
per-frame authentication, so a compromised Server can fabricate frames on a
session an authorized Client already has open — reaching `terminal.write`,
which is keystroke injection into a live PTY — as well as suppress or rewrite
frames in either direction. That follows from the relay being a dumb pipe with
no end-to-end authentication (see Non-goals); the PRF-derived session key in
[Future](#future) is what would close it.

## Future

Onboarding changes with security surface are staged in the
**selfhost-onboarding** scope ([server.md](./server.md) `## Future`).

**Scope: e2e-client-host** — replace the Server-readable pairing, connection,
terminal, and push paths with one mandatory end-to-end protocol. The Server
keeps account authentication, Host discovery, routing, availability, and Web
Push delivery, and never receives Client or Host identity keys, Host labels,
remote API messages, terminal data, pairing decisions, or notification contents
in plaintext. **No feature flag, negotiation, plaintext fallback, or
compatibility path**: existing Hosts re-enroll, existing Pocket identities
reset, and every Client pairs again from a fresh Host QR — this is pre-launch,
so reset-and-re-pair beats any migration reader. This spec owns the trust model
(the subsections below); [server.md](./server.md) `## Future` owns the QR
grammar, relay envelope, routes, and state files; [pocket-app.md](./pocket-app.md)
`## Future` owns the phone flows and the worker build; [remote-api.md](./remote-api.md)
and [alert.md](./alert.md) each carry one pointer item. Trusted endpoints: the
distributed Host binaries and the exact served Pocket artifact — a compromised
device, XSS, or an operator serving modified Pocket code is out of scope, as is
availability (the Server may drop, delay, reorder, or refuse traffic, but must
gain no plaintext and no authorization by doing so).

Staged order, grouped into three stacked PRs. Every stage lands as a green
commit with its specs promoted above the fold, then a `/simplify` pass and a
code review on that stage; no stage introduces a runtime selector, a dual ACL
shape, temporary key distribution, or fallback machinery.

1. **Noise suite and vectors** (infrastructure PR). Implement only
   `Noise_IK_25519_ChaChaPoly_SHA256` in `server-lib-common`, pin
   `@noble/ciphers` exactly and record its release-versus-audit review, and
   prove byte-for-byte conformance against the vendored Cacophony vector.
   Production remote paths do not consume it yet.
2. **Additive identities and storage.** The X25519 capability probe (not yet
   enforced); a Host Noise static minted at enrollment and carried as optional
   enrollment fields; the Pocket IndexedDB v2 stores (`known-hosts`,
   `pending-deletions`) beside the legacy `device-key` store; the presence
   challenge builder. No legacy store deleted, no v1 state rejected, no
   ceremony or relay reader switched.
3. **Relay-integrated Noise harness.** The `e2e` relay envelope accepted by the
   Server additively and driven end to end through the real relay in
   integration tests only, with both parties' statics injected. Proves
   prologue/transcript binding, directional cipher states, counters, framing,
   teardown, relay opacity, and tamper rejection before any ceremony changes.
4. **Atomic pairing, connection, and push re-keying cutover** (cutover PR).
   The positional QR grammar and parser, native-camera bootstrap, in-app
   scanner plus paste, pairing IK against the invitation key, the presence
   proof, reverse two-digit confirmation, `PairingOutcomeV1`, Host-static
   pinning, connection IK, presence-binding reauth variants,
   `ConnectionOutcomeV1`, the one-record ACL conjunction, and push re-keyed by
   `deliveryId` with plaintext payloads — all in one landing. Enforces the
   capability gate; deletes the `device-key` store, the `:paired:` markers,
   `adopt`, `pair`, `pair-status`, `connect`, `connect2`, `msg`, setup proofs,
   `verified`, the fingerprint compare, Server-issued decisions, the push
   challenge and device signature, the `setup-token-redeemed` frame, and every
   related type, fixture, and UI state. Carries the per-client one-pending
   rule, the handshake cap, and the frame size caps from **Host bounds** so the
   Host is never less bounded than today.
5. **Bounds and flood harness.** The remaining **Host bounds**: the crypto
   token bucket, the established-session cap, keepalives, the idle reaper, and
   lifecycle disposal, with instrumentation proving pre-bound rejection
   performs no crypto and allocates nothing, and a malicious-relay harness.
6. **Sealed push and the built worker** (push PR). The domain-separated push
   construction, the TypeScript service-worker source and its classic-IIFE
   build, Pocket's durable deletion queue and retry triggers, and
   provider-failure and parent-deletion cleanup.
7. **Documentation and enforcement.** The rationale split, deletion of
   superseded prose, the `SECURITY.md` `FAIL IF` rewrite, the E2E structural
   lint with its load-bearing selftest, and the nightly application-security
   prompt extended to the new boundary. Stages 1–6 still update every spec they
   change; this stage consolidates structure and enforcement.

Final acceptance: `pnpm test`, `pnpm build`, the Pocket and worker production
builds, the recorded audit review, and a passing local application-security
audit. An independent cryptographic review of the Noise integration, the
WebAuthn channel binding, key storage, and the push construction is required
before paid SaaS may claim this model.

### Cryptographic suite

- **Exactly one suite: `Noise_IK_25519_ChaChaPoly_SHA256`, implemented as
  Noise revision 34.** No generic pattern API, cipher negotiation, AES or P-256
  fallback, or protocol-name override. Exact `HandshakeState`,
  `SymmetricState`, and `CipherState` transitions, `MixHash`/`MixKey`/`Split`,
  16-byte tags, the 96-bit nonce `00000000 || little_endian_u64(n)`, handshake
  messages capped at 65,535 bytes, and Noise's HMAC-based HKDF — never
  WebCrypto HKDF.
- **X25519 stays WebCrypto-only** (`generateKey`/`deriveBits`/`importKey`), so
  Pocket's long-term private keys are nonextractable `CryptoKey`s IndexedDB
  stores without exposing bytes to JavaScript; never a JavaScript curve. An
  X25519 rejection or an all-zero shared secret is one terminal handshake
  failure. SHA-256 and HMAC are WebCrypto. ChaChaPoly is the audited
  `chacha20poly1305` from an exactly pinned `@noble/ciphers` release, bundled
  because no interoperable WebCrypto ChaChaPoly exists and traffic keys are
  already in memory; one implementation in Pocket, the worker, and both Host
  runtimes.
- **Conformance is proven against an independent implementation.** The
  Cacophony vector for this suite is vendored under `server-lib-common` test
  fixtures with attribution, alongside the RFC 7748 X25519 and RFC 8439 AEAD
  vectors; the only test hook is ephemeral-key injection. No helper may reuse
  the production state machine to generate expected values.
- **Prologues are canonical and length-prefixed** (`lengthPrefixedConcat`):
  pairing binds the E2E version, ceremony kind `pairing`, `hostId`, and every
  invitation field including the setup token; connection binds the version,
  kind `connection`, `hostId`, and the connection ID. Application
  authentication binds to Noise's final handshake hash — no parallel
  transcript, exporter, KDF, or nonce scheme. Sessions use only the two
  `CipherState`s from `Split`, each from nonce zero, with empty associated data;
  routing metadata is never authenticated application content. **No rekey**:
  sessions are idle-bounded, not long-lived.
- **Any failure ends the session**: authentication or decryption failure,
  replay, gap, reordering, version mismatch, or counter exhaustion. Relay
  errors stay generic availability errors and never trigger a fallback.
- **Runtimes are gated, not degraded.** Pocket and both Hosts probe X25519
  before sign-in, setup, pairing, connection, or Host start; failure shows a
  fixed upgrade requirement and performs no remote operation. Evidence
  (browser and Node versions, dated) lives in the rationale file; two items
  must be verified on a real iOS device before stage 4 lands: an X25519
  `CryptoKey` survives a structured clone into IndexedDB, and `getUserMedia`
  works inside a Home Screen web app.

### Identities and storage

- **Host static.** One permanent X25519 keypair minted locally at enrollment;
  the private half persists as PKCS#8 only in the owner-only Host state file or
  VS Code `SecretStorage`, imported nonextractably at start. The Server never
  receives it. The enrollment record requires both halves; a record without
  them reads as un-enrolled and the Settings dialog offers enrollment again —
  that shape check is the entire Host-state version.
- **Client static, per Host.** A fresh X25519 keypair generated at scan time
  and persisted, nonextractable, in that Host's `KnownHostV1` record only after
  approval. It replaces the device key as the browser half of the ACL identity
  and does not replace or weaken the passkey half; different Hosts never share
  a Client key.
- **`KnownHostV1`** (IndexedDB, keyed by `hostId`): paired `accountId`, local
  label, pinned Host static public key, the Client static keypair, the paired
  `passkeyCredentialId` and `passkeyPublicKeyHash`, and an authorization state
  of `{ state: 'paired', deliveryId, approvedAt }` or
  `{ state: 'pairing-required' }`. The credential ID is the sole
  `allowCredentials` entry for that Host. `navigator.storage.persist()` is
  requested before the first write. An authenticated `pairing-required`
  outcome removes local authorization without discarding the pin and never
  falls back to an unpaired path; do not call this revocation while
  `revokeDevice` / `revokePasskey` have no callers.
- **`PendingDeliveryDeletionV1`** (IndexedDB): `{ hostId, deliveryId }`
  tombstones written *before* a `KnownHostV1` forgets a delivery ID, cleared
  only by a successful deletion ([alert.md](./alert.md) `## Future`).
- **The Server session is authentication-plane only.** The bearer token stays
  memory-only with its existing absolute 12-hour life and is never reusable
  proof of presence for a Host. There is no app-session signing key: the token
  is memory-only and TLS covers transit, so a second key would answer no
  threat in scope.

### Presence proofs

Both ceremonies prove fresh user presence the same way, so pairing and
connection share one verifier.

- **The WebAuthn challenge is derived, not random.** `POST /api/reauth/begin`
  takes a required, kind-tagged `PresenceBinding` — `pairing`:
  `{ hostId, handshakeHash, passkeyCredentialId }`; `connection`:
  `{ hostId, connectionId, hostChallenge, handshakeHash, passkeyCredentialId }`
  — mints a one-use Server nonce, and answers the challenge
  `SHA-256(lengthPrefixedConcat(domain, kind, fields in declared order,
  serverNonce))` under `dormouse/presence/v1`, the RP ID, the nonce, and the
  named credential as the sole `allowCredentials` entry. `finish` consumes the
  nonce, recomputes the challenge, verifies the assertion against the stored
  key for that exact credential, and extends nothing. The Server learns only
  routing values and the handshake hash, which the relay already sees.
- **`PresenceProofV1`** carries the binding, the Server nonce, `accountId`,
  `passkeyCredentialId`, the canonical SPKI public key, and the assertion. It
  travels only inside the first Client→Host Noise transport payload. The Host
  recomputes the challenge with the same shared builder, checks every binding
  field against its own pending state (its `hostId`, the final handshake hash,
  and for connection its challenge and connection ID), verifies RP ID, origin,
  presence/verification policy, and signature against the presented key, and
  hashes that key for the ACL. A Server success flag is never evidence.
- **Every proof is fresh and single-use.** A dropped transport, a consumed
  challenge, a failed handshake, or a later attempt requires a new handshake,
  Host challenge, Server nonce, and authenticator operation. This replaces the
  30-second pairing-presence window and the stale-presence retry entirely: a
  pairing costs one WebAuthn prompt after sign-in, which is the price of the
  Host verifying freshness itself.
- **The Server is a hard online dependency for every new session.** `Split`
  authenticates a channel but authorizes nothing; without `begin`/`finish` the
  pending channel times out and is destroyed. A future WebRTC data path
  replaces only the relay transport after authorization and inherits this.

### Pairing

- **The invitation is Host memory.** `setupQr` mints the Server's setup token
  and, locally, a 16-byte invitation ID plus a one-use X25519 invitation
  keypair, bounded by the eight-invitation cap, expiring on the pairing TTL.
  The QR carries `hostId`, invitation ID, expiry, setup token, and invitation
  public key ([server.md](./server.md) `## Future` owns the grammar) and
  deliberately omits the Host's long-term static, its label, and any
  signature: a first-time Client has no key to check a signature with, and
  the IK responder proves possession of the scanned key.
- **Invitation lifecycle, Host-owned.** `live` until a valid Noise message 1
  decrypts against it (`reserved`), then consumed by the terminal outcome, or
  expired by TTL. Each invitation accepts one request. The QR panel renders
  that state and offers a new code; token redemption at the Server no longer
  flips anything, so the `setup-token-redeemed` frame is deleted. A signed-in
  phone that scans first retires the token through `POST /api/setup/retire`
  so a photographed code cannot register a passkey afterwards; a phone that
  registered with the token in this run skips that call.
- **IK against the invitation key.** Client initiator, fresh per-Host static
  as `s`, invitation public key as `rs`: `-> e, es, s, ss`; `<- e, ee, se`.
  Both handshake payloads are empty. `Split` yields the pairing channel; no
  ACL, delivery ID, or resumable state exists yet.
- **Reverse two-digit confirmation.** Pocket samples a uniform code `00`–`99`
  (rejection sampling), displays it, and sends it with its `PresenceProofV1`
  and sanitized device label in the first transport payload, a fixed-size
  control message. After the proof verifies, the Host opens a modal with the
  label, an empty two-digit input, and the copy: *Only authorize if your
  phone is showing a two-digit code. If it shows an error or no code, cancel
  this request.* The service holds the expected code and never displays,
  mirrors, or retransmits it; the webview echoes the typed digits with the
  immutable pairing ID. Compare without early exit; **exactly one attempt**.
  A mismatch, denial, timeout (pairing TTL), replacement, malformed input, or
  failed proof consumes the invitation, destroys handshake material, and
  returns the encrypted denial.
- **Approval writes one record, then answers.** On match the Host durably
  writes one active `HostAclRecord` binding `hostId`, `accountId`,
  `passkeyCredentialId`, `passkeyPublicKeyHash`, the Client static public key,
  and a fresh 256-bit `deliveryId`, then sends `PairingOutcomeV1` — success
  carries the Host static public key, local Host label, the paired passkey
  identifiers and hash, and the `deliveryId`; denial carries only
  `user-denied`, `confirmation-mismatch`, `presence-rejected`,
  `invitation-expired`, `superseded`, or `host-error`. Both use the same
  fixed padded control message. Pocket verifies the passkey fields match its
  ceremony, compares the Host static to any existing pin for that `hostId` —
  a mismatch is a terminal security error that keeps the old pin and requires
  a re-enrolled Host with a new ID — and only then stores the record. Pocket
  maps codes to fixed copy and never renders Host- or relay-supplied text.

### Connection

- **IK against the pinned Host static.** Fresh 16-byte connection ID; Client
  initiator with its paired per-Host static, `rs` the pin; message 2 payload
  is a fresh 32-byte Host challenge (`HostChallengeIssuer`, 2-minute TTL).
  Completing Noise proves both statics and authorizes nothing.
- **Authorization = proof ∧ conjunction ∧ capacity.** The Host consumes the
  challenge, verifies `PresenceProofV1`, then requires one active
  `HostAclRecord` holding all four of `accountId`, `passkeyCredentialId`,
  `passkeyPublicKeyHash`, and the IK-authenticated Client static public key.
  Halves on different records are `pairing-mismatch`, not authorization; a
  passkey added to the account after pairing grants nothing until a new local
  approval. Then `ConnectionOutcomeV1`: success carries the Host label; denial
  carries only `pairing-required`, `presence-rejected`, `protocol-rejected`,
  `host-busy`, or `host-error`. Individual ACL, passkey, DH, or transcript
  failures are logged owner-locally, never returned. Success promotes the two
  `CipherState`s into the established session; every terminal decision sends
  exactly one outcome and clears pending state; failures before `Split` yield
  only a generic outer error.
- **Pocket accepts an outcome only after decrypting it** on the cipher state
  for the expected handshake hash. On `pairing-required` it enqueues the old
  `{ hostId, deliveryId }` tombstone, moves the record to `pairing-required`,
  drops local push authorization, closes, and shows *Scan this Host's QR to
  pair again*. Other denials use fixed retry, sign-in, or error copy. Timers
  expiring without an authenticated outcome report unavailable, never denial.
- **Protocol-v1 rides inside.** Remote API requests, responses, events, and
  terminal bytes are serialized as length-prefixed application messages in a
  byte stream carried by Noise transport messages, reassembled up to 1 MiB.
  [remote-api.md](./remote-api.md) states this; nothing in protocol-v1 changes.

### Host bounds

Every bound is Host-enforced and independent of the relay; Server-side gates
are defense in depth only, and Host correctness must survive a relay that
omits `client-gone`, invents client IDs, or reorders frames.

- Keep `MAX_PENDING_PAIRINGS = 8`, `MAX_CLIENT_ID_LENGTH = 256`, and the
  eight-invitation cap. Add `MAX_PENDING_CONNECTION_HANDSHAKES = 8`,
  `MAX_ESTABLISHED_E2E_SESSIONS = 16`, `E2E_KEEPALIVE_INTERVAL_MS = 30_000`,
  `ESTABLISHED_E2E_IDLE_TIMEOUT_MS = 120_000`.
- At most one pending pairing and one pending connection per relay client; a
  replacement disposes its predecessor. Pending pairings expire on the pairing
  TTL (a human is typing); pending connections on the challenge TTL.
- The pending cap and the token bucket (eight-operation burst, one per second
  sustained, on accepted `init` frames) stay active at the established cap,
  since message 1 must decrypt before the Host knows whether this replaces an
  existing session. The established cap is checked at promotion: a Client
  static that already holds a session replaces it atomically after presence
  succeeds; a different identity at the cap receives `host-busy` and evicts
  nothing.
- An established session expires after 120 s without a successfully
  decrypted Client→Host message. `lastClientActivityAt` is set at promotion
  and refreshed only by successful decryption — never by Host output, bad
  ciphertext, relay envelopes, WebSocket pings, or unauthenticated traffic.
  Pocket sends a fixed-size encrypted keepalive every 30 s while visible;
  background suspension may therefore expire the session, and returning costs
  a new handshake and fresh WebAuthn rather than resumed cipher state.
- One reaper over absolute timestamps runs on every init, completion, relay
  lifecycle event, and next-expiry timer. Every expiry or outcome disposes
  remote-control attachments without killing terminal sessions, erases Noise
  state, keys, and buffers, and removes the entry before accepting
  replacement work. `client-gone` disposes that client's state immediately;
  closure or replacement of the Host's own relay socket disposes everything
  before reconnecting.
- Every handshake message is capped at 65,535 bytes and application payloads
  at 1 MiB, measured before JSON parsing or base64 decoding; every routing
  ID, key, ciphertext, signature, label, and chunk count is bounded. Rejected
  frames perform no WebCrypto operation and allocate no entry. A message is
  processed only for its exact pending ID and expected step; established
  frames only for an existing session at its exact next nonce; unknown IDs
  and pre-authorization application data are dropped without decryption, and
  the first invalid ciphertext destroys its session.

### Push sealing

- **The Host seals every notification field.** `ss = X25519(hostStatic,
  clientStatic)`, a random 32-byte salt, `key = HKDF-SHA-256(ss, salt,
  "dormouse/push/v1", 32)`, ChaCha20-Poly1305 under the all-zero 96-bit nonce
  exactly once per key. The sealed envelope carries `hostId`, the salt, and
  the ciphertext; the Server forwards it to the named `deliveryId`s and reads
  nothing. A separate, domain-separated construction — never a Noise
  `CipherState`.
- **Delivery IDs are opaque bearer capabilities**, minted by the Host at
  approval and known only to the Host record and the Client's `KnownHostV1`.
  Possession is what authorizes registering, querying, and deleting a
  subscription row; the Server never lists them to a session
  ([server.md](./server.md) `## Future`). They decouple Server state from the
  ACL identity key and are not an anonymity mechanism.
- **The worker decrypts at the sink**, loading the pinned record for the
  envelope's `hostId`, deriving the same key, re-validating and sanitizing
  the plaintext, and showing a generic content-free notification on any
  failure ([pocket-app.md](./pocket-app.md) `## Future` owns its build).

### Residual metadata

The Server still observes account and passkey authentication data, IPs, Host
IDs and online state, routing relationships, every session's reauth exchange,
push endpoints, timing, ciphertext sizes, and volume. Without batching or
cover traffic, Client→Host ciphertext timing exposes inter-keystroke timing;
that leak is accepted while keystroke values stay encrypted. One worker scope
has one `PushSubscription`, so a shared endpoint lets the Server correlate
every `deliveryId` one Pocket profile registers across Hosts. No
traffic-analysis resistance, per-Host unlinkability, or metadata-anonymity is
claimed.

### Documentation rules for the scope

- **No new spec.** Noise is the trust model and lands here; `server.md` owns
  syntax and routes, `pocket-app.md` the phone, `remote-api.md` one sentence,
  `alert.md` push behavior with a pointer here, `SELF_HOST.md` operator
  recovery, and `docs/stories/pairing.mdx` the narrative. `standalone.md` and
  `vscode.md` lose their `adopt` mentions. `SECURITY.md` is rewritten in the
  stage that changes each claim, not deferred to stage 7.
- **Create `remote-security-model.rationale.md` before adding Noise detail
  above the fold**, moving the sign-in public-key argument, the
  `PUSH_SUBSCRIBE_DOMAIN` separation, the per-Host pairing-cap reasoning, the
  storage-durability platform narrative, and the dated WebCrypto-X25519 versus
  bundled-ChaChaPoly evidence under headings that exist here. Delete rather
  than soften: the PRF item below, the end-to-end-confidentiality non-goal,
  the "Server compromise can act through an open session" paragraph, the
  setup-proof subsection and `verified`, the fingerprint paragraph, and the
  Device Keys section; replace the presence-window paragraphs in place.
- Target about 4,450 words for this spec after promotion with a 4,800 budget;
  raise touched budgets deliberately in the same PR, and if this spec exceeds
  roughly 7,000 words after the split, stop and reconsider the single-file
  design.

### Revocation propagation

The Server pushing revocations to Hosts. Today `HostAcl.revokeDevice` /
`revokePasskey` exist but have no callers, and no relay frame carries a
revocation — revoking is hand-editing state (`docs/specs/server.md`,
Guardrails). Note what that costs an operator: `RemoteHostService.#startHost`
reads the store once and hands the `RemoteHost` a snapshot for its whole
lifetime, so an edited record is not observed until the Host is restarted.
Restarting is therefore the entire lever — it reloads the ACL *and*, by
dropping the relay socket, ends every established session. Editing alone
changes nothing that is running.

### WebAuthn PRF

Superseded by the **e2e-client-host** scope, which derives no key from PRF; the
shipped system relies only on standard WebAuthn assertions. Delete this
subsection when stage 4 lands.
