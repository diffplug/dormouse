# Remote Security Model

The trust model for remote control, built on three primitives between the
Client (Dormouse Pocket), Host (Dormouse Terminal), and coordinating Server:

* **One end-to-end channel per ceremony.** Pairing and connection each run a
  Noise IK handshake whose two `CipherState`s carry everything after it. The
  Server routes ciphertext and learns no pairing decision, no Host label, no
  remote-api message, and no terminal byte.
* **Passkeys prove fresh user presence**, inside that channel, over a challenge
  derived from the handshake itself. A passkey authenticates the user; it
  grants access to no Host.
* **Each Client completes an explicit one-to-one pairing with each Host.** The
  Host keeps its own local ACL of approved Clients, each identified by a
  per-Host X25519 static generated in the browser and stored non-extractably.

The separation is what makes account-level compromise insufficient for host
access: the Host rejects any Client it has not locally approved
([Security Guarantees](#security-guarantees)). `SECURITY.md` -> "Remote Control"
is this model's audited face — the properties load-bearing enough to be checked
nightly, and the gaps left open (revocation, the audit trail).

Every primitive here — the Noise suite, the transport framing, presence proofs,
the invitation grammar, the ceremony messages, the ACL — lives in
`server-lib-common/src/security/`: runtime-agnostic modules shared verbatim by
the Server, the Host module in `lib`, and the Pocket client, so the three sides
cannot disagree on what a valid credential is. The concrete message sequences
live in [server.md](./server.md) (Relay); this spec defines what they must
establish, and
[remote-security-model.rationale.md](./remote-security-model.rationale.md)
holds the evidence behind its rules.

## Goals

Dormouse enables a user to control a Host (Dormouse Terminal) from a Client
(Dormouse Pocket) using only web technologies.

Primary goals:

* No native mobile application required
* Strong protection against account compromise, newly-added credentials, and
  server compromise — including confidentiality of everything the two endpoints
  say to each other
* Explicit host-controlled authorization
* Long-lived trusted client devices
* Modern passkey-based authentication

Non-goals:

* Defending against a fully compromised browser runtime
* Defending against a compromised operating system
* Preventing users from intentionally clearing browser data
* Providing permanent device identity guarantees across browser resets
* **Availability.** The self-host deployment is a per-login user agent, so the
  relay is down whenever the machine is ([server.md](./server.md)), and the
  Server is a hard online dependency for every new session.
* **Traffic analysis** ([Residual metadata](#residual-metadata)).

## Terminology

* **Client (Dormouse Pocket)** — a browser or installed PWA. It authenticates
  with passkeys and holds one X25519 static per paired Host.
* **Host (Dormouse Terminal)** — the machine being remotely controlled. It
  maintains the local ACL, verifies presence and authorization itself, and
  establishes and terminates control sessions. **The Host is the final
  authority for access decisions.**
* **Server** — the coordinating service: account management, passkey
  registration, presence-challenge minting, and routing. Not the final authority
  for Host access, and it cannot read what it routes. Revocation today is local
  state editing plus a Host restart ([server.md](./server.md) Guardrails);
  propagating one is staged in [Future](#future).

## Trust Model

Dormouse separates:

| Layer         | Responsibility                        |
| ------------- | ------------------------------------- |
| Noise channel | Confidentiality and peer authenticity |
| Passkey       | Fresh user presence                   |
| Client static | Long-lived client identity            |
| Host ACL      | Authorization                         |
| Host          | Final access decision                 |

**No single layer is sufficient to gain access** — a successful connection
requires all of them to agree.

**Exactly two endpoints are trusted: the distributed Host binaries and the exact
served Pocket artifact** — an operator serving modified Pocket code is outside
the model, as are a compromised device and XSS in the Pocket origin. **The
Server is trusted with nothing**: it may drop, delay, reorder, or refuse
traffic, and must gain no plaintext and no authorization by doing so.

## Passkeys

Passkeys prove fresh user presence: every pairing and every connection carries
one WebAuthn assertion, verified by the Host inside the encrypted channel.

> **Passkeys are user credentials, not device identities.** A passkey
> authenticates a user account; it grants access to no Host. Synchronized
> credentials — iCloud Keychain, Google Password Manager — put the same passkey
> on many physical devices, and that changes nothing here.

**Presence, or verification.** The default demand is the authenticator's
user-*presence* flag. `DORMOUSE_REQUIRE_USER_VERIFICATION=true` raises it to user
*verification*; the Server mirrors the flag into every Host's enrollment response
and the Host copies it into its policy. **Both verifiers must demand the same
thing** — they evaluate the same assertion, so a Server demanding UV while the
Host does not leaves the weaker verifier deciding, inverting "the Host is the
final authority". Pocket asks for `userVerification: 'preferred'` either way, so
platform authenticators prompt for biometrics in practice; that is convention,
not a guarantee.

**The Host stores only a hash of each paired passkey's public key**, checked
against the full key presented inside the channel — so a compromised Server
cannot substitute a passkey. The Server likewise verifies against its own
*stored* key, never the one a request carries.

Source of truth: `verifyPasskeyAssertion` / `hashPasskeyPublicKey` in
`server-lib-common/src/security/passkey.ts`, run by the Server
(`server/src/app.ts`) and by the Host through `verifyPresenceProof`;
`HostEnrollment.requireUserVerification` in `lib/src/remote/host/enrollment.ts`
carries the mirrored flag. Only ES256 (ECDSA P-256 / SHA-256) is accepted, the
mandatory-to-implement WebAuthn algorithm.

## Client statics

A Client static establishes long-lived Client identity — the capability the
Host actually authorizes. It is what stops newly-added or synced passkeys, and
Server-only compromise, from granting Host access.

**One X25519 keypair per Host, generated at scan time**, persisted
non-extractably in that Host's local record only after the Host approves, and
never shared between Hosts. The raw 32-byte public half, base64url, is the
Client identifier on the ACL, and **Noise IK is what proves possession of the
private half** (rationale).

It is non-extractable through normal browser APIs and durable across restarts,
but active XSS can *use* it, browser or OS compromise defeats the model, and
clearing browser data destroys it ([Client static loss](#client-static-loss)).

Source of truth: `generateNoiseKeyPair` in
`server-lib-common/src/security/noise.ts`; what Pocket stores is
[pocket-app.md](./pocket-app.md).

## Host Authorization

Each Host maintains a local authorization list. **The ACL is authoritative**;
the Server cannot unilaterally grant access.

`HostAclRecord` binds the Host and account to one passkey credential and public
key hash, one Client static public key, a fresh 256-bit `deliveryId`, approval
metadata, and a nullable revocation time. It is persisted through
`HostStateStore` — a 0600 file in standalone, `globalState` in VS Code —
**never on the Server** ([server.md](./server.md)).

**Authorization is the conjunction, on one record.** `HostAcl.authorize`
reports a miss (`passkey-not-paired`, `client-not-paired`, `pairing-mismatch`)
unless the passkey credential and the Client static match the *same* active
record. Halves on different records are not authorization, and a passkey added
to the account after pairing grants nothing until a new local approval.

**The two E2E fields are checked for exact length on read, and that is the whole
of the Host-ACL version.** `isHostAclRecord` + `filterAclRecords` drop anything
malformed or belonging to another
`hostId` before it can reach the conjunction — including every record written
before the end-to-end cutover, which carries neither field. **There is no
migration reader**: such a Host reads an empty ACL and every phone pairs again.
That check is hygiene, not authorization — every field is attacker-choosable by
anything that can write the store at all, and the local approval that minted the
record is the authorization.

**Delivery IDs are opaque bearer capabilities**, minted by the Host at approval
and held only by the record and the Client's own pinned copy. **Possession is
the whole authorization** for registering, querying, and deleting a push
subscription, so the Server never lists one to a session
([server.md](./server.md) -> Web Push). They are not an anonymity mechanism
(rationale).

Source of truth: `server-lib-common/src/security/acl.ts` (the schema and
`HostAcl.authorize`) and `lib/src/remote/host/acl.ts` (the read filter).

## Presence proofs

Both ceremonies prove fresh user presence the same way, so pairing and
connection share one verifier.

- **The WebAuthn challenge is derived, not random.**
  `presenceChallenge(binding, serverNonce)` is base64url
  `SHA-256(lengthPrefixedConcat(domain, kind, binding fields in declared order,
  serverNonce))` under `dormouse/presence/v1`. **One encoding rule: a base64url
  field is hashed as the bytes it encodes and everything else as UTF-8** —
  decoded are `connectionId`, `hostChallenge`, `handshakeHash`, and the nonce;
  text are the domain, the kind, `hostId`, and `passkeyCredentialId`. The
  Server mints and the Host recomputes, so both run this builder.
  `isPresenceBinding` takes **exactly one kind's fields, each bounded** —
  anything the challenge does not cover must not reach the Host inside a
  verified binding.
- **`POST /api/reauth/begin` takes a required, kind-tagged binding**, mints a
  one-use Server nonce, and answers the derived challenge under the RP ID, the
  nonce, and the named credential as the sole `allowCredentials` entry. **No
  binding, or no nonce to `finish`, is a 400**: no arm answers a challenge
  nothing is bound to. `finish` consumes the nonce, recomputes the challenge,
  verifies the assertion against the stored key for that exact credential, and
  **extends nothing** — not the session's life, not the relay socket.
- **`PresenceProofV1`** carries the binding, the Server nonce, `accountId`, the
  passkey credential id, the canonical SPKI public key, and the assertion, and
  travels only inside the first Client→Host transport payload. The Host
  recomputes the challenge with the same builder, requires **every binding field
  to equal what it built from its own state**, verifies RP ID, origin,
  presence/verification policy, and signature against the *presented* key, and
  hashes that key for the ACL. **A Server success flag is never evidence**, and
  **the verifier never throws** — its input is attacker-supplied plaintext
  inside the process that owns every PTY, so a rejection is an ordinary denial.
- **Every proof is fresh and single-use.** A dropped transport, a consumed
  challenge, a failed handshake, or a later attempt requires a new handshake,
  Host challenge, Server nonce, and authenticator operation — one authenticator
  prompt per pairing or connection, three on a self-hosted first run
  (rationale).
- **The Server session is authentication-plane only.** The bearer token stays
  memory-only with its absolute 12-hour life, is never reusable proof of
  presence for a Host, and has no app-session signing key beside it (rationale).

Source of truth: `presenceChallenge` / `isPresenceBinding` in
`server-lib-common/src/security/presence.ts`, `verifyPresenceProof` in
`server-lib-common/src/security/e2e-ceremony.ts`, and the two routes in
`server/src/app.ts`.

## Pairing

Pairing establishes trust between one Client and one Host, and local
confirmation on the Host is the only path that *mints* an ACL record. A
newly-added passkey is not automatically trusted — the Client must still pair.

- **The invitation is Host memory.** `setupQr` mints the Server's setup token
  and, locally, a 16-byte invitation id plus a one-use X25519 invitation
  keypair, bounded by the eight-invitation cap and expiring on the pairing TTL.
  The QR carries `hostId`, invitation id, expiry, setup token, and invitation
  public key ([server.md](./server.md) owns the grammar). **It carries no Host
  static, no label, and no signature** (rationale).
- **Invitation lifecycle, Host-owned.** `live` until a valid Noise message 1
  decrypts against it (`reserved`), then `consumed` by the terminal outcome,
  `expired` by TTL, or `dropped` when the Host discards it un-scanned — lost
  relay socket, or evicted at the cap. **A mint whose keygen straddles a
  teardown is refused rather than inserted**, so no code outlives the socket it
  was made for. **Each invitation accepts one request**,
  a message 1 that fails to decrypt leaves it live, and redemption at the Server
  flips nothing. The QR panel renders that state and offers a new code;
  **`dropped` must not read as a scan**, or it sends the user to a phone that
  never asked.
- **IK against the invitation key.** Client initiator, fresh per-Host static as
  `s`, invitation public key as `rs`. **Both handshake payloads are empty**, and
  `Split` yields the pairing channel; no ACL, delivery ID, or resumable state
  exists yet.
- **Reverse two-digit confirmation.** Pocket samples a uniform code `00`–`99`
  (rejection sampling) and sends it with its `PresenceProofV1` and sanitized
  device label in the first transport payload. After the proof verifies, the
  Host opens a modal with the label, an empty two-digit input, and the copy:
  *Only authorize if your phone is showing a two-digit code. If it shows an
  error or no code, cancel this request.* **The Host holds the expected code and
  never displays, mirrors, or retransmits it**; the webview echoes the typed
  digits with the immutable pairing ID, and the Host compares them without early
  exit. **Exactly one attempt** — a two-digit secret with retries is none.
- **Every terminal outcome consumes the invitation and erases handshake
  material**: a mismatch, denial, timeout on the pairing TTL, replacement by a
  newer pairing from the same Client, malformed input, or a failed proof.
- **Confirmation writes one record, then answers.** On a match the Host durably
  writes one active `HostAclRecord` binding `hostId`, `accountId`,
  `passkeyCredentialId`, `passkeyPublicKeyHash`, **the Client static IK
  authenticated** — never one the payload merely claimed — and a fresh
  `deliveryId`, then sends `PairingOutcomeV1`: success carries the Host static
  public key, the local label, the paired passkey identifiers and hash, and the
  `deliveryId`; denial carries only `user-denied`, `confirmation-mismatch`,
  `presence-rejected`, `invitation-expired`, `superseded`, or `host-error`.
  **Both use the same fixed padded control message**, so approval and denial are
  one size on the wire.
- **An unparseable first control is terminal**, not a retry: it spends the code
  (rationale).
- **A resumed handshake re-checks that its invitation is still the live one**
  (rationale).

Before storing the record, Pocket verifies the passkey fields match its ceremony
and compares the Host static to any existing pin for that `hostId` — **a
mismatch is a terminal security error that keeps the old pin** — and it maps
every denial to fixed copy rather than rendering Host- or relay-supplied text.

Source of truth: `RemoteHost.mintInvitation` / `#onPairingInit` /
`#onPairingTransport` / `#approvePairing` in
`lib/src/remote/host/remote-host.ts`, `PairingRequestV1` / `PairingOutcomeV1` /
`samplePairingCode` in `server-lib-common/src/security/e2e-ceremony.ts`,
`#setupQr` in `lib/src/host/remote/service.ts`, and the modal in
`lib/src/remote/host/RemotePairingModal.tsx`. Driven end to end by
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
  error**, because there is no session to encrypt a denial on.
- **Protocol-v1 rides inside**, as application messages on the session's byte
  stream ([remote-api.md](./remote-api.md) -> Transport).

Pocket accepts an outcome only after decrypting it on the cipher state for the
expected handshake hash, and a timer expiring without one reports unavailable
rather than denial. **The proof asserts with the record's own paired
credential** — the sole `allowCredentials` entry for that Host, not whichever
passkey signed this session in — and an authenticated `pairing-required` removes
the record's local authorization while keeping its pin.

Source of truth: `RemoteHost.#onConnectionInit` / `#onConnectionTransport` /
`#promoteConnection` in `lib/src/remote/host/remote-host.ts`, and
`HostChallengeIssuer` in `server-lib-common/src/security/challenge.ts`.

## Push sealing

A push is the one message the two endpoints exchange with no live session
between them — Host awake, phone asleep, Server store-and-forward — so it gets
its own construction.

- **A fresh key per message, from the two pinned statics.**
  `ss = X25519(hostStatic, clientStatic)`, a random 32-byte salt,
  `key = HKDF-SHA-256(ikm = ss, salt, info = "dormouse/push/v1", 32)`, and
  ChaCha20-Poly1305 under the all-zero 96-bit nonce. **That nonce is spent
  exactly once per key**, by construction: the key exists only for its own salt
  and no counter advances.
- **Never a Noise `CipherState`, and never Noise's HKDF** — a transport state is
  a shared counter, and a phone may receive one push, none, or three, days apart
  and out of order. The ChaChaPoly binding is the pinned `@noble/ciphers` the
  suite already uses ([Noise suite](#noise-suite)).
- **Confidentiality, not freshness**: nothing binds a push to a moment and the
  sink keeps no replay memory, an accepted residual
  ([Residual metadata](#residual-metadata)).
- **The Host seals once per recipient**, to that ACL record's own Client static,
  from the nonextractable `CryptoKey` it holds — the delivery path is handed a
  seal capability, never the key. There is no group key.
- **The Server forwards exactly `{ hostId, v, salt, ct }`**, `hostId` taken from
  the sending Host's token, validating only shape and bounds — the ciphertext
  bound is what keeps the envelope inside Web Push's ~4 KB ceiling
  ([server.md](./server.md) -> Web Push). **Copied field by field, never
  spread**: the guard bounds those three and ignores any others, so a spread
  would let a Host override the token's `hostId` and smuggle readable text
  through.
- **The worker decrypts at the sink**, against the pinned record for that
  `hostId`, and re-bounds what it recovers. **Any failure shows the generic
  content-free notification**, because `userVisibleOnly` makes showing nothing a
  browser-substituted notice ([pocket-app.md](./pocket-app.md) -> Installable
  web app owns the branch list).

Source of truth: `sealPush` / `openPush` / `isSealedPushV1` in
`server-lib-common/src/security/push-seal.ts`, proven by
`server-lib-common/test/push-seal.test.mjs`;
`RemoteHost.sealPushForClient` and `sendPush` in
`lib/src/remote/host/push-delivery.ts`; the sink in
`lib/src/remote/pocket-app/sw.ts`.

## Host bounds

Every bound is Host-enforced and independent of the relay; Server-side gates are
defense in depth only, and Host correctness must survive a relay that omits
`client-gone`, invents client IDs, or reorders frames.

| Bound | Value | Declared in |
| --- | --- | --- |
| `MAX_PENDING_PAIRINGS` | 8 | `server-lib-common/src/security/pairing.ts` |
| `MAX_TOKENS_PER_HOST` | 8 | `server-lib-common/src/remote/wire.ts`, shared with the Server's setup-token cap (rationale) |
| `MAX_CLIENT_ID_LENGTH` | 256 | `server-lib-common/src/remote/wire.ts` |
| `MAX_PENDING_CONNECTION_HANDSHAKES` | 8 | `lib/src/remote/host/remote-host.ts` |
| `MAX_ESTABLISHED_E2E_SESSIONS` | 16 | `server-lib-common/src/security/e2e-bounds.ts` |
| `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` | 120 000 | same |
| `E2E_INIT_BURST` / `E2E_INIT_REFILL_INTERVAL_MS` | 8 / 1 000 | same |

- **At most one pairing, one connection, and one established session per relay
  client**; a replacement disposes its predecessor, whatever identity that
  predecessor belonged to (rationale). Pending pairings expire on the pairing
  TTL (a human is typing); pending connections on the challenge TTL.
- **The session cap is checked at promotion and nowhere else**, after the
  presence proof and the ACL conjunction have both succeeded (rationale). A
  Client static already holding a session **replaces its own** atomically; any
  other identity at the cap receives the fixed-size `host-busy` and **evicts no
  other entry** — reaching the cap never displaces an authorized phone. The
  pending caps and the token bucket stay active at the cap.
- **A Host-global token bucket gates the WebCrypto an accepted `init` buys**, on
  the Host's own clock. A frame it refuses is dropped exactly like one refused
  by shape, size, or a pending cap, and answered with nothing (rationale).
- **A message is processed only for its exact pending ID and expected step.**
  Unknown IDs are dropped without decryption, established frames only decrypt at
  their session's next nonce, and **the first invalid ciphertext destroys its
  session** — there is no resynchronization point in a stream cipher.
- **Rejected frames perform no WebCrypto operation and allocate no entry.** The
  wire guard bounds every routing value, `clientId` first, before the ciphertext
  scan — handshake messages at 65,535 bytes, application payloads at 1 MiB,
  measured before JSON parsing or base64 decoding.
- **One reaper owns every deadline**, over absolute timestamps: invitation
  expiry, pairing TTL, challenge TTL, and the idle timeout. It runs on every
  `init`, every local decision, every relay lifecycle event, and a timer armed
  for the soonest deadline — re-armed when that instant moves earlier, cleared
  on `stop()` — so a Host whose relay never delivers another frame still
  reclaims what it holds. **An expiry emits an outcome only where a transport
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
  frame (rationale). A Client keepalives every
  `E2E_KEEPALIVE_INTERVAL_MS = 30_000` while its page is visible, and **runs the
  same deadline against its own last send**, so a session the Host reaped ends
  on both sides ([pocket-app.md](./pocket-app.md)).
- **Every expiry or outcome disposes remote-control attachments without killing
  terminal sessions**, erases Noise state and keys, and removes the entry before
  accepting replacement work. `client-gone` disposes that client's state;
  **losing the Host's own relay socket disposes everything, invitations
  included** — the one-use key behind a displayed code belongs to the socket it
  was minted over.

Source of truth: `lib/src/remote/host/remote-host.ts`, over the constants above.
Pinned by `lib/src/remote/host/remote-host-bounds.test.ts`, which counts the
WebCrypto a rejected frame buys and drives every deadline off an injected clock,
and by `server/test/malicious-relay.test.mjs`, which drives the same refusals
through a relay holding no guards of its own.

## Noise suite

One suite carries both ceremonies, the terminal stream, and everything else the
two endpoints say to each other.

- **Exactly one suite: `Noise_IK_25519_ChaChaPoly_SHA256`, Noise revision 34.**
  No generic pattern API, cipher negotiation, protocol-name override, or
  caller-selectable suite. `IK` only: pre-message `<- s`, then
  `-> e, es, s, ss` and `<- e, ee, se`.
- **No plaintext path, feature flag, negotiated downgrade, or legacy frame
  discriminant.** `scripts/e2e-lint.mjs` (`pnpm lint:e2e`) refuses each
  textually; `scripts/e2e-lint-selftest.mjs` proves those refusals load-bearing.
- **Prologues are canonical and length-prefixed** (`lengthPrefixedConcat`), each
  binding its own ceremony's identifiers so a transcript is useless against
  another Host, id, or ceremony ([server.md](./server.md) -> E2E framing owns
  the field order). **Application authentication binds to Noise's final
  handshake hash** — no parallel transcript, exporter, KDF, or nonce scheme.
  Sessions use only the two `CipherState`s from `Split`, each from nonce zero,
  with empty associated data; routing metadata is never authenticated
  application content. **No rekey**: sessions are idle-bounded, not long-lived.
- **X25519 stays WebCrypto-only** (`generateKey` / `deriveBits` / `importKey`),
  **never a JavaScript curve**, so a long-term private key can remain a
  nonextractable `CryptoKey` (rationale). **An X25519 rejection and an all-zero
  shared secret are one terminal handshake failure** — indistinguishable, and
  the handshake refuses every later call rather than resuming on half-mixed
  state. SHA-256 and HMAC are WebCrypto; **HKDF is Noise's own HMAC
  construction** (section 4.3), never WebCrypto HKDF.
- **ChaChaPoly is bundled** from an exactly pinned `@noble/ciphers` release, as
  no interoperable WebCrypto ChaChaPoly exists (rationale). **The module header
  records the pin, the published audit, and what changed in the chacha path
  between the audited and the pinned release**; a version bump rewrites that
  note in the same commit.
- **Every message — handshake and transport — is capped at 65,535 bytes** on
  write and read, the tag counted. The 96-bit nonce is
  `00000000 || little_endian_u64(n)` with `2^64-1` reserved, so **counter
  exhaustion is a hard error, never a wrap**, and **a failed decrypt does not
  advance the counter** — otherwise one injected frame locks out the real
  sender.
- **Any failure ends the session**: authentication or decryption failure,
  replay, gap, reordering, version mismatch, or counter exhaustion. Relay errors
  stay generic availability errors and never trigger a fallback.
- **Conformance is proven against an independent implementation**: the vendored
  Cacophony vector, byte for byte through both handshake messages, every
  transport message both ways, and the handshake hash, plus the RFC 7748 and
  RFC 8439 vectors. **No expected value may come from the production state
  machine.**
- **The only test hook is ephemeral-key injection**, without which a published
  vector cannot be replayed. Production callers never pass it.

Source of truth: `server-lib-common/src/security/noise.ts` and
`server-lib-common/src/security/noise-transport.ts`, proven by
`server-lib-common/test/noise.test.mjs` against the attributed vector in
`server-lib-common/test/vectors/`.

## Host identity

**Each Host mints one permanent Noise static at enrollment**, before the request
and never in it: `noiseStaticPrivateKey` (PKCS#8, base64url) and
`noiseStaticPublicKey` (raw 32 bytes, base64url) ride in the enrollment record,
landing exactly where `hostToken` does (`SECURITY.md` -> "Credentials at rest").
The Host's local label rides there too, and reaches a Client only inside an
encrypted outcome.

- **A runtime that cannot mint one does not enroll, and the mint runs *before*
  the exchange**, because a successful `POST /api/host/enroll` appends a
  `hosts.json` row and spends the installer's single-use token, neither of which
  the Host can undo.
- **Both halves or neither.** `isEnrollment` rejects a single half, a malformed
  encoding, or a wrong decoded length, and accepts a record from before the
  fields existed.
- **A Host missing one mints it at start**, persisting before the Host runs
  (rationale).
- **Whatever consumes the static checks that the halves correspond.**
  `deriveNoiseStaticPublicKey` derives the public point from the private half
  and the service compares it; a mismatch keeps the Host **down**, loudly,
  because starting anyway would present a *changed Host identity* to every
  paired Client rather than the corrupt state file it is. An enrollment carrying
  no usable static reads as un-enrolled and the Settings dialog offers
  enrollment again, which is the entire Host-state version.
- `RemoteHost` imports the private half **nonextractably**, never re-exports it,
  and the PKCS#8 in the state file is the only copy that leaves WebCrypto.

Source of truth: `mintNoiseStaticKeyPair` / `importNoiseStaticPrivateKey` /
`deriveNoiseStaticPublicKey` / `isNoiseStaticMaterial` in
`server-lib-common/src/security/noise.ts`, `isEnrollment` / `performEnrollment`
in `lib/src/remote/host/enrollment.ts`, and
`RemoteHostService.#enrolledWithNoiseStatic` in
`lib/src/host/remote/service.ts`.

**X25519 is probed, not assumed.** `probeNoiseSupport` runs one `generateKey`
and one `deriveBits`, and **every rejection — a missing WebCrypto included — is
`false`, never a throw**, because its callers are boot-path gates. **Runtimes
are gated, not degraded**: Pocket runs the same probe before sign-in, setup,
pairing, or connection and shows a fixed upgrade requirement on `false`,
performing no remote operation ([pocket-app.md](./pocket-app.md)).

## Client static loss

**Never treat browser storage as permanent.** An iOS browser tab is the weakest
— storage may be evicted after inactivity — an Android tab is generally
durable, and an installed PWA is the preferred mode on both (rationale).

**Loss is expected, and recovery is a re-run of the normal flow**: scan a fresh
Host QR, generate a new per-Host static, pair again, and optionally revoke the
previous record (`revokedAt`). Nothing is compromised — the lost key authorized
nothing without its paired passkey, and the new one starts unauthorized
everywhere.

## Security Guarantees

Each property below is established in its own section above; this is the
enumeration the section heading promises — the checklist an auditor or a change
reviewer verifies against, and the one
`server-lib-common/test/security-guarantees.test.mjs` drives end to end.

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
exchange, push endpoints, timing, ciphertext sizes, and volume; two leaks follow
from that and are accepted rather than closed (rationale): Client→Host timing
exposes inter-keystroke timing while keystroke *values* stay encrypted, and one
`PushSubscription` per worker scope lets a shared endpoint correlate every
`deliveryId` one Pocket profile registers across Hosts. A push carries no
counter, so a Server that kept an envelope can re-deliver it
([Push sealing](#push-sealing)).

## Future

Onboarding changes with security surface are staged in the
**selfhost-onboarding** scope ([server.md](./server.md) `## Future`).

### Device verification

Two properties of the shipped Pocket client cannot be observed anywhere but a
real iOS device, and both are load-bearing: an X25519 `CryptoKey` surviving a
structured clone into IndexedDB (a Client static that does not is one the phone
loses on every reload), and `getUserMedia` working inside a Home Screen web app
(without it the install has only the paste field).

### Revocation propagation

The Server pushing revocations to Hosts. Today `HostAcl.revokeClient` /
`revokePasskey` have no callers and no relay frame carries a revocation, so
revoking is hand-editing state ([server.md](./server.md), Guardrails) — and
`RemoteHostService` hands the `RemoteHost` one ACL snapshot for its whole
lifetime, so **restarting the Host is the entire lever**: it reloads the ACL
*and*, by dropping the relay socket, ends every established session. Editing
alone changes nothing that is running.
