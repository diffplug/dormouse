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

This table is the whole of what `server/src/` reads from the environment.

| Env var                   | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `DORMOUSE_SETUP_PASSWORD` | Required. Gates account creation and host enrollment.      |
| `DORMOUSE_ORIGIN`         | External origin, e.g. `https://dormouse.tailnet.ts.net`. Source of the WebAuthn `rpId`/`origin` and the Host's `ConnectionPolicy`. Defaults to `http://localhost:<port>` for dev. |
| `DORMOUSE_STATE_DIR`      | Where the JSON state files live. Default `./data`.         |
| `DORMOUSE_POCKET_DIR`     | The built Pocket app to serve at `/*`. Defaults to `lib/dist-pocket` resolved from the compiled server's own location rather than from the cwd, so a service manager's working directory cannot change what is served. Absent or missing its `index.html`, `GET /` is a plaintext stub naming the build command. |
| `PORT`                    | Default 3000. Blank is unset — `Number('')` is 0, which would ask the OS for an ephemeral port and move the server out from under whatever proxy is pointed at it. An explicit `PORT=0` is a `ConfigError` for the same reason. |
| `DORMOUSE_REQUIRE_USER_VERIFICATION` | `true` demands a *user-verified* passkey assertion (biometric/PIN), not merely user presence. Off by default, and only the exact string `true` enables it — a misspelling must read as off, because turning this on without UV-capable authenticators locks the account out of its own server. Applies to sign-in, re-auth and `connect2` alike, so no route is a softer path than another, and is mirrored to every Host in its `HostEnrollResponse` so both sides demand the same thing (`SECURITY.md` -> Remote Control). |
| `DORMOUSE_BIND_HOST`      | Interface to listen on. Unset binds every interface (what a container wants); set `127.0.0.1` when a TLS proxy on the same machine is the front door. |
| `DORMOUSE_VAPID_PUBLIC_KEY` / `DORMOUSE_VAPID_PRIVATE_KEY` | Web Push signing keypair. Set both or neither. At startup the Server decodes both, derives the P-256 public point from the private key, and exits on a missing, malformed, or mismatched pair. Unset, the server mints a pair on first boot and persists it to `vapid.json`. |
| `DORMOUSE_VAPID_SUBJECT`  | `mailto:`/`https:` contact for push-service operators (RFC 8292). Defaults to `DORMOUSE_ORIGIN` when that origin is https and not loopback; otherwise there is no default and push stays off. Validated at startup — an invalid value, a loopback contact included, exits. |
| `DORMOUSE_RUNTIME_FILE`   | Absolute path the server records `{pid, releaseId, port, origin, startedAt}` into once it has **bound**, mode `0600`. Unset — dev, containers, every test — writes nothing. A relative value is a `ConfigError`: the wrapper runs under a service manager whose working directory is not the installer's, so it would land somewhere neither side can predict. Deliberately outside `DORMOUSE_STATE_DIR`, being runtime truth about one process rather than durable state that gets backed up and restored. |
| `DORMOUSE_RELEASE_ID`     | The release directory's name, supplied by the installer's `run-server` wrapper, recorded in the runtime file. `null` when the server was not started by an installer. |

WebAuthn requires a secure context: `localhost` works for development; for a
real phone, put the server behind TLS (`tailscale serve` is the intended
selfhost path, any reverse proxy works). The server itself always speaks
plain HTTP.

Because of that, the listen interface is a security boundary whenever the TLS
proxy is local: `tailscale serve` reaches the app over loopback, so leaving the
socket on every interface would also publish the plaintext port to the LAN and
to the tailnet itself. `DORMOUSE_BIND_HOST` exists to close that, and the
selfhost install sets it. The default stays unbound so a container — where the
namespace is the boundary and the port is published explicitly — keeps working.
Binding loopback is *containment, not admission*: every route is still gated by
the setup password or a bearer token, exactly as `SECURITY.md` -> "Loopback
Listeners" requires. (That section's guard-module rule, and
`scripts/loopback-lint.mjs`, cover the app's browser-reachable local proxies;
this socket is out of their scope because it binds from config rather than from
a loopback literal.)

`DORMOUSE_ORIGIN` is parsed once and normalized with `URL.origin`; WebAuthn
clientData checks, passkey assertion verification, and the Host enrollment
policy all use that normalized origin.

Source of truth: `server/src/config.ts` (`readConfig`), a pure env→config
mapping unit-tested in `server/test/config.test.mjs`. Only the half that touches
disk stays in `server/src/index.ts`: with no keypair configured it mints one and
persists `vapid.json`, then validates the pair and subject before building the
app. `server/test/runtime-file.test.mjs` and `server/test/bind-host.test.mjs`
each spawn the real entrypoint — the first asserting the runtime file appears
only after a bind, names that process, and is `0600`; the second that the
plaintext port is unreachable off-loopback when `DORMOUSE_BIND_HOST=127.0.0.1`.

## Where a Host may reach a relay server (self-host builds)

Neither Host renders the relay socket in a webview any more: standalone's runs
in the Node sidecar and VS Code's in the extension host, so no CSP fences either
of them. The same CSP-shaped source list is therefore **baked into the Node
bundle** and enforced there — one syntax, one build-time variable
(`DORMOUSE_REMOTE_CONNECT_SRC`), whichever process ends up holding the socket.
The webview CSPs carry no relay sources at all (`docs/specs/vscode.md` → "CSP
policy"; `standalone/scripts/tauri-conf.test.mjs` asserts the standalone one).

The shipped binary is scoped to the SaaS origin only,
`https://*.dormouse.sh wss://*.dormouse.sh`. An override **replaces** that
default rather than adding to it, and is a per-build opt-in:

```sh
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
```

So a self-host server on any other origin is reachable only from a custom build
(same variable on `pnpm --filter dormouse-standalone tauri build`). The default
carries **no localhost entry**, and `http`/`ws` are a different scheme class
from `https`/`wss`, so a default build refuses to enroll against a plaintext
`http://localhost:3000` dev server — see "Running it" for the override a local
loop needs.

`scripts/csp-defaults.mjs` holds the one definition of the default and the
override rule; `standalone/scripts/build-sidecar-proxy.mjs` and
`vscode-ext/scripts/esbuild.mjs` esbuild-`define` it into their bundles, where
`bakedConnectSrc()` in `lib/src/host/remote/connect-src.ts` is the single reader.
Two build-time guards, both because their failure mode is silent: a lost define
compiles fine and would only show up as a Host quietly using the shipped default
instead of the selfhoster's origins, so `assertConnectSrcBaked` greps the bundle
for it; and an override the matcher could never read (a trailing slash, a path,
a bare host, a scheme outside `http`/`https`/`ws`/`wss`, a port outside 1–65535)
matches nothing at runtime, so `resolveRemoteConnectSrc` rejects it rather than
ship a binary that builds green and refuses the very server it was built for.
The grammar is one regex duplicated into the `.mjs`, which cannot import
TypeScript; `connect-src.test.ts` pins the two patterns — and the two copies of
the default — as identical.

**Enforcement is `originAllowedByConnectSrc`, at three points in
`lib/src/host/remote/service.ts`:** `enroll` is refused for an origin outside
the list, before the setup password leaves the machine; `adopt` is refused the
same way, since a webview handing over an older build's enrollment may name a
relay this build may not reach; and `start` refuses a persisted enrollment
naming one, staying idle with a warning rather than connecting (a binary
downgraded from a custom build, or a server that moved). Matching is
deliberately narrower than a browser's: `https`/`wss` are one scheme class and
`http`/`ws` the other, host matches exactly or by a leading `*.` wildcard
covering any depth of sub-domain but never the bare domain, ports must match
unless the source says `*` (and numeric ports are canonicalized as `URL` does,
so a leading zero is not a silent miss), and anything unparseable fails closed.
Enrollment and Host-authenticated push fetches use `redirect: 'error'`: unlike
the former webview CSP, a Node process does not re-check a redirect target, so
following one could carry the setup password, Host bearer token, or notification
metadata outside the baked allowlist.

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

Every write is temp-file-plus-rename, and every mutation is serialized through a
per-store promise chain, so a crash cannot leave an unparseable file and two
concurrent read-modify-writes cannot lose each other. Source of truth:
`server/src/state.ts`.

**Rows are validated as they are read** — `hosts.json` and
`push-subscriptions.json` both — because hand-editing these files is the
*documented* revocation mechanism, so a half-finished edit is an expected state
rather than corruption. A malformed host row is dropped instead of carried;
unguarded, one with a null `hostToken` makes `findByToken`'s digest compare
throw, which 500s every `/ws/host` upgrade and every push route over one bad
line. A malformed subscription reads as a missing registration, which Pocket
repairs by re-offering Enable, rather than as a live one nothing can be
delivered to.

`push-subscriptions.json` is the one store that deletes rather than appends: a
push service reports a dead subscription with 404/410, and a browser that
rotates its endpoint must replace the stale row rather than leave one per
rotation. Rows are keyed on the **pair** (`hostId`, `devicePublicKey`), so a
phone paired with two laptops subscribes twice and a Host can only ever read or
reach its own subscribers, and each records the public VAPID key it was
registered under so a rotation reads as stale rather than as still working. The
row holds no label — the Server never learns one. Because one service-worker
scope has only one subscription, an upsert whose endpoint, encryption keys, or
VAPID key differs from an existing row for that device atomically deletes all of
the device's prior Host rows. The response reports the state that mutation left
behind — every Host this device is still registered with — rather than the fact
that a deletion happened, so a committed POST whose response was lost is
repaired by its own idempotent retry. Scoping that answer to the device is safe
where `GET /api/push/subscriptions` must not be: the request carries a device
signature, so the caller has proven it owns the identity reported on.

`hosts.json` stores `hostToken` — the host↔server relay bearer secret — in
plaintext, and `vapid.json` a private key, so both files are written owner-only:
the state dir is created `0o700` and every write lands in a `0o600` temp file
before the rename. Any new file under `$DORMOUSE_STATE_DIR` must go through
`writeAtomic` for the same reason.

That mode is a cheap default, not the guarantee the deployment rests on, and the
difference is worth stating so nothing is built on top of it. It earns its place
on a multi-user unix host, where home-directory permissions vary by distro, so
without an explicit mode whether a second local account can read `hosts.json`
depends on which distro the selfhoster picked. It buys nothing where modes are
not the mechanism — Windows, a container, a database-backed deployment. What
protects the *installed* server's state is the installer's directory
permissions, in "Installing it" below.

## WebAuthn without a WebAuthn library

Two facts keep the server dependency-free:

* **Registration**: browsers expose the new credential's public key directly —
  `response.getPublicKey()` returns SPKI DER. No CBOR, no attestation parsing
  (we request `attestation: 'none'` anyway).
* **Assertions**: `verifyPasskeyAssertion` in `server-lib-common` already
  verifies full assertions against an SPKI key — the same function the Host
  uses, so Server and Host literally cannot disagree on what a valid assertion
  is.

`POST /api/setup/finish` takes `{ credentialId, publicKey, clientDataJSON }` and
checks, in order: `clientDataJSON` decodes; `type === 'webauthn.create'`; its
challenge redeems (400 otherwise); `origin` equals the configured origin; the
public key imports as an ECDSA P-256 verify key — refusing anything assertions
could not later be verified against; and the credential id is new (409
otherwise, so a re-registered credential cannot silently displace a stored key).

Sign-in and re-auth share one verifier: look up the **stored** passkey for the
asserted credential (404 if unknown), pull the challenge out of the assertion's
own `clientDataJSON`, consume it *before* verifying so a captured assertion can
never be replayed even when verification would succeed, then
`verifyPasskeyAssertion` against the stored key under the server's UV policy.

Challenges are `HostChallengeIssuer` from `server-lib-common` — a generic
single-use/TTL store despite the name — and setup, sign-in/re-auth, and
push-subscribe each get **their own issuer**, so a challenge minted for one flow
can never be redeemed in another. Before consuming, the server canonicalizes the
browser's `clientDataJSON.challenge` by decoded base64url bytes, so padded
browser serializations redeem the issued challenge without weakening single-use
replay protection.

Sharing the verifier is also what makes the whole thing testable without a
browser — see Testing below.

## HTTP API

This table is the whole of it. The paths live in `API_ROUTES` / `WS_ROUTES` /
`HELLO_ROUTE` in `server-lib-common`, so Server, Host and Pocket cannot drift.

| Route                            | Auth           | Does                                              |
| -------------------------------- | -------------- | ------------------------------------------------- |
| `GET /api/hello`                 | —              | The shared greeting. Deliberately carries no release identity: it is unauthenticated, CORS-`*` and reachable through `tailscale serve` — see the runtime file under "Installing it" |
| `POST /api/setup/begin`          | setup password | `{ challenge }` for registration. Only the password gates it — re-presenting the password adds another passkey to the account |
| `POST /api/setup/finish`         | setup password | `{ credentialId, publicKey, clientDataJSON }` → creates/updates `account.json` |
| `POST /api/signin/begin`         | —              | `{ challenge }` for sign-in                        |
| `POST /api/signin/finish`        | —              | full assertion → verified → `{ sessionToken, accountId, expiresAt, passkeyPublicKey }` (token is 32 random bytes, in-memory, 12-hour TTL) |
| `POST /api/reauth/begin`         | session token  | `{ challenge }` to re-assert presence on the current session |
| `POST /api/reauth/finish`        | session token  | full assertion → verified (same checks as sign-in) → refreshes the session's presence stamp; the token and relay socket are kept |
| `POST /api/host/enroll`          | setup password | `{ label }` → `{ hostId, hostToken, origin, rpId }` (plus `requireUserVerification` when on); appends to `hosts.json` |
| `GET /api/hosts`                 | session token  | Enrolled hosts + whether each is currently connected |
| `GET /api/push/config`           | —              | `{ applicationServerKey }` — the VAPID public key, or `null` when push is unconfigured. Public by construction |
| `POST /api/push/challenge`       | session token  | `{ challenge }` for the device signature below (no body — the challenge is a pool-wide nonce; the host binding lives in the signature) |
| `POST /api/push/subscribe`       | session token + device signature | Upserts the `(hostId, devicePublicKey)` subscription. 404 for an unknown `hostId`, so no row can strand where no Host can read or prune it |
| `GET /api/push/subscriptions`    | session token  | The account's registrations for the current VAPID key as identities, so a reloaded Client can tell which Hosts it already registered with. With push disabled, returns the stored identities for diagnosis |
| `GET /api/push/devices`          | host token     | The `devicePublicKey`s subscribed to **this** Host under the current VAPID key |
| `POST /api/push/send`            | host token     | Fans a notification out to the named devices; `devicePublicKeys` is required |
| `GET /ws/host`                   | host token     | The Host's relay socket                            |
| `GET /ws/client`                 | session token  | A Client's relay socket                            |
| `GET /*`                         | —              | The built Pocket app, registered last so every route above wins. Cache policy and SPA fallback: [pocket-app.md](./pocket-app.md) |

`/api/*` is CORS-`*`, which is safe here because every endpoint is gated by the
setup password or a bearer token and no cookies exist for a foreign origin to
ride on; the Host and dev Pocket builds call from other origins. WS auth rides
the `token` query param, since browsers cannot set WebSocket headers.

The setup password is compared in constant time (SHA-256 digests, so length
never branches) with a small fixed delay on failure; host tokens are resolved
the same way, checking every row without an early break. That is the extent of
the hardening today.

Every session-gated route — including the `/ws/client` upgrade, which is
rejected before `injectWebSocket` ever sees it — answers an unknown or expired
token with 401 and the shared `UNAUTHORIZED_ERROR` from
`server-lib-common/src/remote/wire.ts`. That exact string is load-bearing:
Pocket keys its "sign in again" recovery on it, and a bare 401 is ambiguous,
since a wrong setup password and a rejected device signature answer 401 as well
([pocket-app.md](./pocket-app.md) -> An expired session drops to sign-in).

### Web Push

A push must reach a phone whose app is closed, which the relay cannot do, so it
is plain HTTP rather than a relay frame and goes out to the platform's push
service (APNs, FCM) through `web-push` — the server's one third-party runtime
dependency. Source of truth: `server/src/push.ts` plus the routes in
`server/src/app.ts`; the Host and webview halves are
[alert.md](./alert.md) -> Push notifications.

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
  device. Neither takes a `devicePublicKey` as input, so no endpoint reports on
  an identity the caller does not hold. Both return identities only — the
  endpoint and its keys are a bearer capability to notify that phone, and never
  leave the Server.
- **Delivery views are VAPID-current.** With push configured,
  `/api/push/subscriptions` and `/api/push/devices` omit rows registered under a
  different (or legacy unknown) public key, and `/api/push/send` never targets
  them — those endpoints cannot receive a send signed by the current key.
  Hiding them exposes Pocket's re-registration action and keeps the Host from
  naming or retrying an unreachable device after a rotation. The rows stay on
  disk until that repair; with push disabled the Client route still returns
  their identities for diagnosis, while the Host has no deliverable devices.
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
- **Endpoint egress is public HTTPS only.** This is the one path where the
  Server makes an outbound request to a Client-supplied address, and on a server
  inside a tailnet `100.64/10` is exactly what it must not reach. Registration
  rejects credentials, localhost, and non-public IP literals; delivery goes
  through a dedicated HTTPS agent whose connection-time DNS lookup rejects every
  non-public range, refuses a hostname *wholesale* if any answer is blocked, and
  hands the socket the exact address it checked so rebinding and mixed answers
  cannot create a second unchecked resolution. The range list is
  `SECURITY.md` -> "Remote Control". Source of truth:
  `server/src/push-endpoint.ts`, wired into registration in `server/src/app.ts`
  and delivery in `server/src/push.ts`.
- **Payload text is re-sanitized at this boundary** even though the Host already
  did it, because it originates in a renderer and is ultimately Pane-derived
  ([alert.md](./alert.md) -> Text And Security). Both sides call the same
  `boundedPushText`, so the two layers cannot enforce different rules.
- **Delivery outcomes prune.** 404/410 means the subscription is permanently
  gone and its row is deleted; anything else is transient and left alone, but
  never silent: the refusal is logged (origin only — the endpoint is a bearer
  capability) and counted in the response's `failed`, since the route answers
  200 either way and the Host needs to tell an all-failed fan-out from success.
  The log carries the push service's own reason body alongside the status —
  whitespace-collapsed and capped at 200 characters so an HTML error page cannot
  flood it — because a status alone does not separate a bad subject from a bad
  key from a bad payload, and this is the only place that explanation is ever
  visible.
- **Delivery is bounded twice, and both bounds resolve as `failed`** so the row
  survives to be retried, unlike a 404/410. The inner bound is a 10-second
  socket-inactivity timeout per push-service request; the outer is a 15-second
  wall-clock deadline per send, catching what inactivity cannot — a service that
  trickles bytes or stalls mid-handshake resets the inactivity timer forever.
  The deadline is applied by the *route*, not the sender, so it holds for any
  injected `PushSender`, and since every send in a fan-out starts at once it
  bounds the route as a whole regardless of device count. It bounds the route,
  not the socket: `web-push` accepts no `AbortSignal`, so a request that loses
  the race is left to its own inactivity timeout. What it prevents is a wedged
  push service holding the handler open while successive alarms stack concurrent
  sends behind it. Both are separate from the 300-second provider TTL — an alarm
  that arrives an hour late is noise, not information.
- Push is disabled, not half-working, when no VAPID key **or no VAPID subject**
  is configured: the config route reports `null` and challenge/subscribe/send
  answer 503. The key and the subject are advertised together or not at all — a
  phone that registered against a key the Server has no contact to sign with
  would be subscribed to a push it can never receive.
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
(`@hono/node-ws`). Before a session is authorized it only forwards an allowlist
of handshake types — `pair`/`connect`/`connect2` up,
`pair-result`/`challenge`/`decision` down — and after authorization it forwards
`msg` verbatim. A session becomes established purely on the Host's authority:
the Host sending `{ t: 'decision', allowed: true }` is what unblocks `msg` in
both directions. `clientId` is a server-assigned secret stamped onto every
host-bound frame so the Host can address replies, and is never sent to the
Client.

Only one socket may own a `hostId`. Registering a second one for the same
`hostId` displaces the first: clients bound to it are told `host-gone`, their
sessions are cleared, and the old socket is closed with
`WS_CLOSE_HOST_REPLACED` (4000) / `WS_CLOSE_HOST_REPLACED_REASON`. Those
constants live in `server-lib-common`, not in `server`, because the code is a
contract rather than a log line: the evicted Host keys its stand-down on it
(see [Host side](#host-side-lib--the-two-node-hosts)). Clearing the sessions at
*replacement* time and not only on disconnect is load-bearing — the displaced
socket's own close event is a no-op here, and the new Host process has a fresh
ACL and no memory of those sessions, so their in-flight `msg` frames must never
stay authorized. Source of truth: `server/src/relay.ts` (`registerHost`).

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
timestamp. That memory is consumed **unconditionally** on the next `connect2`,
whether or not the rest of the check passes, so a replayed `connect2` is refused
at the relay before the Host's challenge can be burned. Source of truth:
`server/src/handshake.ts`.

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
`devicePublicKey`, `requestedLabel`). Before relaying, the server checks the
request is well-formed, is for the owner account, names a registered passkey
credential, and carries that key's real public-key hash — an *account*-level
check, since the `/ws/client` session is not bound to one credential. It also
requires **fresh presence**: the session's last server-verified assertion
(sign-in, re-auth, or a `connect2`) must be within
`PAIRING_PRESENCE_WINDOW_MS`, else the request is answered locally with
`pair-result approved:false, error: 'stale-presence'` and the Pocket client
re-asserts via `/api/reauth/*` (one biometric prompt) and retries. Anything
answered locally never reaches the Host, so it can never appear in the approval
UI or burn a ticket. The ceremony beyond this point — `PairingCeremony`, local
approval as the only thing that writes the ACL — is
[remote-security-model.md](./remote-security-model.md) -> Pairing Ceremony.

**Both sides run the shape guard**, and deliberately so: the server's
`isPairingRequest` is a courtesy that keeps a bad frame off the wire, while the
Host runs the same guard on arrival because the security model does not trust
the relay. A Host that leaned on the server's check would be taking a relayed
object on faith in the one place — the approval UI and the record it writes —
where that is least acceptable. The Host likewise reduces `requestedLabel` with
`boundedPairingLabel` before any consumer sees it (same rule as
`boundedPushText`): it is attacker-chosen text rendered in a security dialog.
Source of truth: `RemoteHost.#onPair` in `lib/src/remote/host/remote-host.ts`.

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

**One host challenge feeds both signatures**, so the user gets one Face ID
prompt per connection: the Client awaits the relayed `challenge`, then produces
the WebAuthn assertion *and* the device-key signature over that same string
before sending one `connect2` (`PocketClient.connect` in
`lib/src/remote/client/pocket-client.ts`).

The server's half of "fresh user presence is validated by the Server and the
Host" is four checks, all of which must pass or the Client gets a `decision`
with the failure list and the Host never sees the request: the challenge is the
exact one this server relayed to *this* client for *this* host and unexpired;
the account is the owner; the asserted credential is a registered passkey whose
stored key equals the one the request carries; and the assertion verifies
**against the stored key** — never against `request.passkey.publicKey`, which is
what makes a substituted public key useless. A pass also refreshes the session's
presence stamp, so "connect to host A, then pair host B moments later" needs no
second prompt. The Host's `authorizeConnection` remains the final authority
regardless of what the server claims to have checked.

### After authorization

The relay stops reading and becomes a dumb `msg` pipe. What flows through it is
exactly the terminal-only protocol-v1 scope of
[remote-api.md](./remote-api.md) -> v1 scope, which owns that message set and
stages everything past it.

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

**One service, two bindings.** The runtime every host shares lives in
`lib/src/host/remote/`: the service itself (`service.ts`), the wire contract
both ends of the bridge compile against (`service-protocol.ts`), the webview
half of the bridge (`link-client.ts` — command correlation, the 15 s timeout,
and the rule that an ask is *always* answered even when nothing matches), the
enrollment exchange (`enrollment.ts`), the edge-triggered webview gate
(`enrolled-gate.ts`), the ask-backed surface provider
(`ask-surface-provider.ts`; the provider seam itself is
[remote-api.md](./remote-api.md)), and `serial-queue.ts`. What remains per host
is its store, its process plumbing, and its transport for the three bridge
messages — specced in `docs/specs/standalone.md` → "Remote Host service" and
`docs/specs/vscode.md` → "Remote Host: a service in the extension host", with
the per-host message-name table in `docs/specs/transport.md` → "Message
protocol".

**The store contract.** Both stores implement `HostStateStore`
(`lib/src/host/remote/host-state-store.ts`) under the same rules: reads fail
closed — an error that says nothing about what the file holds must answer
neither empty nor stale, because an empty ACL silently de-pairs every device;
the in-memory view advances only after the durable write lands, so a failed
save cannot be mistaken for durable state by a later read; every mutation is
serialized in call order through the shared `createSerialQueue`
(`lib/src/host/remote/serial-queue.ts`, also the service's own start/stop
chain) — two rapid pairing approvals write successively larger ACL snapshots,
and the older must not finish last and erase the newer; and a store that
cannot persist still *holds* what it is given in memory and reports
`persistent: false` rather than dropping writes. Each store's mechanics — the
sidecar's single 0600 JSON file, rename semantics, and memory fallback;
VS Code's SecretStorage/globalState split and cross-window memo invalidation —
live in that host's spec.

* **Enrollment** (Settings dialog, or the console hook, once): server URL +
  setup password → `POST /api/host/enroll` → the service persists
  `{ serverUrl, hostId, hostToken, origin, rpId }` (+ `requireUserVerification`
  when the server sent it) through its `HostStateStore` — a 0600 JSON file under
  the app-data dir in standalone, `SecretStorage` in VS Code — then opens and
  maintains `GET /ws/host`. `hostToken` is a bearer credential and never enters a
  webview realm. Refused outright for a server outside this build's allowlist
  (above), before the password leaves the machine. **A 200 that is not an
  enrollment fails the exchange**: the response goes through the same
  `isEnrollment` guard every *read* uses, and a body missing a field or sending
  one mistyped throws naming those fields rather than minting a record with an
  `undefined` in the `ConnectionPolicy` the Host authenticates passkeys against —
  one the store would reject on the next read, un-enrolling the machine at the
  next launch. The request carries a 10 s `AbortSignal.timeout`, under the
  webview's own 15 s command budget so the console sees the real error, because
  it runs on the service's lifecycle chain where every later start/stop command
  queues behind it. Source of truth: `lib/src/remote/host/enrollment.ts`.

  **Order matters, and the store goes first.** The `hostToken` exists nowhere
  else and cannot be re-minted from the same password exchange, so the save is
  awaited before any Host is stopped: a failed write leaves the old Host running
  and every answer it gives still true, rather than stranding the machine with
  no Host, a status that says otherwise, and a lost credential. Replacing a
  *running* Host emits `{ name: 'status', enrolled: false }` between the two,
  because the webview gate that arms on it is edge-triggered and everything it
  holds — the mirrored pairing queue, the push device list — belongs to the
  server being left (`lib/src/remote/host/enrolled-gate.ts`). `clearEnrollment`
  is the same rule backwards: the delete is awaited first and nothing else
  happens unless it succeeded, since reporting un-enrolled over a failed delete
  would leave the credential on disk for the next launch to read back.
* **Relay socket policy**: one socket at a time, reconnected with exponential
  backoff (1 s, doubling to 30 s) after any close — except a close carrying
  `WS_CLOSE_HOST_REPLACED`, which is **terminal**. That code means another
  Dormouse instance enrolled with the same `hostId` took the relay slot, so this
  one disposes its sessions, reports `displaced`, and arms no timer; reconnecting
  on it would evict the newer Host, which would reconnect and evict this one,
  forever. Coming back is an explicit act — `reconnect()` — which takes the slot
  back and displaces the other Host in turn. `displaced` is therefore the one
  connection state the user has to act on, and the only one the Settings dialog
  gives a button. A close event from a socket the controller no longer owns is
  ignored, so a dead socket's late eviction cannot stand down the live one, and
  disposing the service is terminal: an enrollment or ACL read already in flight
  cannot construct a socket after its sidecar/extension instance tore down.
  Source of truth: `lib/src/remote/host/remote-host.ts`,
  `lib/src/host/remote/service.ts` (lifecycle + console commands),
  `lib/src/remote/host/activation.ts` (the webview's client half).
* **Security**: `HostAcl` (persisted through the `HostStateStore`, keyed per
  `hostId`, so an enrollment onto a fresh `hostId` starts with an empty ACL while
  a re-enrollment onto the same one keeps its paired devices),
  `HostChallengeIssuer`, `PairingCeremony`, and `authorizeConnection` — all
  straight from `server-lib-common`, running in the service's process. Nothing a
  webview says can widen access.
* **Pairing approval modal**: the queue is service-side; webviews mirror a
  serializable projection (`{ clientId, pairingId, request, requestedAt }[]`,
  pushed whole on every change) and echo both ids on Approve / Deny, so the
  approve/deny closures never leave the Host's process. **Approval is bound to
  the displayed `pairingId`, not whichever request currently occupies
  `clientId`.** The service coalesces a re-sent pair under one `clientId` by
  *replacing* what it holds, but rejects an old modal action whose immutable
  ticket id no longer matches; the mirror compares on `pairingId` and remounts
  keyed by it, while leaving an unchanged item alone — every snapshot arrives as
  fresh JSON, so identity comparison would re-render on every event. The modal
  shows the requested label + account with Approve / Deny (same pattern as
  KillConfirm); approving after the ticket expires sends
  `pair-result approved:false` and dismisses, ACL untouched. In VS Code the queue
  is broadcast to every window, since any may be the one in front of the user.
* **Terminal bridge**: served through a `HostSurfaceProvider`
  ([remote-api.md](./remote-api.md)). `directory.watch` snapshots come from the
  webviews that own the panes; `surface.attach` resizes through the owning
  webview's live xterm and streams the PTY from the process that owns it;
  `terminal.write` feeds the existing input path. Last-attach-wins size authority
  holds at the PTY level through that same resize path.

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
  *connection* moves with no event at all, so the store also polls every 2 s
  **while something is subscribed** — the seconds the dialog is open, not a
  standing timer in every window. Without it a machine that finished connecting
  a moment after the dialog opened would read as permanently "Connecting…". The
  answer is compared field-wise before being published, since the service returns
  a fresh object every poll and the section would otherwise re-render twice a
  minute to paint identical text (same rule as `setPushDevices` in
  `lib/src/lib/push-devices.ts`).
- **Reads are serialized, and coalescing stops at anything that changes the
  answer.** Ticks arriving during a slow read queue behind it, so a 15-second
  Host-service timeout becomes the visible error instead of being superseded by
  newer polls. But `enroll`, `reconnect` and `clearEnrollment` each *drop* the
  read in flight, because a `status` issued beforehand answers the question as it
  stood then — joining it would report the old enrollment as though the command
  had not run, the inverse of the delete-first ordering the service uses. Losing
  the last subscriber drops it for the same reason: a reopened dialog must not be
  answered with a status fetched for the closed one, and would otherwise sit on
  "Checking…" until that read settled. Source of truth: `dropInFlightRead` in
  `lib/src/remote/host/host-status-store.ts`.

The `window.dormouseRemoteHost` console hook keeps the same four commands and
remains the scripting seam. Pairing approval is deliberately *not* here: it is a
modal, because it must interrupt
([remote-security-model.md](./remote-security-model.md), Pairing Ceremony).

`docs/stories/pairing.mdx` walks this section and the pairing modal in sequence
with the rest of the setup, rendering the real components; it is a narrative
Storybook page, not a spec, so this section is what it defers to.

## Pocket side (phone)

Pocket is served by this server and built from `lib`; its architecture,
theming, and same-origin deployment rule are [pocket-app.md](./pocket-app.md).
What matters here is only the seam: the server ships the static build and
authors no styling of its own — its one self-authored response is the plaintext
missing-build stub at `GET /`.

## Testing

The security and relay layers are covered without a browser: `pnpm --filter
server test` drives setup → pairing → connect end to end through the real server
— `app.request()` for HTTP routes, real WebSockets against an ephemeral-port
server for the relay — using `SimAuthenticator` (from `server-lib-common`) plus
the `FakeHost` harness in `server/test/harness/fake-host.mjs`. Two suites
instead spawn the real entrypoint, because what they assert is a property of the
process rather than of the app: `bind-host` and `runtime-file`. Revoked-record
denial is covered at the unit level in `server-lib-common`'s own tests, not
through the relay. Browser-dependent layers — the Host module and the Pocket
terminal view — are dogfooded rather than automated.

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

Enrollment then persists in the service's own store, and on later launches the
Host connects by itself. (`status()` / `reconnect()` / `clearEnrollment()` on
the same object; all four are promises, since the hook forwards to the service.)
For a headless stand-in host instead:
`DORMOUSE_SETUP_PASSWORD=hunter2 node server/scripts/fake-host.mjs http://localhost:3000`
— it instantiates the test harness's `FakeHost` and differs only in
auto-approving pairing and logging.

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

## Installing it

The shipped selfhost deployment is a per-login user agent on the user's own
machine, reachable only from their tailnet — a LaunchAgent on macOS, a
Scheduled Task on Windows, a systemd *user* service on Linux — with
`tailscale serve` terminating HTTPS on the node's MagicDNS name and proxying to
the server on loopback. There is no cloud relay: an always-on relay is the same
installer on an always-on tailnet machine. Availability follows from what a
per-login agent is: the relay is down while the machine sleeps, is shut off, or
has no logged-in user — usually fine, since there is then no local Host to
control either.

**[SELF_HOST.md](../../SELF_HOST.md) is both the operator runbook and the
installer spec**: the platform mechanism map, the invariants the three
installers hold, and the mechanical traps they encode all live in its
"Installer contract" section, audited by the `FAIL IF` lines in `SECURITY.md`
and checked textually by `scripts/deploy-lint.mjs` (`pnpm lint:deploy`).
Source of truth: `deploy/local/install-macos.sh`,
`deploy/local/install-windows.ps1`, `deploy/local/install-linux.sh`.

Two couplings stay on this side of the seam: the server writes
`DORMOUSE_RUNTIME_FILE` / `DORMOUSE_RELEASE_ID` once bound (Configuration
above) so the installers' health checks can prove *which* release answered
rather than accepting any 200 on the port; and a Host connecting to an
installed server needs a build whose baked relay allowlist admits the origin —
a `*.ts.net` origin means `DORMOUSE_REMOTE_CONNECT_SRC` at build time (see
"Where a Host may reach a relay server" above).

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

Two things above the fold combine into one hard constraint: the shipped Host
bundle may reach only `*.dormouse.sh`, and passkeys bind to the served origin
with Pocket served same-origin ([pocket-app.md](./pocket-app.md)). So whatever a
stock client connects to must present a `*.dormouse.sh` origin over TLS. A raw
`100.x` tailnet IP or a `*.ts.net` MagicDNS name is a different origin and
breaks both the allowlist and the passkey binding, so BYOT cannot simply point
the client at the tailnet node.

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
