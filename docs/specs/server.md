# Server (selfhost)

> See `docs/specs/glossary.md` for Session / Pane / Surface vocabulary; this spec uses it for what the relay exposes.
> Owns the selfhost Server (`server/`) and the shared Host-service runtime (`lib/src/host/remote/`). Read
> [remote-security-model.md](./remote-security-model.md) first — it owns the trust model this one deploys;
> [remote-api.md](./remote-api.md) owns what flows after authorization, [pocket-app.md](./pocket-app.md) the phone.

The coordinating Server from the remote security model, in its selfhost mode,
cut down to the smallest thing that completes this loop:

> Run the server with a setup password. Enroll your laptop's Dormouse Terminal
> with it. Point your phone's camera at the code that Host shows: it creates a
> passkey, signs in, and pairs. Pick up a running terminal session from the
> laptop on the phone.

One Node process (Hono). No database. **Terminal-only.** Every security
primitive lives in `server-lib-common`; the terminal UI lives in
`lib`/`standalone`.

## Guardrails

* One account (`accountId: "owner"`), created once off a code an enrolled Host
  displayed. The setup password enrolls Hosts and registers nothing.
* Terminal surfaces only — exactly remote-api.md's **protocol-v1** (browser
  remoting is staged in that spec's `## Future`).
* Revocation is editing a JSON file by hand; no management UI.
* A dropped WebSocket is handled by reloading the page / reconnecting the
  host. No resume protocol.
* Everything transient (challenges, sessions, presence nonces, relay state) is
  in memory; a server restart means everyone reconnects. **Transient stores must
  prune** — `HostChallengeIssuer.issue` drops expired entries on every call, and
  the presence-nonce and setup-token stores do the same — because the requests
  that mint them are cheap to send and need little or no auth (rationale).

## Configuration

This table is the whole of what `server/src/` reads from the environment.

| Env var                   | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `DORMOUSE_SETUP_PASSWORD` | Required. Gates host enrollment. It registers no passkey: `/api/setup/*` takes a Host-minted setup token only. |
| `DORMOUSE_ORIGIN`         | External origin, e.g. `https://dormouse.tailnet.ts.net`. Source of the WebAuthn `rpId`/`origin` and the Host's `ConnectionPolicy`. Defaults to `http://localhost:<port>` for dev. |
| `DORMOUSE_STATE_DIR`      | Where the JSON state files live. Default `./data`.         |
| `DORMOUSE_POCKET_DIR`     | The built Pocket app to serve at `/*`. Defaults to `lib/dist-pocket` resolved from the compiled server's own location rather than from the cwd, so a service manager's working directory cannot change what is served. Absent or missing its `index.html`, `GET /` is a plaintext stub naming the build command. |
| `PORT`                    | Default 3000. Blank is unset — `Number('')` is 0, which would ask the OS for an ephemeral port and move the server out from under whatever proxy is pointed at it. An explicit `PORT=0` is a `ConfigError` for the same reason. |
| `DORMOUSE_REQUIRE_USER_VERIFICATION` | `true` demands a *user-verified* passkey assertion (biometric/PIN), not merely user presence. Off by default, and only the exact string `true` enables it — a misspelling must read as off, because turning this on without UV-capable authenticators locks the account out of its own server. Applies to sign-in, re-auth and `connect2` alike, so no route is a softer path than another, and is mirrored to every Host in its `HostEnrollResponse` so both sides demand the same thing (`SECURITY.md` -> Remote Control). |
| `DORMOUSE_BIND_HOST`      | Interface to listen on. Unset binds every interface (what a container wants); set `127.0.0.1` when a TLS proxy on the same machine is the front door. |
| `DORMOUSE_VAPID_PUBLIC_KEY` / `DORMOUSE_VAPID_PRIVATE_KEY` | Web Push signing keypair. Set both or neither. At startup the Server decodes both, derives the P-256 public point from the private key, and exits on a missing, malformed, or mismatched pair. Unset, the server mints a pair on first boot and persists it to `vapid.json`. |
| `DORMOUSE_VAPID_SUBJECT`  | `mailto:`/`https:` contact for push-service operators (RFC 8292). Defaults to `DORMOUSE_ORIGIN` when that origin is https and not loopback; otherwise there is no default and push stays off. Validated at startup — an invalid value, a loopback contact included, exits. |
| `DORMOUSE_RUNTIME_FILE`   | Absolute path the server records `{pid, releaseId, port, origin, startedAt}` into once it has **bound**, mode `0600`. Unset — dev, containers, every test — writes nothing. A relative value is a `ConfigError`: the wrapper runs under a service manager whose working directory is not the installer's, so it would land somewhere neither side can predict. Outside `DORMOUSE_STATE_DIR`: runtime truth about one process, not durable state that gets backed up and restored. |
| `DORMOUSE_RELEASE_ID`     | The release directory's name, supplied by the installer's `run-server` wrapper, recorded in the runtime file. `null` when the server was not started by an installer. |
| `DORMOUSE_ENROLL_TOKEN_FILE` | Absolute installer offer path — `{origin, token, mintedAt}`, the token 64 hex characters, shape in `server-lib-common/src/remote/enroll-offer.ts` — which `POST /api/host/enroll` accepts in place of the setup password. Unset, one-click enrollment is off. A relative value is a `ConfigError`, for the reason above. **The offer lasts until the first Host enrollment or 24 hours, whichever comes first.** `hosts.json` is the durable marker; the Host-store mutex serializes password/token requests. Token redemption atomically renames the file before minting, so exactly one concurrent redemption wins; a mismatched claim is restored by no-clobber hard link, so a newer installer generation wins. The installer rotates offers only before `hosts.json` exists. |

**The server itself always speaks plain HTTP**, and WebAuthn requires a secure
context: `localhost` works for development; a real phone needs TLS in front
(`tailscale serve` is the intended selfhost path, any reverse proxy works).

**Must bind loopback when the TLS proxy is local.** `tailscale serve` reaches
the app over loopback, so a socket left on every interface also publishes the
plaintext port to the LAN and to the tailnet itself; the selfhost install sets
`DORMOUSE_BIND_HOST`. The default stays unbound so a container — where the
namespace is the boundary and the port is published explicitly — keeps working.
Binding loopback is *containment, not admission*: every route is still gated by
the setup password or a bearer token, exactly as `SECURITY.md` -> "Loopback
Listeners" requires. `scripts/loopback-lint.mjs` does not cover this socket —
it binds from config rather than from a loopback literal (rationale).

`DORMOUSE_ORIGIN` is normalized to a bare origin exactly once, in `readConfig`,
by the shared `normalizeOrigin` in `server-lib-common` — a trailing slash reads
as correct in an `.env` and fails every compare it reaches, and a value that is
not a URL with a host is a `ConfigError` naming the variable. WebAuthn
clientData checks, passkey assertion verification, the Host enrollment policy
and the `#setup` URL a Host composes all compare against that string rather than
re-parsing it; `createApp` parses it only to take `rpId` from the hostname.

Source of truth: `server/src/config.ts` (`readConfig`), a pure env→config
mapping pinned by `server/test/config.test.mjs`; only the disk half stays
in `server/src/index.ts`, which mints and persists `vapid.json` when no keypair
is configured, then validates the pair and subject **before** building the app.
`server/test/runtime-file.test.mjs` and `server/test/bind-host.test.mjs` pin the
runtime-identity and loopback controls at the process boundary, and
`server/src/enroll-token.ts` redeems the enrollment offer, pinned by
`server/test/enroll-token.test.mjs`.

## Where a Host may reach a relay server (self-host builds)

No CSP fences the relay socket — standalone's runs in the Node sidecar, VS
Code's in the extension host — so the same CSP-shaped source list is **baked
into the Node bundle** and enforced there: one syntax, one build-time variable
(`DORMOUSE_REMOTE_CONNECT_SRC`), whichever process holds the socket. The webview
CSPs carry no relay sources at all (`docs/specs/vscode.md` → "CSP policy";
`standalone/scripts/tauri-conf.test.mjs` asserts the standalone one).

The shipped binary is scoped to the SaaS origin only,
`https://*.dormouse.sh wss://*.dormouse.sh`. An override **replaces** that
default rather than adding to it, and is a per-build opt-in:

```sh
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
```

So a self-host server on any other origin is reachable only from a custom build
(same variable on `pnpm --filter dormouse-standalone tauri build`). The default
carries **no localhost entry and no plaintext scheme**, so a default build
refuses to enroll against an `http://localhost:3000` dev server — see "Running
it" for the override a local loop needs.

`scripts/csp-defaults.mjs` holds the one definition of the default and the
override rule; `standalone/scripts/build-sidecar-proxy.mjs` and
`vscode-ext/scripts/esbuild.mjs` esbuild-`define` it into their bundles, where
`bakedConnectSrc()` in `lib/src/host/remote/connect-src.ts` is the single reader.
Two build-time guards, both because their failure mode is silent (rationale):
`assertConnectSrcBaked` greps the bundle for the define, and
`resolveRemoteConnectSrc` rejects an override the matcher could never read (a
trailing slash, a path, a bare host, a scheme outside `http`/`https`/`ws`/`wss`,
a port outside 1–65535). The grammar is one regex duplicated into the `.mjs`,
which cannot import TypeScript; `connect-src.test.ts` pins the two patterns —
and the two copies of the default — as identical.

**Enforcement is `originAllowedByConnectSrc`, at three points in
`lib/src/host/remote/service.ts`:**

* `enroll` — refused for an origin outside the list, before the setup password
  leaves the machine.
* `start` — refuses a persisted enrollment naming one, staying idle with a
  warning rather than connecting (a binary downgraded from a custom build, or a
  server that moved).

Matching is narrower than a browser's: `https`/`wss` are one scheme class and
`http`/`ws` the other, host matches exactly or by a leading `*.` wildcard
covering any depth of sub-domain but never the bare domain, ports must match
unless the source says `*` (numeric ports canonicalized as `URL` does, so a
leading zero is not a silent miss), and anything unparseable fails closed.
Enrollment and Host-authenticated push fetches **must** use `redirect: 'error'`
— a Node process does not re-check a redirect target, so following one could
carry the setup password, Host bearer token, or notification metadata outside
the baked allowlist.

Reserved: the `https://*.dormouse.sh wss://*.dormouse.sh` entries are
*wildcards* on purpose. The BYOT posture (`## Future`, Scope: saas-multitenant)
has the stock client connect to per-tenant subdomains such as
`tenant-xyz.dormouse.sh` without a custom build, so narrowing them to a fixed
host would foreclose it.

## State files

The entire persistent state is four JSON files. `server/src/state.ts` owns the
exact schemas; the row shapes are sketched here because hand-editing these
files is the *documented* revocation mechanism, so the editor should not need
the source open:

- `account.json` — `{ accountId, passkeys: [{ credentialId, publicKey /* SPKI b64u */, label, createdAt }] }`
- `hosts.json` — `[{ hostId, hostToken, enrolledAt }]`; **no label** — the Server keeps no name for a Host
- `push-subscriptions.json` — `[{ hostId, deliveryId, endpoint, keys, vapidPublicKey, subscribedAt }]`
- `vapid.json` — `{ publicKey, privateKey, createdAt }`; exists only when no keypair is configured by env

**The Host's ACL is never here** — it
lives on the Host, in the process that owns the PTYs
(`lib/src/host/remote/host-state-store.ts`), which is the whole point of the
security model.

Every write is temp-file-plus-rename and every mutation is serialized through a
per-store promise chain, so a crash cannot leave an unparseable file and two
concurrent read-modify-writes cannot lose each other.

**Rows are validated as they are read** — `hosts.json` and
`push-subscriptions.json` both — because hand-editing these files is the
*documented* revocation mechanism, so a half-finished edit is an expected state
rather than corruption. A malformed host row is dropped rather than carried,
since one bad line would otherwise 500 every `/ws/host` upgrade and every push
route (rationale); a malformed subscription reads as a missing registration,
which Pocket repairs by re-offering Enable, rather than as a live one nothing
can be delivered to.

**`hostId` is pinned at enrollment: base64url of 16 bytes**, minted and
validated as `isE2eId`. Every `e2e` envelope routes on it and the shared guard
accepts no other length, so a hand-edited row of another shape would otherwise
be a Host the relay admits and no Client can address. Dropping it on read makes
that row an un-enrolled Host instead, which is what the person editing the file
was reaching for.

**A subscription row from before the end-to-end cutover carries a device key and
no `deliveryId`, so it is dropped on read** — with **one** warning per process
naming the file and saying to re-register. No versioned refusal, no archive
step: the Client that owns the row re-registers on its next Enable, and a
warning per row would bury that in a log.

`push-subscriptions.json` is the one store that deletes rather than appends — a
push service reports a dead subscription with 404/410, and a browser that
rotates its endpoint must replace the stale row rather than leave one per
rotation:

* **Rows are keyed on the pair (`hostId`, `deliveryId`)**, so a phone paired
  with two laptops subscribes twice and a Host can only ever read or reach its
  own subscribers. Each row records the public VAPID key it was registered
  under, so a rotation reads as stale rather than as still working, and holds no
  label — the Server never learns one.
* **An upsert whose endpoint differs deletes every row still carrying an
  address this delivery is moving off.** One service-worker scope has only one
  subscription, so the old address is dead for every Host that phone had
  registered. Two keys, and both are load-bearing: the replaced addresses are
  read from **every row carrying this `deliveryId`**, whichever Host it belongs
  to, since a delivery id names one Client's pairing and so speaks for one
  worker scope; the rows *dropped* are matched on the **endpoint**, which is
  what reaches siblings whose delivery ids this request never names.
* **A brand-new `deliveryId` cannot know its scope's previous address.** After a
  re-pair the Server holds nothing linking the new id to the old, so rows for
  that scope's earlier endpoint survive until the push service 404/410s them.
  Rows already carrying the *presented* endpoint are the same scope and stay,
  which is what makes a second Host's registration additive. Closing the gap
  would need cross-Host device identity on the Server, which the model
  deliberately does not have.
* **The response reports the state that mutation left behind** — every Host the
  presented endpoint is still registered with — rather than the fact that a
  deletion happened, so a committed POST whose response was lost is repaired by
  its own idempotent retry.
* **Removing a Host row is observed lazily.** Nothing cascades on write:
  `listForHost` answers nothing for a `hostId` that is gone, so its subscription
  rows are unreachable the moment the edit lands, and they leave disk on the
  next 404/410 prune or when the Client deletes them.

`hosts.json` stores `hostToken` — the host↔server relay bearer secret — in
plaintext, and `vapid.json` a private key, so both files are written owner-only:
the state dir is created `0o700` and every write lands in a `0o600` temp file
before the rename. **Any new file under `$DORMOUSE_STATE_DIR` must go through
`writeAtomic`.** **Never build anything on that mode** — it is a cheap default,
not the guarantee the deployment rests on (rationale); what protects the
*installed* server's state is the installer's directory permissions, in
"Installing it" below.

Source of truth: `server/src/state.ts`.

## WebAuthn without a WebAuthn library

No WebAuthn library, and none is needed (rationale). Registration reads
`response.getPublicKey()` — SPKI DER straight from the browser, with
`attestation: 'none'` requested, so there is no CBOR and no attestation to
parse. Assertions go through `verifyPasskeyAssertion` in `server-lib-common`,
**the same function the Host uses**, so Server and Host cannot disagree on what
a valid assertion is.

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

## HTTP API

This table is the whole route surface. Paths and request/response shapes live in
`API_ROUTES` / `WS_ROUTES` and their types in
`server-lib-common/src/remote/wire.ts`; `HELLO_ROUTE` lives in
`server-lib-common/src/index.ts`, so Server, Host and Pocket cannot drift.

| Route                            | Auth           | Does                                              |
| -------------------------------- | -------------- | ------------------------------------------------- |
| `GET /api/hello`                 | —              | The shared greeting. Carries no release identity: it is unauthenticated, CORS-`*` and reachable through `tailscale serve` — see the runtime file under "Installing it" |
| `POST /api/setup/begin`          | setup token    | Issues a registration challenge, gated exactly as `finish` is, so neither is softer. A setup token buys one registration; an absent, mistyped, or spent one is the same delayed 401. Answers with the account's credential ids, so a retry's `excludeCredentials` cannot duplicate a passkey that already signs in — an orphan the Server never registered is absent, and is still replaced |
| `POST /api/setup/finish`         | setup token    | Registers the passkey in `account.json`. The token is spent at the gate and put back if the registration then fails |
| `POST /api/setup/retire`         | session token  | Spends a live setup token without registering anything, so a phone that scanned a QR it will not register with cannot leave a photographed code redeemable. 204, or 401 `SETUP_TOKEN_INVALID_ERROR` after the same fixed delay |
| `POST /api/signin/begin`         | —              | Issues a sign-in challenge                          |
| `POST /api/signin/finish`        | —              | Verifies the assertion and issues a 12-hour in-memory session token |
| `POST /api/reauth/begin`         | session token  | Takes a required, kind-tagged `PresenceBinding`, mints a single-use 2-minute `serverNonce`, and answers `presenceChallenge(binding, nonce)` with the RP ID, the nonce, and the bound credential as the sole `allowCredentials` entry. 404 for a credential this account has not registered; 400 for a missing or malformed binding |
| `POST /api/reauth/finish`        | session token  | Consumes the nonce, recomputes the challenge, and verifies the assertion against the **stored** key for exactly that credential. **Extends nothing** — not the session, not the relay socket |
| `POST /api/host/enroll`          | setup password or one-time enroll token | Enrolls a Host, appends `hosts.json`, and mirrors the user-verification policy. Exactly one credential — both, or neither, is a 400. **Takes no label**: the name a machine presents is its own, and a Client learns it only inside an encrypted outcome |
| `POST /api/host/setup-token`     | host token     | Mints the single-use, short-TTL token behind this Host's QR (below) |
| `GET /api/hosts`                 | session token  | Enrolled hosts + whether each is currently connected |
| `GET /api/push/config`           | —              | Returns the public VAPID key, or `null` when push is unconfigured |
| `POST /api/push/subscribe`       | session token  | Upserts the `(hostId, deliveryId)` subscription. **Possession of the 256-bit `deliveryId` is the proof** — no challenge, no signature. 404 for an unknown `hostId`, so no row can strand where no Host can read or prune it |
| `POST /api/push/subscriptions/query` | session token | Reports which of the **presented** `deliveryIds` are registered, and for which Host. Parameterized by a capability the caller must already hold, which is proof of possession rather than the enumeration primitive a device-key parameter was |
| `DELETE /api/push/subscriptions/:deliveryId` | session token | Idempotent: **always 204**, so the route reveals nothing about whether a row existed |
| `GET /api/push/devices`          | host token     | The `deliveryId`s subscribed to **this** Host under the current VAPID key |
| `POST /api/push/send`            | host token     | Fans a notification out to the named deliveries; `deliveryIds` is required |
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
since a spent setup token answers 401 as well
([pocket-app.md](./pocket-app.md) -> An expired session drops to sign-in). A
rejected enroll token answers that same body and delay whatever the cause,
which stays safe because only a Host sends one. A rejected **setup** token does
not: Pocket sends those itself, so it answers the distinct
`SETUP_TOKEN_INVALID_ERROR` — same 401, same delay — which Pocket keys its
"scan again, or type the password" recovery on
([pocket-app.md](./pocket-app.md)).

### Setup tokens and the pairing QR

An enrolled Host mints a setup token over its own authenticated channel; the
response carries the token alone, since the Host knows the origin it enrolled
against and composes the QR itself. Scanning is the *only* way a passkey is
registered: `/api/setup/*` takes no other credential.

**The QR grammar is this spec's.** Exactly
`<enrolledOrigin>/#pair?<v>.<hostId>.<inviteId>.<expiry>.<setupToken>.<ephPub>`,
where the origin is the normalized HTTPS origin with no trailing slash and
appears only as the URL prefix, so a native camera reaches the right
self-hosted Pocket and **the fragment never reaches this server**. The fragment
is positional, dot-delimited, carries no field names, and is exactly 146
characters:

| Field | Encoding, exact length | Purpose |
| --- | --- | --- |
| `v` | literal `1`, one character | E2E wire version; any other value is rejected, never negotiated |
| `hostId` | 16 bytes as 22-character unpadded base64url | relay destination |
| `inviteId` | 16 bytes as 22-character unpadded base64url | single-use invitation held only in Host memory |
| `expiry` | unsigned 32-bit epoch seconds as exactly 10 decimal digits | advisory Client fail-fast; Host memory stays authoritative |
| `setupToken` | 32 bytes as 43-character unpadded base64url | credential for `/api/setup/*` |
| `ephPub` | 32-byte X25519 public key as 43-character unpadded base64url | one-use Host Noise responder key for this invitation |

**`PAIRING_QR_URL_MAX_LENGTH = 256`, enforced before any encoder runs.** The
only variable-length part is the origin, so a mint that would exceed the cap
fails naming that — an error at mint time rather than a thrown QR encoder inside
the app-wide ErrorBoundary. It bounds the longest origin a self-hoster may serve
Pocket from: 103 characters.

**One parser boundary.** `parsePairingInvitationUrl(text, appOrigin, now?)`
answers the complete invitation or `null` — **never a partial parse**, and never
an error a caller can distinguish. Two of its checks are this spec's rather than
the parser's: the URL must be **HTTPS — or plain HTTP on exactly `localhost`,
`127.0.0.1`, or `[::1]`, so the documented `http://localhost:3000` dev loop
parses. Each is a secure context by the platform's rule, but the list is
narrower than that rule and is policy, not derivation** — and its
origin must **equal the running
app's exactly** — a fragment is invisible to this server, so that compare is the
only thing keeping a code from bootstrapping another deployment's Pocket. The
check order is the function's own (cheap before expensive; the X25519 import
last, which is what makes it asynchronous). Pinned by exact encode/parse
vectors, including the 146-character fragment and the longest accepted origin.

Source of truth: `server-lib-common/src/security/pairing-invitation.ts`, with
`#setupQr` in `lib/src/host/remote/service.ts` as the emitter. What the
invitation half proves is
[remote-security-model.md](./remote-security-model.md) -> Pairing.

Token rules, unchanged by the grammar:

* **The setup token is the only credential.** `/api/host/enroll` still counts
  exactly one of password or enroll token, by presence rather than by type —
  trying the two in turn would let a spent token fall through to the password —
  but the setup routes have nothing to count: a request without a live token is
  the same delayed 401 as one with a dead one.
* **`begin` peeks; `finish` consumes before it reads the body.** That delete is
  the single-use gate, so of two overlapping finishes only one registers. Every
  failure past it restores the token on its original expiry without exceeding
  the per-Host cap. `POST /api/setup/retire` consumes the same way and registers
  nothing.
* **Both gates re-read `hosts.json`.** A revoked Host's outstanding tokens die
  with it, rather than staying redeemable for the rest of their TTL.
* **The store remembers which Host minted each token.** TTL is
  `DEFAULT_PAIRING_TTL_MS`, the same window the Host's invitation lives for, and
  it prunes on every mint and caps each Host's outstanding tokens at
  `MAX_TOKENS_PER_HOST`, that Host's own oldest first, so a Host minting in a
  loop cannot evict another's live token (Guardrails). The cap lives in
  `server-lib-common` because the Host bounds its own invitation map at the same
  number.

Source of truth: `server/src/setup-token.ts`, pinned by
`server/test/setup-token.test.mjs`.

### Web Push

A push must reach a phone whose app is closed, which the relay cannot do, so it
is plain HTTP rather than a relay frame and goes out to the platform's push
service (APNs, FCM) through `web-push` — the server's one third-party runtime
dependency. Source of truth: `server/src/push.ts` plus the routes in
`server/src/app.ts`; the Host and webview halves are
[alert.md](./alert.md) -> Push notifications.

- **Two audiences, two credentials.** A Client registers, queries, and deletes
  its own rows with a session token plus the `deliveryId` the Host minted for
  it; a Host reads and sends with its `hostToken`. The send route takes the
  `hostId` from the token and never from the body, so naming a delivery
  explicitly cannot escape the calling Host's own scope.
- **The Server never selects recipients.** `deliveryIds` is required and
  non-empty; an absent or empty list is a 400, not a fan-out. The Host holds the
  ACL and is the only party that may decide who a push reaches.
- **Possession of the delivery id is the whole authorization.** It is 256
  unguessable bits known only to one ACL record and that Client's own pinned
  copy, so registering, querying, and deleting need no challenge and no
  signature — and **the Server never lists delivery ids to a session**. The
  query route reports only on ids the caller presented, which is proof of
  possession rather than the enumeration primitive a device-key parameter was.
  A Host token reads its own subscribers (`/api/push/devices`), identities only:
  the endpoint and its keys are a bearer capability to notify that phone, and
  never leave the Server.
- **Delivery views are VAPID-current.** With push configured, the query route
  and `/api/push/devices` omit rows registered under a different (or legacy
  unknown) public key, and `/api/push/send` never targets them — those endpoints
  cannot receive a send signed by the current key. Hiding them exposes Pocket's
  re-registration action and keeps the Host from naming or retrying an
  unreachable device after a rotation. The rows stay on disk until that repair.
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
  `boundedPushText`, so the two layers cannot enforce different rules. Reserved:
  the payload is the one thing on this wire the Server still reads in plaintext.
  Stage 6 of **Scope: e2e-client-host**
  ([remote-security-model.md](./remote-security-model.md) `## Future`) replaces
  it with a sealed envelope, and nothing else about this route changes then.
- **Delivery outcomes prune.** 404/410 means the subscription is permanently
  gone and its row is deleted; anything else is transient and left alone, but
  never silent: the refusal is logged (origin only — the endpoint is a bearer
  capability) and counted in the response's `failed`, since the route answers
  200 either way and the Host needs to tell an all-failed fan-out from success.
  The log carries the push service's own reason body alongside the status,
  whitespace-collapsed and capped at 200 characters so an HTML error page cannot
  flood it — the only place a rejection is ever explained (rationale).
- **Delivery is bounded twice, and both bounds resolve as `failed`** so the row
  survives to be retried, unlike a 404/410. The inner bound is a 10-second
  socket-inactivity timeout per push-service request; the outer is a 15-second
  wall-clock deadline per send, catching what inactivity cannot — a service that
  trickles bytes or stalls mid-handshake resets the inactivity timer forever.
  The deadline is applied by the *route*, not the sender, so it holds for any
  injected `PushSender`, and since every send in a fan-out starts at once it
  bounds the route as a whole regardless of device count. It bounds the route,
  not the socket: `web-push` accepts no `AbortSignal`, so a request that loses
  the race is left to its own inactivity timeout (rationale). Both are separate
  from the 300-second provider TTL — an alarm that arrives an hour late is
  noise, not information.
- **Push is disabled, not half-working**, when no VAPID key **or no VAPID
  subject** is configured: the config route reports `null` and subscribe/send
  answer 503. Key and subject ship together or not — a
  phone that registered against a key the Server has no contact to sign with
  would be subscribed to a push it can never receive.
- **A VAPID subject naming a loopback host is a startup error, not a default.**
  Apple rejects the JWT signed under one, `web-push` does not warn, and the send
  still answers 200 — the failure is invisible from the Server (rationale). So
  the default is derived from `DORMOUSE_ORIGIN`, and a loopback dev server turns
  push off rather than guessing a placeholder contact. Source of truth:
  `defaultVapidSubject` / `assertVapidSubject` in `server/src/push.ts`.

## Relay

The server routes JSON envelopes between client sockets and host sockets
(`@hono/node-ws`). `clientId` is a server-assigned secret stamped onto every
host-bound frame so the Host can address replies, and is never sent to the
Client.

**The `e2e` envelope is what a Host speaks.** Four `t: 'e2e'` frames
(Client→Server, Server→Host with `clientId` stamped, Host→Server, Server→Client
with `hostId` stamped from the socket), shapes in
`server-lib-common/src/remote/wire.ts`. A Host handles exactly these and
`client-gone`; every legacy frame it receives is ignored.

- **An `init` binds** the Client socket to the named Host: the previous Host
  gets `client-gone` and any `established` flag is cleared.
- **A `transport` frame is forwarded only within that binding**, in either
  direction.
- **Never parsed, never remembered, never authorized.** The relay does not
  decode `ct`, keeps no Noise state, and has no notion of "authorized" here —
  only the Host knows whether a ceremony succeeded, and it says so only inside
  the ciphertext.
- **Its bounds are defense in depth**, on a both-sides rule: `hostId` and `id`
  base64url of 16 bytes, `clientId` a bounded string, `ct` base64url bounded by
  `MAX_E2E_CIPHERTEXT_LENGTH` (the encoding of a maximal Noise message). A
  malformed Client frame gets an `error`; a malformed Host frame is dropped. The
  Host runs the same guard on arrival because it does not trust the relay.

**Only one socket may own a `hostId`.** Registering a second one for the same
`hostId` displaces the first: clients bound to it are told `host-gone`, their
sessions are cleared, and the old socket is closed with
`WS_CLOSE_HOST_REPLACED` (4000) / `WS_CLOSE_HOST_REPLACED_REASON`. Those
constants live in `server-lib-common`, not in `server`, because the code is a
contract rather than a log line: the evicted Host keys its stand-down on it
(see [Host side](#host-side-lib--the-two-node-hosts)). Clearing the sessions at
*replacement* time and not only on disconnect is load-bearing — the displaced
socket's own close event is a no-op here, and the new Host process has a fresh
ACL and no memory of those sessions.

The relay keeps one current Host binding per Client socket. Host-originated
frames are routed only when the frame comes from that current Host; late replies
from a previous Host are ignored and cannot re-establish an old session. When a
Client socket binds to a different Host, the relay sends `client-gone` to the
previous live Host before replacing the binding, so Host-side pairing UI,
remote-api sessions, and watchers are disposed immediately.

**The envelope is the whole client surface.** Any other frame type — including
every frame the pre-cutover handshake used — is answered with an `error` and
reaches no Host; a Host-originated frame that is not one is dropped. The relay
holds no policy of its own: there is no gate, no challenge memory, and nothing
it verifies before forwarding, because only the Host can tell whether a ceremony
succeeded.

Source of truth: `server/src/relay.ts` (`registerHost`), and `isE2eClientFrame` /
`isE2eHostFrame` in `server-lib-common/src/remote/wire.ts`, written for a Host to
reuse verbatim.

### Pairing (phone ↔ laptop, first time)

```
phone                        server                        host (laptop)
  |   scan the Host's QR        |                              |
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

The Server sees two routing ids and a handshake hash, and forwards ciphertext.
It never learns the code, the label, the decision, or the delivery id. What each
step must establish is
[remote-security-model.md](./remote-security-model.md) -> Pairing.

### Connect (every session)

```
phone                        server                        host
  |-- e2e init (Noise msg 1) -->|-- e2e init {clientId} ------>|
  |<-- e2e response ------------|<-- e2e response (msg 2 =     |
  |                             |     32-byte Host challenge)  |
  |   ONE biometric prompt:     |                              |
  |-- reauth begin/finish ----->|  presence challenge + nonce  |
  |-- e2e transport ----------->|-- e2e transport ------------>|  challenge consumed,
  |    ConnectionRequestV1      |                              |  proof + ACL checked
  |<-- e2e transport -----------|<-- ConnectionOutcomeV1 ------|
  |====== protocol-v1 inside the same Noise session ==========>|
```

**One WebAuthn prompt per connection**, over a challenge derived from this
handshake's own transcript, so nothing about it replays anywhere else. The Host
is the only party that decides; the Server's `/api/reauth/*` exchange proves
only that the account holder was present, and the Host verifies that assertion
itself.

### After authorization

The relay stops reading and becomes a dumb ciphertext pipe. What flows through
it is exactly the terminal-only protocol-v1 scope of
[remote-api.md](./remote-api.md) -> v1 scope, framed as application messages on
the Noise session (below).

### E2E framing

What one Noise transport message carries once `Split` has run. The Client and
the Host **must** frame with this one module when they land, so no two speakers
can disagree about what a transport plaintext is; the harness is its only
speaker today.

- **Transport plaintext is `[kind: u8][body]`.** `0x00` keepalive — exactly 32
  zero bytes; `0x01` stream — a slice of the application byte stream; `0x02`
  control — UTF-8 JSON NUL-padded to exactly `CONTROL_PAYLOAD_SIZE` (4096), so
  an approval and a denial are one size on the wire. The decoder strips trailing
  NULs and rejects any other body length, any other kind byte, and JSON that is
  not a plain object.
- **Each application message is `u32 big-endian length || bytes`**, chunked to
  keep every Noise message inside 65,535 bytes with its kind byte and tag
  (`MAX_STREAM_BODY_LENGTH`). **Reassembly rejects a declared length over
  `MAX_APP_MESSAGE_LENGTH` (1 MiB) as soon as its prefix arrives**, which also
  bounds the queue — it only ever waits on a length it accepted. **Bodies are
  queued and copied once, when a message completes**: a peer may legally split
  one message into single-byte bodies, and concatenating on arrival would be
  quadratic.
- **The first failure poisons the session.** A decrypt failure, a nonce gap or
  reorder (which Noise's counter turns into a decrypt failure), or a framing
  violation destroys it and every later call throws — there is no
  resynchronization point in a stream cipher.
- **Prologues are `lengthPrefixedConcat`** of `dormouse/e2e/v1`, the ceremony
  kind, the `hostId`, and — for a connection — the connection id, for a pairing
  every field of its invitation in QR order ("Setup tokens and the pairing QR"
  above), so a transcript is useless against another Host, id, or ceremony.

Source of truth: `server-lib-common/src/security/noise-transport.ts`, pinned by
`server-lib-common/test/noise-transport.test.mjs` and driven through the real
relay by `server/test/e2e-relay.test.mjs`.

## Host side (`lib` + the two Node hosts)

The Host is a service in the process that owns the PTYs — never a webview:
`RemoteHostService` in `lib/src/host/remote/service.ts`, installed in the Tauri
sidecar (`docs/specs/standalone.md` → "Remote Host service") and in the VS Code
extension host (`docs/specs/vscode.md` → "Remote Host: a service in the
extension host"). The webview holds only UI — the pairing modal, the
`window.dormouseRemoteHost` console hook, and answering what its own panes are
called — and reaches the service over the `remoteHost:*` bridge.

**One service, two bindings.** `lib/src/host/remote/` shares the service,
bridge contract/client, ask-backed provider, and serialization across both
hosts. Only the store, process plumbing, and bridge transport remain host-owned;
their contracts live in the standalone, VS Code, transport, and remote-api specs.

**The store contract.** Both stores implement `HostStateStore`
(`lib/src/host/remote/host-state-store.ts`) under the same rules:

* **Reads fail closed** — an error that says nothing about what the file holds
  must answer neither empty nor stale, because an empty ACL silently de-pairs
  every device.
* **The in-memory view advances only after the durable write lands**, so a
  failed save cannot be mistaken for durable state by a later read.
* **Every mutation is serialized in call order** through the shared
  `createSerialQueue` (`lib/src/host/remote/serial-queue.ts`, also the service's
  own start/stop chain): two rapid pairing approvals write successively larger
  ACL snapshots, and the older must not finish last and erase the newer.
* **A store that cannot persist still holds what it is given** in memory and
  reports `persistent: false` rather than dropping writes.

Each store's mechanics — the sidecar's single 0600 JSON file, rename semantics,
and memory fallback; VS Code's SecretStorage/globalState split and cross-window
memo invalidation — live in that host's spec.

* **Enrollment** (Settings dialog, or the console hook, once): server URL +
  one credential → `POST /api/host/enroll` → the service persists
  `{ serverUrl, hostId, hostToken, origin, rpId }` (+ `requireUserVerification`
  when the server sent it, + the `noiseStaticPrivateKey` /
  `noiseStaticPublicKey` this Host mints locally after the answer and the
  request never carries —
  [remote-security-model.md](./remote-security-model.md)) through its
  `HostStateStore`, then opens and
  maintains `GET /ws/host`. The `label` the operator typed is persisted with it
  and **never leaves the machine** — the request body carries the credential and
  nothing else, and a Client learns the name solely inside an encrypted outcome
  ([remote-security-model.md](./remote-security-model.md) -> Host identity).
  `hostToken` is a bearer credential and never enters a webview realm. Refused outright for a server outside this build's allowlist
  (above), before the password leaves the machine. **A 200 that is not an
  enrollment fails the exchange**: the response goes through the same
  `isEnrollment` guard every *read* uses, and a body missing a field or sending
  one mistyped throws naming those fields rather than minting a record with an
  `undefined` in the `ConnectionPolicy` the Host authenticates passkeys against
  (rationale). The request carries a 10 s `AbortSignal.timeout`, under the
  webview's own 15 s command budget so the console sees the real error
  (rationale). `enrollOffer` is the same flow with the offer's one-time token in
  place of the password; neither request carries the label. **A `status` snapshot
  is built after its last await**:
  it reads the offer file, and an enroll finishing under that read would answer
  `enrolled: false` after the `{ enrolled: true }` event, disarming the
  edge-triggered webview gate. The un-enrolled snapshot is one exported builder,
  `unenrolledStatus`, shared with the VS Code glue ([vscode.md](./vscode.md)).
  Source of truth: `lib/src/remote/host/enrollment.ts`, `#enrollWith` and
  `#status` in `lib/src/host/remote/service.ts`.

  **Order matters, and the store goes first.** The `hostToken` exists nowhere
  else and cannot be re-minted from the same exchange, so the save is
  awaited before any Host is stopped — a failed write must leave the old Host
  running and every answer it gives still true (rationale). Replacing a
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
  connection state the user has to act on. A close event from a socket the
  controller no longer owns is
  ignored, so a dead socket's late eviction cannot stand down the live one, and
  disposing the service is terminal: an enrollment or ACL read already in flight
  cannot construct a socket after its sidecar/extension instance tore down.
  Source of truth: `lib/src/remote/host/remote-host.ts`,
  `lib/src/host/remote/service.ts` (lifecycle + console commands),
  `lib/src/remote/host/activation.ts` (the webview's client half).
* **Security**: `HostAcl` (persisted through the `HostStateStore`, keyed per
  `hostId`, so an enrollment onto a fresh `hostId` starts with an empty ACL while
  a re-enrollment onto the same one keeps its paired devices),
  `HostChallengeIssuer`, `verifyPresenceProof`, and the Noise responder for both
  ceremonies — all straight from `server-lib-common`, running in the service's
  process. Nothing a webview says can widen access; in particular the expected
  two-digit confirmation code never leaves it
  ([remote-security-model.md](./remote-security-model.md) -> Pairing).
* **Setup codes**: `setupQr` — enrolled only — mints at `/api/host/setup-token`
  over `hostFetch`, has the `RemoteHost` mint an invitation of its own, and
  composes the `#pair?` URL with `formatPairingInvitationUrl` (above). A mint
  that resolves onto a *different* Host is refused rather than painted: the code
  belongs to the server this machine just left. **The QR's secrets cross into
  the webview and `hostToken` never does** — being displayed to a person is
  their whole purpose — while the invitation's *private* half stays in the Host
  process. The Host reports its own invitation states as an `invitation` event;
  redemption at the Server announces nothing. Source of truth: `#setupQr` in
  `lib/src/host/remote/service.ts` and `RemoteHost.mintInvitation` in
  `lib/src/remote/host/remote-host.ts`;
  [remote-security-model.md](./remote-security-model.md) owns what an invitation
  proves, and `lib/src/remote/host/host-fetch.ts` the transport rules — including
  that a route the Server may legitimately hold open longer than the shared
  budget (push delivery, `PUSH_SEND_DEADLINE_MS`) passes its own timeout.
* **Pairing confirmation modal**: the queue is service-side; webviews mirror a
  serializable projection (`{ clientId, pairingId, label, requestedAt }[]`,
  pushed whole on every change) and echo both ids plus the **typed digits** on
  Confirm, so the approve/deny closures — and the expected code — never leave
  the Host's process. **A confirmation is bound to the displayed `pairingId`,
  not whichever ceremony currently occupies `clientId`.** A re-sent pairing
  replaces its predecessor, and an old modal action whose immutable id no longer
  matches is rejected; the mirror compares on `pairingId` and remounts keyed by
  it, while leaving an unchanged item alone
  (`lib/src/remote/host/activation.ts`). The modal shows the label, an empty
  two-digit input, and Confirm / Cancel (same pattern as KillConfirm), with the
  copy and the one-attempt rule in
  [remote-security-model.md](./remote-security-model.md) -> Pairing. Confirming
  after the invitation expires answers `invitation-expired` and dismisses, ACL
  untouched. In VS Code the queue is broadcast to every window, since any may be
  the one in front of the user.
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
`lib/src/remote/host/host-status-store.ts`; the offer's well-known per-platform
path is `lib/src/host/remote/enroll-offer.ts`, read by `#enrollOffer` in
`lib/src/host/remote/service.ts`.

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
machine — prefilled with the hostname, which `status` carries) calling the
service's `enroll`; enrolled it
shows the server URL, the relay connection state, and the paired-device count,
with `Disconnect` and — only on `displaced` — `Reconnect`. Rules the UI exists
to honor:

- **The offer leads, but only where it can be pressed.** The card shows when an
  unexpired local offer file exists and this Host is un-enrolled: it names the
  origin it
  found, prefills the same editable name, and enrolls on one click, with the
  three-field form folded behind "Enroll with a different server…" — folded with
  `hidden`, never unmounted, so typed input survives both the disclosure and an
  offer appearing underneath it — and unchanged where there is no offer. Reading
  the file is bounded to the un-enrolled state — an enrolled service answers
  `offer: null` without touching disk (rationale).
- **The offer's token never enters a webview.** `status` carries only the origin;
  `enrollOffer` re-reads the file in the Host service, so an old card cannot
  reuse a spent offer (`SECURITY.md`).
- **The click echoes the origin the card displayed**, and the service refuses a
  file that no longer names it: an installer rerun rewrites the offer, and that
  new origin is one nobody reviewed. `enrollOffer` takes `{ origin, label }` —
  the origin reviewed, never the one enrolled against, which stays the file's.
- **The card outlives its offer.** The poll sees the file unlinked the moment an
  enroll redeems it, so the card keeps rendering while that enroll is in flight
  or holding an error: a refusal landing after the card went away is silence
  over a spent token.
- **Only one enrollment may run.** One synchronous gate covers both forms and
  pre-render double clicks.
- **The password is passed through, never held.** It goes straight to the
  service and is cleared on success. `hostToken` never comes back into the
  webview realm: `enroll`
  answers `{ hostId, serverUrl }`.
- **Refusals are shown, not swallowed.** An origin outside this build's baked
  allowlist is refused before any credential leaves the machine (above), and that
  error is what the form renders — so the failure reads as "this build will not
  talk to that server" rather than as a wrong password — the offer card
  included.
- **Enrolled, "Set up a phone" opens an inline QR panel**, so a phone is set up
  by pointing a camera at the laptop rather than typing an origin and a 64-hex
  password. It mints on open and never before — a code is a credential with a
  clock on it — re-mints shortly before `expiresAt` while the panel stays open,
  and offers New code and Done. Rules it exists to honor:
  - **The panel owns its busy and error**, not the section's shared pair: a mint
    also fires on a timer, and the view's one error slot belongs to what the
    user clicked.
  - **Must clamp refresh delay to `[30 s, DEFAULT_PAIRING_TTL_MS - 20 s]`.** The
    floor stops a fast-clock mint loop; the TTL ceiling replaces a slow-clock
    code before its real Server expiry.
  - **The code being replaced stays on screen** until its replacement lands;
    only a first mint blanks. The refresh lead exists so a camera mid-scan keeps
    a live code.
  - **An invitation state change flips only the panel showing that `inviteId`**,
    so a second window offering a different code stays live. The flip that
    matters is `reserved`: a phone has completed the handshake against this
    code, so it is spent whatever the person at the laptop decides next.
  - **The view is keyed by enrollment identity and the QR sits behind its own
    error boundary**: a server swap drops the stale code, and a failed chunk
    fetch or a refused encode costs a retry button rather than the app-wide
    ErrorBoundary taking every terminal down.

  Source of truth: `useSetupQr` and `ScannableCode` in
  `lib/src/components/RemoteControlSection.tsx`, over
  `lib/src/components/QrCode.tsx` (`uqr` encodes; that draws, lazily, so the
  encoder stays out of every main bundle).
- **Disconnect asks first**, because clearing the enrollment drops every paired
  phone until each pairs again.
- **Status is re-read, not patched, and the connection is polled.** The
  service's `status` event carries only `{ enrolled }` — the edge its webview
  gate arms on — so every event triggers a full `status` command, and the dialog
  re-reads on open since another window may have enrolled meanwhile. The
  *connection* moves with no event at all, so the store also polls every 2 s
  **while something is subscribed**, never as a standing timer in every window,
  and compares the answer field-wise before publishing (rationale; same rule as
  `setPushDevices` in `lib/src/lib/push-devices.ts`).
- **Reads are serialized, and coalescing stops at anything that changes the
  answer.** Ticks arriving during a slow read queue behind it, so a 15-second
  Host-service timeout becomes the visible error instead of being superseded by
  newer polls; `enroll`, `reconnect`, `clearEnrollment` and losing the last
  subscriber each *drop* the read in flight, since an answer fetched before the
  command — or for a dialog now closed — is no longer the question anyone asked
  (rationale). Source of truth: `dropInFlightRead` in
  `lib/src/remote/host/host-status-store.ts`.

The `window.dormouseRemoteHost` console hook exposes the five enrollment commands —
`enroll(serverUrl, password, label)`, `enrollOffer(origin, label)` (its origin
from `status().offer.origin`), `status`, `reconnect`, `clearEnrollment` — and
remains the scripting seam. **Pairing confirmation is never here** — it is a modal, because
it must interrupt, and because the digits it takes are read off a phone
([remote-security-model.md](./remote-security-model.md) -> Pairing).

`docs/stories/pairing.mdx` walks this section and the pairing modal in sequence
with the rest of the setup, rendering the real components; it is a narrative
Storybook page that defers to this one.

## Pocket side (phone)

Pocket is served by this server and built from `lib`; its architecture,
theming, and same-origin deployment rule are [pocket-app.md](./pocket-app.md).
The seam: the server ships the static build and authors no styling of its own —
its one self-authored response is the plaintext missing-build stub at `GET /`.

## Testing

`pnpm --filter server test` drives setup → pairing → connect through real HTTP
and WebSocket boundaries: the `FakeHost` in `server/test/harness/fake-host.mjs`
speaks only the `e2e` envelope and `client-gone`, mirroring the shipped Host's
ceremony semantics over the same shared primitives,
the `FakeClient` in `server/test/harness/fake-client.mjs` runs both ceremonies
as a real Noise initiator with `SimAuthenticator` producing presence proofs
through the real `/api/reauth/*` routes, and process-level tests spawn the real
entrypoint. `server-lib-common/test/security-guarantees.test.mjs` drives the
model's guarantee list end to end. Browser-dependent Host and Pocket UI remain
dogfood coverage.

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
startup — no routable VAPID subject (Web Push above). Setting `DORMOUSE_ORIGIN`
to an https origin enables it with no further configuration, since that origin
becomes the subject. To exercise push against a desktop browser on localhost, supply a
contact explicitly:

```sh
DORMOUSE_SETUP_PASSWORD=hunter2 DORMOUSE_VAPID_SUBJECT=mailto:you@example.com \
  pnpm dev:pocket-server
```

**2. Host** (the laptop being controlled). The Host refuses any origin outside
the allowlist baked into its bundle (above), which by default admits neither
localhost nor a plaintext scheme, so a local server needs the override at build
time — `dev:standalone` picks it up because it re-stages the sidecar bundles on
the way:

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
Host connects by itself. (The same commands ride on that object, all promises
since the hook forwards to the service. The dev loop has no installer offer.)
For a headless
stand-in host instead:
`DORMOUSE_SETUP_PASSWORD=hunter2 node server/scripts/fake-host.mjs http://localhost:3000`
— it instantiates the test harness's `FakeHost`, prints a pairing URL to paste
into Pocket, and differs from a real Host only in auto-approving and logging.

**3. Phone** (or any other browser profile): show a code on the laptop
(**Settings → Remote control → Show a pairing code**) and open the server origin
on the phone. A browser that has never been here leads with **Scan a Host QR**;
scan or paste the code, which creates the passkey and signs you in, then read
the two digits off the phone and type them into the laptop's modal → one
biometric prompt → pick a pane → type. **A Host must be enrolled first**: the
code is the only credential `/api/setup/*` takes, so there is no way to register
a passkey before step 2.

A code the phone's *own camera* opens is origin bootstrap only — Pocket erases
the fragment, spends nothing, and asks you to scan again from inside the app,
because on iOS the camera opens Safari rather than the installed app
([pocket-app.md](./pocket-app.md)). On the localhost dev loop the parser's
loopback exemption is what lets a code minted at `http://localhost:3000` parse
at all.

To test push, **add Pocket to the Home Screen before scanning** and do all of
the above inside the installed app: iOS delivers Web Push only there, and the
install is a separate storage partition needing its own pairing, so setting up
in the tab first means doing it twice ([pocket-app.md](./pocket-app.md) ->
Installable web app). Push is then one tap for the whole device — **Enable push
notifications**, on the card above the host list, which subscribes the browser
and registers every paired Host at once. That tap is the user gesture iOS
requires before it will prompt for permission; connecting alone does not
subscribe.

Limitations to know about: each browser storage partition has its own keys and
therefore needs its own Host pairing, even when a synced passkey signs it in;
clearing site data destroys them → re-pair, per the security model; a dropped
WebSocket sends you back to the Hosts view — reconnect by tapping Connect
again.

## Installing it

The shipped selfhost deployment is a per-login user agent on the user's own
machine, reachable only from their tailnet — a LaunchAgent on macOS, a
Scheduled Task on Windows, a systemd *user* service on Linux — with
`tailscale serve` terminating HTTPS on the node's MagicDNS name and proxying to
the server on loopback. There is no cloud relay: an always-on relay is the same
installer on an always-on tailnet machine. The relay is down while the machine
sleeps, is shut off, or has no logged-in user — usually fine, since there is
then no local Host to control either.

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

**Scope: selfhost-onboarding** — collapse self-host first-run friction. The
first run is now *run installer → click Enroll → scan QR → approve*, with
nothing typed on the phone (Setup tokens, Host side,
[pocket-app.md](./pocket-app.md)); the setup password now enrolls Hosts only.
One settled decision constrains what is left: **the stock allowlist stays
`*.dormouse.sh`-only** ("Where a Host may reach a relay server") —
self-hosting keeps requiring a source build, deliberately, so nothing may depend
on widening it. The remaining phone-side items — in-app scanning and the end of
the setup-password path — are absorbed by the **e2e-client-host** scope
([remote-security-model.md](./remote-security-model.md) `## Future`), which also
rules out the one-minute resume token that used to be staged here: every new
session requires fresh WebAuthn presence, by design.

Unstaged but adjacent: origin migration (re-binding the passkey and
enrollments after a Tailscale node rename), and the revocation UI staged in
[remote-security-model.md](./remote-security-model.md) `## Future`.

**Owned here for the e2e-client-host scope** — what remains of the syntax,
routes, and state the trust model in
[remote-security-model.md](./remote-security-model.md) `## Future` requires. The
QR grammar and its parser, the relay envelope, the reauth and retire routes, the
delivery-keyed push routes, the Host side, and the deletion of every legacy path
all landed in that scope's stage 4 (above).

- **Sealed push** (stage 6). `POST /api/push/send` carries only the sealed
  envelope; the Server also deletes a delivery row when its push provider
  answers 404/410 — which it does already — and Pocket stays the normal
  lifecycle initiator, with provider deletion as cleanup for clients that can no
  longer submit tombstones.
- **Testing.** What remains is stage 5's flood and malicious-relay cases
  (record, drop, reorder, modify, inject — asserting nothing decrypts or forges
  a decision, remote API traffic, terminal bytes, labels, or notifications).
- **Operator recovery** (`SELF_HOST.md`): a Host whose enrollment predates the
  scope shows the enrollment form again; re-run the installer only if the offer
  is wanted — it mints one solely while `state/hosts.json` is absent, so remove
  that file first or enroll with the setup password.

**Scope: saas-multitenant** — the server-side hurdles between today's
single-owner selfhost server and a multi-tenant SaaS on `*.dormouse.sh`,
including the Bring-Your-Own-Tailnet (BYOT) posture that puts the relay inside a
customer's own tailnet without a custom client build. The wire API and security
model are unchanged from selfhost ([remote-api.md](./remote-api.md),
Transport); everything here is deployment and relay plumbing beneath them. The
SaaS account model (email + passkey self-serve signup) is this scope's own —
see **Accounts** below. Complementary front-door work staged elsewhere, which
this scope does not restate: CloudFlare routing + Pocket static serving in
[pocket-app.md](./pocket-app.md) `## Future`.

Framing invariant: Tailscale is network-layer defense-in-depth *under* the
existing authorization model, never a substitute for it. The Host stays the
final authority and the relay never decides access
([remote-security-model.md](./remote-security-model.md)). BYOT controls
**reachability** — the relay endpoint leaves the public internet and is
addressable only from the customer's tailnet — and nothing more; confidentiality
of relayed bytes from the SaaS operator is the end-to-end protocol's job, and it
already holds without BYOT.

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
