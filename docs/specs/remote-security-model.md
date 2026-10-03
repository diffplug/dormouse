# Remote Security Model

> See `docs/specs/glossary.md` for Client, Burrow, Relay, and Session vocabulary.

> Owns ceremony trust and authorization. `docs/specs/relay.md` owns message orchestration; `docs/specs/security-remote.md` owns the audited checks and open gaps.

**Must share cryptographic primitives through `remote-lib-common/src/security/`.**

## Goals

Primary: no native mobile application; strong protection against account
compromise, newly-added credentials, and Relay compromise, including
confidentiality of everything the two endpoints say to each other; explicit
burrow-controlled authorization; long-lived trusted client devices; passkeys.

Non-goals: a compromised browser runtime or operating system; a user
intentionally clearing browser data; permanent device identity across browser
resets; **availability** — a self-host Relay shares its deployment machine's
availability; the Relay is an online dependency for each new paired session,
and a one-time session needs Hosted's rendezvous until the direct switch
([relay.md](./relay.md); [One-time connection](#one-time-connection)); **traffic analysis**
([Residual metadata](#residual-metadata)).

## Trust Model

| Layer         | Responsibility                        |
| ------------- | ------------------------------------- |
| Noise channel | Confidentiality and peer authenticity |
| Passkey       | Fresh user presence                   |
| Client static | Long-lived client identity            |
| Burrow ACL      | Authorization                         |
| Burrow          | Final access decision                 |

**No single layer is sufficient** — a connection requires all of them to agree.

**Exactly two endpoints are trusted: the distributed Burrow binaries and the exact
served Pocket artifact** — an operator serving modified Pocket code is outside
the model, as is XSS in the Pocket origin. A one-time session trusts a third,
the page Hosted serves ([One-time connection](#one-time-connection)). **The
Relay is trusted with nothing**: it may drop, delay, reorder, or refuse
traffic, and must gain no plaintext and no authorization by doing so.

## Passkeys

Every pairing and every connection carries one WebAuthn assertion, verified by
the Burrow inside the encrypted channel.

> **Passkeys are user credentials, not device identities** — synchronization
> puts one passkey on many physical devices and changes nothing here
> (rationale).

**Presence, or verification.** The default demand is the authenticator's
user-*presence* flag; `DORMOUSE_REQUIRE_USER_VERIFICATION=true` raises it to user
*verification*, mirrored by the Relay into every Burrow's enrollment response and
copied by the Burrow into its policy. **Both verifiers must demand the same thing**
(rationale). Pocket asks `userVerification: 'preferred'` either way, so platform
authenticators prompt for biometrics in practice — convention, not a guarantee.

**The Burrow stores only a hash of each paired passkey's public key**, checked
against the full key presented inside the channel, so a compromised Relay
cannot substitute a passkey. **The Relay likewise verifies against its own
*stored* key**, never one a request carries. **Only ES256 (ECDSA P-256 /
SHA-256) is accepted**, the mandatory-to-implement WebAuthn algorithm.

Source of truth: `verifyPasskeyAssertion` / `hashPasskeyPublicKey` in
`remote-lib-common/src/security/passkey.ts`;
`BurrowEnrollment.requireUserVerification` in `lib/src/remote/burrow/enrollment.ts`.

## Client statics

A Client static is long-lived Client identity — the capability the Burrow actually
authorizes.

**Must generate one X25519 keypair per Burrow at scan time and persist it only
after approval, never shared between Burrows.** (rationale) The raw 32-byte public
half, base64url, is the Client
identifier on the ACL; **Noise IK proves possession of the private half**
(rationale).

**Must prefer a directly persisted nonextractable private key.** Only a failed
native storage probe may select AES-256-GCM-encrypted PKCS#8 with a per-key
nonextractable AES key, after that format passes reopen and key agreement.
**Must import recovered X25519 keys nonextractably, never persist plaintext
private bytes, and leave existing native records unchanged.** (rationale)

Active XSS can use either format and can extract the X25519 private bytes in
the encrypted format. Nonextractability is therefore not a universal at-rest
guarantee; browser/OS compromise defeats both formats. A stolen static still
requires its paired passkey's fresh presence proof. Clearing browser data
destroys either format ([Client static loss](#client-static-loss)).

Source of truth: `generatePocketKeyPair` in
`lib/src/remote/client/pocket-private-key.ts`; what Pocket stores is
[pocket-app.md](./pocket-app.md).

## Burrow Authorization

**The ACL is authoritative**; the Relay cannot unilaterally grant access.

`BurrowAclRecord` binds the Burrow and account to one passkey credential and public
key hash, one Client static public key, a fresh 256-bit `deliveryId`, approval
metadata, and a nullable revocation time. Persisted through `BurrowStateStore` — a
private file in standalone (0600 on POSIX; protected user-only DACL on Windows), `globalState` in VS Code — **never on the Relay**
([relay.md](./relay.md)).

**Authorization is the conjunction, on one record.** `BurrowAcl.authorize`
reports a miss (`passkey-not-paired`, `client-not-paired`, `pairing-mismatch`)
unless the passkey credential and the Client static match the *same* active
record. Halves on different records are not authorization, and a passkey added
to the account after pairing grants nothing until a new local approval.

**The two E2E fields are checked for exact length on read, and that is the whole
of the Burrow-ACL version**: `isBurrowAclRecord` + `filterAclRecords` drop anything
malformed, pre-cutover, or belonging to another `burrowId` before it reaches the
conjunction, and **there is no migration reader** — such a Burrow reads an empty
ACL and every phone pairs again. Hygiene, not authorization (rationale).

**Delivery IDs are opaque bearer capabilities**, minted by the Burrow at approval
and held only by the record and the Client's own pinned copy. **Possession is
the whole authorization** for registering, querying, and deleting a push
subscription, so the Relay never lists one to a session
([relay.md](./relay.md) -> Web Push). They are not an anonymity mechanism
(rationale).

Source of truth: `remote-lib-common/src/security/acl.ts` (the schema and
`BurrowAcl.authorize`), `lib/src/remote/burrow/acl.ts` (the read filter).

## Presence proofs

**Use one verifier for pairing and connection.**

- **The WebAuthn challenge is derived, not random.**
  `presenceChallenge(binding, relayNonce)` is base64url
  `SHA-256(lengthPrefixedConcat(domain, kind, binding fields in declared order,
  relayNonce))` under `dormouse/presence/v1`. **One encoding rule: a base64url
  field is hashed as the bytes it encodes and everything else as UTF-8** —
  decoded are `connectionId`, `burrowChallenge`, `handshakeHash`, and the nonce;
  text are the domain, the kind, `burrowId`, and `passkeyCredentialId`. Relay
  mints, Burrow recomputes, one builder. `isPresenceBinding` takes **exactly one
  kind's fields, each bounded** — anything the challenge does not cover must not
  reach the Burrow inside a verified binding.
- **`POST /api/reauth/begin` takes a required, kind-tagged binding** and answers
  the derived challenge over a one-use Relay nonce ([relay.md](./relay.md)
  owns both routes). **No binding, or no nonce to `finish`, is a 400**
  (rationale). `finish` consumes the nonce, recomputes the challenge, verifies
  the assertion against the **stored** key for that exact credential, and
  **extends nothing** — not the session's life, not the relay socket.
- **`PresenceProofV1` travels only inside the first Client→Burrow transport
  payload**, carrying the binding, the Relay nonce, `accountId` (as the
  Relay answered sign-in), the passkey
  credential id, its canonical SPKI public key, and the assertion. The Burrow
  recomputes the challenge with the same builder, requires **every binding field
  to equal what it built from its own state**, verifies RP ID, origin,
  presence/verification policy, and signature against the *presented* key, and
  hashes that key for the ACL. **A Relay success flag is never evidence**, and
  **the verifier never throws**, including missing WebCrypto or rejected digest
  operations — a rejection is an ordinary denial (rationale).
- **Every proof is fresh and single-use**: any restart — dropped transport,
  consumed challenge, failed handshake, later attempt — needs a new handshake,
  Burrow challenge, Relay nonce, and authenticator operation; one prompt per
  pairing or connection, three on a self-hosted first run (rationale).
- **The Relay session is authentication-plane only.** Its bearer token
  ([relay.md](./relay.md)) is never reusable proof of presence for a Burrow, and
  **has no app-session signing key beside it** (rationale).

Source of truth: `utf8Encode` in `remote-lib-common/src/security/bytes.ts`
(`remote-lib-common/test/bytes.test.mjs`); `presenceChallenge` / `isPresenceBinding` in
`remote-lib-common/src/security/presence.ts`, `verifyPresenceProof` in
`remote-lib-common/src/security/e2e-ceremony.ts`, `relay/src/app.ts`.

## Pairing

**Local confirmation on the Burrow is the only path that mints an ACL record.** A
newly-added passkey is not automatically trusted; its Client must still pair.

- **The invitation is Burrow memory.** `setupQr` mints the Relay's setup token
  and, locally, a 16-byte invitation id plus a one-use X25519 invitation
  keypair, bounded by the eight-invitation cap and expiring on the pairing TTL.
  The QR carries `burrowId`, invitation id, expiry, setup token, and invitation
  public key ([relay.md](./relay.md) owns the grammar); **it carries no Burrow
  static, no label, and no signature** (rationale).
- **Invitation lifecycle, Burrow-owned**, and the QR panel renders it: `live`
  until a valid message 1 and the responder's message 2 complete the Noise
  handshake (`reserved`), which then always ends `consumed`; an un-scanned one ends `expired` by TTL or `dropped`
  when the Burrow discards it — lost relay socket, or evicted at the cap. **A mint
  whose keygen straddles a teardown is refused rather than inserted**
  (rationale). **Must accept one completed handshake per invitation**; a failed handshake leaves
  it live and redemption at the Relay flips nothing, and **neither may read as
  a scan**.
- **IK against the invitation key**: Client initiator, fresh per-Burrow static as
  `s`, invitation public key as `rs`. **Both handshake payloads are empty**;
  `Split` yields the pairing channel, and no ACL, delivery ID, or resumable
  state exists yet.
- **Reverse two-digit confirmation.** Pocket samples a uniform code `00`–`99`
  (rejection sampling) and sends it with its `PresenceProofV1` and sanitized
  device label in the first transport payload. After the proof verifies, the
  Burrow opens a modal with the label, an empty two-digit input, and the copy:
  *Only authorize if your phone is showing a two-digit code. If it shows an
  error or no code, cancel this request.* **The Burrow holds the expected code and
  never displays, mirrors, or retransmits it**, and compares the typed digits
  without early exit ([relay.md](./relay.md) owns the webview echo). **Exactly
  one attempt** (rationale).
- **Every terminal outcome consumes the invitation, erases handshake material,
  and is reported at both ends in fixed local copy, never text off the wire**
  ([relay.md](./relay.md) -> "Remote control, in the Settings dialog"):
  mismatch, denial, pairing-TTL timeout, replacement by a newer pairing from the
  same Client, malformed input, or a failed proof.
- **Confirmation writes one record, then answers.** On a match the Burrow durably
  writes one active `BurrowAclRecord` binding `burrowId`, `accountId`,
  `passkeyCredentialId`, `passkeyPublicKeyHash`, **the Client static IK
  authenticated** — never one the payload merely claimed — and a fresh
  `deliveryId`, then sends `PairingOutcomeV1`: success carries the Burrow static
  public key, the local label, the paired passkey identifiers and hash, and the
  `deliveryId`; denial carries only `user-denied`, `confirmation-mismatch`,
  `presence-rejected`, `invitation-expired`, `superseded`, or `burrow-error`.
  **Both use the same fixed padded control message**, so approval and denial are
  one size on the wire ([relay.md](./relay.md) -> E2E framing).
- **Must serialize approval snapshots and publish the ACL only after saving.**
  Service lifecycle changes await approval writes. A failed save denies
  `burrow-error` without changing the live ACL. Once the
  write starts, local consent is final: teardown can discard its transport but
  cannot cancel the write or announce denial; completion never revives a retired
  ceremony.
- **An unparseable first control is terminal**, not a retry: it spends the code
  (rationale).
- **A resumed handshake re-checks that its invitation is still the live one**
  (rationale).

Before storing the record, Pocket verifies the passkey fields and its session's
account match, and compares the Burrow static to any existing pin for that `burrowId`: **a
mismatch is a terminal security error that keeps the old pin**.

Source of truth: `BurrowRuntime.mintInvitation` / `#onPairingInit` /
`#onPairingTransport` / `#approvePairing` in
`lib/src/remote/burrow/burrow-runtime.ts`, `PairingRequestV1` / `PairingOutcomeV1` /
`samplePairingCode` in `remote-lib-common/src/security/e2e-ceremony.ts`,
`#setupQr` in `lib/src/host/remote/service.ts`,
`lib/src/remote/burrow/RemotePairingModal.tsx`, `PocketClient.pair` in
`lib/src/remote/client/pocket-client.ts`. Pinned by
`lib/src/remote/burrow/burrow-runtime.test.ts`.

## Connection

- **IK against the pinned Burrow static.** Fresh 16-byte connection ID; Client
  initiator with its paired per-Burrow static, `rs` the pin; message 2's payload
  is a fresh 32-byte Burrow challenge (`ChallengeIssuer`, 2-minute TTL).
  Completing Noise proves both statics and **authorizes nothing**.
- **Authorization = proof ∧ conjunction.** The Burrow consumes the challenge
  *before verifying presence*, verifies `PresenceProofV1` against the binding it
  built from its own `burrowId`, connection ID, challenge and handshake hash, then
  requires one active `BurrowAclRecord` holding all four of `accountId`,
  `passkeyCredentialId`, `passkeyPublicKeyHash`, and the IK-authenticated Client
  static.
- **Then `ConnectionOutcomeV1`**: success carries the Burrow label (and
  `directOnly` under Local networks); denial carries
  only `pairing-required`, `presence-rejected`, `protocol-rejected`,
  `burrow-busy`, or `burrow-error`. **Every ACL miss is `pairing-required`** —
  individual ACL and presence failures are logged owner-locally
  and never returned. Success promotes the two `CipherState`s into the
  established session; every terminal decision sends exactly one outcome and
  clears pending state; **failures before `Split` yield only a generic outer
  error** (rationale).
- **Protocol-v1 rides inside**, as application messages on the session's byte
  stream ([remote-api.md](./remote-api.md) -> Transport).

**Pocket accepts an outcome only after decrypting it on the cipher state for the
expected handshake hash**; a timer expiring without one reports unavailable, not
denial. **The proof asserts with the record's own paired credential** — the sole
`allowCredentials` entry for that Burrow, never whichever passkey signed this
session in ([pocket-app.md](./pocket-app.md) owns what the outcome then does to
the record).

Source of truth: `BurrowRuntime.#onConnectionInit` / `#onConnectionTransport` /
`#promoteConnection` in `lib/src/remote/burrow/burrow-runtime.ts`,
`EstablishedE2eSession` in `lib/src/remote/burrow/established-session.ts` (the
established session), `ChallengeIssuer` in
`remote-lib-common/src/security/challenge.ts`.

## One-time connection

**A third ceremony on the one suite, authorizing one session and writing
nothing.** `docs/specs/one-time.md` owns the link, the rendezvous wire, and the
runtime that carries these rules out ("Burrow runtime").

- **IK against the link's one-use key.** The phone is the initiator with a fresh
  nonextractable static it **never persists**, minted for the one handshake,
  the link's `ephPub` as `rs`; both handshake payloads are empty. The link
  carries no Burrow static, so the phone is left holding nothing to pin.
- **The prologue binds every link field under its own kind** (field order:
  `docs/specs/one-time.md` -> "Link"), so a one-time transcript equals no
  pairing or connection transcript, and is useless in any other room.
- **Must reserve the link only after a valid message 1 and responder message 2
  complete the handshake.** The one-use key is erased with it; a later `init`
  is dropped before WebCrypto, and a failed handshake reserves nothing.
- **The one carve-out from [Presence proofs](#presence-proofs): a fresh local
  confirmation authorizes exactly one session and writes nothing.**
  `OneTimeRequestV1` carries the phone's code and label and nothing else; the
  Burrow opens the approval modal on it, holds the expected code as
  [Pairing](#pairing) does, and gets **exactly one attempt** — spent before the
  expiry check and the constant-time comparison. No ACL record, `deliveryId`,
  or Burrow static results, and the Burrow persists nothing.
- **The one-time modal never renders text the phone chose.** The phone picks
  the digits and the label both, so the Burrow shows a label only as a member
  of `ONE_TIME_DEVICE_LABELS`, and any other as `Phone browser` (rationale).
- **One padded outcome.** `OneTimeOutcomeV1` success carries only the Burrow
  label — no Burrow static, no `deliveryId` — and a denial only one of
  `ONE_TIME_DENIAL_CODES` (`docs/specs/one-time.md` -> "Wire contract"), in the
  same fixed control message as [Pairing](#pairing)'s.
- **Direct required: application data never crosses the rendezvous.** The
  outcome promotes the same session; the phone refuses protocol-v1 until both
  directions are direct, and an application message the Burrow decrypts off
  the rendezvous ends the session unread. A session with no direct path by
  `DIRECT_ONLY_DEADLINE_MS` ends at both ends; no relayed fallback.
- **After the switch the direct channel, not the rendezvous, is the lifecycle
  authority** — for this ceremony alone, the carve-out from
  [remote-api.md](./remote-api.md) -> "Direct path"'s rule that the Relay stays
  the lifecycle authority, since no Relay carries it. Both ends close the
  rendezvous at the switch and ignore its loss; channel loss or the idle
  deadline ends the session, and nothing resumes.
- **The page Hosted serves at `/connect/` is a third trusted endpoint for every
  session confirmed through it**: the channel ends inside that page, so whoever
  controls Hosted's deploy pipeline or Cloudflare account can serve one that
  reads or drives the session, which Noise cannot prevent. **The rendezvous is
  trusted with nothing**, as the Relay is ([Residual metadata](#residual-metadata)).

Source of truth: `OneTimeRuntime` in
`lib/src/remote/burrow/one-time-runtime.ts`, `OneTimeClient` in
`lib/src/remote/client/one-time-client.ts`, `oneTimeLinkPrologue` in
`remote-lib-common/src/security/one-time-link.ts`, `e2eOneTimePrologue` in
`remote-lib-common/src/security/noise-transport.ts`, `OneTimeRequestV1` /
`OneTimeOutcomeV1` / `knownOneTimeDeviceLabel` in
`remote-lib-common/src/security/e2e-ceremony.ts`. Pinned
by `remote-lib-common/test/one-time-link.test.mjs`,
`remote-lib-common/test/e2e-ceremony.test.mjs`,
`lib/src/remote/burrow/one-time-runtime.test.ts`, and
`lib/src/remote/client/one-time-e2e.test.ts`.

## Push sealing

**A push gets its own construction** — no live session exists between the two
endpoints when one is sent (rationale).

- **Push is opt-in.** A Burrow that never enrolls to a Relay sends none, and none
  of the push limitations apply; an enrolled Burrow pushes only to a phone that
  turned push on ([pocket-app.md](./pocket-app.md) -> Installable web app owns
  the card).
- **A fresh key per message, from the two pinned statics.**
  `ss = X25519(burrowStatic, clientStatic)`, a random 32-byte salt,
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
- **The Burrow seals once per recipient**, to that ACL record's own Client static,
  handing the delivery path a seal capability over its nonextractable
  `CryptoKey` rather than the key. There is no group key.
- **The Relay forwards exactly `{ burrowId, v, salt, ct }`**, `burrowId` taken from
  the sending Burrow's token, validating only shape and bounds — the ciphertext
  bound is what keeps the envelope inside Web Push's ~4 KB ceiling
  ([relay.md](./relay.md) -> Web Push). **Copied field by field, never
  spread**, so no Burrow can override the token's `burrowId`.
- **The worker decrypts at the sink**, against the pinned record for that
  `burrowId`, and re-bounds what it recovers. **Any failure, including missing
  WebCrypto, shows the generic content-free notification**, because `userVisibleOnly` makes showing nothing a
  browser-substituted notice ([pocket-app.md](./pocket-app.md) -> Installable
  web app owns the branch list).

Source of truth: `sealPush` / `openPush` / `isSealedPushV1` in
`remote-lib-common/src/security/push-seal.ts`, pinned by
`remote-lib-common/test/push-seal.test.mjs`; `BurrowRuntime.sealPushForClient` in
`lib/src/remote/burrow/burrow-runtime.ts`, `sendPush` in
`lib/src/remote/burrow/push-delivery.ts`;
`lib/src/remote/pocket-app/sw.ts`.

## Burrow bounds

**Every bound is Burrow-enforced and independent of the relay** — Relay-side
gates are defense in depth only, and Burrow correctness must survive a relay that
omits `client-gone`, invents client IDs, or reorders frames. The one-time
runtime holds the same line against the rendezvous (`docs/specs/one-time.md`
-> "Burrow runtime").

| Bound | Value | Declared in |
| --- | --- | --- |
| `MAX_PENDING_PAIRINGS` | 8 | `remote-lib-common/src/security/pairing.ts` |
| `MAX_TOKENS_PER_BURROW` | 8 | `remote-lib-common/src/remote/wire.ts`, shared with the Relay's setup-token cap (rationale) |
| `MAX_CLIENT_ID_LENGTH` | 256 | `remote-lib-common/src/remote/wire.ts` |
| `MAX_RELAY_TO_BURROW_FRAME_LENGTH` | one maximal `ct` + `MAX_CLIENT_ID_LENGTH` + 512 | same |
| `MAX_PENDING_CONNECTION_HANDSHAKES` | 8 | `lib/src/remote/burrow/burrow-runtime.ts` |
| `MAX_QUEUED_RELAY_FRAMES` / `MAX_QUEUED_RELAY_FRAME_CHARS` | 128 frames / 4,194,304 UTF-16 code units | same |
| `MAX_ESTABLISHED_E2E_SESSIONS` | 16 | `remote-lib-common/src/security/e2e-bounds.ts` |
| `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` | 120 000 | same |
| `E2E_INIT_BURST` / `E2E_INIT_REFILL_INTERVAL_MS` | 8 / 1 000 | same |
| `DIRECT_SETUP_TIMEOUT_MS` / `DIRECT_ANSWER_TIMEOUT_MS` / `DIRECT_GATHER_TIMEOUT_MS` / `DIRECT_SRFLX_GRACE_MS` | 15 000 / 10 000 / 3 000 / 500 | `remote-lib-common/src/security/direct-path.ts` |
| `DIRECT_HANDOFF_TIMEOUT_MS` / `DIRECT_DISCONNECTED_GRACE_MS` | `= DIRECT_SETUP_TIMEOUT_MS` (15 000) / 5 000 | same |
| `DIRECT_ONLY_DEADLINE_MS` | `= DIRECT_SETUP_TIMEOUT_MS + DIRECT_HANDOFF_TIMEOUT_MS` (30 000; rationale) | same |
| `MAX_DIRECT_SDP_LENGTH` | 2 000 characters | same |
| `MAX_DIRECT_PENDING_FRAMES` / `MAX_DIRECT_PENDING_BYTES` | 8 192 frames / 4 MiB, bytes binding first; one pair for a receiver's hold and a sender's queue alike (rationale) | same |
| `DIRECT_BUFFER_HIGH` / `DIRECT_BUFFER_LOW` | 256 KiB / 64 KiB | same |
| `MAX_ONE_TIME_FRAME_LENGTH` | one maximal `ct` + 512 | `remote-lib-common/src/remote/one-time-wire.ts` |
| `MAX_ONE_TIME_FORWARDED` | 32 messages, both directions together | same |
| `ONE_TIME_LINK_TTL_MS` / `ONE_TIME_EXPIRY_GRACE_MS` | `= DEFAULT_PAIRING_TTL_MS` (300 000) / 45 000 (> `DIRECT_ONLY_DEADLINE_MS`) | same |
| `ONE_TIME_OPEN_TIMEOUT_MS` | 8 000 | `lib/src/remote/burrow/one-time-runtime.ts` |

- **Must bound waiting relay frames before enqueueing**, by count and cumulative
  received-string length; both `e2e` and `client-gone` share one FIFO and one
  in-flight operation across reconnects. Overflow synchronously closes the relay
  connection and clears its queue and transient state; never skip a transport
  frame and continue its Noise session (rationale).
- **At most one pairing, one connection, and one established session per relay
  client**; a replacement disposes its predecessor, whatever identity it
  belonged to (rationale). Pending pairings expire on the pairing TTL, pending
  connections on the challenge TTL.
- **The session cap is checked at promotion and nowhere else**, after the
  presence proof and the ACL conjunction have both succeeded (rationale). A
  Client static already holding a session **replaces its own** atomically; any
  other identity at the cap gets the fixed-size `burrow-busy` and **evicts no
  other entry**. Pending caps and the token bucket stay active at the cap.
- **A Burrow-global token bucket gates the WebCrypto an accepted `init` buys**, on
  the Burrow's own clock, and **must answer a refused init with nothing**, as for shape or size refusals.
  **Must enforce pending caps after a valid handshake by evicting the oldest
  pending entry**, with the outcome in the expiry table below (rationale).
- **A message is processed only for its exact pending ID and expected step**:
  unknown IDs are dropped without decryption, established frames decrypt only at
  their session's next nonce, and **the first invalid ciphertext destroys its
  session** (rationale).
- **Must reject malformed or over-size routing frames before WebCrypto or entry allocation.**
  **`MAX_RELAY_TO_BURROW_FRAME_LENGTH` is measured on the received string before
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
  | Idle established session | the goodbye, `SessionEndV1` ([remote-api.md](./remote-api.md) → Transport) |
  | Pending pairing evicted at its cap | `superseded` (rationale) |
  | Pending connection evicted at its cap | nothing (rationale) |

- **The idle deadline moves only on a successfully decrypted Client→Burrow
  transport message**, keepalive or application data; **never** on Burrow output,
  a failed decrypt, a relay envelope, a socket ping, or any unauthenticated
  frame (rationale). The Client keepalives on `E2E_KEEPALIVE_INTERVAL_MS` and
  runs the same deadline against its own last send, so a session the Burrow reaped
  ends on both sides ([pocket-app.md](./pocket-app.md)).
- **Every expiry or outcome disposes remote-control attachments without killing
  terminal sessions**, erases Noise state and keys, and removes the entry before
  accepting replacement work. `client-gone` disposes that client's state;
  **losing the Burrow's own relay socket disposes everything, invitations
  included** (rationale).

Source of truth: `lib/src/remote/burrow/burrow-runtime.ts`,
`EstablishedE2eSession` in `lib/src/remote/burrow/established-session.ts` (an
established session's decrypt and idle clock), and `TokenBucket` in
`remote-lib-common/src/security/token-bucket.ts` — the same primitive the Relay
admits Burrow enrollment with ([relay.md](./relay.md#http-api)). Pinned by
`lib/src/remote/burrow/burrow-bounds.test.ts`,
`relay/test/malicious-relay.test.mjs` and
`remote-lib-common/test/token-bucket.test.mjs`.

## Direct path

**The direct path adds no layer to this model.** A WebRTC data channel replaces
the Relay as the carrier of an already-authorized session; every rule above
holds unchanged, because nothing about *what* is carried changes.
[remote-api.md](./remote-api.md) -> "Direct path" owns the design — the session
promoted at [Connection](#connection) and its `CipherState`s, the signals that
ride inside it, and the bound on either end's queue;
[remote-network.md](./remote-network.md) -> "Anywhere" owns its ICE server.
What this model adds is what is *underneath* them.

- **DTLS beneath is transport hygiene this model does not rely on.** It protects
  nothing the Noise session does not already protect, and **the fingerprints in
  an SDP are authentic for exactly one reason — that SDP arrived inside the
  session**. A DTLS peer is never an authenticated one.

**The listener is UDP on every interface a candidate names, for the life of an
attempt.** The standalone Burrow's addon binds one socket on the unspecified
address and advertises each routable interface at that port; a browser binds per
interface. Either way the host answers UDP from anyone who can route to it on
any of those networks. (rationale) Local networks may bind one address instead
([remote-network.md](./remote-network.md) -> "Local networks"); under Anywhere
the NAT mapping STUN opens may admit senders beyond them.
**Two parsers sit behind it and both are attack surface**: before DTLS, ICE's
own STUN parser, which answers a binding request only under this attempt's
ufrag and password (RFC 8445 requires 24 and 128 bits of randomness), both
freshly generated and reaching the peer only inside the session; after DTLS,
the peer implementation's TLS stack — the browser's on the phone, the addon's
on a standalone Burrow (`docs/specs/security-supply-chain.md`). A memory-safety
bug in either is reachable by any stranger on those networks, and nothing above
it mitigates that.

**A channel lost after a session has switched is burrow loss, and that is
accepted**: both ends end the session rather than resume on the Relay. (rationale) The Relay
still sees that the session exists and whether each end is online; it no longer
sees the traffic ([Residual metadata](#residual-metadata)).

Source of truth: `remote-lib-common/src/security/direct-path.ts` (the signals,
their guard, and `DirectCutover`), `lib/src/remote/direct/direct-peer.ts`
(`DirectPeer`), `DirectEndpoint` in
`lib/src/remote/direct/direct-endpoint.ts` (the attempt, the peer, and the
switch, created at promotion by `EstablishedE2eSession` in
`lib/src/remote/burrow/established-session.ts`, which
`BurrowRuntime.#promoteConnection` in `lib/src/remote/burrow/burrow-runtime.ts`
and `OneTimeRuntime.#promote` in `lib/src/remote/burrow/one-time-runtime.ts`
construct, and by `ClientSessionCore.establish` in
`lib/src/remote/client/session-core.ts`). The audited rows are
`docs/specs/security-remote.md` -> "Direct path".

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
  another Burrow, id, or ceremony ([relay.md](./relay.md) -> E2E framing owns
  the field order; `docs/specs/one-time.md` -> "Link" a one-time link's).
  **Application authentication binds to Noise's final handshake hash** — no
  parallel transcript, exporter, KDF, or nonce scheme.
  Sessions use the two `CipherState`s from `Split`, each from nonce zero,
  with empty associated data; routing metadata is never authenticated
  application content. **No rekey**: sessions expire on inactivity.
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

Source of truth: `remote-lib-common/src/security/noise.ts`,
`remote-lib-common/src/security/noise-transport.ts`, pinned by
`remote-lib-common/test/noise.test.mjs` against the attributed vector in
`remote-lib-common/test/vectors/`.

## Burrow identity

**Each Burrow mints one permanent Noise static at enrollment**, before the request
and never in it: `noiseStaticPrivateKey` (PKCS#8, base64url) and
`noiseStaticPublicKey` (raw 32 bytes, base64url) ride in the enrollment record,
landing exactly where `burrowToken` does (`docs/specs/security-remote.md` -> "Credentials at rest").
The Burrow's local label rides there too, reaching a Client only inside an
encrypted outcome.

- **A runtime that cannot mint one does not enroll, and the mint runs *before*
  the exchange**, since a successful `POST /api/burrow/enroll` is not undoable by
  the Burrow (rationale).
- **Both halves, always.** `isEnrollment` rejects a missing half, a malformed
  encoding, or a wrong decoded length.
- **Whatever consumes the static checks that the halves correspond**
  (`deriveNoiseStaticPublicKey`), and **a mismatch keeps the Burrow down**, loudly
  (rationale). An enrollment carrying no usable static reads as un-enrolled and
  the Settings dialog offers enrollment again — the entire Burrow-state version.
- `BurrowRuntime` imports the private half **nonextractably**, never re-exports it,
  and the PKCS#8 in the state file is the only copy that leaves WebCrypto.

**X25519 is probed, not assumed.** `probeNoiseSupport` runs one `generateKey`
and one `deriveBits`, and **every rejection — a missing WebCrypto included — is
`false`, never a throw** (rationale). **Runtimes are gated, not degraded**:
Pocket runs the same probe before sign-in, setup, pairing, or connection and
shows a fixed upgrade requirement on `false`, performing no remote operation
([pocket-app.md](./pocket-app.md)).

Source of truth: `mintNoiseStaticKeyPair` / `importNoiseStaticPrivateKey` /
`deriveNoiseStaticPublicKey` / `isNoiseStaticMaterial` / `probeNoiseSupport` in
`remote-lib-common/src/security/noise.ts`, `isEnrollment` / `performEnrollment`
in `lib/src/remote/burrow/enrollment.ts`,
`BurrowService.#hasUsableNoiseStatic` in `lib/src/host/remote/service.ts`.

## Client static loss

**Never treat browser storage as permanent.** An iOS browser tab is the weakest,
an Android tab is generally durable, and an installed PWA is the preferred mode
on both (rationale).

**Loss is expected, and recovery is a re-run of the normal flow**: scan a fresh
setup code, generate a new per-Burrow static, pair again, optionally revoke the old
record (`revokedAt`). **Nothing is compromised** — the lost key authorized
nothing without its paired passkey.

## Security Guarantees

The checklist an auditor or a change reviewer verifies against, each property
established above and pinned by
`remote-lib-common/test/security-guarantees.test.mjs`:

* Adding a new passkey does not grant Burrow access.
* Compromising the Relay does not let it create an authorized Client.
* Compromising the Relay reveals no pairing decision, Burrow label, remote-api
  message, terminal byte, or notification text.
* Passkey synchronization does not automatically create trusted Clients.
* Every trusted Client must be explicitly paired with every Burrow.
* Every connection requires fresh user presence, single-use and bound to that
  connection's own transcript.
* Every access decision is ultimately made by the Burrow.
* A one-time session is authorized only by typing, on the Burrow, the two
  digits its phone shows; it writes nothing at either end and runs only on the
  direct path (pinned by `lib/src/remote/client/one-time-e2e.test.ts`).

**Never claim this model for paid SaaS before an independent cryptographic
review** of the Noise integration, the WebAuthn channel binding, key storage,
and the push construction. Self-hosting is the shipped deployment and carries no
such claim.

## Residual metadata

**No traffic-analysis resistance, per-Burrow unlinkability, or metadata anonymity
is claimed.** The Relay still observes account and passkey authentication data,
IPs, Burrow IDs and online state, routing relationships, every session's reauth
exchange, push endpoints, timing, ciphertext sizes, and volume — **the last
three only while the Relay is carrying the session**, since a session that has
switched to the [direct path](#direct-path) leaves it the fact of the session
and each end's liveness and nothing else. Two leaks follow and are accepted
rather than closed (rationale): Client→Burrow timing exposes inter-keystroke
timing on a relayed session while keystroke *values* stay encrypted, ending at
the switch — which in exchange shows each paired peer the other's addresses,
until then known only to the Relay — and one
`PushSubscription` per worker scope lets a shared endpoint correlate every
`deliveryId` one Pocket profile registers across Burrows. A push carries no
counter, so a Relay that kept an envelope can re-deliver it
([Push sealing](#push-sealing)).

**Hosted's Relay observes what the self-host Relay does**, each account's in
its own `RelayRoom` ([hosted.md](./hosted.md) -> "Relay sockets").

**Hosted's one-time rendezvous observes each room's timing, both ends' IP
addresses, the room id, and the size and count of the handshake frames it
forwards** — never plaintext, and nothing once the session is direct
([One-time connection](#one-time-connection)).

## Future

Onboarding changes with security surface are staged in the
**selfhost-onboarding** scope ([relay.md](./relay.md) `## Future`).

### Device verification

`getUserMedia` inside a Home Screen web app is observable only on a real iOS
device, and without it the install has only the paste field. The Client-static
storage format surviving an app and phone restart is no longer open: the v3
Home Screen report is in [Client statics](#client-statics)'s rationale and in
[pocket-app.rationale.md](./pocket-app.rationale.md).

### Revocation propagation

The Relay pushing revocations to Burrows. Today `BurrowAcl.revokeClient` /
`revokePasskey` have no callers and no relay frame carries a revocation, so
revoking is hand-editing state ([relay.md](./relay.md), Guardrails) — and
`BurrowService` hands the `BurrowRuntime` one ACL snapshot for its whole
lifetime, so **restarting the Burrow is the entire lever**: it reloads the ACL
*and*, by dropping the relay socket, ends every established session. Editing
alone changes nothing that is running.
