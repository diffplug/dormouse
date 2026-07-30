# Server (selfhost)

> See `docs/specs/glossary.md` for Session / Pane / Surface vocabulary; this spec uses it for what the relay exposes.

The coordinating Server from the
[remote security model](./remote-security-model.md), in its selfhost mode, cut
down to the smallest thing that completes this loop:

> Run the server with a setup password. Visit it, present the password, create
> a passkey. Pair your phone with your laptop's Dormouse Terminal. Pick up a
> running terminal session from the laptop on the phone.

One Node process (Hono, as the `server` package already is). No database. No
browser-surface support — **terminal-only**. The heavy lifting is already
done: every security primitive lives in `server-lib-common`, and the terminal
UI lives in `lib`/`standalone`.

## Guardrails

* One account (`accountId: "owner"`), created once with the setup password.
* Terminal surfaces only — exactly remote-api.md's **protocol-v1** (browser
  remoting is staged in that spec's `## Future`).
* Revocation is editing a JSON file by hand; no management UI.
* A dropped WebSocket is handled by reloading the page / reconnecting the
  host. No resume protocol.
* Everything transient (challenges, sessions, relay state) is in memory; a
  server restart just means everyone reconnects.

## Configuration

| Env var                   | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `DORMOUSE_SETUP_PASSWORD` | Required. Gates account creation and host enrollment.      |
| `DORMOUSE_ORIGIN`         | External origin, e.g. `https://dormouse.tailnet.ts.net`. Source of the WebAuthn `rpId`/`origin` and the Host's `ConnectionPolicy`. Defaults to `http://localhost:<port>` for dev. |
| `DORMOUSE_STATE_DIR`      | Where the JSON state files live. Default `./data`.         |
| `PORT`                    | Default 3000.                                              |
| `DORMOUSE_VAPID_PUBLIC_KEY` / `DORMOUSE_VAPID_PRIVATE_KEY` | Web Push signing keypair. Set both or neither. At startup the Server decodes both, derives the P-256 public point from the private key, and exits on a missing, malformed, or mismatched pair. Unset, the server mints a pair on first boot and persists it to `vapid.json`. |
| `DORMOUSE_VAPID_SUBJECT`  | `mailto:`/`https:` contact for push-service operators (RFC 8292). Default `mailto:admin@localhost`. The Server parses and validates it at startup and exits on an invalid value. |

WebAuthn requires a secure context: `localhost` works for development; for a
real phone, put the server behind TLS (`tailscale serve` is the intended
selfhost path, any reverse proxy works). The server itself always speaks
plain HTTP.

`DORMOUSE_ORIGIN` is parsed once and normalized with `URL.origin`; WebAuthn
clientData checks, passkey assertion verification, and the Host enrollment
policy all use that normalized origin.

## Host webview CSP (self-host builds)

The standalone Host is a Tauri app, and its webview `connect-src` bounds where
the Host can reach a relay server. The shipped binary is scoped to the SaaS
origin only (`https://*.dormouse.sh wss://*.dormouse.sh`, plus localhost for
dev), so a compromised webview cannot exfiltrate to an arbitrary host. A
self-host server on a different origin is therefore reached only by a custom
build: set `DORMOUSE_REMOTE_CONNECT_SRC` when building
(`pnpm --filter dormouse-standalone tauri build`) to the CSP sources for your
server, e.g. `https://dormouse.example.com wss://dormouse.example.com` (or a
tailnet wildcard `https://*.ts.net wss://*.ts.net`). It replaces the default
SaaS sources; localhost and the rest of the policy are untouched. The default
is deliberately not internet-wide — widening it is an explicit, per-build
opt-in.

Reserved: the `https://*.dormouse.sh wss://*.dormouse.sh` entries are
*wildcards* on purpose. The BYOT posture (`## Future`, Scope: saas-multitenant)
has the stock client connect to per-tenant subdomains such as
`tenant-xyz.dormouse.sh` without a custom build, so narrowing them to a fixed
host would foreclose it.

## State files

```
$DORMOUSE_STATE_DIR/
  account.json   { accountId: "owner",
                   passkeys: [{ credentialId, publicKey /* SPKI b64u */,
                                label, createdAt }] }
  hosts.json     [{ hostId, hostToken, label, enrolledAt }]
  push-subscriptions.json
                 [{ hostId, devicePublicKey, endpoint, keys,
                    vapidPublicKey, subscribedAt }]
  vapid.json     { publicKey, privateKey, createdAt }   (only when unset by env)
```

That is the entire persistent state. The Host's ACL is not here — it lives on
the Host, in webview `localStorage` (`lib/src/lib/local-json-store.ts`),
which is the whole point of the security model.

`push-subscriptions.json` is the one store that deletes rather than appends: a
push service reports a dead subscription with 404/410, and a browser that
rotates its endpoint must replace the stale row rather than leave one per
rotation. Rows are keyed on the **pair** (`hostId`, `devicePublicKey`), so a
phone paired with two laptops subscribes twice and a Host can only ever read or
reach its own subscribers. Each row records the public VAPID key it was
registered under, so a key rotation makes the Client readback treat the row as
stale and offer re-registration rather than claiming delivery still works.
Because one service-worker scope has only one subscription, an upsert whose
endpoint, encryption keys, or VAPID key differs from an existing row for that
device atomically deletes all of the device's prior Host rows; the response
tells Pocket to discard the same stale Host ids. It holds no label — the Server
never learns one. Source of truth: `PushSubscriptionStore.upsert` in
`server/src/state.ts` and the subscribe route in `server/src/app.ts`.

`hosts.json` stores `hostToken` — the host↔server relay bearer secret — in
plaintext, and `vapid.json` a private key, so both files are written owner-only:
the state dir is created
`0o700` and every write lands in a `0o600` temp file before the rename
(`server/src/state.ts`, `writeAtomic`). Without explicit modes these inherit
the umask and end up world-readable, handing live host tokens to any other
local account on a shared machine. Any new file under `$DORMOUSE_STATE_DIR`
must go through `writeAtomic` for the same reason.

## WebAuthn without a WebAuthn library

Two facts keep the server dependency-free:

* **Registration**: browsers expose the new credential's public key directly —
  `response.getPublicKey()` returns SPKI DER. The Pocket page sends
  `{ credentialId, publicKey, clientDataJSON }`; the server checks
  `clientDataJSON` (`type === 'webauthn.create'`, its challenge, its origin)
  and stores the key. No CBOR, no attestation parsing (we request
  `attestation: 'none'` anyway).
* **Assertions**: `verifyPasskeyAssertion` in `server-lib-common` already
  verifies full assertions against an SPKI key — the same function the Host
  uses, so Server and Host literally cannot disagree on what a valid assertion
  is.

Server-issued challenges (registration, sign-in) reuse `HostChallengeIssuer`
— it is a generic single-use/TTL challenge store despite the name.

Before a challenge is consumed, the server canonicalizes the browser's
`clientDataJSON.challenge` by decoded base64url bytes, so padded browser
serializations redeem the issued challenge without weakening single-use replay
protection.

This also makes the server fully testable without a browser: the
`SimAuthenticator` harness in `server-lib-common` produces real assertions,
so `node --test` can drive setup → pairing → connect end to end via
`app.request()` and real WebSockets against an ephemeral-port server.

## HTTP API

| Route                            | Auth           | Does                                              |
| -------------------------------- | -------------- | ------------------------------------------------- |
| `GET /*`                         | —              | Serves the Pocket web app (static build of `lib`'s pocket entry) |
| `POST /api/setup/begin`          | setup password | `{ challenge }` for registration. Only the password gates it — re-presenting the password adds another passkey to the account |
| `POST /api/setup/finish`         | setup password | `{ credentialId, publicKey, clientDataJSON }` → creates/updates `account.json` |
| `POST /api/signin/begin`         | —              | `{ challenge }` for sign-in                        |
| `POST /api/signin/finish`        | —              | full assertion → verified → `{ sessionToken, passkeyPublicKey }` (token is random, in-memory, hours-scale TTL) |
| `POST /api/reauth/begin`         | session token  | `{ challenge }` to re-assert presence on the current session |
| `POST /api/reauth/finish`        | session token  | full assertion → verified (same checks as sign-in) → refreshes the session's presence stamp; the token and relay socket are kept |
| `POST /api/host/enroll`          | setup password | `{ label }` → `{ hostId, hostToken, origin, rpId }`; appends to `hosts.json` |
| `GET /api/hosts`                 | session token  | Enrolled hosts + whether each is currently connected |
| `GET /api/push/config`           | —              | `{ applicationServerKey }` — the VAPID public key, or `null` when push is unconfigured. Public by construction |
| `POST /api/push/challenge`       | session token  | `{ challenge }` for the device signature below (no body — the challenge is a pool-wide nonce; the host binding lives in the signature) |
| `POST /api/push/subscribe`       | session token + device signature | Upserts the `(hostId, devicePublicKey)` subscription |
| `GET /api/push/subscriptions`    | session token  | The account's registrations for the current VAPID key as identities, so a reloaded Client can tell which Hosts it already registered with. With push disabled, returns the stored identities for diagnosis |
| `GET /api/push/devices`          | host token     | The `devicePublicKey`s subscribed to **this** Host under the current VAPID key |
| `POST /api/push/send`            | host token     | Fans a notification out to the named devices; `devicePublicKeys` is required |
| `GET /ws/host`                   | host token     | The Host's relay socket                            |
| `GET /ws/client`                 | session token  | A Client's relay socket                            |

The setup password is compared in constant time with a small fixed delay on
failure; that is the extent of the hardening today.

### Web Push

The relay routes between two live sockets; a push has to reach a phone whose app
is closed. That is a separate capability, so it is plain HTTP rather than a new
relay frame, and delivery goes out to the platform's push service (APNs, FCM)
through `web-push` — the one third-party runtime dependency the server has.
Source of truth: `server/src/push.ts` and the routes in `server/src/app.ts`.

- **Two audiences, two credentials.** A Client registers its own subscription
  with a session token; a Host reads and sends with its `hostToken`. The send
  route takes the `hostId` from the token and never from the body, so naming a
  device explicitly cannot escape the calling Host's own scope.
- **The Server never selects recipients.** `devicePublicKeys` is required and
  non-empty; an absent or empty list is a 400, not a fan-out. The Host holds the
  ACL and is the only party that may decide who a push reaches.
- **Reads are scoped by credential, never by a supplied identity.** A Host token
  reads its own subscribers (`/api/push/devices`); a session reads the account's
  registrations (`/api/push/subscriptions`) and the Client filters to its own
  device. Neither takes a `devicePublicKey` as input, so there is no endpoint
  that reports on an identity the caller does not hold. Both return identities
  only — the endpoint and its keys are a bearer capability to notify that phone
  and never leave the Server.
- **Delivery views are VAPID-current.** With push configured,
  `/api/push/subscriptions` and the Host's `/api/push/devices` omit rows
  registered under a different (or legacy unknown) public key, and
  `/api/push/send` never targets them. Those endpoints cannot receive a send
  signed by the current key; hiding them exposes Pocket's re-registration
  action and keeps the Host from naming or retrying an unreachable device after
  rotation. The file rows are retained until that upsert; when push is disabled
  the Client subscriptions route still returns their identities for diagnosis,
  while the Host has no deliverable devices.
- **The subscription is bound to a Client identity by signature.** The Client
  signs `(hostId, challenge, devicePublicKey, endpoint)` with its device key
  under `PUSH_SUBSCRIBE_DOMAIN` — deliberately *not* `DEVICE_AUTH_DOMAIN`, since
  the Server relays Host-issued challenges during `connect` and so sees them in
  transit. Binding the endpoint is what stops a captured signature registering a
  different endpoint under the same identity. The challenge is single-use and
  consumed before verification, as at sign-in.
- **A subscription authorizes nothing.** It is a delivery address the Host may
  write to; the Host's ACL remains the only thing that decides what a Client may
  reach ([remote-security-model.md](./remote-security-model.md)).
- **Endpoint egress is public HTTPS only.** Registration rejects credentials,
  localhost, and non-public IP literals. Delivery uses a dedicated HTTPS agent
  whose connection-time DNS lookup rejects loopback, private, carrier-grade NAT
  (including Tailscale's `100.64/10`), link-local, documentation, benchmark,
  multicast, reserved, IPv4-mapped, unique-local, and site-local ranges. A
  hostname with any blocked answer is rejected wholesale; the accepted DNS
  result is the one handed to the socket, so mixed answers and rebinding cannot
  create a second unchecked resolution. Source of truth:
  `server/src/push-endpoint.ts`, wired into registration in
  `server/src/app.ts` and delivery in `server/src/push.ts`.
- **Payload text is re-sanitized at this boundary** even though the Host already
  did it, because it originates in a renderer and is ultimately Pane-derived
  ([alert.md](./alert.md) -> Text And Security). Both sides call the same
  `boundedPushText`, so the two layers cannot enforce different rules.
- **Delivery outcomes prune.** 404/410 means the subscription is permanently
  gone and its row is deleted; anything else is transient and left alone, but
  never silent: the refusal is logged (origin only — the endpoint is a bearer
  capability) and counted in the response's `failed`, since the route answers
  200 either way and the Host needs to tell an all-failed fan-out from
  success. Each push-service request has a 10-second socket-inactivity timeout,
  which resolves as `failed`; this is separate from the 300-second provider
  TTL, which prevents a delayed alarm from arriving after it is useful.
- Push is disabled, not half-working, when no VAPID key is configured: the
  config route reports `null` and subscribe/send answer 503.

## Relay

The server routes JSON envelopes between client sockets and host sockets
(`@hono/node-ws`). Before a session is authorized it only forwards an
allowlist of handshake types; after authorization it is a dumb pipe.

The relay keeps one current Host binding per Client socket. Host-originated
handshake replies and `msg` frames are routed only when the frame comes from
that current Host; late replies from a previous Host are ignored and cannot
re-establish an old session.
When a Client socket binds to a different Host, the relay sends `client-gone`
to the previous live Host before replacing the binding, so Host-side pairing UI,
remote-api sessions, and watchers are disposed immediately.

Client-originated `pair` and `connect2` frames are also rechecked after their
async validation work: if the Client disconnected, rebound, or the Host socket
was replaced while validation was pending, the stale result is dropped.

For `connect2`, the server remembers the last Host challenge it relayed to a
Client with a relay-local expiry derived from the server's observation time
(`DEFAULT_CHALLENGE_TTL_MS`). The Host's `expiresAt` is still forwarded to the
Client, but the server never compares its own clock to that Host wall-clock
timestamp.

### Pairing (phone ↔ laptop, first time)

```
phone                        server                        host (laptop)
  |-- signin (passkey) -------->|                              |
  |   generate device key       |                              |
  |-- pair -------------------->|-- pair --------------------->|  approval modal
  |                             |                              |  user clicks Approve
  |<-- pair-result -------------|<-- pair-result --------------|  ACL record saved
```

The `pair` frame carries the `PairingRequest` shape from `server-lib-common`
(`accountId`, `passkeyCredentialId`, `passkeyPublicKeyHash`,
`devicePublicKey`, `requestedLabel`). The server checks the request's
credential is a registered passkey of the account (and that its public-key
hash matches the stored key) and rejects malformed requests before relaying —
an account-level check; the `/ws/client` session is not bound to one
credential. The server also requires **fresh presence**: the session's last
verified assertion (sign-in, re-auth, or a connect handshake) must be within
`PAIRING_PRESENCE_WINDOW_MS`, else the request is answered locally with
`pair-result approved:false, error: 'stale-presence'` and the Pocket client
re-asserts via `/api/reauth/*` (one biometric prompt) and retries
(`docs/specs/remote-security-model.md`, Pairing Ceremony). The Host runs
`PairingCeremony` and only local approval writes the ACL. A malformed or
stale `PairingRequest` is answered locally and is never shown in the Host
approval UI.

### Connect (every session)

```
phone                        server                        host
  |-- connect {hostId} -------->|-- connect {clientId} ------->|
  |<-- challenge ---------------|<-- challenge (HostChallengeIssuer)
  |   ONE biometric prompt:     |                              |
  |   WebAuthn get({challenge}) |                              |
  |   + device-key signature    |                              |
  |-- ConnectionRequest ------->|  server verifies the         |
  |                             |  assertion itself, then      |
  |                             |-- ConnectionRequest -------->|  authorizeConnection()
  |<-- decision ----------------|<-- decision -----------------|  (final authority)
  |============ opaque remote-api relay from here ============>|
```

One host challenge feeds both signatures, so the user gets one Face ID prompt
per connection. The server verifies the assertion against the stored passkey
(its half of "fresh user presence is validated by the Server and the Host")
and drops the request on failure; the Host's `authorizeConnection` remains the
final authority regardless of what the server claims to have checked.

### After authorization: remote-api protocol-v1

Exactly the protocol-v1 scope of [remote-api.md](./remote-api.md)
(terminal-only): `hello`, `directory.watch` (snapshot-only), one
`surface.attach` (attach-is-the-resize), `terminal.data`/`terminal.closed`
out, `terminal.write`/`terminal.resize` in. (Host→client size-authority and
semantic events are staged in remote-api.md `## Future`.)

## Host side (`lib` + `standalone`)

A `remote-host` module in `lib`, active in standalone:

* **Enrollment** (settings UI, once): server URL + setup password →
  `POST /api/host/enroll` → persist `{ serverUrl, hostId, hostToken, origin,
  rpId }` in webview `localStorage` (`local-json-store.ts` — deliberately no
  platform-adapter dependency); open and maintain `GET /ws/host`.
* **Security**: `HostAcl` (persisted to `localStorage` as
  `records()`/`fromRecords`), `HostChallengeIssuer`, `PairingCeremony`, and
  `authorizeConnection` — all straight from `server-lib-common`, running in
  the webview.
* **Pairing approval modal**: shows the requested label + account; Approve /
  Deny. (Same modal pattern as KillConfirm.) If the Host user approves after
  the pairing ticket expires, the Host sends `pair-result approved:false` with
  an error and dismisses the modal; the ACL is untouched.
* **Terminal bridge**: `directory.watch` snapshots come from the existing
  terminal registry/state store (title, activity, cwd, exitCode, ringing,
  hasTODO — all already tracked); `surface.attach` resizes the PTY through
  the existing resize path and subscribes to its data stream;
  `terminal.write` feeds the existing input path.
* **Size authority**: last-attach-wins holds at the PTY level through the
  existing resize path. The "tethering to \<label\>" grey-out display on the
  local pane is staged — see remote-api.md `## Future`.

## Pocket side (phone)

Served by the server, built from `lib`:

* Sign-in with passkey; session token in memory.
* Device key: `generateDeviceKeyPair()` persisted as non-extractable
  CryptoKeys in IndexedDB (the tiny IndexedDB wrapper lives in `lib` — it is
  DOM-dependent, so not in `server-lib-common`).
* First run against a host: pairing flow, then connect. After that: connect
  straight away.
* Picker renders `directory.snapshot`; tapping a pane attaches with the
  phone's cols/rows and reuses the existing mobile terminal UI (xterm).
* All of it — auth screens included — renders on the shared themeable design
  system, with the theme restored before first paint
  (`docs/specs/pocket-app.md`, Design system and theming). The server serves
  no styling of its own; its only self-authored output is the plaintext
  missing-build stub.

## Testing

The security and relay layers are covered without a browser: `node --test`
drives setup → pairing → connect end to end through the real server —
`app.request()` for HTTP routes, real WebSockets against an ephemeral-port
server for the relay — using `SimAuthenticator` (from `server-lib-common`)
plus the `FakeHost` harness in `server/test/harness/fake-host.mjs` (register,
sign-in, wrong password, replayed challenge, wrong origin, plus relay routing
and token/session rejection). Revoked-record denial is covered at the unit
level in `server-lib-common`'s own tests, not through the relay.
`server/scripts/fake-host.mjs` is a manual dev stand-in built on the same
`FakeHost` class (see Running it below). Browser-dependent layers — the
standalone host module and the Pocket terminal view — are dogfooded rather
than automated.

## Running it

The loop at the top of this spec is implemented end to end. To test:

**1. Server + Pocket** (one terminal):

```sh
DORMOUSE_SETUP_PASSWORD=hunter2 pnpm dev:pocket-server
```

Builds the Pocket app (`lib/dist-pocket`) and the server, then serves both on
`:3000`. Other env vars per Configuration above; for a real phone set
`DORMOUSE_ORIGIN` to your TLS origin (e.g. via `tailscale serve`) — WebAuthn
needs a secure context, and only `localhost` is exempt.

**2. Host** (the laptop being controlled): `pnpm dev:standalone`, then enroll
once from the devtools console of the standalone webview:

```js
await window.dormouseRemoteHost.enroll('http://localhost:3000', 'hunter2', 'My Laptop')
```

Enrollment persists in localStorage; on later launches the host connects by
itself. (`status()` / `clearEnrollment()` on the same object.) For a headless
stand-in host instead:
`DORMOUSE_SETUP_PASSWORD=hunter2 node server/scripts/fake-host.mjs http://localhost:3000`
(auto-approves pairing and serves the same synthetic echo terminals as the
test harness — it instantiates `FakeHost` from
`server/test/harness/fake-host.mjs`; only the auto-approval and logging
differ).

**3. Phone** (or any other browser profile): open the server origin →
First-time setup (password + label) creates the passkey and signs you in →
Hosts → **Pair** → approve in the modal on the laptop → **Connect** (one
biometric prompt) → pick a pane → type.

Limitations to know about: each browser storage partition has its own device key
and therefore needs its own Host pairing, even when a synced passkey signs it
in; clearing site data destroys that device key → re-pair, per the security
model; a dropped WebSocket sends you back to the Hosts view — reconnect by
tapping Connect again.

Everything past this loop (browser surfaces, in-flight replay, thumbnails,
the tethering display, WebRTC) is staged in remote-api.md `## Future` as
additive follow-ups.

## Future

**Scope: saas-multitenant** — the server-side hurdles between today's
single-owner selfhost server and a multi-tenant SaaS on `*.dormouse.sh`,
including the Bring-Your-Own-Tailnet (BYOT) posture that puts the relay inside a
customer's own tailnet without a custom client build. The wire API and security
model are unchanged from selfhost ([remote-api.md](./remote-api.md), Server
deployment modes); everything here is deployment and relay plumbing beneath
them. Complementary front-door work is staged elsewhere and this scope does not
restate it: the SaaS account model (email + passkey self-serve signup) in
remote-api.md, and CloudFlare routing + Pocket static serving in
[pocket-app.md](./pocket-app.md) `## Future`.

Framing invariant: Tailscale is network-layer defense-in-depth *under* the
existing authorization model, never a substitute for it. The Host's
`authorizeConnection` stays the final authority and the relay never decides
access ([remote-security-model.md](./remote-security-model.md)). Keep two
properties separate: BYOT controls **reachability** (the relay endpoint leaves
the public internet and is addressable only from the customer's tailnet), while
**confidentiality of relayed bytes from the SaaS operator** is a distinct layer
— app-layer encryption, staged in remote-api.md `## Future` — that BYOT does
*not* provide, since the tenant's tunnel still terminates at our node inside our
process.

### From single-owner to multi-tenant

Selfhost (everything above the fold) stays as-is; SaaS is a parallel deployment
that lifts each single-tenant simplification. Each guardrail was chosen to be
liftable:

* **Accounts.** One `accountId: "owner"` gated by a shared
  `DORMOUSE_SETUP_PASSWORD` becomes many accounts, each created by email +
  passkey. The two hand-edited JSON files (`account.json`, `hosts.json`) become
  a real per-tenant store with per-tenant revocation, and Host enrollment moves
  from the global setup password to the authenticated account.
* **Relay tenant-scoping (an invariant, not a check).** The relay binds one Host
  per Client socket with no notion of tenant. Multi-tenant makes tenancy
  intrinsic to that binding: a Client may only ever be offered, and bound to,
  Hosts of its own account, and a cross-tenant binding must be *impossible*, not
  merely unauthorized. This is defense-in-depth — the Host still authorizes —
  but the relay must not be the weak point.
* **Statefulness → horizontal scale.** All transient state (challenges,
  sessions, relay bindings) is in memory, so the relay is one process. At scale
  a Client and its Host must land on the same instance (sticky routing) or share
  a bus; the CloudFlare front door ([pocket-app.md](./pocket-app.md) `## Future`)
  is where that routing lands.

### The `*.dormouse.sh` pin — the constraint everything obeys

The shipped signed client scopes its webview CSP `connect-src` to
`https://*.dormouse.sh wss://*.dormouse.sh` (Host webview CSP, above), and
passkeys bind to the served origin (`DORMOUSE_ORIGIN` → `rpId`/`origin`) with
Pocket served same-origin ([pocket-app.md](./pocket-app.md)). This is why a
selfhoster must produce a custom build (`DORMOUSE_REMOTE_CONNECT_SRC`) — the
stock client refuses any other origin — and it is the hard constraint on BYOT:
whatever a stock client connects to must present a `*.dormouse.sh` origin over
TLS. A raw `100.x` tailnet IP or a `*.ts.net` MagicDNS name is a different
origin and breaks both the CSP and the passkey binding, so BYOT cannot simply
point the client at the tailnet node.

### BYOT — a per-tenant tailnet node

The SaaS process embeds one Tailscale node per tenant via `tsnet` (one
`tsnet.Server` per tenant, each with its own state dir), joining the customer's
own tailnet. Tenant A's Host and Pocket reach the relay as a node inside A's
tailnet; A cannot address B's node because it is not in A's tailnet — network
isolation layered on the relay tenant-scoping above.

The load-bearing hurdle is reconciling that node with the `*.dormouse.sh` pin:

* **Name + cert.** A per-tenant hostname under the wildcard — e.g.
  `tenant-xyz.dormouse.sh` — must resolve, *for tailnet members only*
  (split-horizon DNS coordinated with the customer's MagicDNS), to that tenant's
  node, which serves a real TLS cert for the subdomain (we control `dormouse.sh`,
  so ACME DNS-01 issues it). Origin stays `*.dormouse.sh`, so the existing CSP
  wildcard, passkeys, and autoupdate all keep working while the bytes ride the
  tailnet and the relay never touches the public internet. This is exactly what
  a selfhoster cannot reproduce (no `*.dormouse.sh` cert, no stock client),
  which is what makes BYOT a distinct product rather than dressed-up selfhost.
* **Enrollment.** The customer supplies a Tailscale OAuth client or tagged
  ephemeral auth key scoped to a tag (e.g. `tag:dormouse-relay`); the server
  brings the tenant's node up as an ephemeral, tagged device, and the customer's
  own ACLs pin which of their devices may reach it.
* **Operational hurdles.** N userspace WireGuard nodes (each a gVisor netstack,
  a DERP connection, and key material) live in one process: lazy activation
  (node up only while a tenant has a live device, ephemeral teardown when idle),
  sharding across processes at scale, per-tenant cert provisioning + split-DNS,
  server-side custody of per-tenant Tailscale auth material, and per-node health
  (a dropped node means that tenant is offline). The node also consumes a device
  slot on the *customer's* tailnet — kept ephemeral to minimize it.
