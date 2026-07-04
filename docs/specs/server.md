# Server (selfhost POC)

The coordinating Server from the
[remote security model](./remote-security-model.md), in its selfhost mode, cut
down to the smallest thing that completes this loop:

> Run the server with a setup password. Visit it, present the password, create
> a passkey. Pair your phone with your laptop's Dormouse Terminal. Move a
> running terminal session from the laptop to the phone.

One Node process (Hono, as the `server` package already is). No database. No
browser-surface support — **terminal-only**. The heavy lifting is already
done: every security primitive lives in `server-lib-common`, and the terminal
UI lives in `lib`/`standalone`.

## POC guardrails

* One account (`accountId: "owner"`), created once with the setup password.
* Terminal surfaces only; the remote-api v1 subset minus browser surfaces.
* Revocation is editing a JSON file by hand; no management UI.
* A dropped WebSocket is handled by reloading the page / reconnecting the
  host. No resume protocol.
* Everything transient (challenges, sessions, relay state) is in memory; a
  server restart just means everyone reconnects.

---

# Configuration

| Env var                   | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `DORMOUSE_SETUP_PASSWORD` | Required. Gates account creation and host enrollment.      |
| `DORMOUSE_ORIGIN`         | External origin, e.g. `https://dormouse.tailnet.ts.net`. Source of the WebAuthn `rpId`/`origin` and the Host's `ConnectionPolicy`. Defaults to `http://localhost:<port>` for dev. |
| `DORMOUSE_STATE_DIR`      | Where the JSON state files live. Default `./data`.         |
| `PORT`                    | Default 3000.                                              |

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

# State files

```
$DORMOUSE_STATE_DIR/
  account.json   { accountId: "owner",
                   passkeys: [{ credentialId, publicKey /* SPKI b64u */,
                                label, createdAt }] }
  hosts.json     [{ hostId, hostToken, label, enrolledAt }]
```

That is the entire persistent state. The Host's ACL is not here — it lives on
the Host (platform `saveState`), which is the whole point of the security
model.

---

# WebAuthn without a WebAuthn library

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
`app.request()` and a pair of in-process WebSockets.

---

# HTTP API

| Route                            | Auth           | Does                                              |
| -------------------------------- | -------------- | ------------------------------------------------- |
| `GET /*`                         | —              | Serves the Pocket web app (static build of `lib`'s pocket entry) |
| `POST /api/setup/begin`          | setup password | `{ challenge }` for registration; rejects if the account already has a passkey (add more by re-presenting the password) |
| `POST /api/setup/finish`         | setup password | `{ credentialId, publicKey, clientDataJSON }` → creates/updates `account.json` |
| `POST /api/signin/begin`         | —              | `{ challenge }` for sign-in                        |
| `POST /api/signin/finish`        | —              | full assertion → verified → `{ sessionToken }` (random, in-memory, hours-scale TTL) |
| `POST /api/host/enroll`          | setup password | `{ label }` → `{ hostId, hostToken, origin, rpId }`; appends to `hosts.json` |
| `GET /api/hosts`                 | session token  | Enrolled hosts + whether each is currently connected |
| `GET /ws/host`                   | host token     | The Host's relay socket                            |
| `GET /ws/client`                 | session token  | A Client's relay socket                            |

The setup password is compared in constant time with a small fixed delay on
failure; that is the extent of POC hardening.

---

# Relay

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

## Pairing (phone ↔ laptop, first time)

```
phone                        server                        host (laptop)
  |-- signin (passkey) -------->|                              |
  |   generate device key       |                              |
  |-- pair-request ------------>|-- pair-request ------------->|  approval modal
  |                             |                              |  user clicks Approve
  |<-- pair-result -------------|<-- pair-result --------------|  ACL record saved
```

The `pair-request` carries the `PairingRequest` shape from `server-lib-common`
(`accountId`, `passkeyCredentialId`, `passkeyPublicKeyHash`,
`devicePublicKey`, `requestedLabel`). The server checks the session's
credential matches and rejects malformed requests before relaying; the Host runs
`PairingCeremony` and only local approval writes the ACL. A malformed
`PairingRequest` is answered locally with `pair-result approved:false` and is
never shown in the Host approval UI.

## Connect (every session)

```
phone                        server                        host
  |-- connect-request {hostId}->|-- challenge-request -------->|
  |<-- challenge ---------------|<-- challenge (HostChallengeIssuer)
  |   ONE biometric prompt:     |                              |
  |   WebAuthn get({challenge}) |                              |
  |   + device-key signature    |                              |
  |-- ConnectionRequest ------->|  server verifies the         |
  |                             |  assertion itself, then      |
  |                             |-- ConnectionRequest -------->|  authorizeConnection()
  |<-- session-established -----|<-- decision -----------------|  (final authority)
  |============ opaque remote-api relay from here ============>|
```

One host challenge feeds both signatures, so the user gets one Face ID prompt
per connection. The server verifies the assertion against the stored passkey
(its half of "fresh user presence is validated by the Server and the Host")
and drops the request on failure; the Host's `authorizeConnection` remains the
final authority regardless of what the server claims to have checked.

## After authorization: remote-api v1, terminal-only

Exactly the v1 scope of [remote-api.md](./remote-api.md) minus browser
surfaces: `hello`, `directory.watch` (snapshot-only), one `surface.attach`
(attach-is-the-resize), `terminal.data`/`semantic`/`resize`/`closed` out,
`terminal.write`/`terminal.resize` in.

---

# Host side (`lib` + `standalone`)

A `remote-host` module in `lib`, active in standalone:

* **Enrollment** (settings UI, once): server URL + setup password →
  `POST /api/host/enroll` → persist `{ serverUrl, hostId, hostToken, origin,
  rpId }` via the platform adapter; open and maintain `GET /ws/host`.
* **Security**: `HostAcl` (persisted with `saveState`/`getState` as
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
* **Tethering**: while a remote session holds size authority, the local pane
  greys out to "tethering to \<label\>"; local interaction reclaims it.

# Pocket side (phone)

Served by the server, built from `lib`:

* Sign-in with passkey; session token in memory.
* Device key: `generateDeviceKeyPair()` persisted as non-extractable
  CryptoKeys in IndexedDB (the tiny IndexedDB wrapper lives in `lib` — it is
  DOM-dependent, so not in `server-lib-common`).
* First run against a host: pairing flow, then connect. After that: connect
  straight away.
* Picker renders `directory.snapshot`; tapping a pane attaches with the
  phone's cols/rows and reuses the existing mobile terminal UI (xterm).

---

# Build order — five slices, each testable

1. **Accounts & passkeys.** Setup/sign-in endpoints + `account.json` +
   static-serving stub. Tests: `node --test` with `SimAuthenticator` against
   `app.request()` — register, sign in, wrong password, replayed challenge,
   wrong origin. Manual: create a real passkey at `localhost:3000`.
2. **Relay & host enrollment.** `hosts.json`, host/client sockets, envelope
   routing, presence in `GET /api/hosts`. Tests: two in-process WebSockets
   echo through the relay; token/session rejection.
3. **Security handshake over the relay.** A headless fake host (a Node script
   wiring `server-lib-common` exactly as the harness's `SimHost` does) +
   `SimAuthenticator` client: full pairing ceremony and connect through the
   real server, plus the deny cases (unpaired device, revoked record, replayed
   challenge). Still no browser anywhere.
4. **Standalone host module.** Enrollment settings, approval modal, ACL
   persistence, host socket. Dogfood: pair a second browser profile (or the
   phone) against your real standalone app and watch the modal + ACL.
5. **Terminal bridge + Pocket terminal view.** Directory, attach-is-the-resize,
   write/resize, tether display, mobile terminal UI hookup. Dogfood — the
   actual goal: pick up a running session from your laptop on your phone.

Slices 1–3 are pure Node with full automated coverage; browsers only enter at
slice 4. After slice 5 the POC is in daily-use territory, and everything
after that (browser surfaces, in-flight replay, thumbnails, WebRTC) is
already staged in remote-api.md as additive follow-ups.

---

# Running the POC

All five slices are implemented. To test end to end:

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
(auto-approves pairing; answers `hello` only — no real terminals).

**3. Phone** (or any other browser profile): open the server origin →
First-time setup (password + label) creates the passkey and signs you in →
Hosts → **Pair** → approve in the modal on the laptop → **Connect** (one
biometric prompt) → pick a pane → type.

POC limitations to know about: pair/connect only works from the browser that
registered the passkey (the passkey public key is stored client-side at
registration); clearing site data destroys the device key → re-pair, per the
security model; a dropped WebSocket sends you back to the Hosts view —
reconnect by tapping Connect again.
