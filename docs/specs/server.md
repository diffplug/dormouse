# Server (selfhost POC)

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

## POC guardrails

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

WebAuthn requires a secure context: `localhost` works for development; for a
real phone, put the server behind TLS (`tailscale serve` is the intended
selfhost path, any reverse proxy works). The server itself always speaks
plain HTTP.

## State files

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

This also makes the server fully testable without a browser: the
`SimAuthenticator` harness in `server-lib-common` produces real assertions,
so `node --test` can drive setup → pairing → connect end to end via
`app.request()` and a pair of in-process WebSockets.

## HTTP API

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

### Pairing (phone ↔ laptop, first time)

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

### Connect (every session)

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

### After authorization: remote-api protocol-v1

Exactly the protocol-v1 scope of [remote-api.md](./remote-api.md)
(terminal-only): `hello`, `directory.watch` (snapshot-only), one
`surface.attach` (attach-is-the-resize), `terminal.data`/`semantic`/`resize`/
`closed` out, `terminal.write`/`terminal.resize` in.

## Host side (`lib` + `standalone`)

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

## Testing

The security and relay layers are covered without a browser: `node --test`
drives setup → pairing → connect end to end through the real server via
`app.request()` and in-process WebSockets, using the `SimAuthenticator` /
`SimHost` harness from `server-lib-common` (register, sign-in, wrong password,
replayed challenge, wrong origin, unpaired device, revoked record, plus relay
echo and token/session rejection). `server/test/harness/fake-host.mjs` is the
automated-test fake host; `server/scripts/fake-host.mjs` is a separate manual
dev stand-in (see Running the POC below). Browser-dependent layers — the
standalone host module and the Pocket terminal view — are dogfooded rather
than automated.

## Running the POC

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
(auto-approves pairing; answers `hello` only — no real terminals; distinct
from the automated-test harness `server/test/harness/fake-host.mjs`).

**3. Phone** (or any other browser profile): open the server origin →
First-time setup (password + label) creates the passkey and signs you in →
Hosts → **Pair** → approve in the modal on the laptop → **Connect** (one
biometric prompt) → pick a pane → type.

POC limitations to know about: pair/connect only works from the browser that
registered the passkey (the passkey public key is stored client-side at
registration); clearing site data destroys the device key → re-pair, per the
security model; a dropped WebSocket sends you back to the Hosts view —
reconnect by tapping Connect again.

Everything past this loop (browser surfaces, in-flight replay, thumbnails,
the tethering display, WebRTC) is staged in remote-api.md `## Future` as
additive follow-ups.
