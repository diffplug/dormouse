# Server (selfhost)

> See `docs/specs/glossary.md` for Session / Pane / Surface vocabulary; this spec uses it for what the relay exposes.
> Owns the selfhost Server (`server/`) and the shared Host-service runtime (`lib/src/host/remote/`). Read
> [remote-security-model.md](./remote-security-model.md) first — it owns the trust model this one deploys;
> [remote-api.md](./remote-api.md) owns what flows after authorization, [pocket-app.md](./pocket-app.md) the phone.

The coordinating Server from the remote security model, in selfhost mode, cut
down to the smallest thing that completes this loop:

> Run the server with a setup password. Enroll your laptop's Dormouse Terminal
> with it. Point your phone's camera at the code that Host shows: it creates a
> passkey, signs in, and pairs. Pick up a running terminal session from the
> laptop on the phone.

One Node process (Hono). No database. **Terminal-only.** Every security
primitive lives in `server-lib-common`, the terminal UI in `lib`/`standalone`.

## Guardrails

* One account (`accountId: "owner"`), created once off a code an enrolled Host
  displayed; the setup password enrolls Hosts and registers nothing.
* Terminal surfaces only — exactly remote-api.md's **protocol-v1** (browser
  remoting is staged in that spec's `## Future`).
* Revocation is hand-editing a JSON file; no management UI. **A `/ws/host` token
  is re-checked against `hosts.json` after the upgrade too**, on a bounded sweep
  (`HOST_REVOCATION_SWEEP_MS`, one minute), since the upgrade check runs once and
  a Host may stay connected indefinitely. The sweep closes it with
  `WS_CLOSE_HOST_REVOKED` (4001) and its Clients get `host-gone`, the teardown a
  disconnect performs; the Host may reconnect, and the upgrade then answers 401.
  Revoking a *Client* is the Host's own ACL and still needs a Host restart
  ([remote-security-model.md](./remote-security-model.md)).
* A dropped WebSocket is handled by reloading the page / reconnecting the host;
  no resume protocol.
* Everything transient (challenges, sessions, presence nonces, relay state) is
  in memory; a server restart means everyone reconnects. **Transient stores must
  prune** — `HostChallengeIssuer.issue` drops expired entries on every call, as
  do the presence-nonce and setup-token stores (rationale).
* **A cap that one caller can spend on another's behalf is not a cap.** Every
  bounded transient store here is keyed by whoever grew it: setup tokens per
  minting Host (`MAX_TOKENS_PER_HOST`), presence nonces per session
  (`MAX_PENDING_REAUTH_NONCES_PER_SESSION`, `MAX_REAUTH_NONCE_SESSIONS` LRU
  buckets bounding the total) (rationale).

## Configuration

The whole of what `server/src/` reads from the environment:

| Env var                   | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `DORMOUSE_SETUP_PASSWORD` | Required. Gates host enrollment; registers no passkey — `/api/setup/*` takes a Host-minted setup token only. |
| `DORMOUSE_ORIGIN`         | External origin, e.g. `https://dormouse.tailnet.ts.net`; source of the WebAuthn `rpId`/`origin` and the Host's `ConnectionPolicy`. Defaults to `http://localhost:<port>` for dev. |
| `DORMOUSE_STATE_DIR`      | Where the JSON state files live. Default `./data`.         |
| `DORMOUSE_POCKET_DIR`     | The built Pocket app served at `/*`. Defaults to `lib/dist-pocket` resolved from the compiled server's own location, never the cwd (rationale). Absent or lacking `index.html`, `GET /` is a plaintext stub naming the build command. |
| `PORT`                    | Default 3000. Blank reads as unset; an explicit `PORT=0` is a `ConfigError` (rationale). |
| `DORMOUSE_REQUIRE_USER_VERIFICATION` | Only the exact string `true` demands a *user-verified* passkey assertion (biometric/PIN) rather than mere user presence; off by default (rationale). Applies to sign-in and re-auth alike, and is mirrored to every Host as `ConnectionPolicy.requireUserVerification` in its `HostEnrollResponse` (`docs/specs/security-remote.md` -> "Trust boundary"). |
| `DORMOUSE_BIND_HOST`      | Interface to listen on; unset binds every interface (below). |
| `DORMOUSE_VAPID_PUBLIC_KEY` / `DORMOUSE_VAPID_PRIVATE_KEY` | Web Push signing keypair; set both or neither. At startup the Server decodes both, derives the P-256 public point from the private key, and exits on a missing, malformed, or mismatched pair. Unset, it mints a pair on first boot into `vapid.json`. |
| `DORMOUSE_VAPID_SUBJECT`  | `mailto:`/`https:` contact for push-service operators (RFC 8292), defaulted from `DORMOUSE_ORIGIN` and validated at startup — Web Push below. |
| `DORMOUSE_RUNTIME_FILE`   | Absolute path the server records `{pid, releaseId, port, origin, startedAt}` into once it has **bound**, mode `0600`. Unset — dev, containers, every test — writes nothing. A relative value is a `ConfigError`, and the path lives outside `DORMOUSE_STATE_DIR` (rationale). |
| `DORMOUSE_RELEASE_ID`     | The release directory's name, supplied by the installer's `run-server` wrapper, recorded in the runtime file. `null` when the server was not started by an installer. |
| `DORMOUSE_ENROLL_TOKEN_FILE` | Absolute installer offer path — `{origin, token, mintedAt}`, the token 64 hex characters, shape in `server-lib-common/src/remote/enroll-offer.ts` — which `POST /api/host/enroll` accepts in place of the setup password; unset, one-click enrollment is off. A relative value is a `ConfigError` (rationale). **The offer lasts until the first Host enrollment or 24 hours, whichever comes first**, `hosts.json` being the durable marker (rationale); the Host-store mutex serializes password/token requests. **Redemption atomically renames the file before minting**, so exactly one concurrent redemption wins, and a mismatched claim is restored by no-clobber hard link so a newer installer generation wins. The installer rotates offers only before `hosts.json` exists. |

**The server itself always speaks plain HTTP**, and WebAuthn requires a secure
context: `localhost` works for development, a real phone needs TLS in front
(`tailscale serve` is the intended selfhost path; any reverse proxy works).

**Must bind loopback when the TLS proxy is local**, since `tailscale serve`
reaches the app over loopback and a socket left on every interface also publishes
the plaintext port to the LAN and to the tailnet itself; the selfhost install
sets `DORMOUSE_BIND_HOST`, and the default stays unbound for containers, where
the namespace is the boundary. Binding loopback is *containment, not admission* —
every route is still gated by the setup password or a bearer token, exactly as
`docs/specs/security-local.md` -> "Loopback Listeners" requires; `scripts/loopback-lint.mjs` does
not cover this socket (rationale).

**`DORMOUSE_ORIGIN` is normalized to a bare origin exactly once**, in
`readConfig` by the shared `normalizeOrigin` in `server-lib-common`; a value that
is not a URL with a host is a `ConfigError` naming the variable (rationale).
WebAuthn clientData checks, passkey assertion verification, the Host enrollment
policy and the pairing URL a Host composes all compare against that string
rather than re-parsing it; `createApp` parses it only to take `rpId` from the
hostname.

**`server/src/index.ts` validates the VAPID pair and subject before building the
app** — the only disk half of an otherwise pure env→config mapping.

Source of truth: `readConfig` in `server/src/config.ts`,
`server/src/enroll-token.ts`; pinned by `server/test/config.test.mjs`,
`server/test/runtime-file.test.mjs`, `server/test/bind-host.test.mjs`,
`server/test/enroll-token.test.mjs`.

## Where a Host may reach a relay server (self-host builds)

No CSP fences the relay socket — standalone's runs in the Node sidecar, VS
Code's in the extension host — so the same CSP-shaped source list is **baked
into the Node bundle** and enforced there: one syntax, one build-time variable
(`DORMOUSE_REMOTE_CONNECT_SRC`), whichever process holds the socket. **The
webview CSPs carry no relay sources at all** (`docs/specs/vscode.md` → "CSP
policy"; `standalone/scripts/tauri-conf.test.mjs` asserts the standalone one).

**The shipped binary is scoped to the SaaS origin only,
`https://*.dormouse.sh wss://*.dormouse.sh`, and an override replaces that
default rather than adding to it** — a per-build opt-in:

```sh
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
```

A self-host server on any other origin is therefore reachable only from a custom
build (same variable on `pnpm --filter dormouse-standalone tauri build`). The
default carries **no localhost entry and no plaintext scheme**, so a default
build refuses an `http://localhost:3000` dev server — "Running it" has the
override.

`scripts/csp-defaults.mjs` holds the one definition of the default and the
override rule; `standalone/scripts/build-sidecar-proxy.mjs` and
`vscode-ext/scripts/esbuild.mjs` esbuild-`define` it into their bundles, where
`bakedConnectSrc()` in `lib/src/host/remote/connect-src.ts` is the single reader
— **reading it as a `declare const`, never an import**, so the value is a literal
nothing at runtime can move.
Two build-time guards, both because their failure mode is silent (rationale):
`assertConnectSrcBaked` greps the bundle for the define, and
`resolveRemoteConnectSrc` rejects an override the matcher could never read — a
trailing slash, a path, a bare host, a scheme outside `http`/`https`/`ws`/`wss`,
a port outside 1–65535. The grammar is one regex duplicated into the `.mjs`,
which cannot import TypeScript; `connect-src.test.ts` pins both patterns, and
both copies of the default, as identical.

**Enforcement is `originAllowedByConnectSrc` in
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
**Enrollment and Host-authenticated push fetches must use `redirect: 'error'`** —
a Node process does not re-check a redirect target, so following one could carry
the setup password, Host bearer token, or notification metadata outside the baked
allowlist.

Reserved: the `https://*.dormouse.sh wss://*.dormouse.sh` entries are
*wildcards* on purpose — the BYOT posture (`## Future`, Scope: saas-multitenant)
has the stock client connect to per-tenant subdomains such as
`tenant-xyz.dormouse.sh` without a custom build, so narrowing them to a fixed
host would foreclose it.

## State files

The entire persistent state is four JSON files. The row shapes are sketched here
because hand-editing them is the *documented* revocation mechanism:

- `account.json` — `{ accountId, passkeys: [{ credentialId, publicKey /* SPKI b64u */, label, createdAt }] }`
- `hosts.json` — `[{ hostId, hostToken, enrolledAt }]`; **no label** — the Server keeps no name for a Host
- `push-subscriptions.json` — `[{ hostId, deliveryId, endpoint, keys, vapidPublicKey, subscribedAt }]`
- `vapid.json` — `{ publicKey, privateKey, createdAt }`; exists only when no keypair is configured by env

**The Host's ACL is never here** — it lives on the Host, in the process that owns
the PTYs (`lib/src/host/remote/host-state-store.ts`).

**Every write is temp-file-plus-rename and every mutation is serialized through
a per-store promise chain**, so a crash cannot leave an unparseable file and two
concurrent read-modify-writes cannot lose each other. `hosts.json` stores
`hostToken` — the host↔server relay bearer secret — in plaintext and `vapid.json`
a private key, so the state dir is created `0o700` and every write lands in a
`0o600` temp file before the rename. **Any new file under `$DORMOUSE_STATE_DIR`
must go through `writeAtomic`.** **Never build anything on that mode**
(rationale); what protects the *installed* server's state is the installer's
directory permissions, in "Installing it" below.

**Rows are validated as they are read**, `hosts.json` and
`push-subscriptions.json` both — a half-finished hand edit is an expected state,
not corruption. A malformed host row is dropped rather than carried (rationale);
a malformed subscription reads as a missing registration, which Pocket repairs by
re-offering Enable, rather than as a live one nothing can reach.

**`hostId` is pinned at enrollment: base64url of 16 bytes**, minted and
validated as `isE2eId` on both sides — the Server reading `hosts.json`,
`isEnrollment` on the Host (rationale). A wrong shape reads as un-enrolled on the
Server, and on the Host fails the exchange naming the field.

**A row whose `hostId` has left `hosts.json` is dropped on read**, joined
against the Host store rather than pruned at startup, so revoking a Host
cascades without a restart; the next mutation writes the pruned set back. **The
join reads `listIfPresent`, so an absent `hosts.json` drops nothing** — an empty
enrolled set written back would make a rename in flight a durable truncation. A
pre-end-to-end row (a device key, no `deliveryId`) is **dropped on read** too,
with **one** warning per process naming the file and saying to re-register.

`push-subscriptions.json` is the one store that deletes rather than appends —
404/410 retires a dead subscription, and a rotated endpoint must replace its
stale row rather than leave one per rotation:

* **Rows are keyed on the pair (`hostId`, `deliveryId`)**, so a phone paired
  with two laptops subscribes twice and a Host can only ever read or reach its
  own subscribers. Each row records the public VAPID key it was registered
  under, so a rotation reads as stale rather than working, and holds no label.
* **An upsert whose endpoint differs deletes every row still carrying an address
  this delivery is moving off**, one service-worker scope having one
  subscription. Both keys are load-bearing: the addresses being replaced are read
  from **every row carrying this `deliveryId`**, whichever Host it belongs to;
  the rows *dropped* are matched on the **endpoint**, which is what reaches
  siblings whose delivery ids this request never names.
* **A brand-new `deliveryId` cannot know its scope's previous address**, so rows
  for that scope's earlier endpoint survive a re-pair until a 404/410 retires
  them (rationale). Rows already carrying the *presented* endpoint are the same
  scope and stay, which is what makes a second Host's registration additive.
* **The response reports the state that mutation left behind** — every Host the
  presented endpoint is still registered with — so a committed POST whose
  response was lost is repaired by its own idempotent retry.
* **Removing a Host row is observed lazily**, nothing cascading on write:
  `listForHost` answers nothing for a `hostId` that is gone, so its rows are
  unreachable the moment the edit lands and leave disk on the next 404/410 prune
  or Client delete.
* **Every stored field is bounded and the row count is capped** — the one
  *durable* store a session token can grow (rationale). `endpoint` at
  `MAX_PUSH_ENDPOINT_LENGTH` (1024) on admission; both `keys` at the base64
  lengths RFC 8291 fixes — `p256dh` an uncompressed P-256 point, `auth` the
  16-byte secret — each at its *padded* encoding, so a browser that pads still
  registers. An upsert then caps the committed set at
  `MAX_PUSH_SUBSCRIPTIONS_PER_HOST` (32) and `MAX_PUSH_SUBSCRIPTIONS_TOTAL`
  (256), **evicting the oldest `subscribedAt` first and never the row it just
  wrote**. Eviction covers every Host, so a hand-edited file over the cap
  converges on the next write.

Source of truth: `server/src/state.ts`.

## WebAuthn without a WebAuthn library

No WebAuthn library, and none is needed (rationale): registration reads
`response.getPublicKey()` — SPKI DER straight from the browser,
`attestation: 'none'` requested, so there is no CBOR and no attestation to
parse. **Assertions go through `verifyPasskeyAssertion` in `server-lib-common`,
the same function the Host uses**, so Server and Host cannot disagree on what a
valid assertion is.

`POST /api/setup/finish` takes `{ credentialId, publicKey, clientDataJSON }` and
checks, in order: `clientDataJSON` decodes; `type === 'webauthn.create'`; its
challenge redeems (400 otherwise); `origin` equals the configured origin; the
public key imports as an ECDSA P-256 verify key — refusing anything assertions
could not later be verified against; and the credential id is new (409
otherwise, so a re-registered credential cannot silently displace a stored key).

**Sign-in and re-auth share one verifier**: look up the **stored** passkey for
the asserted credential (404 if unknown), pull the challenge out of the
assertion's own `clientDataJSON`, **consume it *before* verifying** so a captured
assertion can never be replayed even when verification would succeed, then
`verifyPasskeyAssertion` against the stored key under the server's UV policy.

Challenges are `HostChallengeIssuer` from `server-lib-common` — a generic
single-use/TTL store despite the name — and **setup, sign-in/re-auth, and
push-subscribe each get their own issuer**, so a challenge minted for one flow
can never be redeemed in another. **Both server-side issuers are capped**
(`MAX_PENDING_CHALLENGES`, oldest evicted) as well as swept (rationale).
**Before consuming, the server canonicalizes the browser's
`clientDataJSON.challenge` by decoded base64url bytes**, so padded browser
serializations redeem the issued challenge without weakening single-use replay
protection.

## HTTP API

The whole route surface; paths and request/response shapes live in
`API_ROUTES` / `WS_ROUTES` with their types in
`server-lib-common/src/remote/wire.ts`, and `HELLO_ROUTE` in
`server-lib-common/src/index.ts`, so Server, Host and Pocket cannot drift.

| Route                            | Auth           | Does                                              |
| -------------------------------- | -------------- | ------------------------------------------------- |
| `GET /api/hello`                 | —              | The shared greeting. **Carries no release identity** — unauthenticated, CORS-`*`, reachable through `tailscale serve`; the runtime file carries it ("Installing it") |
| `POST /api/setup/begin`          | setup token    | Issues a registration challenge, gated exactly as `finish` is so neither is softer. Answers the account's credential ids for a retry's `excludeCredentials`, so no passkey that already signs in is duplicated — an orphan the Server never registered is absent, and is still replaced |
| `POST /api/setup/finish`         | setup token    | Registers the passkey in `account.json`; the token is spent at the gate and put back if registration then fails. `label` is **reduced, not refused** — the same `boundedPushText` a pairing label goes through, to `MAX_PASSKEY_LABEL_LENGTH` code points with control and bidi characters stripped |
| `POST /api/setup/retire`         | session token  | Spends a live setup token without registering anything (rationale). 204, or 401 `SETUP_TOKEN_INVALID_ERROR` after the same fixed delay |
| `POST /api/signin/begin`         | —              | Issues a sign-in challenge                          |
| `POST /api/signin/finish`        | —              | Verifies the assertion and issues a 12-hour in-memory session token |
| `POST /api/reauth/begin`         | session token  | Takes a required, kind-tagged `PresenceBinding`, mints a single-use 2-minute `serverNonce`, and answers `presenceChallenge(binding, nonce)` with the RP ID, the nonce, and the bound credential as the sole `allowCredentials` entry. 404 for a credential this account has not registered; 400 for a missing or malformed binding |
| `POST /api/reauth/finish`        | session token  | Consumes the nonce, recomputes the challenge, and verifies the assertion against the **stored** key for exactly that credential. **Extends nothing** — not the session, not the relay socket |
| `POST /api/host/enroll`          | setup password or one-time enroll token | Enrolls a Host, appends `hosts.json`, mirrors the user-verification policy. Exactly one credential — both, or neither, is a 400. **Takes no label**: a Client learns the machine's name only inside an encrypted outcome. Capped at `MAX_ENROLLED_HOSTS`, answering 409 naming the file to edit — checked inside the store mutex and **after** the credential (rationale) |
| `POST /api/host/setup-token`     | host token     | Mints the single-use, short-TTL token behind this Host's QR (below) |
| `GET /api/hosts`                 | session token  | Enrolled hosts + whether each is currently connected |
| `GET /api/push/config`           | —              | Returns the public VAPID key, or `null` when push is unconfigured |
| `POST /api/push/subscribe`       | session token  | Upserts the `(hostId, deliveryId)` subscription. 404 for an unknown `hostId` (rationale) |
| `POST /api/push/subscriptions/query` | session token | Reports which of the **presented** `deliveryIds` are registered, and for which Host |
| `DELETE /api/push/subscriptions/:deliveryId` | session token | Idempotent: **always 204**, so the route reveals nothing about whether a row existed |
| `GET /api/push/devices`          | host token     | The `deliveryId`s subscribed to **this** Host under the current VAPID key |
| `POST /api/push/send`            | host token     | Fans out one sealed envelope per named delivery; `recipients` is required, and the Server reads no notification text |
| `GET /ws/host`                   | host token     | The Host's relay socket                            |
| `GET /ws/client`                 | session token  | A Client's relay socket                            |
| `GET /*`                         | —              | The built Pocket app, registered last so every route above wins. Cache policy and SPA fallback: [pocket-app.md](./pocket-app.md) |

`/api/*` is CORS-`*` — every endpoint is gated by a credential and no cookies
exist for a foreign origin to ride on, and the Host and dev Pocket builds call
from other origins. WS auth rides the `token` query param, since browsers cannot
set WebSocket headers.

**Every request body is bounded before any route runs**, at
`MAX_REQUEST_BODY_BYTES` (64 KiB), answering 413 — the routes carrying their
credential in the body (`/api/host/enroll`, `/api/setup/*`,
`/api/signin/finish`) read it *before* that gate (rationale). **The bound is on
the body, never on the caller**: a correct credential inside an over-long body is
still 413. **One route is exempt**, its legitimate body being larger:
`/api/push/send`, whose `MAX_PUSH_SEND_BODY_BYTES` is *derived* from
`MAX_PUSH_QUERY_DELIVERY_IDS` and `MAX_SEALED_PUSH_LENGTH` so it cannot drift
from what a maximal fan-out costs. **The limit is staged after CORS**, so a 413
carries the headers a browser needs to read it. Source of truth:
`server/src/app.ts`, pinned by `server/test/body-limit.test.mjs`.

**The setup password is compared in constant time** (SHA-256 digests, so length
never branches) with a small fixed delay on failure; host tokens resolve the same
way, checking every row without an early break. **The same delay answers a
rejected host token**, on `requireHost` and on the `/ws/host` upgrade; the
session token gets neither it nor a shape check (rationale). **A `hostToken` is
pinned to its minted shape**, 32 bytes base64url, refused before `hosts.json` is
read at all, the way `isDeliveryId` guards the push routes. That is the extent of
the hardening today.

Every session-gated route — including the `/ws/client` upgrade, rejected before
`injectWebSocket` sees it — answers an unknown or expired token 401 with the
shared `UNAUTHORIZED_ERROR` from `server-lib-common/src/remote/wire.ts`. **That
exact string is load-bearing**: Pocket keys its "sign in again" recovery on it,
and a bare 401 is ambiguous since a spent setup token answers 401 too
([pocket-app.md](./pocket-app.md) -> An expired session drops to sign-in). A
rejected enroll token answers that same body and delay whatever the cause, safe
because only a Host sends one; **a rejected setup token answers the distinct
`SETUP_TOKEN_INVALID_ERROR`** — same 401, same delay — which Pocket keys its
"scan again, or type the password" recovery on.

### Setup tokens and the pairing QR

An enrolled Host mints a setup token over its own authenticated channel; the
response carries the token alone — the Host knows its enrolled origin and
composes the QR itself. **Scanning is the only way a passkey is registered** —
`/api/setup/*` takes no other credential.

**The QR grammar is this spec's.** Exactly
`<enrolledOrigin>/#pair?<v>.<hostId>.<inviteId>.<expiry>.<setupToken>.<ephPub>`,
the origin being the normalized HTTPS origin with no trailing slash and appearing
only as the URL prefix, so a native camera reaches the right self-hosted Pocket
and **the fragment never reaches this server**. The fragment is positional,
dot-delimited, carries no field names, and is exactly 146 characters:

| Field | Encoding, exact length | Purpose |
| --- | --- | --- |
| `v` | literal `1`, one character | E2E wire version; any other value is rejected, never negotiated |
| `hostId` | 16 bytes as 22-character unpadded base64url | relay destination |
| `inviteId` | 16 bytes as 22-character unpadded base64url | single-use invitation held only in Host memory |
| `expiry` | unsigned 32-bit epoch seconds as exactly 10 decimal digits | advisory Client fail-fast; Host memory stays authoritative |
| `setupToken` | 32 bytes as 43-character unpadded base64url | credential for `/api/setup/*` |
| `ephPub` | 32-byte X25519 public key as 43-character unpadded base64url | one-use Host Noise responder key for this invitation |

**`PAIRING_QR_URL_MAX_LENGTH = 256`, enforced before any encoder runs**, so a
mint over the cap fails naming the origin rather than throwing inside the
app-wide ErrorBoundary. The origin being the only variable-length part, that
bounds a self-hoster's Pocket origin at 103 characters.

**One parser boundary.** `parsePairingInvitationUrl(text, appOrigin, now?)`
answers the complete invitation or `null` — **never a partial parse**, and never
an error a caller can distinguish. Two of its checks are this spec's rather than
the parser's: the URL must be **HTTPS, or plain HTTP on exactly `localhost`,
`127.0.0.1`, or `[::1]`** — policy, not derivation from the platform's
secure-context rule (rationale) — and its origin must **equal the running app's
exactly**, the only thing keeping a code from bootstrapping another deployment's
Pocket, a fragment being invisible to this server. Check order is the function's
own: cheap before expensive, the X25519 import last, which is what makes it
asynchronous.

Source of truth: `server-lib-common/src/security/pairing-invitation.ts`, with
`#setupQr` in `lib/src/host/remote/service.ts` as the emitter; pinned by exact
encode/parse vectors in `server-lib-common/test/pairing-invitation.test.mjs`.
What the invitation half proves is
[remote-security-model.md](./remote-security-model.md) -> Pairing.

Token rules, unchanged by the grammar:

* **`/api/host/enroll` counts exactly one credential by presence, not by type**
  (rationale); the setup routes have nothing to count — a request without a live
  token is the same delayed 401 as one with a dead one.
* **`begin` peeks; `finish` consumes before it reads the body** — that delete is
  the single-use gate, so of two overlapping finishes only one registers. Every
  failure past it restores the token on its original expiry without exceeding
  the per-Host cap. `POST /api/setup/retire` consumes the same way and registers
  nothing.
* **Both gates re-read `hosts.json`**, so a revoked Host's outstanding tokens die
  with it rather than staying redeemable for the rest of their TTL.
* **The store remembers which Host minted each token.** TTL is
  `DEFAULT_PAIRING_TTL_MS`, the window the Host's invitation lives for; it prunes
  on every mint and caps each Host's outstanding tokens at `MAX_TOKENS_PER_HOST`,
  that Host's own oldest first (Guardrails). The cap lives in `server-lib-common`
  because the Host bounds its own invitation map at the same number.

Source of truth: `server/src/setup-token.ts`, pinned by
`server/test/setup-token.test.mjs`.

### Web Push

A push must reach a phone whose app is closed, which the relay cannot do, so it
is plain HTTP to the platform's push service (APNs, FCM) through `web-push`, the
server's one third-party runtime dependency. Host and webview halves:
[alert.md](./alert.md) -> Push notifications.

- **Two audiences, two credentials.** A Client registers, queries, and deletes
  its own rows with a session token plus the `deliveryId` the Host minted for
  it; a Host reads and sends with its `hostToken`. **The send route takes the
  `hostId` from the token, never from the body**, so naming a delivery explicitly
  cannot escape the calling Host's own scope.
- **The Server never selects recipients.** `recipients` is required and
  non-empty; an absent or empty list is a 400, not a fan-out. The Host names its
  targets ([alert.md](./alert.md) -> Push notifications).
- **Possession of the delivery id is the whole authorization** — 256 unguessable
  bits known only to one ACL record and that Client's own pinned copy, so
  registering, querying, and deleting need no challenge and no signature. **The
  Server never lists delivery ids to a session**: the query route reports only on
  ids the caller presented. A Host token reads its own subscribers
  (`/api/push/devices`), identities only — **the endpoint and its keys never
  leave the Server**.
- **Delivery views are VAPID-current.** With push configured, the query route
  and `/api/push/devices` omit rows registered under a different (or legacy
  unknown) public key, and `/api/push/send` never targets them (rationale); the
  rows stay on disk until Pocket's re-registration repairs them.
- **A subscription authorizes nothing.** It is a delivery address the Host may
  write to; the Host's ACL alone decides what a Client may reach
  ([remote-security-model.md](./remote-security-model.md)).
- **Endpoint egress is public HTTPS only** — the one path where the Server makes
  an outbound request to a Client-supplied address, and inside a tailnet
  `100.64/10` is exactly what it must not reach. Registration rejects
  credentials, localhost, and non-public IP literals; delivery uses a dedicated
  HTTPS agent whose connection-time DNS lookup rejects every non-public range,
  refuses a hostname *wholesale* if any answer is blocked, and hands the socket
  the exact address it checked, so rebinding and mixed answers cannot create a
  second unchecked resolution. Range list: `docs/specs/security-remote.md` -> "What crosses the boundary".
- **The payload is sealed, and the Server reads none of it.** A send carries
  `recipients: [{ deliveryId, sealed }]` — one envelope per Client, the seal
  being to that Client's own static — and the Server validates only shape and
  bounds, then forwards exactly `JSON.stringify({ hostId, ...sealed })` with the
  `hostId` from the caller's own token, which is how the worker picks the record
  to decrypt against. Notification text is bounded on the Host before sealing
  and re-sanitized in the worker at the sink
  ([remote-security-model.md](./remote-security-model.md) -> Push sealing).
- **Delivery outcomes prune.** 404/410 means the subscription is permanently
  gone, so its row is deleted; anything else is transient and left alone, never
  silent — the refusal is logged (origin only, the endpoint being a bearer
  capability) and counted in the response's `failed`, since the route answers 200
  either way. **The log carries the push service's own reason body**,
  whitespace-collapsed and capped at 200 characters so an HTML error page cannot
  flood it (rationale).
- **Delivery is bounded twice, and both bounds resolve as `failed`** so the row
  survives to be retried, unlike a 404/410: a 10-second socket-inactivity timeout
  per push-service request, and a 15-second wall-clock deadline per send. **The
  deadline is applied by the *route*, not the sender**, so it holds for any
  injected `PushSender` and bounds the route as a whole (rationale). Both are
  separate from the 300-second provider TTL — an alarm an hour late is noise.
- **Push is disabled, not half-working**, when no VAPID key **or no VAPID
  subject** is configured: the config route reports `null` and subscribe/send
  answer 503; a phone registered against a key the Server has no contact to sign
  with would be subscribed to a push it can never receive.
- **A VAPID subject naming a loopback host is a startup error, not a default**
  (rationale). The default is `DORMOUSE_ORIGIN` when that origin is https and not
  loopback; otherwise there is none, and a loopback dev server turns push off
  rather than guessing a placeholder contact. An invalid configured value exits.

Source of truth: `server/src/push-endpoint.ts`, wired into registration by the
push routes in `server/src/app.ts` and into delivery by `server/src/push.ts`,
which also holds `defaultVapidSubject` / `assertVapidSubject`.

## Relay

The server routes JSON envelopes between client sockets and host sockets
(`@hono/node-ws`). **`clientId` is a server-assigned secret** stamped onto every
host-bound frame so the Host can address replies, and never sent to the Client.

**The `e2e` envelope is what a Host speaks.** Four `t: 'e2e'` frames
(Client→Server, Server→Host with `clientId` stamped, Host→Server, Server→Client
with `hostId` stamped from the socket), shapes in
`server-lib-common/src/remote/wire.ts`. A Host handles exactly these and
`client-gone`; anything else it receives is ignored.

- **An `init` binds** the Client socket to the named Host, replacing whatever
  binding it held; the previous live Host gets `client-gone` first, disposing its
  pairing UI, remote-api sessions, and watchers immediately.
- **A `transport` frame is forwarded only within that binding**, in either
  direction; one outside it is dropped, including a late reply from a Host the
  Client has since left.
- **Never parsed, never remembered, never authorized.** The relay does not
  decode `ct`, keeps no Noise state, holds no policy, and verifies nothing before
  forwarding — only the Host knows whether a ceremony succeeded, and says so only
  inside the ciphertext.
- **Its bounds are defense in depth**, on a both-sides rule: `hostId` and `id`
  base64url of 16 bytes, `clientId` a bounded string, `ct` base64url bounded by
  `MAX_E2E_CIPHERTEXT_LENGTH` (the encoding of a maximal Noise message). A
  malformed Client frame gets an `error`; a malformed Host frame is dropped.
  **The Host runs the same guard on arrival** (rationale).

**The envelope is the whole client surface**: any other frame type is answered
with an `error` and reaches no Host.

Its four resource bounds, enforced under `sweepRelaySockets` or at the socket:

* **A frame larger than any legal one never reaches a guard**: the adapter's
  `maxPayload` is `MAX_RELAY_FRAME_BYTES` — *derived* from
  `MAX_E2E_CIPHERTEXT_LENGTH`, `MAX_CLIENT_ID_LENGTH` and `E2E_ID_LENGTH`, the
  same bounds the frame guards enforce — because `ws` otherwise buffers up to
  100 MiB whole before `isE2eClientFrame` runs. Over it, the socket closes 1009.
* **Client sockets are capped** at `MAX_RELAY_CLIENT_SOCKETS` (64), and the
  (n+1)-th **is refused, never admitted by evicting another**: a live socket
  belongs to a ceremony or an attached terminal, so evicting would let a token
  holder take the relay away from itself. It closes 1013, a retry.
* **An expired session is closed after the fact**, the `/ws/client` counterpart
  of the revoked-Host sweep in Guardrails: the upgrade checks the session once
  and the socket outlives it by up to twelve hours. Closed 1008 `unauthorized`,
  the same pair the upgrade answers with, so Pocket needs no second recovery.
  **Only a registered conn is routed or torn down**, on both sides — a `close()`
  starts a handshake rather than ending the socket, so a frame already buffered
  still arrives carrying the conn the sweep dropped. `onClientFrame` and
  `unregisterClient` carry the same generation guard `onHostFrame` and
  `unregisterHost` do, or a late `init` would open a fresh ceremony for the
  session just expired.
* **A half-open connection is closed by heartbeat**, or its entry and its Host
  binding would live until the OS gave up: the sweep pings every socket and
  closes whatever has not answered within `RELAY_IDLE_TIMEOUT_MS` (three sweeps)
  with 1001 — a pong, not traffic, is what tells a dead socket from a
  legitimately idle terminal.

`index.ts` runs the sweep every `RELAY_SWEEP_MS` (30 s), `unref`'d like the
revocation sweep and far more often, touching no disk. Pinned by
`server/test/relay-limits.test.mjs`.

**Only one socket may own a `hostId`.** A second registration displaces the
first: clients bound to it are told `host-gone`, their bindings are cleared, and
the old socket closes with `WS_CLOSE_HOST_REPLACED` (4000) /
`WS_CLOSE_HOST_REPLACED_REASON` — constants living in `server-lib-common` because
the evicted Host keys its stand-down on the code (see
[Host side](#host-side-lib--the-two-node-hosts)). **Clearing the bindings at
*replacement* time, not only on disconnect, is load-bearing** — the displaced
socket's own close event is a no-op here, and the new Host process has a fresh
ACL and no memory of them.

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
handshake's own transcript, so nothing about it replays anywhere else. **The Host
is the only party that decides**: `/api/reauth/*` proves only that the account
holder was present, and the Host verifies that assertion itself.

### After authorization

The relay becomes a dumb ciphertext pipe. What flows through it is exactly the
terminal-only protocol-v1 scope of [remote-api.md](./remote-api.md) -> v1 scope,
framed as application messages on the Noise session (below).

### E2E framing

What one Noise transport message carries once `Split` has run. **The Client and
the Host must frame with this one module when they land**, so no two speakers can
disagree what a transport plaintext is; the harness is its only speaker today.

- **Transport plaintext is `[kind: u8][body]`.** `0x00` keepalive — exactly 32
  zero bytes; `0x01` stream — a slice of the application byte stream; `0x02`
  control — UTF-8 JSON NUL-padded to exactly `CONTROL_PAYLOAD_SIZE` (4096), so
  an approval and a denial are one size on the wire. The decoder strips trailing
  NULs and rejects any other body length, kind byte, or JSON that is not a plain
  object.
- **Each application message is `u32 big-endian length || bytes`**, chunked to
  keep every Noise message inside 65,535 bytes with its kind byte and tag
  (`MAX_STREAM_BODY_LENGTH`). **Reassembly rejects a declared length over
  `MAX_APP_MESSAGE_LENGTH` (1 MiB) as soon as its prefix arrives**, which also
  bounds it — it only ever waits on a length it accepted. **Bodies compact into
  one geometrically-grown buffer** (rationale).
- **The first failure poisons the session.** A decrypt failure, a nonce gap or
  reorder (which Noise's counter turns into a decrypt failure), or a framing
  violation destroys it and every later call throws — there is no
  resynchronization point in a stream cipher.
- **Prologues are `lengthPrefixedConcat`** of `dormouse/e2e/v1`, the ceremony
  kind, the `hostId`, and — for a connection — the connection id; for a pairing,
  every field of its invitation in QR order ("Setup tokens and the pairing QR"
  above), so a transcript is useless against another Host, id, or ceremony.

Source of truth: `server-lib-common/src/security/noise-transport.ts`, pinned by
`server-lib-common/test/noise-transport.test.mjs` and driven through the real
relay by `server/test/e2e-relay.test.mjs`.

## Host side (`lib` + the two Node hosts)

The Host is a service in the process that owns the PTYs — never a webview:
`RemoteHostService`, installed in the Tauri sidecar
(`docs/specs/standalone.md` → "Remote Host service") and in the VS Code extension
host (`docs/specs/vscode.md` → "Remote Host: a service in the extension host").
The webview holds only UI — the pairing modal, the `window.dormouseRemoteHost`
console hook, ring detection for push ([alert.md](./alert.md) -> Push
notifications), and answering what its own panes are called and how big its
terminals are — reaching the service over the `remoteHost:*` bridge.

**One service, two bindings.** `lib/src/host/remote/` shares the service, bridge
contract/client, ask-backed provider, and serialization across both hosts; only
the store, process plumbing, and bridge transport stay host-owned, their
contracts in the standalone, VS Code, transport, and remote-api specs.

**The store contract.** Both stores implement `HostStateStore` under the same
rules:

* **Reads fail closed** — an error that says nothing about what the file holds
  must answer neither empty nor stale, since an empty ACL silently de-pairs
  every device.
* **The in-memory view advances only after the durable write lands**, so a
  failed save cannot be mistaken for durable state by a later read.
* **Every mutation is serialized in call order** through the shared
  `createSerialQueue` (also the service's own start/stop chain), so an older ACL
  snapshot cannot finish last and erase a newer one (rationale).
* **A store that cannot persist still holds what it is given** in memory and
  reports `persistent: false` rather than dropping writes.

Each store's mechanics — the sidecar's single 0600 JSON file, rename semantics,
and memory fallback; VS Code's SecretStorage/globalState split and cross-window
memo invalidation — live in that host's spec.

* **Enrollment** (Settings dialog, or the console hook, once): server URL + one
  credential → `POST /api/host/enroll` → the service persists
  `{ serverUrl, hostId, hostToken, origin, rpId }` (+ `requireUserVerification`
  when the server sent it, + the `noiseStaticPrivateKey` /
  `noiseStaticPublicKey` this Host mints locally **before** the request and
  never sends in it —
  [remote-security-model.md](./remote-security-model.md)) through its
  `HostStateStore`, then opens and maintains `GET /ws/host`. Refused outright for
  a server outside this build's allowlist (above). **The `label` the operator
  typed is persisted with it and never leaves the machine** — the request body
  carries the credential and nothing else
  ([remote-security-model.md](./remote-security-model.md) -> Host identity) — and
  **`hostToken` never enters a webview realm**. **A 200 that is not an enrollment
  fails the exchange**: the response goes through the same `isEnrollment` guard
  every *read* uses, and a field missing, mistyped, or of the wrong shape (above)
  throws naming it (rationale). **The request carries a 10 s
  `AbortSignal.timeout`, under the webview's own 15 s command budget**
  (rationale). `enrollOffer` is the same flow with the offer's one-time token in
  place of the password; neither request carries the label. **A `status` snapshot
  is built after its last await**, or an enroll finishing under its offer-file
  read would answer `enrolled: false` after the `{ enrolled: true }` event,
  disarming the edge-triggered webview gate. The un-enrolled snapshot is one
  exported builder, `unenrolledStatus`, shared with the VS Code glue
  ([vscode.md](./vscode.md)).

  **Order matters, and the store goes first**: the `hostToken` exists nowhere
  else and cannot be re-minted from the same exchange, so the save is awaited
  before any Host is stopped (rationale). Replacing a *running* Host emits
  `{ name: 'status', enrolled: false }` between the two, since that webview gate
  is edge-triggered and everything it holds — the mirrored pairing queue, the
  push device list — belongs to the server being left. **`clearEnrollment` is the
  same rule backwards**: the delete is awaited first and nothing else happens
  unless it succeeded, or a failed delete would leave the credential on disk for
  the next launch to read back.
* **Relay socket policy**: one socket at a time, reconnected with exponential
  backoff (1 s, doubling to 30 s) after any close — **except a close carrying
  `WS_CLOSE_HOST_REPLACED`, which is terminal** (rationale): another Dormouse
  instance enrolled with the same `hostId` took the relay slot, so this one
  disposes its sessions, reports `displaced`, and arms no timer. Coming back is
  an explicit act — `reconnect()` — which takes the slot back and displaces the
  other Host in turn, so `displaced` is the one connection state the user has to
  act on. **A close event from a socket the controller no longer owns is
  ignored**, so a dead socket's late eviction cannot stand down the live one, and
  **disposing the service is terminal**: an enrollment or ACL read already in
  flight cannot construct a socket afterwards.
* **Security**: `HostAcl` (persisted through the `HostStateStore`, **keyed per
  `hostId`**, so an enrollment onto a fresh one starts with an empty ACL while a
  re-enrollment onto the same one keeps its paired devices),
  `HostChallengeIssuer`, `verifyPresenceProof`, and the Noise responder for both
  ceremonies — all from `server-lib-common`, running in the service's process.
  **Nothing a webview says can widen access**; the expected two-digit
  confirmation code never leaves it
  ([remote-security-model.md](./remote-security-model.md) -> Pairing).
* **Setup codes**: `setupQr` — enrolled only — mints at `/api/host/setup-token`
  over `hostFetch`, has the `RemoteHost` mint an invitation of its own, and
  composes the `#pair?` URL with `formatPairingInvitationUrl` (above). **A mint
  that resolves onto a *different* Host is refused rather than painted**: the
  code belongs to the server this machine just left. **The QR's secrets cross
  into the webview** — being displayed to a person is their whole purpose —
  **while the invitation's *private* half stays in the Host process**, as does
  `hostToken`. The Host reports its own invitation states as an `invitation`
  event; redemption at the Server announces nothing. `host-fetch.ts` holds the
  transport rules, including that **a route the Server may legitimately hold open
  longer than the shared budget** (push delivery, `PUSH_SEND_DEADLINE_MS`)
  **passes its own timeout**; [remote-security-model.md](./remote-security-model.md)
  owns what an invitation proves.
* **Pairing confirmation modal**: the queue is service-side; webviews mirror a
  serializable projection (`{ clientId, pairingId, label, requestedAt }[]`,
  pushed whole on every change) and echo both ids plus the **typed digits** on
  Confirm, so the approve/deny closures never leave the Host's process. **A
  confirmation is bound to the displayed `pairingId`, not whichever ceremony
  currently occupies `clientId`**: a re-sent pairing replaces its predecessor,
  and an old modal action whose immutable id no longer matches is rejected; the
  mirror compares on `pairingId` and remounts keyed by it, leaving an unchanged
  item alone. The modal shows the label, an empty two-digit input, and Confirm /
  Cancel (same pattern as KillConfirm), with the copy and the one-attempt rule in
  [remote-security-model.md](./remote-security-model.md) -> Pairing. **Confirming
  after the invitation expires answers `invitation-expired` and dismisses, ACL
  untouched.** In VS Code the queue is broadcast to every window, any of which
  may be in front of the user.
* **Terminal bridge**: served through a `HostSurfaceProvider`
  ([remote-api.md](./remote-api.md)). `directory.watch` snapshots come from the
  webviews that own the panes; `surface.attach` resizes through the owning
  webview's live xterm and streams the PTY from the process that owns it;
  `terminal.write` feeds the existing input path. **Last-attach-wins size
  authority holds at the PTY level** through that same resize path.

Source of truth: `lib/src/host/remote/service.ts` (`RemoteHostService`,
`#enrollWith`, `#status`, `#setupQr`, `unenrolledStatus`, lifecycle + console
commands),
`lib/src/host/remote/host-state-store.ts`, `lib/src/host/remote/serial-queue.ts`,
`lib/src/remote/host/enrollment.ts`, `RemoteHost.mintInvitation` in
`lib/src/remote/host/remote-host.ts`, `lib/src/remote/host/host-fetch.ts`,
`lib/src/remote/host/enrolled-gate.ts`, `lib/src/remote/host/activation.ts` (the
webview's client half).

### Remote control, in the Settings dialog

Enrolling is the one step a self-hoster cannot skip, so it is UI, not a console
incantation: a **Remote control** section at the bottom of the app-global
Settings dialog ([alert.md](./alert.md) -> Settings dialog).

**It renders nothing at all where `getPlatform().remoteHost` is absent** — the
website and lib dev server have no Host service, so the form would promise what
the build cannot do.

**The push-devices line above it must key on that same seam, not on its own
`no-host`**, a superset covering both a Host service that has not enrolled *and*
a build with no Host service at all ([alert.md](./alert.md) -> Push
notifications). Only the first has a section beneath it, so only the first says
"below". `describePushTargets` takes the seam as an argument; the `PushNoHost` /
`PushNotEnrolled` story pair holds the two apart.

Un-enrolled it is a three-field form (server, setup password, machine name —
prefilled with the hostname `status` carries) calling the service's `enroll`;
enrolled it shows the server URL, relay connection state, and paired-device
count, with `Disconnect` and — only on `displaced` — `Reconnect`. Rules the UI
exists to honor:

- **The offer leads, but only where it can be pressed.** The card shows when an
  unexpired local offer file exists and this Host is un-enrolled: it names the
  origin found, prefills the same editable name, and enrolls on one click, the
  three-field form folded behind "Enroll with a different server…" — **folded
  with `hidden`, never unmounted**, so typed input survives the disclosure and an
  offer appearing underneath it. **Reading the file is bounded to the un-enrolled
  state**; enrolled answers `offer: null` without touching disk (rationale).
- **The offer's token never enters a webview.** `status` carries only the origin;
  `enrollOffer` re-reads the file in the Host service, so an old card cannot
  reuse a spent offer (`docs/specs/security-remote.md` -> "Credentials at rest").
- **The click echoes the origin the card displayed**, and the service refuses a
  file that no longer names it — an installer rerun rewrites the offer with an
  origin nobody reviewed. `enrollOffer` takes `{ origin, label }`: the origin
  reviewed, never the one enrolled against, which stays the file's.
- **The card outlives its offer**, so a refusal landing after the enroll unlinked
  the file is not silence over a spent token.
- **Only one enrollment may run.** One synchronous gate covers both forms and
  pre-render double clicks.
- **The password is passed through, never held**, cleared on success; `enroll`
  answers `{ hostId, serverUrl }`, so `hostToken` never re-enters the webview.
- **Refusals are shown, not swallowed**, the offer card included: the allowlist
  error (above) is what the form renders, so the failure reads as "this build
  will not talk to that server" rather than as a wrong password.
- **Enrolled, "Set up a phone" opens an inline QR panel**, so a phone is set up
  by pointing a camera at the laptop rather than typing an origin and a 64-hex
  password. It mints on open and never before, re-mints shortly before
  `expiresAt` while the panel stays open, and always offers New code and Done,
  the only exit from a dead code (`RemoteControlSection.test.tsx`). Rules it
  exists to honor:
  - **The panel owns its busy and error**, not the section's shared pair, since
    its mint also fires on a timer.
  - **Must clamp refresh delay to `[30 s, DEFAULT_PAIRING_TTL_MS - 20 s]`**: the
    floor stops a fast-clock mint loop, the ceiling replaces a slow-clock code
    before its real Server expiry.
  - **The code being replaced stays on screen** until its replacement lands;
    only a first mint blanks.
  - **An invitation state change flips only the panel showing that `inviteId`**,
    so a second window offering a different code stays live, and **the panel
    stays subscribed past the QR**: `reserved` spends the code, `consumed` says
    the request it produced has been answered.
  - **The panel reports which decision ended the code**, in fixed copy per
    outcome (rationale), riding that `consumed` event; a retirement nobody
    decided carries none. **One region reports it**: the panel where it
    supersedes that sentence, the section otherwise. **Only a user action clears
    it**, never the timed re-mint.
  - **The view is keyed by enrollment identity and the QR sits behind its own
    error boundary**: a server swap drops the stale code, and a failed chunk
    fetch or refused encode costs a retry button, not the app-wide ErrorBoundary.
- **Disconnect asks first**: clearing the enrollment drops every paired phone
  until each pairs again.
- **Status is re-read, not patched, and the connection is polled.** The
  service's `status` event carries only `{ enrolled }`, so every event triggers a
  full `status` command, and the dialog re-reads on open since another window may
  have enrolled meanwhile. The *connection* moves with no event at all, so the
  store polls every 2 s **while something is subscribed**, never as a standing
  timer in every window, comparing field-wise before publishing (rationale; same
  rule as `setPushDevices` in `lib/src/lib/push-devices.ts`).
- **Reads are serialized, and coalescing stops at anything that changes the
  answer.** Ticks arriving during a slow read queue behind it, so a 15-second
  Host-service timeout becomes the visible error rather than being superseded by
  newer polls; `enroll`, `reconnect`, `clearEnrollment` and losing the last
  subscriber each *drop* the read in flight (rationale).

Source of truth: `useSetupQr` and `ScannableCode` in
`lib/src/components/RemoteControlSection.tsx` over `lib/src/components/QrCode.tsx`
(`uqr` encodes; that draws, lazily, so the encoder stays out of every main
bundle); `describePushTargets` in `lib/src/components/SettingsDialog.tsx`;
`dropInFlightRead` in `lib/src/remote/host/host-status-store.ts`;
`lib/src/host/remote/enroll-offer.ts` for the offer's well-known per-platform
path, read by `#enrollOffer` in `lib/src/host/remote/service.ts`.

The `window.dormouseRemoteHost` console hook — the scripting seam — exposes the
five enrollment commands: `enroll(serverUrl, password, label)`,
`enrollOffer(origin, label)` (its origin from `status().offer.origin`), `status`,
`reconnect`, `clearEnrollment`. **Pairing confirmation is never here**: it is a
modal because it must interrupt, and because the digits it takes are read off a
phone ([remote-security-model.md](./remote-security-model.md) -> Pairing).

`docs/stories/pairing.mdx` is a narrative Storybook page walking this section and
the pairing modal in sequence with the rest of the setup, rendering the real
components.

## Pocket side (phone)

Pocket is served by this server and built from `lib`; its architecture,
theming, and same-origin deployment rule are [pocket-app.md](./pocket-app.md).
The seam: the server ships the static build and authors no styling — its one
self-authored response is the plaintext missing-build stub at `GET /`.

## Testing

`pnpm --filter server test` drives setup → pairing → connect through real HTTP
and WebSocket boundaries: the `FakeHost` in `server/test/harness/fake-host.mjs`
speaks only the `e2e` envelope and `client-gone`, mirroring the shipped Host's
ceremony semantics over the same shared primitives; the `FakeClient` in
`server/test/harness/fake-client.mjs` runs both ceremonies as a real Noise
initiator, `SimAuthenticator` producing presence proofs through the real
`/api/reauth/*` routes; process-level tests spawn the real entrypoint.
`server-lib-common/test/security-guarantees.test.mjs` drives the model's
guarantee list end to end.

`server/test/malicious-relay.test.mjs` runs the same two halves over a relay
that records, drops, reorders, duplicates, modifies, and invents frames
(`server/test/harness/malicious-relay.mjs`, wrapping the real `RelayHub` over an
in-memory socket pair, so its routing is the shipped routing); its last case
swaps the hub for a guard-less router — no `ct`, `id`, or shape check anywhere —
and the Host refuses every frame itself. Browser-dependent Host and Pocket UI
remain dogfood coverage.

## Running it

The loop at the top of this spec is implemented end to end. To test:

**1. Server + Pocket** (one terminal):

```sh
DORMOUSE_SETUP_PASSWORD=hunter2 pnpm dev:pocket-server
```

Builds the Pocket app (`lib/dist-pocket`) and the server, then serves both on
`:3000`. **`./data` survives between runs**, so a second one starts already
enrolled with no setup path left to walk; remove it, or set
`DORMOUSE_STATE_DIR`. For a real phone set `DORMOUSE_ORIGIN` to your TLS origin
(e.g. via `tailscale serve`) — WebAuthn needs a secure context, and only
`localhost` is exempt. On localhost **push is off**, and the server says so at
startup: no routable VAPID subject (Web Push above). An https `DORMOUSE_ORIGIN`
enables it with no further configuration; to exercise push on localhost, supply
a contact:

```sh
DORMOUSE_SETUP_PASSWORD=hunter2 DORMOUSE_VAPID_SUBJECT=mailto:you@example.com \
  pnpm dev:pocket-server
```

**2. Host** (the laptop being controlled). A default build's baked allowlist
admits neither localhost nor a plaintext scheme (above), so a local server needs
the override at build time — `dev:standalone` picks it up because it re-stages
the sidecar bundles on the way:

```sh
DORMOUSE_REMOTE_CONNECT_SRC='http://localhost:3000 ws://localhost:3000' pnpm dev:standalone
```

Then enroll once, in **Settings → Remote control** (the sliders icon at the far
right of the baseboard): server `http://localhost:3000`, the setup password, and
a name for this machine. The same from the webview's devtools console, the
scripting seam:

```js
await window.dormouseRemoteHost.enroll('http://localhost:3000', 'hunter2', 'My Laptop')
```

Enrollment persists in the service's own store, and later launches connect by
themselves. (Every command rides on that object; the dev loop has no installer
offer.) For a headless stand-in host instead:
`DORMOUSE_SETUP_PASSWORD=hunter2 node server/scripts/fake-host.mjs http://localhost:3000`
— it instantiates the test harness's `FakeHost`, prints a pairing URL to paste
into Pocket, and differs from a real Host only in auto-approving and logging.

**3. Phone** (or any other browser profile): open the server origin there first,
then show a code on the laptop (**Settings → Remote control → Set up a phone**).
A browser that has never been here leads with **Scan a setup code**; scanning or
pasting it creates the passkey and signs you in. Read the two digits off the
phone into the laptop's modal; the phone then answers its own biometric prompt
and lands on the laptop's terminal, with no picker. **A Host must be enrolled
first** (Setup tokens). A code the phone's *own camera* opens is origin bootstrap
only; scan again from inside the app ([pocket-app.md](./pocket-app.md)).

To test push, **add Pocket to the Home Screen before scanning** and do all of
the above inside the installed app ([pocket-app.md](./pocket-app.md) ->
Installable web app owns why). Push is then one tap
for the whole device — **Enable push notifications**, on the card above the host
list, subscribing the browser and registering every paired Host at once. **That
tap is the user gesture iOS requires; connecting alone does not subscribe.**

Limitations: each browser partition needs its own Host pairing, even when a
synced passkey signs it in; clearing site data destroys them → re-pair, per the
security model; a dropped WebSocket sends you back to the Hosts view — reconnect
by tapping Connect again.

`scripts/pairing-walkthrough/` drives all three in real browsers, ending at a
command typed from Pocket. Not in CI.

## Installing it

The shipped selfhost deployment is a per-login user agent on the user's own
machine, reachable only from their tailnet, with `tailscale serve` terminating
HTTPS and proxying to the server on loopback.

**[SELF_HOST.md](../../SELF_HOST.md) is both the operator runbook and the
installer spec**: the per-platform mechanism map, the availability shape, the
invariants the three installers hold, and the mechanical traps they encode live
there, audited by the `FAIL IF` lines in `docs/specs/security-remote.md` and checked textually by
`scripts/deploy-lint.mjs` (`pnpm lint:deploy`). Source of truth:
`deploy/local/install-macos.sh`, `deploy/local/install-windows.ps1`,
`deploy/local/install-linux.sh`.

Two couplings stay on this side of the seam: the server writes
`DORMOUSE_RUNTIME_FILE` / `DORMOUSE_RELEASE_ID` once bound (Configuration above)
so the installers' health checks can prove *which* release answered rather than
accepting any 200 on the port; and a Host reaching an installed server needs a
build whose baked relay allowlist admits the origin — a `*.ts.net` one means
`DORMOUSE_REMOTE_CONNECT_SRC` at build time ("Where a Host may reach a relay
server" above).

## Future

**Scope: selfhost-onboarding** — collapse self-host first-run friction. The
first run is now *run installer → click Enroll → scan QR → approve*, with
nothing typed on the phone (Setup tokens, Host side,
[pocket-app.md](./pocket-app.md)); the setup password enrolls Hosts only, and
every phone-side item is done. One settled decision constrains what is left:
**the stock allowlist stays `*.dormouse.sh`-only** ("Where a Host may reach a
relay server") — self-hosting keeps requiring a source build, deliberately, so
nothing may depend on widening it. Nor is a resume token staged — every new
session requires fresh WebAuthn presence, by design
([remote-security-model.md](./remote-security-model.md) -> Presence proofs).

Unstaged but adjacent: origin migration (re-binding the passkey and enrollments
after a Tailscale node rename), and the revocation UI staged in
[remote-security-model.md](./remote-security-model.md) `## Future`.

**Scope: saas-multitenant** — the server-side hurdles between today's
single-owner selfhost server and a multi-tenant SaaS on `*.dormouse.sh`,
including the Bring-Your-Own-Tailnet (BYOT) posture that puts the relay inside a
customer's own tailnet without a custom client build. The wire API and security
model are unchanged from selfhost ([remote-api.md](./remote-api.md), Transport);
everything here is deployment and relay plumbing beneath them. The SaaS account
model (email + passkey self-serve signup) is this scope's own — **Accounts**
below. Front-door work staged elsewhere and not restated: CloudFlare routing +
Pocket static serving in [pocket-app.md](./pocket-app.md) `## Future`.

Framing invariant: Tailscale is network-layer defense-in-depth *under* the
existing authorization model, never a substitute for it — the Host stays the
final authority and the relay never decides access
([remote-security-model.md](./remote-security-model.md)). BYOT controls
**reachability** and nothing more: the relay endpoint leaves the public internet
and is addressable only from the customer's tailnet. Confidentiality of relayed
bytes from the SaaS operator is the end-to-end protocol's job, and holds without
BYOT.

### From single-owner to multi-tenant

Selfhost (everything above the fold) stays as-is; SaaS is a parallel deployment
that lifts each single-tenant simplification, every one chosen to be liftable:

* **Accounts.** One `accountId: "owner"` gated by a shared
  `DORMOUSE_SETUP_PASSWORD` becomes many accounts, each created by email +
  passkey. The two hand-edited JSON files (`account.json`, `hosts.json`) become
  a real per-tenant store with per-tenant revocation, and Host enrollment moves
  from the global setup password to the authenticated account.
* **Relay tenant-scoping (an invariant, not a check).** The relay binds one Host
  per Client socket with no notion of tenant; multi-tenant makes tenancy
  intrinsic to that binding — a Client may only ever be offered, and bound to,
  Hosts of its own account, and a cross-tenant binding must be *impossible*, not
  merely unauthorized. Defense-in-depth: the Host still authorizes, but the relay
  must not be the weak point.
* **Statefulness → horizontal scale.** All transient state (challenges,
  sessions, relay bindings) is in memory, so the relay is one process. At scale
  a Client and its Host must land on the same instance (sticky routing) or share
  a bus; the CloudFlare front door ([pocket-app.md](./pocket-app.md) `## Future`)
  is where that routing lands.

### The `*.dormouse.sh` pin — the constraint everything obeys

Two things above the fold combine into one hard constraint: the shipped Host
bundle may reach only `*.dormouse.sh`, and passkeys bind to the served origin
with Pocket served same-origin ([pocket-app.md](./pocket-app.md)). Whatever a
stock client connects to must therefore present a `*.dormouse.sh` origin over
TLS. A raw `100.x` tailnet IP or a `*.ts.net` MagicDNS name is a different
origin, breaking both the allowlist and the passkey binding, so BYOT cannot
simply point the client at the tailnet node.

### BYOT — a per-tenant tailnet node

The SaaS process embeds one Tailscale node per tenant via `tsnet` (one
`tsnet.Server` per tenant, each with its own state dir), joining the customer's
own tailnet. Tenant A's Host and Pocket reach the relay as a node inside A's
tailnet; A cannot address B's node, which is not in A's tailnet — network
isolation layered on the relay tenant-scoping above. The load-bearing hurdle is
reconciling that node with the `*.dormouse.sh` pin:

* **Name + cert.** A per-tenant hostname under the wildcard — e.g.
  `tenant-xyz.dormouse.sh` — must resolve, *for tailnet members only*
  (split-horizon DNS coordinated with the customer's MagicDNS), to that tenant's
  node, which serves a real TLS cert for the subdomain (we control `dormouse.sh`,
  so ACME DNS-01 issues it). Origin stays `*.dormouse.sh`, so the existing CSP
  wildcard, passkeys, and autoupdate all keep working while the bytes ride the
  tailnet and the relay never touches the public internet. A selfhoster cannot
  reproduce this (no `*.dormouse.sh` cert, no stock client), which is what makes
  BYOT a distinct product rather than dressed-up selfhost.
* **Enrollment.** The customer supplies a Tailscale OAuth client or ephemeral
  auth key scoped to a tag (e.g. `tag:dormouse-relay`); the server brings the
  tenant's node up as an ephemeral, tagged device, and the customer's own ACLs
  pin which of their devices may reach it.
* **Operational hurdles.** N userspace WireGuard nodes (each a gVisor netstack,
  a DERP connection, and key material) in one process: lazy activation (node up
  only while a tenant has a live device, ephemeral teardown when idle), sharding
  across processes at scale, per-tenant cert provisioning + split-DNS,
  server-side custody of per-tenant Tailscale auth material, per-node health (a
  dropped node means that tenant is offline). The node also consumes a device
  slot on the *customer's* tailnet — kept ephemeral to minimize it.
