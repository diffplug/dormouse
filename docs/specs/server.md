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
  server restart just means everyone reconnects. In-memory is not unbounded:
  `HostChallengeIssuer.issue` prunes expired entries on every call, and
  `PairingCeremony` drops tickets one TTL past expiry. Both matter because the
  frames that mint them are cheap to send — `POST /api/signin/begin` needs no
  auth at all, and a `connect` frame needs only a session, not a pairing, yet
  issues a challenge in the Host process on the user's laptop.

## Configuration

| Env var                   | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `DORMOUSE_SETUP_PASSWORD` | Required. Gates account creation and host enrollment.      |
| `DORMOUSE_ORIGIN`         | External origin, e.g. `https://dormouse.tailnet.ts.net`. Source of the WebAuthn `rpId`/`origin` and the Host's `ConnectionPolicy`. Defaults to `http://localhost:<port>` for dev. |
| `DORMOUSE_STATE_DIR`      | Where the JSON state files live. Default `./data`.         |
| `PORT`                    | Default 3000. Blank is unset — `Number('')` is 0, which would ask the OS for an ephemeral port and move the server out from under whatever proxy is pointed at it. An explicit `PORT=0` is a `ConfigError` for the same reason: nothing can be pointed at a port that changes every restart. |
| `DORMOUSE_REQUIRE_USER_VERIFICATION` | `true` demands a *user-verified* passkey assertion (biometric/PIN), not merely user presence. Off by default, and only the exact string `true` enables it — a misspelling must read as off, because turning this on without UV-capable authenticators locks the account out of its own server. Mirrored to every Host in its `HostEnrollResponse` so both sides demand the same thing (`SECURITY.md` -> Remote Control). |
| `DORMOUSE_BIND_HOST`      | Interface to listen on. Unset binds every interface (what a container wants); set `127.0.0.1` when a TLS proxy on the same machine is the front door. |
| `DORMOUSE_VAPID_PUBLIC_KEY` / `DORMOUSE_VAPID_PRIVATE_KEY` | Web Push signing keypair. Set both or neither. At startup the Server decodes both, derives the P-256 public point from the private key, and exits on a missing, malformed, or mismatched pair. Unset, the server mints a pair on first boot and persists it to `vapid.json`. |
| `DORMOUSE_VAPID_SUBJECT`  | `mailto:`/`https:` contact for push-service operators (RFC 8292). Defaults to `DORMOUSE_ORIGIN` when that origin is https and not loopback; otherwise there is no default and push stays off. The Server parses and validates it at startup and exits on an invalid value — including a loopback contact, which Apple rejects. |

WebAuthn requires a secure context: `localhost` works for development; for a
real phone, put the server behind TLS (`tailscale serve` is the intended
selfhost path, any reverse proxy works). The server itself always speaks
plain HTTP.

Because the server always speaks plain HTTP, the listen interface is a security
boundary whenever the TLS proxy is local: `tailscale serve` reaches the app over
loopback, so leaving the socket on every interface would also publish the
plaintext port to the LAN and to the tailnet itself. `DORMOUSE_BIND_HOST` exists
to close that, and the selfhost install sets it. The default stays unbound so a
container — where the namespace is the boundary and the port is published
explicitly — keeps working unchanged.

Source of truth: `server/src/config.ts` (`readConfig`) maps the environment to
the entrypoint's config and is unit-tested in `server/test/config.test.mjs`;
`server/test/bind-host.test.mjs` spawns the real entrypoint and asserts the
plaintext port is unreachable off-loopback when `DORMOUSE_BIND_HOST=127.0.0.1`.
`readConfig` also reads the `DORMOUSE_VAPID_*` vars — the both-or-neither
keypair rule as a `ConfigError`, and the subject with its origin-derived
fallback — because that part is a pure mapping like the rest. What stays in
`server/src/index.ts` is only the half that touches disk: with no keypair
configured it mints one and persists `vapid.json`, then validates the pair and
the subject before building the app.

`DORMOUSE_ORIGIN` is parsed once and normalized with `URL.origin`; WebAuthn
clientData checks, passkey assertion verification, and the Host enrollment
policy all use that normalized origin.

## Where a Host may reach a relay server (self-host builds)

> Code comments and older specs call this section "Host webview CSP", from when
> the allowlist was a webview CSP directive.

Neither Host renders the relay socket in a webview any more: standalone's runs
in the Node sidecar and VS Code's in the extension host, so no CSP fences either
of them. The same CSP-shaped source list is therefore **baked into the Node
bundle** and enforced there — one syntax, one build-time variable
(`DORMOUSE_REMOTE_CONNECT_SRC`), whichever process ends up holding the socket.
The webview CSPs carry no relay sources at all (`docs/specs/vscode.md` → "CSP
policy"; `standalone/scripts/tauri-conf.test.mjs` asserts the standalone one).

Both bundles default to the SaaS origin only and take the same override:

```sh
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
```

`scripts/csp-defaults.mjs` holds the one definition of the default and the
override rule; `standalone/scripts/build-sidecar-proxy.mjs` and
`vscode-ext/scripts/esbuild.mjs` each esbuild-`define` it into their bundle, and
`assertConnectSrcBaked` fails the build if the define did not reach it — a lost
define compiles fine and would only show up as a Host silently using the shipped
default instead of the selfhoster's origins. `bakedConnectSrc()` in
`lib/src/host/remote/connect-src.ts` is the single place the value is read.

`resolveRemoteConnectSrc` also **fails the build on an override the matcher
could never read** — a trailing slash, a path, a bare host with no scheme, a
scheme outside `http`/`https`/`ws`/`wss`, or a numeric port outside 1–65535.
Numeric ports are canonicalized the same way as `URL` (so leading zeroes do not
turn a valid source into a silent miss). The grammar is one regex duplicated
into the build script, since an `.mjs` build script cannot import TypeScript;
`connect-src.test.ts` asserts the two pattern strings are identical, the same
way it pins the two copies of the default.

**Enforcement is `originAllowedByConnectSrc`, at two points:** the service
refuses `enroll` for an origin outside the list — before the setup password
leaves the machine — and refuses to *start* from a persisted enrollment naming
one, staying idle with a warning rather than connecting (a binary downgraded
from a custom build, or a server that moved). Matching is deliberately narrower
than a browser's: `https`/`wss` are one scheme class and `http`/`ws` the other,
host matches exactly or by a leading `*.` wildcard covering any depth of
sub-domain but never the bare domain, ports must match unless the source says
`*`, and anything unparseable fails closed. Enrollment and Host-authenticated
push fetches use `redirect: 'error'`: unlike the former webview CSP, a Node
process does not re-check a redirect target, so following one could carry the
setup password, Host bearer token, or notification metadata outside the baked
allowlist.

The shipped binary is scoped to the SaaS origin only
(`https://*.dormouse.sh wss://*.dormouse.sh`). A self-host server on a different
origin is therefore reached only by a custom build: set
`DORMOUSE_REMOTE_CONNECT_SRC` when building (e.g.
`pnpm --filter dormouse-standalone tauri build`) to the sources for your server,
such as `https://dormouse.example.com wss://dormouse.example.com` or a tailnet
wildcard `https://*.ts.net wss://*.ts.net`. It **replaces** the default SaaS
sources rather than adding to them. The default is deliberately not
internet-wide — widening it is an explicit, per-build opt-in.

The default carries **no localhost entry**, and `http`/`ws` are a different
scheme class from `https`/`wss`, so a Host built with the default refuses to
enroll against a plaintext `http://localhost:3000` dev server — see
"Running it" for the override a local loop needs. (This is narrower than the old
webview CSP, which allowed localhost for the app's own loopback proxies; that
allowance is still in the webview CSP, where it is about the agent-browser and
iframe proxies rather than about relays.)

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
the Host, in the process that owns the PTYs
(`lib/src/host/remote/host-state-store.ts`), which is the whole point of the
security model.

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
device atomically deletes all of the device's prior Host rows. The response
reports the state that mutation left behind — every Host this device is still
registered with — rather than the fact that a deletion happened, so a committed
POST whose response was lost is repaired by its own idempotent retry. Scoping
that answer to the device is safe where `GET /api/push/subscriptions` must not
be: the request carries a device signature, so the caller has proven it owns the
identity being reported on. The row holds no label — the Server never learns
one. Rows are validated as they are read, so a hand-edit that leaves one
malformed reads as a missing registration (which Pocket repairs by re-offering
Enable) instead of a live one nothing can be delivered to. Source of truth:
`PushSubscriptionStore.list` / `.upsert` in `server/src/state.ts` and the
subscribe route in `server/src/app.ts`.

`hosts.json` rows are validated as they are read, the same way
`push-subscriptions.json`'s are and for the same reason: hand-editing this file
is the *documented* revocation mechanism, so a half-finished edit is an
expected state. A row that is not a well-formed enrollment is dropped rather
than carried — unguarded, one with a null `hostToken` makes `findByToken`'s
digest compare throw, which 500s every `/ws/host` upgrade and every push route
over a single bad line.

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

Every session-gated route — including the `/ws/client` upgrade, which is
rejected before `injectWebSocket` ever sees it — answers an unknown or expired
token with 401 and the shared `UNAUTHORIZED_ERROR` from
`server-lib-common/src/remote/wire.ts`. That exact string is load-bearing:
Pocket keys its "sign in again" recovery on it, and a bare 401 is ambiguous,
since a wrong setup password and a rejected device signature answer 401 as well
([pocket-app.md](./pocket-app.md) -> An expired session drops to sign-in).

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
  success. The log carries the push service's own reason body alongside the
  status — whitespace-collapsed and capped at 200 characters so an HTML error
  page cannot flood it — because a status alone does not separate a bad subject
  from a bad key from a bad payload, and this is the only place that
  explanation is ever visible. Delivery is bounded twice, and both bounds
  resolve as `failed` — so the row survives to be retried, unlike a 404/410.
  The inner bound is a 10-second socket-inactivity timeout on each push-service
  request. The outer is a 15-second wall-clock deadline per send, which catches
  what inactivity cannot: a service that trickles bytes or stalls mid-handshake
  resets the inactivity timer indefinitely. The deadline is applied by the
  route rather than by the sender, so it holds for any injected `PushSender`,
  and because every send in a fan-out starts at once it also bounds the route
  as a whole regardless of device count. It bounds the *route*, not the socket:
  `web-push` accepts no `AbortSignal`, so a request that loses the race is left
  to its own inactivity timeout rather than cancelled. What this prevents is a
  wedged push service holding the handler open while successive alarms stack
  concurrent sends behind it. Both are separate from the 300-second provider
  TTL — an alarm that arrives an hour late is noise, not information.
- Push is disabled, not half-working, when no VAPID key **or no VAPID subject**
  is configured: the config route reports `null` and subscribe/send answer 503.
  The key and the subject are advertised together or not at all — a phone that
  registered against a key the Server has no contact to sign with would be
  subscribed to a push it can never receive.
- **A VAPID subject naming a loopback host is a startup error, not a default.**
  Apple answers `403 {"reason":"BadJwtToken"}` for one — verified against
  `web.push.apple.com` for `mailto:admin@localhost` and `https://localhost:3000`,
  while `mailto:admin@example.com` and an ordinary https origin were accepted, so
  the rule is loopback specifically and not reachability of the contact.
  `web-push` only warns about the https form, at send time, and says nothing
  about `mailto:` at `localhost`. This mattered: the previous default
  (`mailto:admin@localhost`) let a Server boot clean, answer 200 on send, and
  deliver nothing to any iPhone — the one platform the feature targets. Hence
  the origin-derived default, and hence a loopback dev server turning push off
  instead of guessing a placeholder contact. Source of truth:
  `defaultVapidSubject` / `assertVapidSubject` in `server/src/push.ts`.

## Relay

The server routes JSON envelopes between client sockets and host sockets
(`@hono/node-ws`). Before a session is authorized it only forwards an
allowlist of handshake types; after authorization it is a dumb pipe.

Only one socket may own a `hostId`. Registering a second one for the same
`hostId` displaces the first: clients bound to it are told `host-gone`, their
sessions are cleared, and the old socket is closed with
`WS_CLOSE_HOST_REPLACED` (4000) / `WS_CLOSE_HOST_REPLACED_REASON`. Both
constants live in `server-lib-common` rather than in `server` because the code
is a contract, not a log line: the evicted Host keys its stand-down on it (see
[Host side](#host-side-lib--the-two-node-hosts)), and if the two sides disagreed on the
number the two Hosts would evict each other forever. Source of truth:
`server/src/relay.ts` (`registerHost`).

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
approval UI. **Both sides run the shape guard**, and deliberately so: the
server's `isPairingRequest` check is a courtesy that keeps a bad frame off the
wire, while the Host runs the same `isPairingRequest` from `server-lib-common`
on arrival because the security model does not trust the relay. A Host that
relied on the server's check would be taking a relayed object on faith in the
one place — the approval UI and the record it writes — where that is least
acceptable. The Host also reduces `requestedLabel` with `boundedPairingLabel`
before any consumer sees it (same rule as `boundedPushText`): it is
attacker-chosen text rendered in a security dialog. Source of truth:
`RemoteHost.#onPair` in `lib/src/remote/host/remote-host.ts`.

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

## Host side (`lib` + the two Node hosts)

The Host is a service in the process that owns the PTYs — never a webview:
`RemoteHostService` in `lib/src/host/remote/service.ts`, installed in the Tauri
sidecar (`docs/specs/standalone.md` → "Remote Host service") and in the VS Code
extension host (`docs/specs/vscode.md` → "Remote Host: a service in the
extension host"). The webview holds only UI — the pairing modal, the
`window.dormouseRemoteHost` console hook, and answering what its own panes are
called — and reaches the service over the `remoteHost:*` bridge, so the console
API's shape is unchanged and its calls are now promises one round trip further
away.

* **Enrollment** (Settings dialog, or the console hook, once): server URL + setup password →
  `POST /api/host/enroll` → the service persists `{ serverUrl, hostId,
  hostToken, origin, rpId }` through its `HostStateStore` — a 0600 JSON file
  under the app-data dir in standalone, `SecretStorage` in VS Code — then opens
  and maintains `GET /ws/host`. `hostToken` is a bearer credential and never
  enters a webview realm. Enrollment is refused outright for a server outside
  this build's allowlist (above), before the password leaves the machine. A 200
  that is not an enrollment fails the exchange: the response goes through the
  same `isEnrollment` guard every *read* of an enrollment uses, and a body that
  misses a field or sends one with the wrong type throws naming those fields
  rather than minting a record with an `undefined` in the `ConnectionPolicy` the
  Host authenticates passkeys against — one the store would reject on the next
  read, un-enrolling the machine at the next launch. Source of truth:
  `lib/src/remote/host/enrollment.ts`.
  **Order matters, and the store goes first.** The `hostToken` this exchange
  mints exists nowhere else and cannot be minted again from the same password
  exchange, so the save is awaited before any Host is stopped: a failed write
  then leaves the old Host running and every answer it gives still true, instead
  of stranding the machine with no Host, a status that says otherwise, and a
  credential lost to the failure. Replacing a *running* Host emits
  `{ name: 'status', enrolled: false }` between the two, because the webview gate
  that arms on it is edge-triggered and everything it holds — the mirrored
  pairing queue, the push device list — belongs to the server being left
  (`lib/src/remote/host/enrolled-gate.ts`). `clearEnrollment` is the same rule
  read backwards: the delete is awaited first and nothing else happens unless it
  succeeded, since reporting un-enrolled over a delete that failed would leave
  the credential on disk for the next launch to read back. The enroll request
  itself carries a 10 s `AbortSignal.timeout` — under the webview's own 15 s
  command budget, so the console sees the real error — because it runs on the
  service's lifecycle chain, where every later start/stop command queues behind
  it and a black-holed relay would otherwise wedge them all.
* **Relay socket policy**: one socket at a time, reconnected with exponential
  backoff (1s, doubling to 30s) after any close — except a close carrying
  `WS_CLOSE_HOST_REPLACED`, which is **terminal**. That code means another
  Dormouse instance enrolled with the same `hostId` took the relay slot, so
  this one disposes its sessions, reports `displaced`, and arms no timer;
  reconnecting on it would evict the newer Host, which would reconnect and
  evict this one, forever. Coming back is an explicit act —
  `window.dormouseRemoteHost.reconnect()` (or `RemoteHost.start()`), which
  takes the slot back and displaces the other Host in turn. `displaced` is the
  one connection state the user has to act on, so it is the only one the
  Settings dialog gives a button (Remote control, below);
  `window.dormouseRemoteHost.status()` reports it as `connection`, distinct from
  the retrying `disconnected`. A close event from a
  socket the controller no longer owns is ignored, so a dead socket's late
  eviction cannot stand down the live one. Disposing the service is terminal:
  an enrollment or ACL read already in flight cannot construct a relay socket
  after its owning sidecar/extension instance has torn down. Source of truth:
  `lib/src/remote/host/remote-host.ts`, `lib/src/host/remote/service.ts`
  (lifecycle + the console commands), `lib/src/remote/host/activation.ts` (the
  webview's client half).
* **Security**: `HostAcl` (persisted through the `HostStateStore` as
  `records()`/`fromRecords`, keyed per `hostId` so a re-enrollment cannot
  inherit a stale ACL), `HostChallengeIssuer`, `PairingCeremony`, and
  `authorizeConnection` — all straight from `server-lib-common`, running in the
  service's process. Nothing a webview says can widen access.
* **Pairing approval modal**: the queue is service-side; webviews mirror a
  serializable projection of it
  (`{ clientId, pairingId, request, requestedAt }[]`, pushed whole on every
  change) and echo both ids on Approve / Deny, so the approve/deny closures
  never leave the Host's process. **Approval is bound to the displayed
  `pairingId`, not whichever request currently occupies `clientId`.** The
  service coalesces a re-sent pair under one `clientId` by *replacing* what it
  holds, but rejects an old modal action whose immutable ticket id no longer
  matches. The mirror likewise includes `pairingId` in its content comparison,
  replaces the old item, and remounts the modal keyed by that id. An unchanged
  item is left alone: every snapshot arrives as fresh JSON, so identity
  comparison would re-render the modal on every event. The modal shows the
  requested label + account;
  Approve / Deny. (Same modal pattern as KillConfirm.) If the Host user approves
  after the pairing ticket expires, the Host sends `pair-result approved:false`
  with an error and dismisses the modal; the ACL is untouched. In VS Code the
  queue is broadcast to every window, since any of them may be the one in front
  of the user.
* **Terminal bridge**: served through a `HostSurfaceProvider`
  (`docs/specs/remote-api.md`). `directory.watch` snapshots are collected from
  the webviews that own the panes (title, activity, cwd, exitCode, ringing,
  hasTODO — all already tracked there); `surface.attach` resizes through the
  owning webview's live xterm and streams the PTY from the process that owns it;
  `terminal.write` feeds the existing input path.
* **Size authority**: last-attach-wins holds at the PTY level through the
  existing resize path. The "tethering to \<label\>" grey-out display on the
  local pane is staged — see remote-api.md `## Future`.

### Remote control, in the Settings dialog

Enrolling is the one step a self-hoster cannot skip, so it is UI rather than a
console incantation: a **Remote control** section at the bottom of the
app-global Settings dialog ([alert.md](./alert.md) -> Settings dialog). Source
of truth: `lib/src/components/RemoteControlSection.tsx` over
`lib/src/remote/host/host-status-store.ts`.

It renders **nothing at all** where `getPlatform().remoteHost` is absent — the
website and the lib dev server have no Host service behind them, and offering
the form would promise something the build cannot do.

The push-devices line above it must key on that same seam, and **not** on its
own `no-host`, which is a superset: `no-host` covers both a Host service that
has not enrolled *and* a build with no Host service at all
([alert.md](./alert.md) -> Push notifications). Only the first has a section
beneath it, so only the first says "below" — otherwise the website points the
reader at nothing. Source of truth: `describePushTargets` in
`lib/src/components/SettingsDialog.tsx`, which takes the seam as an argument;
the `PushNoHost` / `PushNotEnrolled` story pair holds the two apart.

Un-enrolled it is a three-field form (server, setup password, name for this
machine) calling the service's `enroll`; enrolled it shows the server URL, the
relay connection state, and the paired-device count, with `Disconnect` and —
only on `displaced` — `Reconnect`. Rules the UI exists to honor:

- **The password is passed through, never held.** It goes straight to the
  service, which is the party that talks to the server, and is cleared on
  success. `hostToken` never comes back into the webview realm: `enroll`
  answers `{ hostId, serverUrl }`.
- **Refusals are shown, not swallowed.** An origin outside this build's baked
  allowlist is refused before the password leaves the machine (above), and that
  error is what the form renders — so the failure reads as "this build will not
  talk to that server" rather than as a wrong password.
- **Disconnect asks first**, because clearing the enrollment drops every paired
  phone until each pairs again.
- **Status is re-read, not patched, and the connection is polled.** The
  service's `status` event carries only `{ enrolled }` — the edge its webview
  gate arms on — so every event triggers a full `status` command, and the dialog
  re-reads on open since another window may have enrolled meanwhile. The
  *connection* moves with no event at all (`connecting -> connected`,
  `-> disconnected`, `-> displaced`), so the store also polls every 2 s **while
  something is subscribed**, which is the seconds the dialog is open rather than
  a standing timer in every window. Status reads are serialized: ticks that
  arrive during a slow read coalesce behind it, so a 15-second Host-service
  timeout is allowed to become the visible error instead of being superseded by
  newer polls. Without the poll a machine that finished connecting a moment
  after the dialog opened would read as permanently "Connecting…".
- **A repeat answer is not published.** The service returns a fresh object every
  poll, so the state is compared field-wise before it is stored — otherwise the
  section would re-render twice a minute to paint identical text. This matches
  the sibling store the same dialog reads (`setPushDevices` in
  `lib/src/lib/push-devices.ts`).
- **Coalescing stops at anything that changes the answer.** `enroll`,
  `reconnect` and `clearEnrollment` each drop the read in flight and start their
  own, because a `status` issued before the command answers the question as it
  stood beforehand — joining it would report the old enrollment as though the
  command had not run, the inverse of the delete-first ordering the service uses
  so a failed delete never claims to have succeeded. Losing the last subscriber
  drops it for the same reason: a reopened dialog must not be answered with a
  status fetched for the closed one, and would otherwise sit on "Checking…"
  until that read settled. Source of truth: `dropInFlightRead` in
  `lib/src/remote/host/host-status-store.ts`.

The `window.dormouseRemoteHost` console hook keeps the same four commands and
remains the scripting seam. Pairing approval is deliberately *not* here: it is a
modal, because it must interrupt
([remote-security-model.md](./remote-security-model.md), Pairing Ceremony).

`docs/stories/pairing.mdx` walks this section and the pairing modal in sequence
with the rest of the setup, rendering the real components; it is a narrative
Storybook page, not a spec, so this section is what it defers to.

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

On the default localhost origin **push is off** and the server says so at
startup: there is no routable operator contact to sign a VAPID JWT with, and a
phone could not route to localhost anyway. Setting `DORMOUSE_ORIGIN` to an https
origin enables it with no further configuration, since that origin becomes the
subject. To exercise push against a desktop browser on localhost, supply a
contact explicitly:

```sh
DORMOUSE_SETUP_PASSWORD=hunter2 DORMOUSE_VAPID_SUBJECT=mailto:you@example.com \
  pnpm dev:pocket-server
```

**2. Host** (the laptop being controlled). The Host runs in the sidecar / the
extension host and refuses any origin outside the allowlist baked into that
bundle — by default the SaaS origin only, with no localhost and no plaintext
scheme. A local server therefore needs the override at build time, which
`dev:standalone` picks up because it re-stages the sidecar bundles on the way:

```sh
DORMOUSE_REMOTE_CONNECT_SRC='http://localhost:3000 ws://localhost:3000' pnpm dev:standalone
```

Then enroll once, in **Settings → Remote control** (the sliders icon at the far
right of the baseboard): server `http://localhost:3000`, the setup password, and
a name for this machine. The same thing from the devtools console of the
webview, which is the scripting seam:

```js
await window.dormouseRemoteHost.enroll('http://localhost:3000', 'hunter2', 'My Laptop')
```

The console hook forwards to the Host service, so these are promises; enrollment
persists in the service's own store (a 0600 file under the app-data dir in
standalone) and on later launches the Host connects by itself. (`status()` /
`reconnect()` / `clearEnrollment()` on the same object.) For a headless
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

To test push, **add Pocket to the Home Screen before signing in** and do all of
the above inside the installed app: iOS delivers Web Push only there, and the
install is a separate storage partition needing its own pairing, so setting up
in the tab first means doing it twice ([pocket-app.md](./pocket-app.md) ->
Installable web app). Alerts are then a per-Host opt-in — **Enable alerts** on the Host's
row, which is the user gesture iOS requires before it will prompt for
permission. Connecting alone does not subscribe.

Limitations to know about: each browser storage partition has its own device key
and therefore needs its own Host pairing, even when a synced passkey signs it
in; clearing site data destroys that device key → re-pair, per the security
model; a dropped WebSocket sends you back to the Hosts view — reconnect by
tapping Connect again.

Everything past this loop (browser surfaces, in-flight replay, thumbnails,
the tethering display, WebRTC) is staged in remote-api.md `## Future` as
additive follow-ups.

## Installing it (behind Tailscale)

The selfhost deployment that exists today is a **per-login user agent on the
user's own laptop**, reachable only from their tailnet: a LaunchAgent on macOS,
a Scheduled Task on Windows. `tailscale serve` terminates HTTPS on the node's
own MagicDNS name and proxies to the server on loopback. There is no cloud
relay; that is staged in [SELF_HOST.md](../../SELF_HOST.md) `## Future`.

The security properties this deployment is audited against — the credential
modes, the loopback bind, the origin-rewrite refusal, the Funnel check — are the
"Network posture" and "Credentials at rest" `FAIL IF` lines in `SECURITY.md`.
Those lines bind **both** installers; a control present in one and absent from
the other is a finding.

Source of truth: `deploy/local/install-macos.sh` and
`deploy/local/install-windows.ps1`. One of them is the whole mechanism on its
platform — one idempotent script, no hand-edited service definitions, no
scheduled updater. Running it again updates the installed release from the
current checkout; it never pulls, fetches, or switches branches. The operator
runbook is [SELF_HOST.md](../../SELF_HOST.md).

Each release is self-contained: the production server tree, `lib/dist-pocket`,
and a **copy of the exact Node binary the build ran under**, so the service
depends on neither the source checkout, nor Homebrew/nvm/a version manager, nor
pnpm's store, nor the user's interactive `PATH` — neither launchd nor Task
Scheduler reads any of those. The install root holds `bin/` (the stable
`run-server` wrapper and the `manage` helper), `config/`, `state/`, and
`releases/<id>` with a current/previous pointer.

The *invariants* below are shared; where the two platforms reach them by
different means, the text is tagged `(macOS)` or `(Windows)` inline. This table
is the mechanism-by-mechanism map:

| | macOS | Windows |
| --- | --- | --- |
| Service | LaunchAgent `sh.dormouse.server` in `gui/$UID` | Scheduled Task `\Dormouse Server`, at-logon, `LogonType=Interactive`, `RunLevel=Limited` |
| Install root | `~/Library/Application Support/Dormouse Server` | `%LOCALAPPDATA%\Dormouse Server` |
| Logs | `~/Library/Logs/Dormouse Server` | `<root>\logs` |
| RunAtLoad | plist `RunAtLoad` | the at-logon trigger |
| KeepAlive | plist `KeepAlive` — launchd restarts on any exit | the supervision loop in `bin\run-server.ps1`; Task Scheduler's own `RestartCount` only fires on a *failed* exit, so it is defence in depth, not the mechanism |
| Stopping it | `launchctl bootout` takes the process tree | stopping the task ends only the `powershell.exe` it launched; its `cmd.exe`/`node.exe` children survive and must be reaped by install root (see the trap below) |
| `current`/`previous` | symlinks, swapped with `rename(2)` on the link path | `current.txt`/`previous.txt` naming a release id, swapped with `rename(2)` on the file |
| `0700` / `0600` | the modes, under `umask 077` | a DACL protected from inheritance carrying exactly one ACE, for the installing user |
| Refuses | running as root (`id -u`) | running elevated (the `Administrator` role) |
| Entry | `/bin/bash bin/run-server` | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bin\run-server.ps1`, at an absolute interpreter path |

Two of those rows are the load-bearing Windows deviations, and both exist
because the macOS mechanism has no unprivileged Windows equivalent:

* **The release pointer is a file, not a symlink.** Windows has no
  unprivileged replaceable directory symlink — a junction cannot be renamed over
  an existing junction, and a delete-then-create leaves a window in which
  `current` names nothing. A file *can* be replaced atomically
  (`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`), so the pointer holds the release id
  and `bin\run-server.ps1` joins it to `releases\`. The switch still asserts
  afterwards that the pointer advanced.
* **KeepAlive lives in the wrapper.** Task Scheduler restarts a task that
  *fails*; it does not restart one that exits 0, which is what launchd's
  `KeepAlive` does. So `bin\run-server.ps1` is a supervision loop with the same
  10-second throttle the plist declares, and `manage verify` checks that the
  loop is still there rather than trusting the task settings alone. Stopping the
  task terminates its whole job object, wrapper included.

Invariants the installer exists to hold:

* **One replica, and an update is a short intentional restart.** Challenges,
  sessions and relay bindings are in memory (Guardrails above), so Hosts and
  Pocket clients reconnect across a release switch. There is no zero-downtime
  swap to attempt.
* **State outlives code.** `config/` and `state/` sit outside `releases/`, are
  readable only by the installing user, and are never touched by an update, a
  prune, or an uninstall. `config/server.env` is likewise user-only, generated
  once with a locally generated setup password, and preserved byte-for-byte
  thereafter. Purging state is a separate, explicitly confirmed operation. On
  Windows the installer creates `server.env` and applies its DACL *before*
  writing the password, so the secret never sits under the inherited
  `%LOCALAPPDATA%` ACL; and because Node's file modes are a no-op there, the
  `0o600` that `server/src/state.ts` requests does nothing, leaving inheritance
  from `state\` as the only control — which is why the Windows `manage verify`
  checks each state file individually and the macOS one does not need to.
* **Loopback only, and tailnet-only.** The install pins
  `DORMOUSE_BIND_HOST=127.0.0.1` and refuses to proceed without it — see the
  Configuration note above on why the listen interface is a security boundary
  when the TLS proxy is local. Port 3100, deliberately not 3000, so the
  installed service can coexist with `pnpm dev:server` /
  `pnpm dev:pocket-server` on the same laptop. `verify` also fails on an
  active `tailscale funnel`: Serve and Funnel are one configuration surface,
  and a Funnel publishes this same origin to the public internet, where the
  setup password becomes an internet-facing guessing target that nothing in
  the threat model was sized for (`SECURITY.md` -> "Network posture").
* **`DORMOUSE_ORIGIN` is durable WebAuthn identity.** It is derived from the
  node's MagicDNS name. If an existing installation records a different origin
  the installer stops rather than rewriting it, because the rewrite silently
  invalidates the registered passkey and every enrolled Host.
* **The install belongs to one user account.** Both installers refuse to run
  privileged — as root on macOS, elevated on Windows — because the whole
  credential posture is that one account owns `config/` and `state/`. An
  elevated run would write them owned by another principal and register the
  service for it.
* **A failed update is a failure.** The candidate release is health-checked on
  an ephemeral port against a throwaway state dir *before* `current` moves; if
  the live service then fails to answer, `current` is restored to `previous`
  and the installer exits nonzero. Rollback succeeding is not success. On
  Windows the restore additionally clears the `previous` pointer, because the
  switch had already set it to the release `current` is being restored to:
  leaving both naming one release would make `verify` report a rollback target
  that does not exist and `rollback` swap a release with itself and call it
  success. *(The macOS installer has the same ordering and not yet this
  correction.)* The Windows restore also reaps orphaned processes and re-checks
  which release holds the port, for the reason in the Scheduled Task trap below
  — otherwise the rejected release's own orphan answers the health check and is
  reported as the previous release being "healthy again".

Mechanical traps the scripts encode, each of which fails silently otherwise:

* **`pnpm deploy --prod --legacy` poisons the workspace.** (Both.) It rewrites
  the root `node_modules/.pnpm-workspace-state-v1.json` to `production: true` /
  `dev: false`. Every later pnpm command in that checkout then decides the
  workspace is stale and tries to run `pnpm install --production`, which would
  strip the developer's devDependencies. The installer snapshots that file and
  restores it unconditionally on exit — from an `EXIT` trap on macOS, a
  `finally` block on Windows — so even a failed install leaves the checkout as
  it found it.
* **`mv -f tmp link` follows a symlink to a directory.** (macOS.) Used to swap
  `current`, it deposits the temp link *inside* the old release and leaves
  `current` pointing where it was — the update becomes a silent no-op, and the
  prune then deletes the release nothing points at. The switch uses `rename(2)`
  on the link path instead, and asserts afterwards that `current` advanced.
* **`pnpm` resolves to a `.ps1` before its `.CMD`.** (Windows.) The PowerShell
  shim cannot be launched as a process, so the installer takes the first
  `Application`-typed resolution rather than `(Get-Command pnpm).Source`.
* **Redirecting a native command's stderr inline sets `$?` to false.**
  (Windows.) Windows PowerShell 5.1 wraps each stderr line in an `ErrorRecord`,
  so a clean `exit 0` reads as a failure. The installer's own control flow runs
  every external command through one `Invoke-Native` helper that captures the
  two streams via `Start-Process` instead. Two spawns deliberately bypass it,
  each needing something `Start-Process` cannot express: the candidate-release
  probe, which clears the environment for the `env -i` analog, and
  `run-server.ps1`'s `cmd.exe` redirector, which needs append redirection.
* **Stopping a Scheduled Task does not reap its grandchildren.** (Windows.)
  Task Scheduler ends the `powershell.exe` it launched; the `cmd.exe` and
  `node.exe` beneath it survive. The orphan keeps `127.0.0.1:3100`, so the next
  start cannot bind — and because the orphan answers `/api/hello` exactly like a
  healthy server, every health check passes while the *old* release serves. This
  is the "a stale process on 3100 would let the post-install health check pass
  against the wrong server" trap from SELF_HOST.md's preflight, reached from the
  inside. Two defences, both required: the installer and `manage` reap every
  process belonging to the install root (matched by image path and command line,
  never by image name — that would kill unrelated `node.exe` processes including
  the invoking pnpm) before any start; and neither the installer nor
  `manage verify` accepts a 200 as proof, instead resolving the PID holding the
  port back to the release directory it runs from and comparing it to `current`.
  `Source of truth:` `Get-DormouseProcess` / `Get-ListeningRelease`.
* **Windows `tailscaled` serves its local API to one interactive session at a
  time.** (Windows.) On a PC with a second signed-in profile every `tailscale`
  call fails `401 Unauthorized: Tailscale already in use by <user>`. The
  installer matches that string in preflight and says which account holds it and
  what to do, rather than reporting the raw 401 as "is Tailscale signed in?".

`bin/manage` (`bin\manage.ps1`, with a `manage.cmd` shim, on Windows) carries
the operator surface: `status`, `verify` (runs every acceptance check and exits
nonzero on any failure), `logs`, `restart`, `show-password`, `serve` (re-apply
the Serve mapping after a dev session repointed it), `rollback`, `uninstall`,
and the separately-confirmed `purge`.

The Host that connects to such a server needs a build whose baked relay
allowlist admits the origin — see "Where a Host may reach a relay server"
above; a `*.ts.net` origin requires `DORMOUSE_REMOTE_CONNECT_SRC` at build time.

Availability follows from what a per-login agent is, on either platform: the
relay is down while the laptop sleeps, is shut off, or has no logged-in user.
That is usually fine, since there is then no local Host to control either. On
Windows the trigger is at-logon with `LogonType=Interactive`, which is what
keeps the task free of a stored password — and is the same tradeoff.

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

The shipped signed client bakes `https://*.dormouse.sh wss://*.dormouse.sh` into
its Host bundle as the only origins that Host may reach (above), and
passkeys bind to the served origin (`DORMOUSE_ORIGIN` → `rpId`/`origin`) with
Pocket served same-origin ([pocket-app.md](./pocket-app.md)). This is why a
selfhoster must produce a custom build (`DORMOUSE_REMOTE_CONNECT_SRC`) — the
stock client refuses any other origin — and it is the hard constraint on BYOT:
whatever a stock client connects to must present a `*.dormouse.sh` origin over
TLS. A raw `100.x` tailnet IP or a `*.ts.net` MagicDNS name is a different
origin and breaks both the allowlist and the passkey binding, so BYOT cannot
simply point the client at the tailnet node.

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
