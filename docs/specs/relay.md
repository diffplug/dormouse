# Relay (selfhost)

> See `docs/specs/glossary.md` for Session / Pane / Surface vocabulary; this spec uses it for what the relay exposes.
> Owns the selfhost Relay server (`relay/`): configuration, state files, WebAuthn, the HTTP API, routing, and running and installing it. `docs/specs/burrow-service.md` owns the desktop side — the baked Relay origin, `BurrowService`, enrollment, Settings.
> Read `docs/specs/remote-security-model.md` first — it owns the trust model this one deploys; `docs/specs/remote-api.md` owns what flows after authorization, `docs/specs/pocket-app.md` the Pocket app this Relay serves.

One Node process (Hono). No database. Every security primitive lives in `remote-lib-common`.

## Guardrails

* **One account** (`accountId: "owner"`), created once off a code an enrolled
  Burrow displayed; the setup password enrolls Burrows and registers nothing.
* **Terminal-only**: exactly `docs/specs/remote-api.md` -> "v1 scope".
* **Revocation is hand-editing a JSON file** ("State files"); no management UI.
  **Must re-check a connected Burrow's membership in `burrows.json`** every
  `BURROW_REVOCATION_SWEEP_MS`, the upgrade check running once and a Burrow
  staying connected indefinitely: a revoked Burrow's socket closes
  `WS_CLOSE_BURROW_REVOKED` (4001), its Clients get `burrow-gone`, and a later
  upgrade answers 401. Revoking a *Client* is the Burrow's own ACL and needs a
  Burrow restart (`docs/specs/remote-security-model.md` -> "Revocation propagation").
* **No resume protocol**: a dropped WebSocket is handled by reloading the page or
  reconnecting the Burrow.
* **Everything transient is in memory** (challenges, sessions, presence nonces,
  routing); a Relay restart means everyone reconnects. **Transient stores must
  prune expired entries as they issue** (rationale).
* **A cap that one caller can spend on another's behalf is not a cap.** Every
  keyed transient store is keyed by whoever grew it: setup tokens per minting
  Burrow (`MAX_TOKENS_PER_BURROW`), presence nonces per session
  (`MAX_PENDING_REAUTH_NONCES_PER_SESSION`, with `MAX_REAUTH_NONCE_SESSIONS` LRU
  buckets bounding the total). **The two challenge issuers are the accepted
  exception**: one flat `MAX_PENDING_CHALLENGES` map apiece, whose oldest entry
  a caller past that route's gate (sign-in has none) can evict at the cost of one
  ceremony's retry (rationale).

## Configuration

Production configuration (`pnpm --filter relay start`, containers, installers):

| Env var | Meaning |
| --- | --- |
| `DORMOUSE_ORIGIN` | External origin; source of the WebAuthn `rpId`/`origin` and the Burrow's `ConnectionPolicy`. Default `http://localhost:<port>`. |
| `DORMOUSE_STATE_DIR` | The JSON state files. Default `./data`. |
| `DORMOUSE_POCKET_DIR` | The built Pocket app served at `/*`. Default `lib/dist-pocket` resolved from the compiled Relay's own location, never the cwd (rationale); without an `index.html`, `GET /` is a plaintext stub naming the build command. |
| `PORT` | Default 3000. Blank reads as unset; `PORT=0` is a `ConfigError` (rationale). |
| `DORMOUSE_REQUIRE_USER_VERIFICATION` | Only `true`, trimmed, demands a user-verified assertion for sign-in and re-auth (rationale); mirrored to every Burrow as `ConnectionPolicy.requireUserVerification` (`docs/specs/security-remote.md` -> "Trust boundary"). |
| `DORMOUSE_BIND_HOST` | Interface to listen on; unset binds every interface (below). |
| `DORMOUSE_VAPID_PUBLIC_KEY` / `DORMOUSE_VAPID_PRIVATE_KEY` | Web Push keypair, both or neither; a missing, malformed, or mismatched pair exits at startup. Unset, one is minted into `vapid.json` on first boot. |
| `DORMOUSE_VAPID_SUBJECT` | RFC 8292 contact, defaulted from `DORMOUSE_ORIGIN` ("Web Push"); an invalid value exits at startup. |
| `DORMOUSE_RUNTIME_FILE` | Absolute path of the runtime record, written only once bound (POSIX `0600`); unset writes nothing; relative is a `ConfigError` (rationale). The installers keep it outside `DORMOUSE_STATE_DIR` (`SELF_HOST.md`), which the Relay does not enforce (rationale). |
| `DORMOUSE_RELEASE_ID` | The release directory's name from the installer's `run-relay` wrapper, recorded in the runtime file; `null` when no installer started the Relay. |
| `DORMOUSE_ENROLL_TOKEN_FILE` | Absolute path to the installer's enrollment offer (shape in `remote-lib-common/src/remote/enroll-offer.ts`), which `POST /api/burrow/enroll` accepts in place of the setup password; unset turns one-click enrollment off; relative is a `ConfigError` (rationale). |

**The enrollment offer lasts until the first Burrow enrollment or 24 hours,
whichever comes first**, `burrows.json` existing being the durable marker
(rationale), and **exactly one concurrent redemption wins**.

**Must generate the setup password inside the Relay on first boot — 32 random
bytes as lowercase hex — never accept it as configuration, and persist it as
`setup-password.json`.**

**The Relay itself always speaks plain HTTP**; WebAuthn needs a secure context,
so `localhost` serves development and a real phone needs TLS in front
(`tailscale serve` is the intended selfhost path; any reverse proxy works).

**Must bind loopback when the TLS proxy is local**: a socket on every interface
also publishes the plaintext port to the LAN and the tailnet. The selfhost
installers set `DORMOUSE_BIND_HOST`; the default stays unbound for containers,
where the namespace is the boundary; **every developer and test entrypoint
binds loopback itself**, and an explicit value wins. Binding loopback is
containment, not admission: "HTTP API" owns the gates and
`docs/specs/security-local.md` -> "Loopback Listeners" the admission rule,
which `scripts/loopback-lint.mjs` does not check for this socket (rationale).

**`DORMOUSE_ORIGIN` is normalized to a bare origin exactly once**, in
`readConfig` by `normalizeOrigin`; anything but an `http`/`https` URL with a
host is a `ConfigError` naming the variable (rationale). Every WebAuthn,
enrollment, and pairing-URL compare uses that string rather than re-parsing it.

Source of truth: `readConfig` in `relay/src/config.ts`; `startRelay` in
`relay/src/start.ts`; `redeemEnrollToken` in `relay/src/enroll-token.ts`;
`SetupPasswordStore` in `relay/src/state.ts`; `RuntimeInfo` in
`relay/src/runtime-file.ts`. `relay/test/bind-host.test.mjs` pins that the
bind, not just the config, holds.

## State files

Five JSON files, sketched because hand-editing them is the revocation mechanism
(Guardrails):

- `account.json` — `{ accountId, passkeys: [{ credentialId, publicKey /* SPKI b64u */, label, createdAt }] }`
- `burrows.json` — `[{ burrowId, burrowToken, enrolledAt }]`; **no label**: the Relay keeps no name for a Burrow
- `push-subscriptions.json` — `[{ burrowId, deliveryId, endpoint, keys, vapidPublicKey, subscribedAt }]`
- `vapid.json` — `{ publicKey, privateKey, createdAt }`; only when env configures no keypair
- `setup-password.json` — `{ password, createdAt }`

**Must refuse a malformed singleton record** (`account.json`, `vapid.json`,
`setup-password.json`) rather than mint over it as first boot.

**The Burrow's ACL is never here**; it lives with the Burrow
(`docs/specs/burrow-service.md` -> "Burrow side").

**Any new file under `$DORMOUSE_STATE_DIR` must go through `writeAtomic`**:
temp-file-plus-rename, every mutation serialized per store, POSIX `0o700` for
the directory and `0o600` for files — `burrows.json` holds each `burrowToken`
in plaintext, `vapid.json` a private key. **Never build anything on that mode**
(rationale); the installed Relay's state is protected by the installer's
directory permissions ("Installing it").

**Collection rows are validated as they are read**, a half-finished hand edit
being an expected state: a malformed `burrows.json` row is dropped (rationale);
a malformed subscription reads as a missing registration, which Pocket repairs
by re-offering Enable.

**`burrowId` is base64url of 16 bytes (`isE2eId`) on both sides** (rationale):
a wrong shape reads as un-enrolled on the Relay and fails enrollment on the
Burrow.

**A subscription whose `burrowId` has left `burrows.json` is dropped on read**,
so revoking a Burrow cascades without a restart; **an absent `burrows.json`
drops nothing**. A pre-end-to-end row is dropped too, with one warning per
process.

`push-subscriptions.json` is the one store that deletes:

* **Rows are keyed on (`burrowId`, `deliveryId`)**, so a phone paired with two
  laptops subscribes twice and a Burrow reads or reaches only its own
  subscribers. Each row records the VAPID public key it was registered under, so
  a key rotation reads as stale.
* **An upsert whose endpoint differs drops every row on an address this delivery
  is moving off**, under every Burrow, one service-worker scope having one
  subscription. **A brand-new `deliveryId` cannot know its scope's previous
  address**, so those rows survive a re-pair until a 404/410 retires them
  (rationale).
* **The upsert answers the state it left** — every Burrow the endpoint is
  registered with under the current VAPID key — so retrying a committed POST
  whose answer was lost is idempotent.
* **Every stored field is bounded and the row count capped** (rationale):
  `MAX_PUSH_ENDPOINT_LENGTH`, keys that must decode to an RFC 8291 P-256 point
  and 16-byte secret (`importableWebPushKeys`), and
  `MAX_PUSH_SUBSCRIPTIONS_PER_BURROW` / `MAX_PUSH_SUBSCRIPTIONS_TOTAL`,
  **evicting the oldest first and never the row just written**.

Source of truth: `relay/src/state.ts`, including `MAX_PUSH_SUBSCRIPTIONS_TOTAL`;
the per-Burrow cap and field bounds in
`remote-lib-common/src/remote/relay-common.ts`; `importableWebPushKeys` in
`remote-lib-common/src/remote/web-push.ts`.

## WebAuthn without a WebAuthn library

No WebAuthn library (rationale): registration requests `attestation: 'none'`
and reads the SPKI key from `response.getPublicKey()`. **Assertions go through
`verifyPasskeyAssertion` in `remote-lib-common`, the Burrow's own verifier**, so
Relay and Burrow cannot disagree on a valid assertion.

- **Registration** (`checkRegistration`, shared with the Hosted Relay) **must
  redeem the challenge before the origin check**, so a wrong-origin registration
  still burns it, and requires a key that imports as ECDSA P-256. A credential id
  already stored is a 409, so re-registration cannot displace a stored key.
- **Must verify sign-in and re-auth against the stored passkey under the Relay's
  UV policy**, consuming the challenge or presence nonce first. An unknown
  credential is 404. Both Relays refuse with the error constants in
  `remote-lib-common/src/remote/wire.ts`.
- **Setup and sign-in each get their own `ChallengeIssuer`**, so a challenge
  minted for one cannot redeem in the other; each is capped
  (`MAX_PENDING_CHALLENGES`) as well as swept (rationale). Re-auth uses
  `PresenceNonceStore`.
- **The browser's `clientDataJSON.challenge` is canonicalized by decoded bytes
  before lookup**, so a padded serialization redeems without weakening single
  use.

Source of truth: `checkRegistration` / `verifySigninAssertion` in
`remote-lib-common/src/remote/relay-common.ts`.

## HTTP API

Paths and shapes are `API_ROUTES` / `WS_ROUTES` and their types in
`remote-lib-common/src/remote/wire.ts`, shared by Relay, Burrow, and Pocket.

| Route | Auth | Does |
| --- | --- | --- |
| `GET /api/hello` | — | Fixed health response; **carries no release identity**, which the runtime file holds ("Installing it") |
| `POST /api/setup/begin` | setup token | Registration challenge, gated exactly as `finish` is; answers the account's credential ids for a retry's `excludeCredentials` |
| `POST /api/setup/finish` | setup token | Registers the passkey; `label` is reduced (`boundedPushText`), never refused |
| `POST /api/setup/retire` | session token | Spends a live setup token, registering nothing (rationale); 204, or 401 `SETUP_TOKEN_INVALID_ERROR` |
| `POST /api/signin/begin` | — | Sign-in challenge |
| `POST /api/signin/finish` | — | Verifies the assertion; issues a 12-hour in-memory session token |
| `POST /api/reauth/begin` | session token | Takes a `PresenceBinding`, mints a single-use `relayNonce`, answers `presenceChallenge(binding, nonce)` with the bound credential as the sole `allowCredentials` entry; 404 for an unregistered credential |
| `POST /api/reauth/finish` | session token | Verifies against the **stored** key for that credential; **extends nothing** — not the session, not the relay socket |
| `POST /api/burrow/enroll` | setup password or enroll token | Exactly one credential, else 400. **Takes no label.** A foreign `origin` is a 409 `ORIGIN_MISMATCH_ERROR` naming the Relay's, ahead of the credential (rationale); absent, it enrolls (an older Burrow). `MAX_ENROLLED_BURROWS` is checked after the credential (rationale) |
| `POST /api/burrow/setup-token` | burrow token | Mints the token behind this Burrow's QR (below) |
| `GET /api/burrows` | session token | Enrolled Burrows and whether each is connected |
| `GET /api/push/config` | — | The public VAPID key, or `null` when push is off |
| `POST /api/push/subscribe` | session token | Upserts `(burrowId, deliveryId)`; 404 for an unknown `burrowId` (rationale) |
| `POST /api/push/subscriptions/query` | session token | Which **presented** `deliveryIds` are registered, and for which Burrow |
| `DELETE /api/push/subscriptions/:deliveryId` | session token | **Always 204**, revealing nothing |
| `GET /api/push/devices` | burrow token | This Burrow's `deliveryId`s under the current VAPID key |
| `POST /api/push/send` | burrow token | One sealed envelope per named delivery ("Web Push") |
| `GET /ws/burrow` | burrow token | The Burrow's relay socket |
| `GET /ws/client` | session token | A Client's relay socket |
| `GET /*` | — | The built Pocket app, registered last; cache policy and SPA fallback: `docs/specs/pocket-app.md` |

The device-code routes `burrowEnrollBegin` / `burrowEnrollPoll` are Hosted's
(`docs/specs/hosted.md` -> "Burrow enrollment"); here they 404. The Relay emits
no cross-origin grant (`docs/specs/security-remote.md` -> "Cross-origin access").
**WS auth rides the `token` query param**, browsers being unable to set
WebSocket headers.

**Every request body is bounded at `MAX_REQUEST_BODY_BYTES` before any route or
credential gate runs** (rationale), so a correct credential in an over-long body
is still 413. **Only `/api/push/send` is exempt**, at
`MAX_PUSH_SEND_BODY_BYTES`, derived from what a maximal fan-out costs.

**Must admit Burrow enrollment through one process-global `TokenBucket` before
body parsing** (`BURROW_ENROLL_ATTEMPT_*`); empty, it answers 429 with
`Retry-After`.

**Must compare the setup password in constant time, and delay only that
rejection** (rationale); Burrow tokens use a constant-time full-row scan.
**Must reject a `burrowToken` outside its minted 32-byte base64url shape before
reading `burrows.json`**; that read is cached on the file's stat, so a hand edit
still revokes at once.

**Every session-gated route, the `/ws/client` upgrade included, answers an
unknown or expired token 401 with exactly `UNAUTHORIZED_ERROR`**, which Pocket
keys its sign-in recovery on (`docs/specs/pocket-app.md` -> "An expired session
drops to sign-in"); a rejected enroll token answers the same body and delay.
**A rejected setup token answers the distinct `SETUP_TOKEN_INVALID_ERROR`**,
undelayed, which Pocket keys "scan again" on.

Source of truth: `createApp` in `relay/src/app.ts`; `TokenBucket` in
`remote-lib-common/src/security/token-bucket.ts`.

### Setup tokens and the pairing QR

An enrolled Burrow mints a setup token over its own authenticated channel; the
answer is `{ token, expiresAt }` with no origin, the Burrow composing the QR
from its enrolled origin. **Scanning is the only way a passkey is registered.**

**The QR grammar is this spec's.** Exactly
`<enrolledOrigin>/#pair?<v>.<burrowId>.<inviteId>.<expiry>.<setupToken>.<ephPub>`,
the bare origin appearing only as the prefix, so a native camera reaches the
right self-hosted Pocket and **the fragment never reaches the Relay**. The
fragment is positional and dot-delimited, with no field names:

| Field | Encoding, exact length | Purpose |
| --- | --- | --- |
| `v` | literal `1`, one character | E2E wire version; any other value is rejected, never negotiated |
| `burrowId` | 16 bytes as 22-character unpadded base64url | relay destination |
| `inviteId` | 16 bytes as 22-character unpadded base64url | single-use invitation held only in Burrow memory |
| `expiry` | unsigned 32-bit epoch seconds as exactly 10 decimal digits | advisory Client fail-fast; Burrow memory stays authoritative |
| `setupToken` | 32 bytes as 43-character unpadded base64url | credential for `/api/setup/*` |
| `ephPub` | 32-byte X25519 public key as 43-character unpadded base64url | one-use Burrow Noise responder key for this invitation |

**`PAIRING_QR_URL_MAX_LENGTH` (256) is enforced before any encoder runs**, so a
mint over it fails naming the origin.

**`parsePairingInvitationUrl` answers the complete invitation or `null`** —
never a partial parse, never an error a caller can distinguish. Two of its
checks are this spec's: the URL is **HTTPS, or plain HTTP on exactly
`localhost`, `127.0.0.1`, or `[::1]`** (rationale), and its origin **equals the
running app's exactly** — the only thing keeping a code from bootstrapping
another deployment's Pocket.

- **`/api/burrow/enroll` counts its credential by presence, not type**
  (rationale); a setup route without a live token is the same 401 as one with a
  dead one.
- **`begin` peeks; `finish` consumes before validating the registration**, so
  of two overlapping finishes one registers. A failure past that restores the
  token on its original expiry; a confirmed revocation leaves it spent. `retire`
  consumes and registers nothing.
- **Both gates re-read `burrows.json`**, so a revoked Burrow's tokens die with it.
- **TTL is `DEFAULT_PAIRING_TTL_MS`**, the invitation's; each Burrow's
  outstanding tokens are capped at `MAX_TOKENS_PER_BURROW`, its own oldest
  evicted, the Burrow bounding its invitation map at the same number.

Source of truth: `remote-lib-common/src/security/pairing-invitation.ts` and
`parseLinkFragment` in `remote-lib-common/src/security/link-url.ts`, with exact
vectors in `remote-lib-common/test/pairing-invitation.test.mjs`;
`relay/src/setup-token.ts`. What the invitation proves:
`docs/specs/remote-security-model.md` -> "Pairing".

### Web Push

The Relay reaches a phone whose app is closed through the platform's push
service, via `web-push`; the Burrow and webview halves are
`docs/specs/alert.md` -> "Push notifications".

- **Two audiences, two credentials.** A Client registers, queries, and deletes
  its own rows with a session token plus the `deliveryId` the Burrow minted; a
  Burrow reads and sends with its `burrowToken`. **The send route takes the
  `burrowId` from the token, never the body.**
- **The Relay never selects recipients**: an absent or empty `recipients` is a
  400, not a fan-out.
- **Possession of the delivery id is the whole authorization** (256 unguessable
  bits). **The Relay never lists delivery ids to a session**, and
  `/api/push/devices` gives a Burrow identities only: **the endpoint and its keys
  never leave the Relay**.
- **Delivery views are VAPID-current**: rows registered under another key are
  omitted from query, devices, and send (rationale), and stay on disk until
  Pocket re-registers.
- **A subscription authorizes nothing**; the Burrow's ACL alone decides what a
  Client reaches.
- **Endpoint egress is public HTTPS only.** Registration refuses credentials,
  localhost, and non-public IP literals; delivery's own HTTPS agent refuses, at
  connect time, a hostname with any non-public answer and connects to the exact
  address it checked. Ranges: `docs/specs/security-remote.md` -> "What crosses
  the boundary".
- **The payload is sealed and the Relay reads none of it**:
  `docs/specs/remote-security-model.md` -> "Push sealing".
- **404/410 deletes the row; any other refusal is logged — by endpoint origin
  only, the endpoint being a bearer capability — with the push service's reason
  (rationale), and counted in `failed`**, the route answering 200 either way.
- **A per-request inactivity timeout and a per-send wall-clock deadline both
  resolve as `failed`**, keeping the row; **the deadline is the route's, not the
  sender's**, so it holds for any injected `PushSender` (rationale). **Must count
  sender throws as `failed`**, preserving sibling deliveries.
- **Push is disabled, not half-working, and only a missing VAPID subject
  disables it**: `/api/push/config` answers `null` and subscribe/send 503.
- **A VAPID subject naming a loopback host is a startup error, not a default**
  (rationale): the default is `DORMOUSE_ORIGIN` when that is https and not
  loopback, else none.

Source of truth: `relay/src/push-endpoint.ts`; `relay/src/push.ts`, including
`assertVapidSubject`; `defaultVapidSubject` in
`remote-lib-common/src/remote/web-push.ts`.

## Routing

The Relay routes JSON envelopes between Client and Burrow sockets
(`@hono/node-ws`). **`clientId` is a Relay-assigned secret** stamped onto every
Burrow-bound frame so the Burrow can address replies, and never sent to a Client.

**The `e2e` envelope is the whole surface.** Four `t: 'e2e'` frames:
Client→Relay, Relay→Burrow with `clientId` stamped, Burrow→Relay, Relay→Client
with `burrowId` stamped from the socket. A Burrow handles exactly these and
`client-gone`, ignoring anything else; any other Client frame type is answered
with an `error` and reaches no Burrow.

- **An `init` binds** the Client socket to the named Burrow, replacing any
  binding; the previously bound live Burrow gets `client-gone` first.
- **A `transport` frame is forwarded only within that binding**, in either
  direction; one outside it is dropped.
- **Never parsed, never remembered, never authorized**: the Relay does not decode
  `ct`, keeps no Noise state, and verifies nothing; only the Burrow knows whether
  a ceremony succeeded.
- **Shape bounds are defense in depth, on a both-sides rule**
  (`isE2eClientFrame` / `isE2eBurrowFrame`): a malformed Client frame gets an
  `error`, a malformed Burrow frame is dropped, and **the Burrow runs the same
  guard on arrival** (rationale).
- **Every Relay reads and rebuilds frames through one frame layer**
  (`remote-lib-common/src/remote/relay-routing.ts`) **and passes the same
  routing cases** (`remote-lib-common/test/harness/relay-parity.mjs`, registered
  by `relay/test/relay.test.mjs`, `relay/test/e2e-relay.test.mjs`, and
  `hosted/server/tests/relay-room.test.ts`).

Resource bounds:

* **`maxPayload` is `MAX_RELAY_FRAME_BYTES`**, derived from the frame guards'
  bounds and counted in UTF-8 bytes on every Relay; over it the socket closes
  1009.
* **Client sockets are capped at `MAX_RELAY_CLIENT_SOCKETS`; the next is
  refused (1013), never admitted by evicting another.**
* **An expired session's socket is closed** 1008 `unauthorized`, the pair the
  upgrade answers with. **Only a registered conn is routed or torn down**, so a
  frame buffered behind that close cannot open a ceremony.
* **A half-open socket is closed by heartbeat**: unanswered within
  `RELAY_IDLE_TIMEOUT_MS`, it is unregistered and closed 1001.

**Must answer the text `RELAY_PING` with `RELAY_PONG`** on either socket kind,
compared whole before any parse, never forwarded and never an `error`. **The
Burrow and Pocket ping every `RELAY_PING_INTERVAL_MS` and enforce a deadline
only once a pong has arrived on that socket**, so a Relay that never answers is
never held to one; Pocket pauses while the page is hidden.

**Only one socket may own a `burrowId`.** A second registration displaces the
first: its Clients get `burrow-gone`, **their bindings are cleared at
replacement time** (the new process has a fresh ACL), and the old socket closes
`WS_CLOSE_BURROW_REPLACED` (4000), on which the evicted Burrow stands down
(`docs/specs/burrow-service.md` -> "Burrow side").

Source of truth: `RelayHub` in `relay/src/relay.ts`; the sweeps in
`relay/src/app.ts`; the frame guards and `RELAY_PING` in
`remote-lib-common/src/remote/wire.ts`; the bounds in
`remote-lib-common/src/remote/relay-common.ts`; `RelayHeartbeat` in
`lib/src/remote/ws.ts`.

### Pairing (phone ↔ laptop, first time)

```
phone                        relay                        burrow (laptop)
  |   scan the Burrow's QR        |                              |
  |-- setup (token) ----------->|  registers a passkey         |
  |-- signin (passkey) -------->|  session token               |
  |-- e2e init (Noise msg 1) -->|-- e2e init {clientId} ------>|  invitation -> reserved
  |<-- e2e response ------------|<-- e2e response (Noise msg 2) |
  |-- reauth begin/finish ----->|  presence challenge + nonce  |
  |-- e2e transport ----------->|-- e2e transport ------------>|  proof verified,
  |    {code, label, proof}     |                              |  modal opens
  |                             |                              |  user types the code
  |<-- e2e transport -----------|<-- e2e transport ------------|  ACL record written
  |    PairingOutcomeV1         |     (same size either way)   |
```

What each step establishes: `docs/specs/remote-security-model.md` -> "Pairing".

### Connect (every session)

```
phone                        relay                        burrow
  |-- e2e init (Noise msg 1) -->|-- e2e init {clientId} ------>|
  |<-- e2e response ------------|<-- e2e response (msg 2 =     |
  |                             |     32-byte Burrow challenge)  |
  |   ONE biometric prompt:     |                              |
  |-- reauth begin/finish ----->|  presence challenge + nonce  |
  |-- e2e transport ----------->|-- e2e transport ------------>|  challenge consumed,
  |    ConnectionRequestV1      |                              |  proof + ACL checked
  |<-- e2e transport -----------|<-- ConnectionOutcomeV1 ------|
  |====== protocol-v1 inside the same Noise session ==========>|
```

What each step establishes: `docs/specs/remote-security-model.md` ->
"Connection"; what then flows: `docs/specs/remote-api.md` -> "Transport".

### E2E framing

**Must frame Client and Burrow transport messages with the shared
`noise-transport` module once `Split` has run.**

- **Transport plaintext is `[kind: u8][body]`**: `0x00` keepalive, exactly 32
  zero bytes; `0x01` stream, a slice of the application byte stream; `0x02`
  control, UTF-8 JSON NUL-padded to exactly `CONTROL_PAYLOAD_SIZE`, so an
  approval and a denial are one size on the wire. Any other kind, body length,
  or non-object JSON is rejected.
- **Each application message is `u32 big-endian length || bytes`**, chunked so
  every Noise message fits 65,535 bytes. **A declared length over
  `MAX_APP_MESSAGE_LENGTH` is rejected as soon as its prefix arrives.**
- **The first failure poisons the session**: a decrypt failure, a nonce gap or
  reorder, or a framing violation destroys it and every later call throws.
- **The control messages are the two ceremonies' outcomes, the direct path's
  signals** (`docs/specs/remote-api.md` -> "Direct path"), **and the Burrow's
  goodbye** (`docs/specs/remote-api.md` -> "Transport").
- **Prologues are `lengthPrefixedConcat`** of `dormouse/e2e/v1`, the ceremony
  kind, the `burrowId`, and then the connection id for a connection, or for a
  pairing the invitation's `v`, `inviteId`, `expiry`, `setupToken`, `ephPub` —
  `burrowId` ahead of `v` here, behind it in the QR.

Source of truth: `remote-lib-common/src/security/noise-transport.ts`.

## Testing

`pnpm --filter relay test` drives setup → pairing → connect through real HTTP and
WebSocket boundaries: `FakeBurrow` and `FakeClient` in
`remote-lib-common/test/harness/` run both ceremonies over the shared
primitives, and process-level tests spawn the real entrypoint.
`remote-lib-common/test/security-guarantees.test.mjs` drives the security
model's guarantee list. `relay/test/malicious-relay.test.mjs` runs both halves
over a Relay that tampers with frames, ending with a guard-less router whose
frames the Burrow must refuse itself. Browser-dependent Burrow and Pocket UI
remain dogfood coverage.

## Running it

**1. Relay + Pocket**: `pnpm dev:relay` builds both and prints the bound URL.

- **The dev runner binds an OS-assigned port unless `PORT` is pinned**, deriving
  the default origin from it; **a pinned port that is occupied fails without
  stopping its owner**. Production `PORT` rules ("Configuration") are unchanged.
- **Dev state defaults to `<worktree>/relay/data` regardless of cwd**;
  `DORMOUSE_STATE_DIR` overrides it **unless it equals `DORMOUSE_RECOVERY_DIR`**,
  which an older Dormouse leaks as both.
- **Explicit origin and bind-host overrides are kept**; a blank bind host means
  loopback.
- **Use the printed origin for the Burrow, enrollment, and Pocket**; pin
  `PORT=3000 pnpm dev:relay` to keep it across restarts, as below.

For a real phone set `DORMOUSE_ORIGIN` to your TLS origin (e.g. via
`tailscale serve`). On localhost **push is off**, and the Relay says so at
startup ("Web Push"); to exercise it there, supply a contact:

```sh
DORMOUSE_VAPID_SUBJECT=mailto:you@example.com pnpm dev:relay
```

**2. Burrow**: a dev build baked with the local origin
(`docs/specs/burrow-service.md` -> "Relay origin"):

```sh
DORMOUSE_RELAY_ORIGIN=http://localhost:3000 pnpm dev:standalone
```

Enroll once in **Settings → Network**: choose **My Relay only**, then the
`password` from the generated `setup-password.json` and a name. The scripting
seam does the same from the webview's devtools console:

```js
await window.dormouseBurrow.enroll('<64 hex characters>', 'My Laptop')
```

For a headless stand-in Burrow, `node relay/scripts/fake-burrow.mjs
http://localhost:3000` reads the same state, prints a pairing URL, and
auto-approves.

**3. Phone** (or any other browser profile): open the Relay origin, show a code
on the laptop (**Settings → Network → Set up a phone**), and scan or paste it;
read the two digits into the laptop's modal. A code the phone's own camera opens
only bootstraps the origin; scan again inside the app
(`docs/specs/pocket-app.md`). For push, add Pocket to the Home Screen before
scanning (`docs/specs/pocket-app.md` -> "Installable web app"); **the Enable tap
is the user gesture iOS requires**.

Limitations: each browser partition needs its own pairing; clearing site data
destroys it; a dropped WebSocket returns to the Burrows view, where Connect
reconnects.

`scripts/pairing-walkthrough/README.md` drives all three in real browsers; the
run is not in CI.

Source of truth: `relay/scripts/dev.mjs`; `devStateDir` in
`relay/scripts/dev-paths.mjs`.

## Installing it

The shipped selfhost deployment is a per-login user agent on the user's own
machine, reachable only from their tailnet, `tailscale serve` terminating HTTPS
and proxying to the Relay on loopback.

**`SELF_HOST.md` is both the operator runbook and the installer spec**,
audited by the `FAIL IF` lines in `docs/specs/security-remote.md` and checked
by `scripts/deploy-lint.mjs` (`pnpm lint:deploy`). Two couplings stay here: the
Relay writes `DORMOUSE_RUNTIME_FILE` / `DORMOUSE_RELEASE_ID` once bound
("Configuration"), so the installers' health checks prove *which* release
answered; and a Burrow reaching it needs a build baked with its origin
(`docs/specs/burrow-service.md` -> "Relay origin").

Source of truth: `deploy/local/install-macos.sh`,
`deploy/local/install-windows.ps1`, `deploy/local/install-linux.sh`.

## Future

**Scope: selfhost-onboarding** — collapse self-host first-run friction. The
first run is now *run installer → click Enroll → scan QR → approve*, with
nothing typed on the phone (Setup tokens, `docs/specs/burrow-service.md`,
[pocket-app.md](./pocket-app.md)); the setup password enrolls Burrows only, and
every phone-side item is done. One settled decision constrains what is left:
**the stock binary reaches only the default origin**
(`docs/specs/burrow-service.md` -> "Relay origin") — self-hosting keeps
requiring a source build, deliberately, so nothing may depend on a stock build
reaching another. Nor is a resume token staged — every new session requires
fresh WebAuthn presence, by design
([remote-security-model.md](./remote-security-model.md) -> Presence proofs).

Unstaged but adjacent: origin migration (re-binding the passkey and enrollments
after a Tailscale node rename), and the revocation UI staged in
[remote-security-model.md](./remote-security-model.md) `## Future`.
