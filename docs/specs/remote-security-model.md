# Remote Security Model

The trust model for remote control: three primitives between the Client
(Dormouse Pocket), Host (Dormouse Terminal), and coordinating Server.

* **One end-to-end channel per ceremony** — pairing and connection each run a
  Noise IK handshake whose two `CipherState`s carry everything after it, and the
  Server routes that ciphertext without reading it.
* **Passkeys prove fresh user presence** inside that channel, over a challenge
  derived from the handshake itself. A passkey authenticates the user; it grants
  access to no Host.
* **Each Client pairs explicitly, one-to-one, with each Host** — the Host keeps
  its own local ACL of approved Clients, each identified by a per-Host X25519
  static generated in the browser and stored non-extractably.

Account compromise is therefore insufficient for host access
([Security Guarantees](#security-guarantees)). `docs/specs/security-remote.md` -> "Remote Control"
is this model's audited face — the properties checked nightly and the gaps left
open (revocation, the audit trail).

**Every primitive here lives in `server-lib-common/src/security/`**, shared
verbatim by Server, Host, and Pocket so the three cannot disagree on what a
valid credential is. Message sequences are [server.md](./server.md) (Relay);
this spec defines what they must establish. Evidence:
[remote-security-model.rationale.md](./remote-security-model.rationale.md).

## Goals

Primary: no native mobile application; strong protection against account
compromise, newly-added credentials, and server compromise, including
confidentiality of everything the two endpoints say to each other; explicit
host-controlled authorization; long-lived trusted client devices; passkeys.

Non-goals: a compromised browser runtime or operating system; a user
intentionally clearing browser data; permanent device identity across browser
resets; **availability** — the relay is down whenever the machine is (a
per-login user agent), and the Server is a hard online dependency for every new
session ([server.md](./server.md)); **traffic analysis**
([Residual metadata](#residual-metadata)).

## Terminology

* **Client (Dormouse Pocket)** — a browser or installed PWA; authenticates with
  passkeys, holds one X25519 static per paired Host.
* **Host (Dormouse Terminal)** — the machine being controlled. **The Host is
  the final authority for access decisions.**
* **Server** — coordination only: accounts, passkey registration,
  presence-challenge minting, routing. It cannot read what it routes and is not
  the final authority for Host access. Revocation today is local editing plus a
  Host restart ([server.md](./server.md) Guardrails); propagation is staged in
  [Future](#future).

## Trust Model

| Layer         | Responsibility                        |
| ------------- | ------------------------------------- |
| Noise channel | Confidentiality and peer authenticity |
| Passkey       | Fresh user presence                   |
| Client static | Long-lived client identity            |
| Host ACL      | Authorization                         |
| Host          | Final access decision                 |

**No single layer is sufficient** — a connection requires all of them to agree.

**Exactly two endpoints are trusted: the distributed Host binaries and the exact
served Pocket artifact** — an operator serving modified Pocket code is outside
the model, as is XSS in the Pocket origin. **The Server is trusted with
nothing**: it may drop, delay, reorder, or refuse traffic, and must gain no
plaintext and no authorization by doing so.

## Passkeys

Every pairing and every connection carries one WebAuthn assertion, verified by
the Host inside the encrypted channel.

> **Passkeys are user credentials, not device identities** — synchronization
> puts one passkey on many physical devices and changes nothing here
> (rationale).

**Presence, or verification.** The default demand is the authenticator's
user-*presence* flag; `DORMOUSE_REQUIRE_USER_VERIFICATION=true` raises it to user
*verification*, mirrored by the Server into every Host's enrollment response and
copied by the Host into its policy. **Both verifiers must demand the same thing**
(rationale). Pocket asks `userVerification: 'preferred'` either way, so platform
authenticators prompt for biometrics in practice — convention, not a guarantee.

**The Host stores only a hash of each paired passkey's public key**, checked
against the full key presented inside the channel, so a compromised Server
cannot substitute a passkey. **The Server likewise verifies against its own
*stored* key**, never one a request carries. **Only ES256 (ECDSA P-256 /
SHA-256) is accepted**, the mandatory-to-implement WebAuthn algorithm.

Source of truth: `verifyPasskeyAssertion` / `hashPasskeyPublicKey` in
`server-lib-common/src/security/passkey.ts`;
`HostEnrollment.requireUserVerification` in `lib/src/remote/host/enrollment.ts`.

## Client statics

A Client static is long-lived Client identity — the capability the Host actually
authorizes.

**One X25519 keypair per Host, generated at scan time** (rationale), persisted
non-extractably in that Host's local record only after the Host approves, never
shared between Hosts. The raw 32-byte public half, base64url, is the Client
identifier on the ACL; **Noise IK proves possession of the private half**
(rationale).

It is durable across restarts and non-extractable through normal browser APIs,
but **active XSS can *use* it**, browser or OS compromise defeats the model, and
clearing browser data destroys it ([Client static loss](#client-static-loss)).

Source of truth: `generateNoiseKeyPair` in
`server-lib-common/src/security/noise.ts`; what Pocket stores is
[pocket-app.md](./pocket-app.md).

## Host Authorization

**The ACL is authoritative**; the Server cannot unilaterally grant access.

`HostAclRecord` binds the Host and account to one passkey credential and public
key hash, one Client static public key, a fresh 256-bit `deliveryId`, approval
metadata, and a nullable revocation time. Persisted through `HostStateStore` — a
0600 file in standalone, `globalState` in VS Code — **never on the Server**
([server.md](./server.md)).

**Authorization is the conjunction, on one record.** `HostAcl.authorize`
reports a miss (`passkey-not-paired`, `client-not-paired`, `pairing-mismatch`)
unless the passkey credential and the Client static match the *same* active
record. Halves on different records are not authorization, and a passkey added
to the account after pairing grants nothing until a new local approval.

**The two E2E fields are checked for exact length on read, and that is the whole
of the Host-ACL version**: `isHostAclRecord` + `filterAclRecords` drop anything
malformed, pre-cutover, or belonging to another `hostId` before it reaches the
conjunction, and **there is no migration reader** — such a Host reads an empty
ACL and every phone pairs again. Hygiene, not authorization (rationale).

**Delivery IDs are opaque bearer capabilities**, minted by the Host at approval
and held only by the record and the Client's own pinned copy. **Possession is
the whole authorization** for registering, querying, and deleting a push
subscription, so the Server never lists one to a session
([server.md](./server.md) -> Web Push). They are not an anonymity mechanism
(rationale).

Source of truth: `server-lib-common/src/security/acl.ts` (the schema and
`HostAcl.authorize`), `lib/src/remote/host/acl.ts` (the read filter).

## Presence proofs

One verifier serves both ceremonies.

- **The WebAuthn challenge is derived, not random.**
  `presenceChallenge(binding, serverNonce)` is base64url
  `SHA-256(lengthPrefixedConcat(domain, kind, binding fields in declared order,
  serverNonce))` under `dormouse/presence/v1`. **One encoding rule: a base64url
  field is hashed as the bytes it encodes and everything else as UTF-8** —
  decoded are `connectionId`, `hostChallenge`, `handshakeHash`, and the nonce;
  text are the domain, the kind, `hostId`, and `passkeyCredentialId`. Server
  mints, Host recomputes, one builder. `isPresenceBinding` takes **exactly one
  kind's fields, each bounded** — anything the challenge does not cover must not
  reach the Host inside a verified binding.
- **`POST /api/reauth/begin` takes a required, kind-tagged binding** and answers
  the derived challenge over a one-use Server nonce ([server.md](./server.md)
  owns both routes). **No binding, or no nonce to `finish`, is a 400**
  (rationale). `finish` consumes the nonce, recomputes the challenge, verifies
  the assertion against the **stored** key for that exact credential, and
  **extends nothing** — not the session's life, not the relay socket.
- **`PresenceProofV1` travels only inside the first Client→Host transport
  payload**, carrying the binding, the Server nonce, `accountId`, the passkey
  credential id, its canonical SPKI public key, and the assertion. The Host
  recomputes the challenge with the same builder, requires **every binding field
  to equal what it built from its own state**, verifies RP ID, origin,
  presence/verification policy, and signature against the *presented* key, and
  hashes that key for the ACL. **A Server success flag is never evidence**, and
  **the verifier never throws** — a rejection is an ordinary denial (rationale).
- **Every proof is fresh and single-use**: any restart — dropped transport,
  consumed challenge, failed handshake, later attempt — needs a new handshake,
  Host challenge, Server nonce, and authenticator operation; one prompt per
  pairing or connection, three on a self-hosted first run (rationale).
- **The Server session is authentication-plane only.** Its bearer token
  ([server.md](./server.md)) is never reusable proof of presence for a Host, and
  **has no app-session signing key beside it** (rationale).

Source of truth: `presenceChallenge` / `isPresenceBinding` in
`server-lib-common/src/security/presence.ts`, `verifyPresenceProof` in
`server-lib-common/src/security/e2e-ceremony.ts`, `server/src/app.ts`.

## Pairing

**Local confirmation on the Host is the only path that mints an ACL record.** A
newly-added passkey is not automatically trusted; its Client must still pair.

- **The invitation is Host memory.** `setupQr` mints the Server's setup token
  and, locally, a 16-byte invitation id plus a one-use X25519 invitation
  keypair, bounded by the eight-invitation cap and expiring on the pairing TTL.
  The QR carries `hostId`, invitation id, expiry, setup token, and invitation
  public key ([server.md](./server.md) owns the grammar); **it carries no Host
  static, no label, and no signature** (rationale).
- **Invitation lifecycle, Host-owned**, and the QR panel renders it: `live`
  until a valid Noise message 1 decrypts against it (`reserved`), which then
  always ends `consumed`; an un-scanned one ends `expired` by TTL or `dropped`
  when the Host discards it — lost relay socket, or evicted at the cap. **A mint
  whose keygen straddles a teardown is refused rather than inserted**
  (rationale). **Each invitation accepts one request**; a failed decrypt leaves
  it live and redemption at the Server flips nothing, and **neither may read as
  a scan**.
- **IK against the invitation key**: Client initiator, fresh per-Host static as
  `s`, invitation public key as `rs`. **Both handshake payloads are empty**;
  `Split` yields the pairing channel, and no ACL, delivery ID, or resumable
  state exists yet.
- **Reverse two-digit confirmation.** Pocket samples a uniform code `00`–`99`
  (rejection sampling) and sends it with its `PresenceProofV1` and sanitized
  device label in the first transport payload. After the proof verifies, the
  Host opens a modal with the label, an empty two-digit input, and the copy:
  *Only authorize if your phone is showing a two-digit code. If it shows an
  error or no code, cancel this request.* **The Host holds the expected code and
  never displays, mirrors, or retransmits it**, and compares the typed digits
  without early exit ([server.md](./server.md) owns the webview echo). **Exactly
  one attempt** (rationale).
- **Every terminal outcome consumes the invitation, erases handshake material,
  and is reported at both ends in fixed local copy, never text off the wire**
  ([server.md](./server.md) -> "Remote control, in the Settings dialog"):
  mismatch, denial, pairing-TTL timeout, replacement by a newer pairing from the
  same Client, malformed input, or a failed proof.
- **Confirmation writes one record, then answers.** On a match the Host durably
  writes one active `HostAclRecord` binding `hostId`, `accountId`,
  `passkeyCredentialId`, `passkeyPublicKeyHash`, **the Client static IK
  authenticated** — never one the payload merely claimed — and a fresh
  `deliveryId`, then sends `PairingOutcomeV1`: success carries the Host static
  public key, the local label, the paired passkey identifiers and hash, and the
  `deliveryId`; denial carries only `user-denied`, `confirmation-mismatch`,
  `presence-rejected`, `invitation-expired`, `superseded`, or `host-error`.
  **Both use the same fixed padded control message**, so approval and denial are
  one size on the wire ([server.md](./server.md) -> E2E framing).
- **An unparseable first control is terminal**, not a retry: it spends the code
  (rationale).
- **A resumed handshake re-checks that its invitation is still the live one**
  (rationale).

Before storing the record, Pocket verifies the passkey fields match its ceremony
and compares the Host static to any existing pin for that `hostId`: **a
mismatch is a terminal security error that keeps the old pin**.

Source of truth: `RemoteHost.mintInvitation` / `#onPairingInit` /
`#onPairingTransport` / `#approvePairing` in
`lib/src/remote/host/remote-host.ts`, `PairingRequestV1` / `PairingOutcomeV1` /
`samplePairingCode` in `server-lib-common/src/security/e2e-ceremony.ts`,
`#setupQr` in `lib/src/host/remote/service.ts`,
`lib/src/remote/host/RemotePairingModal.tsx`. Pinned by
`lib/src/remote/host/remote-host.test.ts`.

## Connection

- **IK against the pinned Host static.** Fresh 16-byte connection ID; Client
  initiator with its paired per-Host static, `rs` the pin; message 2's payload
  is a fresh 32-byte Host challenge (`HostChallengeIssuer`, 2-minute TTL).
  Completing Noise proves both statics and **authorizes nothing**.
- **Authorization = proof ∧ conjunction.** The Host consumes the challenge
  *before any other work*, verifies `PresenceProofV1` against the binding it
  built from its own `hostId`, connection ID, challenge and handshake hash, then
  requires one active `HostAclRecord` holding all four of `accountId`,
  `passkeyCredentialId`, `passkeyPublicKeyHash`, and the IK-authenticated Client
  static.
- **Then `ConnectionOutcomeV1`**: success carries the Host label; denial carries
  only `pairing-required`, `presence-rejected`, `protocol-rejected`,
  `host-busy`, or `host-error`. **Every ACL miss is `pairing-required`** —
  individual ACL, passkey, DH, or transcript failures are logged owner-locally
  and never returned. Success promotes the two `CipherState`s into the
  established session; every terminal decision sends exactly one outcome and
  clears pending state; **failures before `Split` yield only a generic outer
  error** (rationale).
- **Protocol-v1 rides inside**, as application messages on the session's byte
  stream ([remote-api.md](./remote-api.md) -> Transport).

**Pocket accepts an outcome only after decrypting it on the cipher state for the
expected handshake hash**; a timer expiring without one reports unavailable, not
denial. **The proof asserts with the record's own paired credential** — the sole
`allowCredentials` entry for that Host, never whichever passkey signed this
session in ([pocket-app.md](./pocket-app.md) owns what the outcome then does to
the record).

Source of truth: `RemoteHost.#onConnectionInit` / `#onConnectionTransport` /
`#promoteConnection` in `lib/src/remote/host/remote-host.ts`,
`HostChallengeIssuer` in `server-lib-common/src/security/challenge.ts`.

## Push sealing

**A push gets its own construction** — no live session exists between the two
endpoints when one is sent (rationale).

- **Push is opt-in.** A Host that never enrolls to a server sends none, and none
  of the push limitations apply; an enrolled Host pushes only to a phone that
  turned push on ([pocket-app.md](./pocket-app.md) -> Installable web app owns
  the card).
- **A fresh key per message, from the two pinned statics.**
  `ss = X25519(hostStatic, clientStatic)`, a random 32-byte salt,
  `key = HKDF-SHA-256(ikm = ss, salt, info = "dormouse/push/v1", 32)`, and
  ChaCha20-Poly1305 under the all-zero 96-bit nonce. **That nonce is spent
  exactly once per key**, by construction: the key exists only for its own salt
  and no counter advances.
- **Never a Noise `CipherState`, and never Noise's HKDF** (rationale). The
  ChaChaPoly binding is the pinned `@noble/ciphers` the suite already uses
  ([Noise suite](#noise-suite)).
- **Confidentiality, not freshness**: nothing binds a push to a moment and the
  sink keeps no replay memory, an accepted residual
  ([Residual metadata](#residual-metadata)).
- **The Host seals once per recipient**, to that ACL record's own Client static,
  handing the delivery path a seal capability over its nonextractable
  `CryptoKey` rather than the key. There is no group key.
- **The Server forwards exactly `{ hostId, v, salt, ct }`**, `hostId` taken from
  the sending Host's token, validating only shape and bounds — the ciphertext
  bound is what keeps the envelope inside Web Push's ~4 KB ceiling
  ([server.md](./server.md) -> Web Push). **Copied field by field, never
  spread**, so no Host can override the token's `hostId`.
- **The worker decrypts at the sink**, against the pinned record for that
  `hostId`, and re-bounds what it recovers. **Any failure shows the generic
  content-free notification**, because `userVisibleOnly` makes showing nothing a
  browser-substituted notice ([pocket-app.md](./pocket-app.md) -> Installable
  web app owns the branch list).

Source of truth: `sealPush` / `openPush` / `isSealedPushV1` in
`server-lib-common/src/security/push-seal.ts`, pinned by
`server-lib-common/test/push-seal.test.mjs`; `RemoteHost.sealPushForClient` in
`lib/src/remote/host/remote-host.ts`, `sendPush` in
`lib/src/remote/host/push-delivery.ts`;
`lib/src/remote/pocket-app/sw.ts`.

## Host bounds

**Every bound is Host-enforced and independent of the relay** — Server-side
gates are defense in depth only, and Host correctness must survive a relay that
omits `client-gone`, invents client IDs, or reorders frames.

| Bound | Value | Declared in |
| --- | --- | --- |
| `MAX_PENDING_PAIRINGS` | 8 | `server-lib-common/src/security/pairing.ts` |
| `MAX_TOKENS_PER_HOST` | 8 | `server-lib-common/src/remote/wire.ts`, shared with the Server's setup-token cap (rationale) |
| `MAX_CLIENT_ID_LENGTH` | 256 | `server-lib-common/src/remote/wire.ts` |
| `MAX_SERVER_TO_HOST_FRAME_LENGTH` | one maximal `ct` + `MAX_CLIENT_ID_LENGTH` + 512 | same |
| `MAX_PENDING_CONNECTION_HANDSHAKES` | 8 | `lib/src/remote/host/remote-host.ts` |
| `MAX_ESTABLISHED_E2E_SESSIONS` | 16 | `server-lib-common/src/security/e2e-bounds.ts` |
| `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` | 120 000 | same |
| `E2E_INIT_BURST` / `E2E_INIT_REFILL_INTERVAL_MS` | 8 / 1 000 | same |

- **At most one pairing, one connection, and one established session per relay
  client**; a replacement disposes its predecessor, whatever identity it
  belonged to (rationale). Pending pairings expire on the pairing TTL, pending
  connections on the challenge TTL.
- **The session cap is checked at promotion and nowhere else**, after the
  presence proof and the ACL conjunction have both succeeded (rationale). A
  Client static already holding a session **replaces its own** atomically; any
  other identity at the cap gets the fixed-size `host-busy` and **evicts no
  other entry**. Pending caps and the token bucket stay active at the cap.
- **A Host-global token bucket gates the WebCrypto an accepted `init` buys**, on
  the Host's own clock, and **answers a refused frame with nothing** — as do
  refusals by shape, size, or a pending cap (rationale).
- **A message is processed only for its exact pending ID and expected step**:
  unknown IDs are dropped without decryption, established frames decrypt only at
  their session's next nonce, and **the first invalid ciphertext destroys its
  session** (rationale).
- **Rejected frames perform no WebCrypto operation and allocate no entry.**
  **`MAX_SERVER_TO_HOST_FRAME_LENGTH` is measured on the received string before
  `JSON.parse`** (a non-string payload is dropped) and given to the socket
  implementation's `maxPayload` where it takes one (rationale); the wire guard
  then bounds every routing value, `clientId` first, before the ciphertext
  scan — handshake messages at 65,535 bytes, application payloads at 1 MiB, each
  measured before base64 decoding.
- **One reaper owns every deadline**, over absolute timestamps: invitation
  expiry, pairing TTL, challenge TTL, idle timeout. It runs on every `init`,
  every local decision, every relay lifecycle event, and a timer armed for the
  soonest deadline — re-armed when that instant moves earlier, cleared on
  `stop()` (rationale). **An expiry emits an outcome only where a transport
  cipher exists and someone is owed one:**

  | Expired | Answer |
  | --- | --- |
  | Pending pairing | `invitation-expired` |
  | Pending connection (its challenge is now dead) | `presence-rejected` |
  | Idle established session | nothing |
  | Ceremony evicted at a cap | nothing (rationale) |

- **The idle deadline moves only on a successfully decrypted Client→Host
  transport message**, keepalive or application data; **never** on Host output,
  a failed decrypt, a relay envelope, a socket ping, or any unauthenticated
  frame (rationale). The Client keepalives on `E2E_KEEPALIVE_INTERVAL_MS` and
  runs the same deadline against its own last send, so a session the Host reaped
  ends on both sides ([pocket-app.md](./pocket-app.md)).
- **Every expiry or outcome disposes remote-control attachments without killing
  terminal sessions**, erases Noise state and keys, and removes the entry before
  accepting replacement work. `client-gone` disposes that client's state;
  **losing the Host's own relay socket disposes everything, invitations
  included** (rationale).

Source of truth: `lib/src/remote/host/remote-host.ts`. Pinned by
`lib/src/remote/host/remote-host-bounds.test.ts` and
`server/test/malicious-relay.test.mjs`.

## Noise suite

- **Exactly one suite: `Noise_IK_25519_ChaChaPoly_SHA256`, Noise revision 34.**
  No generic pattern API, cipher negotiation, protocol-name override, or
  caller-selectable suite. `IK` only: pre-message `<- s`, then
  `-> e, es, s, ss` and `<- e, ee, se`.
- **No plaintext path, feature flag, negotiated downgrade, or legacy frame
  discriminant** — `scripts/e2e-lint.mjs` (`pnpm lint:e2e`) refuses each
  textually, and `scripts/e2e-lint-selftest.mjs` proves them load-bearing.
- **Prologues are canonical and length-prefixed** (`lengthPrefixedConcat`), each
  binding its own ceremony's identifiers so a transcript is useless against
  another Host, id, or ceremony ([server.md](./server.md) -> E2E framing owns
  the field order). **Application authentication binds to Noise's final
  handshake hash** — no parallel transcript, exporter, KDF, or nonce scheme.
  Sessions use only the two `CipherState`s from `Split`, each from nonce zero,
  with empty associated data; routing metadata is never authenticated
  application content. **No rekey**: sessions are idle-bounded, not long-lived.
- **X25519 stays WebCrypto-only** (`generateKey` / `deriveBits` / `importKey`),
  **never a JavaScript curve** (rationale). **An X25519 rejection and an
  all-zero shared secret are one terminal handshake failure**, and the handshake
  refuses every later call rather than resuming on half-mixed state. SHA-256 and
  HMAC are WebCrypto; **HKDF is Noise's own HMAC construction** (section 4.3),
  never WebCrypto HKDF.
- **ChaChaPoly is bundled** from an exactly pinned `@noble/ciphers` release
  (rationale). **The module header records the pin, the published audit, and
  what changed in the chacha path between the audited and the pinned release**;
  a version bump rewrites that note in the same commit.
- **Every message — handshake and transport — is capped at 65,535 bytes** on
  write and read, the tag counted. The 96-bit nonce is
  `00000000 || little_endian_u64(n)` with `2^64-1` reserved, so **counter
  exhaustion is a hard error, never a wrap**, and **a failed decrypt does not
  advance the counter** (rationale).
- **Any failure ends the session**: authentication or decryption failure,
  replay, gap, reordering, version mismatch, or counter exhaustion. Relay errors
  stay generic availability errors and never trigger a fallback.
- **Conformance is proven against an independent implementation** (rationale):
  the vendored Cacophony vector matched byte for byte through both handshake
  messages, every transport message both ways, and the handshake hash, plus the
  RFC 7748 and RFC 8439 vectors. **No expected value may come from the
  production state machine.**
- **The only test hook is ephemeral-key injection**; production callers never
  pass it.

Source of truth: `server-lib-common/src/security/noise.ts`,
`server-lib-common/src/security/noise-transport.ts`, pinned by
`server-lib-common/test/noise.test.mjs` against the attributed vector in
`server-lib-common/test/vectors/`.

## Host identity

**Each Host mints one permanent Noise static at enrollment**, before the request
and never in it: `noiseStaticPrivateKey` (PKCS#8, base64url) and
`noiseStaticPublicKey` (raw 32 bytes, base64url) ride in the enrollment record,
landing exactly where `hostToken` does (`docs/specs/security-remote.md` -> "Credentials at rest").
The Host's local label rides there too, reaching a Client only inside an
encrypted outcome.

- **A runtime that cannot mint one does not enroll, and the mint runs *before*
  the exchange**, since a successful `POST /api/host/enroll` is not undoable by
  the Host (rationale).
- **Both halves or neither.** `isEnrollment` rejects a single half, a malformed
  encoding, or a wrong decoded length, and accepts a record from before the
  fields existed.
- **A Host missing one mints it at start**, persisting before the Host runs
  (rationale).
- **Whatever consumes the static checks that the halves correspond**
  (`deriveNoiseStaticPublicKey`), and **a mismatch keeps the Host down**, loudly
  (rationale). An enrollment carrying no usable static reads as un-enrolled and
  the Settings dialog offers enrollment again — the entire Host-state version.
- `RemoteHost` imports the private half **nonextractably**, never re-exports it,
  and the PKCS#8 in the state file is the only copy that leaves WebCrypto.

**X25519 is probed, not assumed.** `probeNoiseSupport` runs one `generateKey`
and one `deriveBits`, and **every rejection — a missing WebCrypto included — is
`false`, never a throw** (rationale). **Runtimes are gated, not degraded**:
Pocket runs the same probe before sign-in, setup, pairing, or connection and
shows a fixed upgrade requirement on `false`, performing no remote operation
([pocket-app.md](./pocket-app.md)).

Source of truth: `mintNoiseStaticKeyPair` / `importNoiseStaticPrivateKey` /
`deriveNoiseStaticPublicKey` / `isNoiseStaticMaterial` / `probeNoiseSupport` in
`server-lib-common/src/security/noise.ts`, `isEnrollment` / `performEnrollment`
in `lib/src/remote/host/enrollment.ts`,
`RemoteHostService.#enrolledWithNoiseStatic` in `lib/src/host/remote/service.ts`.

## Client static loss

**Never treat browser storage as permanent.** An iOS browser tab is the weakest,
an Android tab is generally durable, and an installed PWA is the preferred mode
on both (rationale).

**Loss is expected, and recovery is a re-run of the normal flow**: scan a fresh
setup code, generate a new per-Host static, pair again, optionally revoke the old
record (`revokedAt`). **Nothing is compromised** — the lost key authorized
nothing without its paired passkey.

## Security Guarantees

The checklist an auditor or a change reviewer verifies against, each property
established above and pinned by
`server-lib-common/test/security-guarantees.test.mjs`:

* Adding a new passkey does not grant Host access.
* Compromising the Server does not let it create an authorized Client.
* Compromising the Server reveals no pairing decision, Host label, remote-api
  message, terminal byte, or notification text.
* Passkey synchronization does not automatically create trusted Clients.
* Every trusted Client must be explicitly paired with every Host.
* Every connection requires fresh user presence, single-use and bound to that
  connection's own transcript.
* Every access decision is ultimately made by the Host.

**Never claim this model for paid SaaS before an independent cryptographic
review** of the Noise integration, the WebAuthn channel binding, key storage,
and the push construction. Self-hosting is the shipped deployment and carries no
such claim.

## Residual metadata

**No traffic-analysis resistance, per-Host unlinkability, or metadata anonymity
is claimed.** The Server still observes account and passkey authentication data,
IPs, Host IDs and online state, routing relationships, every session's reauth
exchange, push endpoints, timing, ciphertext sizes, and volume. Two leaks follow
and are accepted rather than closed (rationale): Client→Host timing exposes
inter-keystroke timing while keystroke *values* stay encrypted, and one
`PushSubscription` per worker scope lets a shared endpoint correlate every
`deliveryId` one Pocket profile registers across Hosts. A push carries no
counter, so a Server that kept an envelope can re-deliver it
([Push sealing](#push-sealing)).

## Future

Onboarding changes with security surface are staged in the
**selfhost-onboarding** scope ([server.md](./server.md) `## Future`).

### Device verification

Two properties of the shipped Pocket client are observable only on a real iOS
device, and both are load-bearing: an X25519 `CryptoKey` surviving a structured
clone into IndexedDB (a Client static that does not is one the phone loses on
every reload), and `getUserMedia` working inside a Home Screen web app (without
it the install has only the paste field).

### Revocation propagation

The Server pushing revocations to Hosts. Today `HostAcl.revokeClient` /
`revokePasskey` have no callers and no relay frame carries a revocation, so
revoking is hand-editing state ([server.md](./server.md), Guardrails) — and
`RemoteHostService` hands the `RemoteHost` one ACL snapshot for its whole
lifetime, so **restarting the Host is the entire lever**: it reloads the ACL
*and*, by dropping the relay socket, ends every established session. Editing
alone changes nothing that is running.
