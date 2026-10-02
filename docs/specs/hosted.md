# Dormouse Hosted accounts

> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the Hosted account application, the Hosted Relay's account-scoped routes and sockets, and the deployment of Hosted's three Workers. The one-time rendezvous the relay Worker serves belongs to `docs/specs/one-time.md` -> "Hosted rendezvous"; the Relay's shared route and routing semantics to `docs/specs/relay.md` -> "HTTP API" and "Routing"; remote authorization to `docs/specs/remote-security-model.md`.

## Application boundary

**Must serve Hosted as three Workers from `hosted/`, one origin each:**

| Worker | Origin | Serves | Holds |
|---|---|---|---|
| `dormouse-hosted` | `https://hosted.dormouse.sh` | the account frontend, `/api/auth/*`, `/api/providers`, `/api/ready`, voice tokens, the Relay's account routes ("Burrow enrollment") | the login cookie, auth secrets, Hyperdrive, the approval rate limit, a binding to the relay's `RelayRoom` |
| `dormouse-relay` | `https://relay.dormouse.sh` | the Hosted Relay, its sockets, and Pocket ("Relay", "Relay sockets"), the one-time rendezvous and `/connect/` (`docs/specs/one-time.md` -> "Hosted rendezvous") | Hyperdrive, `OneTimeRoom`, `RelayRoom`, the one-time, sign-in, setup, and enrollment rate limits, `ACCOUNT_ORIGIN`, `RELAY_ENROLL_SECRET`, the VAPID pair |
| `dormouse-voice` | `https://voice.dormouse.sh` | speak and the history sweep ("Managed voice") | `ELEVENLABS_API_KEY`, Hyperdrive |

Every Worker answers `/api/health`, 404s anything else under its non-page prefixes (`/api`, and the relay's `/ws` too), `/dev/*`, or `/__test/*`, and answers a thrown request 503 under `secureHeaders`. The account falls back to its SPA assets, the relay to Pocket's. Origin and binding isolation: `docs/specs/security-hosted.md` -> "Origin boundary" (rationale).

Marketing deploys separately; esbuild and Wrangler compile `remote-lib-common` from source through `hosted/tsconfig.json` `paths`.

**Must run committed Better Auth migrations before deploying code that needs them, never during a Worker request.** Postgres is reached through an uncached Hyperdrive binding. The runtime creates and closes its database pool within each request.

**Must install released core/auth packages from npm and commit their lockfile integrity hashes.** The installed packages' `dist/provenance.json` must name the same clean pgstencil commit; no runtime import depends on a sibling checkout. The auth migrations remain owned by the package; Dormouse's own tables migrate from `hosted/server/dormouse-migrations/`. **Never edit a merged migration**: a migrated database never reruns one, so append the next number (pinned by `hosted/server/tests/migrations.test.ts`).

**Must declare every peer dependency of the installed packages in `hosted/package.json`**, so they share Hosted's copy and Renovate updates them.

Source of truth: `workerApp` in `hosted/server/worker-app.ts`; `accountApp` in `hosted/server/account-app.ts`; `hosted/server/relay-worker.ts`; `voiceApp` in `hosted/server/voice-app.ts`; `hosted/server/bindings.ts`; `WORKERS` in `hosted/scripts/workers.mjs`; `hosted/wrangler.jsonc`, `hosted/wrangler.relay.jsonc`, `hosted/wrangler.voice.jsonc`; `migrations` in `hosted/server/migrations.ts`; `verifyPackages` in `hosted/scripts/production.mjs`. Pinned by `hosted/server/tests/boundary.test.ts`, `hosted/server/tests/workers.test.ts`, and `hosted/server/tests/artifacts.test.ts`.

## Identity and login

**Must retain independent simultaneous browser logins.** Login lifetime is 24 hours without refresh or cookie caching; logout revokes only the current login. These authentication records are not terminal Sessions.

**Must require explicit provider connection from a login less than ten minutes old.** The callback must retain that same live login. Matching email alone never connects an unbound OAuth identity. Different verified provider emails are allowed; an identity already attached to another account cannot be claimed.

**May create provider-only accounts without verified email.** Public email is null; pgstencil's internal placeholder is never a delivery address. Email-code login remains an access path to an account's canonical verified mailbox. No merge, email adoption, unlink, or account-recovery interface exists.

**Must identify accounts by immutable user ID, never email.** Provider-only accounts keep their identity when a provider subsequently supplies email. Exception: `ADMIN_EMAIL` ("Managed voice").

**Must enable providers explicitly in `OAUTH_PROVIDERS`.** The allowed set is GitHub, Google, Microsoft, and Apple. Missing paired credentials or unknown names fail closed; unused credentials enable nothing. Email uses Postmark in production and local capture in development.

**Must discard provider tokens after identity verification and omit login tokens from browser JSON.** Cookies and upstream identity verification follow the packed adapter; `hosted/server/tests/workers.test.ts` pins the consumer's browser contract in workerd with real Postgres and simulated providers.

Source of truth: `hosted/server/providers.js`; `authPolicy` / `providerBindings` in `hosted/server/policy.ts`; `App` in `hosted/src/App.tsx`.

## Interface

**Must link the account footer to the public Hosted privacy policy and terms.**

**Must show configured sign-in methods only.** Email supports sign-in and address-change actions. The account screen lists connected methods and explains recent-login requirements and provider-only recovery limits. Failed callbacks display a recoverable error and remove query parameters from browser history.

**Must check the account on return to the page and serialize submitted actions.** Authenticated data remains in memory; login tokens never enter local storage. Only public identity fields are rendered, without provider images or external assets. The Voice tokens and Computers sections render only when `GET /api/voice/tokens` and `GET /api/relay/burrows` succeed, and neither failure fails the account page; a minted token stays in memory and is shown once.

**Must inherit Dormouse product theme tokens before mounting React.** The OS light/dark preference selects bundled Light Visual Studio or Kimbie Dark. Type and touch sizing: `hosted/src/style.css`. It loads no marketing styles, fonts, or analytics.

Source of truth: `App` in `hosted/src/App.tsx`; `restoreTheme` in `hosted/src/main.tsx`; `hosted/src/style.css`.

## Managed voice

An admin-only test slice: Dormouse desktop exchanges a pasted voice token for ElevenLabs speech. The account Worker serves the token routes; the voice Worker serves speak.

| Route | Credential | Success |
|---|---|---|
| `GET /api/voice/tokens` | login cookie | 200 `{ tokens: [{ id, createdAt, lastUsedAt, revokedAt }] }` |
| `POST /api/voice/tokens` | login cookie, exact `Origin` | 201 `{ id, token, createdAt }` |
| `DELETE /api/voice/tokens/:id` | login cookie, exact `Origin` | 204; 404 for another account's or an unknown ID |
| `POST /api/voice/speak` | `Authorization: Bearer dmv_…`, JSON `{ text, voiceId }` | 200 `audio/mpeg`, `Cache-Control: no-store` |

Errors are JSON `{ message }`. Cookie routes answer 401 without a login and 403 for any account but the admin.

**Must admit only `ADMIN_EMAIL` while it is the account's verified email, rechecked on every request.** This gate, `isAdmin`, is also the Relay's entitlement ("Relay") and the only exception to "never email" ("Identity and login"); nothing else may key on an address, and it ends with the entitlement in Future item 3. Cookie routes ask the Better Auth handler's `get-session` for the login; speak reads the token owner's user row.

**Must store only a token's SHA-256.** A token is `dmv_` plus base64url of 32 random bytes, returned only by the mint response. Revocation is permanent; speak stamps `lastUsedAt`.

**Speak must answer in this order:**

1. 401 for a missing, malformed, unknown, or revoked token.
2. 403 when the owner is not the verified admin.
3. 400 for malformed JSON, `text` outside 1–200 characters after trim, or `voiceId` outside `^[A-Za-z0-9]{1,64}$`.
4. 503 when the deployment has no `ELEVENLABS_API_KEY`.
5. 429 once the owner's UTC-day counter reaches 500. The increment is atomic and precedes the upstream call, so failed upstream attempts count.
6. 502 when ElevenLabs throws or answers non-2xx.

**Never log the text or forward an upstream body or status.** The upstream URL, model `eleven_flash_v2_5`, and format `mp3_44100_128` are fixed in code; no binding or request field redirects them. `ELEVENLABS_API_KEY` is the voice Worker's secret, which production preflight requires there; the voice preview mapper never passes it. Tests fake ElevenLabs in Miniflare's outbound service, so no entry carries an upstream override.

**Must delete ElevenLabs speech history, which keeps each generation's text, from the production voice Worker only.** A successful speak schedules one sweep about 10 s later in `waitUntil`; a Cron Trigger every 5 minutes sweeps what that missed. No retention bound is guaranteed (rationale).

- **Must use an ElevenLabs account dedicated to Dormouse voice.** A sweep deletes the whole account's history.
- **Never touch the database or any binding but `ELEVENLABS_API_KEY` in a sweep**, so an idle deployment lets Postgres suspend. Without the key nothing runs; development and previews never sweep, and the preview configs drop `triggers`.
- **Must bound each pass**; a backlog waits for the next pass. At most six deletes are in flight; a 404 counts as deleted; a failed delete never aborts the pass. Only counts and statuses are logged or thrown.
- **Must fail the cron invocation when its pass cannot list or any delete fails; the after-speech pass only logs** (rationale).

Source of truth: `isAdmin` in `hosted/server/admin.ts`; `cookieAdmin` in `hosted/server/account-gate.ts`; `voiceTokenRoutes` / `speakRoute` / `elevenLabs` / `sweepOnCron` / `sweepAfterSpeech` in `hosted/server/voice.ts`; `scheduled` in `hosted/server/voice-app.ts` and `hosted/server/worker-app.ts`; `triggers` in `hosted/wrangler.voice.jsonc`; `hosted/server/dormouse-migrations/001_voice_tokens.sql`; `preflight` in `hosted/scripts/production.mjs`. Pinned by `hosted/server/tests/workers.test.ts`, `hosted/server/tests/boundary.test.ts`, `hosted/scripts/production.test.mjs`, and `hosted/scripts/preview.test.mjs`.

## Relay

The relay Worker serves the self-host Relay's HTTP API to many accounts: the paths, shapes, statuses, and error strings of `docs/specs/relay.md` -> "HTTP API", "Setup tokens and the pairing QR", and "WebAuthn without a WebAuthn library", so a Burrow and Pocket cannot tell the two apart; both run the checks and bounds in `remote-lib-common/src/remote/relay-common.ts`. Assertions demand presence, not verification. Security checks: `docs/specs/security-hosted.md` -> "Relay boundary". Only the differences:

| Route | On Hosted |
|---|---|
| `POST /api/setup/begin`, `/finish` | The passkey joins the account owning the token's Burrow: `accountId` is its user ID, `existingCredentialIds` its passkeys; 409 at `MAX_PASSKEYS_PER_ACCOUNT` |
| `POST /api/setup/retire` | Spends only a token one of the session's account's Burrows minted |
| `POST /api/signin/finish` | The asserted credential's account; `accountId` is its user ID. 401 `NOT_ENTITLED_ERROR`, and no session, for an account not entitled |
| `POST /api/reauth/begin`, `/finish` | Only the session's account's credentials and nonces |
| `GET /api/burrows` | The session's account's Burrows, each `online` while it holds a live socket in the account's `RelayRoom` ("Relay sockets") |
| `POST /api/burrow/setup-token` | 401 for a removed Burrow, 403 `NOT_ENTITLED_ERROR` for an owner not entitled |
| `POST /api/burrow/enroll` | Always 401 `UNAUTHORIZED_ERROR`: Hosted has no setup password; a Burrow enrolls by device code ("Burrow enrollment") |
| `GET /api/push/config` | The VAPID public key, or `null` when push is off ("Push") |
| `POST /api/push/subscribe` | 404 for a Burrow not the session's account's; 400 `endpoint must be a known push service` off the allowlist ("Push") |
| `POST /api/push/subscriptions/query`, `DELETE /api/push/subscriptions/:deliveryId` | Only rows of the session's account's Burrows |
| `POST /api/push/send` | A recipient repeating an earlier one's `deliveryId` is not sent again and counts as `unknown` (rationale) |
| `GET /api/hello` | 404: the self-host installers' probe |
| `GET /*` | Pocket (below) |

A session-gated route answers a session of an account no longer entitled with the expired session's 401 `UNAUTHORIZED_ERROR`, so Pocket returns to sign-in.

- **Must keep the Relay's state in Postgres** (`hosted/server/dormouse-migrations/002_relay.sql`). A sign-in challenge is the challenge row with no Burrow.
- **Must resolve each bearer and its owner's entitlement in one query joining `"user"`** (`sessionByToken`, `burrowByToken`), the socket upgrades' query-parameter token included. The entitlement is `isAdmin` ("Managed voice").
- **Must cap every table a caller grows, keyed by whoever grows it**, as `docs/specs/relay.md` -> "Guardrails" does: setup tokens and setup challenges per Burrow (`MAX_TOKENS_PER_BURROW`), presence nonces per session (`MAX_PENDING_REAUTH_NONCES_PER_SESSION`), and sessions per account (`MAX_SESSIONS_PER_ACCOUNT`), each evicting its key's own oldest; passkeys per account are refused at the cap (rationale). A capped insert runs under its key's advisory lock and, in one statement, prunes that key's own expired rows, trims its live rows, and inserts; it never touches another key's rows.
- **Must sweep every Relay table's expired rows from the relay's hourly Cron Trigger** (rationale); sign-in challenges, minted unauthenticated and flat, are bounded by it and the per-address limit.
- **Must answer 429 with `Retry-After` past the per-address limit on `signin/*` (`RELAY_SIGNIN_LIMIT`) and `setup/begin`/`finish` (`RELAY_SETUP_LIMIT`)**, before the body limit and any database read: 30 a minute, a ceremony's two routes sharing one budget (rationale).
- **Must restore a token a refused `finish` spent on its original expiry, within the Burrow's cap, and never once that expiry has passed.**

Known gap: restored-token admission samples time before locking, permitting
expired reinsertion.

**Push.** The push routes keep `docs/specs/relay.md` -> "Web Push" and its "State files" upsert rules; a send is HTTPS from the Burrow to the relay Worker, independent of terminal transport.

- **Must keep subscriptions in Postgres** (`hosted/server/dormouse-migrations/003_relay_push.sql`), keyed `(burrowId, deliveryId)`, every field bounded as self-host bounds it, deleted with their Burrow. **Must read the addresses a delivery moves off, drop rows, and prune 404/410 among the account's rows only.**
- **Must cap subscriptions at `MAX_PUSH_SUBSCRIPTIONS_PER_BURROW` and `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT`** in place of self-host's file total, evicting the oldest `subscribedAt`, never the row just written, in the upsert's transaction under the account's advisory lock (rationale). **Must stamp `subscribedAt` and every capped expiry with `clock_timestamp()`**, never `now()`, so a write that waited on its lock sorts after the one it followed. **Must share-lock the Burrow row**, so a subscribe racing its removal answers 404.
- **Must register and fetch only a known Web Push service's endpoint** (`knownPushEndpoint`) in place of the self-host DNS guard: `https:` on the default port, no credentials, at most `MAX_PUSH_ENDPOINT_LENGTH`, and host `fcm.googleapis.com` or `updates.push.services.mozilla.com`, or one under `.push.apple.com` or `.notify.windows.com` (rationale). **Never follow a redirect**: a 3xx is `failed`. A refusal's log keeps at most 1 KiB of its body, copying no chunk past it, and cancels the rest.
- **Must send through `webPushRequest`** (`remote-lib-common/src/remote/web-push.ts`), WebCrypto with no `web-push`: one RFC 8291 `aes128gcm` record and an RFC 8292 `ES256` VAPID JWT, `aud` the endpoint's origin, `exp` `VAPID_JWT_LIFETIME_S` (12 hours) ahead, `sub` the relay's `APP_ORIGIN`, signed once per origin per send (`vapidAuthorizations`). The route bounds each delivery by `PUSH_SEND_DEADLINE_MS`, aborting its fetch. **Never hold a Postgres connection across a push service's fetch**: read the targets (`readAsBurrow`), release, fan out, then reconnect only to prune.
- **Push is disabled, not half-working**: without both `RELAY_VAPID_PUBLIC_KEY` and `RELAY_VAPID_PRIVATE_KEY`, with malformed keys (including noncanonical base64url), with a private key that does not sign for its public point, or without a subject (`defaultVapidSubject`: an https, non-loopback `APP_ORIGIN`), the config route answers `null` and subscribe and send 503. The pair is a relay Worker secret; previews derive theirs ("PR previews"), and the dev loop has none.

**Pocket at the root.** `build` stages `lib/dist-pocket` at the root of the relay's assets and the one-time page beside it, checking both shells. Pocket is served per `docs/specs/pocket-app.md` -> "Serving the built bundle", except that a path naming no file (no extension, outside `/diagnostics`) gets the shell in one asset fetch.

Source of truth: `relayApiRoutes` / `sweepExpired` in `hosted/server/relay-api.ts`; `sessionByToken` / `burrowByToken` / `requireSession` / `requireBurrow` / `readAsBurrow` / `locked` in `hosted/server/relay-auth.ts`; `hosted/server/dormouse-migrations/002_relay.sql`; `relayPushRoutes` / `upsertSubscription` / `knownPushEndpoint` / `deliverPush` / `reasonOf` / `vapidAuthorizations` / `pushConfigOf` in `hosted/server/relay-push.ts`; `hosted/server/dormouse-migrations/003_relay_push.sql`; `vapidSigner` / `encryptWebPush` in `remote-lib-common/src/remote/web-push.ts`; `triggers` and `ratelimits` in `hosted/wrangler.relay.jsonc`; `pocketRoutes` in `hosted/server/pocket.ts`; `relayRules` / `relayPathKind` in `hosted/server/headers.ts`; `stageRelay` in `hosted/scripts/stage-relay.mjs`; `checkRegistration` / `verifySigninAssertion` and the push bounds in `remote-lib-common/src/remote/relay-common.ts`. Pinned by `hosted/server/tests/relay.test.ts`, `hosted/server/tests/relay-push.test.ts`, `hosted/server/tests/pocket.test.ts`, `hosted/server/tests/boundary.test.ts`, `hosted/scripts/stage-relay.test.mjs`, `remote-lib-common/test/relay-common.test.mjs`, and `remote-lib-common/test/web-push.test.mjs` (the RFC 8291 Appendix A vector).

## Relay sockets

The relay Worker serves `GET /ws/burrow` and `GET /ws/client` at the self-host paths, token in `WS_TOKEN_PARAM`, and routes them by `docs/specs/relay.md` -> "Routing", every rule, through the same frame layer and bounds. Only the differences; `docs/specs/security-hosted.md` -> "Relay boundary" holds the checks.

| Route | Admitted | Refused |
|---|---|---|
| `GET /ws/burrow` | no `Origin`, a Burrow token whose owner is entitled | 403 `forbidden` with any `Origin`; 401 `UNKNOWN_BURROW_TOKEN_ERROR`; 403 `NOT_ENTITLED_ERROR` |
| `GET /ws/client` | `Origin` exactly `APP_ORIGIN`, a live session of an entitled account | 403 `forbidden`; 401 `UNAUTHORIZED_ERROR` for any session refused, which Pocket's probe of `GET /api/burrows` reads as expiry |

- **Must route each account's sockets through one `RelayRoom` Durable Object, named `idFromName(userId)` from the account the token resolved to**, holding all its Burrow and Client sockets. Another account's Burrow is in another object, so a cross-account binding is impossible, not refused.
- **Must hand the object a fresh request**: the upgrade, the account, and the Burrow's id or the session's `expiresAt` as search parameters (`RELAY_ROOM_PARAMS`); never a header, token, or cookie of the caller's.
- **Must store only the account id**, written at the object's first upgrade; a request or RPC naming another account is refused and logged with no frame content.
- **Must recheck a Burrow's row in the object before accepting its socket**, under `blockConcurrencyWhile`: enrolled, the account's, its owner entitled, else the Worker's 401 or 403. A removal committed after the Worker's token check is refused here; one committed later has its `closeBurrow` delivered after the accept. **Never open a database connection in the object** (rationale): it reads rows through the relay Worker's `RelayRows` entrypoint, reached by `ctx.exports`. **Must bound every row read at `RELAY_ROW_READ_TIMEOUT_MS`**, under the runtime's 30 s `blockConcurrencyWhile` reset: past it the upgrade answers 503 and the sweep leaves its Burrows to the next.
- **Must accept every socket through the Hibernation API**, tagged by role and id, keeping the routing state in its attachment — role, `clientId`, bound `burrowId`, `expiresAt` — so a woken object rebuilds it from `ctx.getWebSockets`.
- **Must measure a text frame in UTF-8 bytes against `MAX_RELAY_FRAME_BYTES` before parsing it**, as the self-host `maxPayload` counts, closing 1009 past it; a binary frame is dropped. The Client cap is per account object.
- **Must keep one alarm at the earlier of the earliest held Client's `expiresAt` and, while a Burrow socket is held, the next sweep**, at most `RELAY_ROOM_SWEEP_MS` (an hour) away. Each alarm closes every expired Client 1008 `unauthorized`, its Burrow told `client-gone`; then reads every held Burrow's row in one query and closes each removed or another account's 4001 (`WS_CLOSE_BURROW_REVOKED`) and each de-entitled 4002 (`WS_CLOSE_BURROW_NOT_ENTITLED`), its Clients told `burrow-gone`; then re-arms, or clears while nothing is held. An upgrade only brings the alarm earlier and a close leaves it. It replaces the self-host expiry and revocation sweeps.
- **Must answer `RELAY_PING` with `RELAY_PONG` as the object's auto-response**, which never wakes it, reaches no handler, and is never forwarded. **A socket whose last auto-response is older than `RELAY_IDLE_TIMEOUT_MS` is gone**, retired with 1001; a socket that never pinged is never judged. It replaces the self-host heartbeat. Two gaps are accepted: a Burrow that never pings is never judged, since every build that can enroll with Hosted pings; and at the Client cap a backgrounded Pocket, its pings paused, counts as gone once silent that long — the cap is far above real use, and the Burrow reaps its session at 120 s anyway.
- **Must close a removed Burrow's socket from the account Worker's `DELETE /api/relay/burrows/:burrowId`**, through its `RELAY_ROOM` binding (`script_name` the relay) calling `closeBurrow`: 4001, its Clients `burrow-gone`. **Must answer 204 once the row is gone, even if the close fails**, logging it; the sweep closes the socket. `GET /api/burrows` reads `online` through account-scoped `onlineBurrows`. **Never expose either RPC or `RelayRows` as a public endpoint.**

Known gap: sweep-read failures violate the revocation bound; see
`docs/specs/security-hosted.md` -> "Relay boundary".

Source of truth: `relaySocketRoutes` in `hosted/server/relay-sockets.ts`; `relayRoom` / `RELAY_ROOM_PARAMS` / `RELAY_ROOM_SWEEP_MS` / `RELAY_ROW_READ_TIMEOUT_MS` in `hosted/server/relay-room-contract.ts`; `RelayRoom` in `hosted/server/relay-room.ts`; `RelayRows` in `hosted/server/relay-rows.ts`; `forwardUpgrade` / `refuseSocket` in `hosted/server/socket-room.ts`; `relayAccountRoutes` in `hosted/server/relay-account.ts`; `exceedsRelayFrameBytes` in `remote-lib-common/src/remote/relay-routing.ts`; `durable_objects` and `migrations` in `hosted/wrangler.relay.jsonc` and `hosted/wrangler.jsonc`. Pinned by `hosted/server/tests/relay-room.test.ts`, which also runs the routing cases every Relay passes (`remote-lib-common/test/harness/relay-parity.mjs`), and `hosted/server/tests/workers.test.ts`.

## Burrow enrollment

A Burrow joins an account by device code, in place of the self-host setup password. The account owns the Burrow; the Burrow's own ACL still authorizes every Client. The relay serves the Burrow's two routes, the account the rest; wire types are `BurrowEnrollBeginResponse` / `BurrowEnrollPollResponse` in `remote-lib-common/src/remote/wire.ts`. The desktop's side is `docs/specs/relay.md` -> "Burrow side".

1. The Burrow sends `{ origin }` to `POST /api/burrow/enroll/begin`. Another origin, or none, is the self-host 409 `ORIGIN_MISMATCH_ERROR`. The answer: `deviceCode`, `userCode` (`XXXX-XXXX`), `verificationUrl` (`ACCOUNT_ORIGIN/enroll#<userCode>`, absent without `ACCOUNT_ORIGIN`), `expiresAt` (`ENROLLMENT_TTL_MS`, 10 minutes), and `interval` (5 seconds).
2. The user opens the link, signs in, compares the code, and approves, writing the approval `{ userCode, userId, expiresAt }`.
3. The Burrow polls `POST /api/burrow/enroll/poll` with `{ deviceCode }` every `interval`: `expired` for a malformed or expired code; `pending` while no live approval holds its user code; `enrolled` with the self-host `BurrowEnrollResponse`, `origin` the relay's `APP_ORIGIN` and `rpId` its hostname, without `requireUserVerification`; or `redeemed` with the `burrowId` an earlier poll enrolled, until the approval expires, so the Burrow can name what the account must remove. 403 `NOT_ENTITLED_ERROR` when the approver is no longer entitled; 409 naming `ACCOUNT_ORIGIN/account` at `MAX_ENROLLED_BURROWS` Burrows. Both refusals keep the approval, so a later poll can enroll.

- **Never write from begin.** The device code is 32 bytes, the bearer shape: a 4-byte big-endian expiry in epoch seconds, then 28 random bytes. The user code is `enrollUserCode`: `HMAC-SHA-256(RELAY_ENROLL_SECRET, deviceCode)` read five bits at a time into `ENROLL_USER_CODE_ALPHABET`, values past it skipped (rationale).
- **Must store the approval alone** (`dormouse_relay_enrollment_approvals`; its redeemed columns in `004_relay_enrollment_redeemed.sql`): it cannot tell an issued code from any well-formed one, so it approves any; one no Burrow redeems expires (rationale).
- **Never admit a begin or poll request carrying `Origin`** (403): only a Node Burrow calls them. Then 429 with `Retry-After` past `RELAY_ENROLL_BEGIN_LIMIT` (10 a minute per address) or `RELAY_ENROLL_POLL_LIMIT` (60), before the body limit and any database read.
- **Must answer an expired device code from the code alone**, reading no database.
- **Must redeem in one statement**: the poll recomputes the user code, marks its live unredeemed approval with `redeemedBurrowId` and `redeemedAt`, and inserts the Burrow owned by the approval's `userId`, under the account's lock with the cap check, so two polls mint one Burrow. The entitlement is rechecked first.
- **Must keep a redeemed approval until it expires**, swept hourly, so a poll whose `enrolled` answer was lost reads `redeemed`. **Never key it to the Burrow**: removing that Burrow leaves it redeemed; only an approval after it expires replaces it.

| Route (account) | Credential | Success |
|---|---|---|
| `POST /api/relay/enrollments/approve` | login cookie, exact `Origin`, JSON `{ userCode }` | 204 |
| `GET /api/relay/burrows` | login cookie | 200 `{ burrows: [{ burrowId, enrolledAt }] }` |
| `DELETE /api/relay/burrows/:burrowId` | login cookie, exact `Origin` | 204; 404 for another account's or an unknown ID |

Errors are the managed-voice cookie routes' ("Managed voice"), except that 403 for any account but the admin carries `NOT_ENTITLED_ERROR`.

- **Must refuse approval from a login older than `LOGIN_FRESH_AGE_MS`**, 403 `RECENT_LOGIN_REQUIRED`, reading `get-session`'s `createdAt` in that route alone and failing closed when it is missing or unparsable; the gate the voice routes share never reads it.
- **Must count every approval attempt** against `RELAY_APPROVE_LIMIT` (10 a minute per account) before reading the body: 429 with `Retry-After` past it.
- **Must answer a malformed code 400**, forgiving case, spaces, and dashes, and a second approval of a live code 409 `ALREADY_APPROVED`, whichever account sends it: a live approval never moves. An expired one is replaced.
- **Must remove by deleting the Burrow's row**, its setup tokens and setup challenges cascading, so `burrowByToken` finds nothing on any relay route, **then close its live socket** ("Relay sockets").
- **Must take the `/enroll` fragment before render and erase it from history**, as `/connect/` does, and hold the code in memory only: through email sign-in and back, never into storage. A fragment change on `/enroll` takes the new code without reloading; elsewhere it does nothing. Provider sign-in leaves the page, so the user opens the link again.

Known gaps: approval buffers bodies before auth/rate gates; poll expiry and
entitlement checks precede the account lock; racing last-slot polls can answer
capacity before redeemed status. Stale approval completion can clear a newer link.

The page shows the code in the user-code role with "Approve only if Dormouse on your computer is showing this code right now." and offers Approve only within the recent-login window, Sign in again otherwise. The account page's Computers section lists each Burrow by its ID's first eight characters and enrollment date (the Relay keeps no name), with Remove.

Source of truth: `relayApiRoutes` in `hosted/server/relay-api.ts`; `relayAccountRoutes` in `hosted/server/relay-account.ts`; `cookieAdmin` in `hosted/server/account-gate.ts`; `ENROLLMENT_TTL_MS` / `RECENT_LOGIN_WINDOW` in `hosted/server/policy-constants.ts`; `takeEnrollment` in `hosted/src/enrollment.ts`; `App` in `hosted/src/App.tsx`; `enrollUserCode` in `remote-lib-common/src/remote/enroll-code.ts`; `MAX_ENROLLED_BURROWS` in `remote-lib-common/src/remote/relay-common.ts`; `relayBindings` in `hosted/server/bindings.ts`; `ratelimits` and `ACCOUNT_ORIGIN` in `hosted/wrangler.relay.jsonc` and `hosted/wrangler.jsonc`; `previewConfigs` in `hosted/scripts/preview.mjs`. Pinned by `hosted/server/tests/relay.test.ts`, `hosted/server/tests/workers.test.ts`, `hosted/server/tests/pocket.test.ts`, `hosted/server/tests/boundary.test.ts`, and `remote-lib-common/test/wire.test.mjs`.

## Development and release

**Must run local development with `dor tool hosted` inside Dormouse.** A single `http://localhost:<port>` origin, bound to loopback on an OS-assigned port unless `PORT` pins one, serves Vite and Node auth, with a disposable development database, and the voice token and Relay account routes but never speak, which every Hosted build reaches only at `https://voice.dormouse.sh`. Host, Origin, and Fetch Metadata checks guard the local captured-email inbox; no production entry imports an inbox or test-control handler. `dor tool one-time` runs the relay Worker on loopback without a database, so its Relay routes answer 503 (`docs/specs/one-time.md` -> "Dev loop").

**Must verify the three production Worker bundles and run the consumer's integration suite before release.** Root `pnpm test` runs the `hosted/scripts/*.test.mjs` deploy suites and `test:miniflare`, the Docker-free suites (the rendezvous, Pocket's serving, the three Workers' boundary, and push egress); the rest of `pnpm test:hosted`'s vitest half runs only there, `workers.test.ts`, `relay.test.ts`, and `relay-room.test.ts` needing Docker. Only test entries inject deterministic Better Auth. Simulated callbacks do not certify provider registrations; production acceptance requires real browser login with each enabled provider and email delivery.

**Must keep production, test, and preview databases and credentials separate.** The development and preview entries are email-only. Production configuration and operator steps live in `hosted/README.md`.

Source of truth: `allowedDevRequest` in `hosted/server/dev-host-guard.ts`; `hosted/server/dev.ts`; `hosted/server/tests/workers.test.ts`; `build` in `hosted/package.json`. Pinned by `the local development entry serves no speak` in `hosted/server/tests/boundary.test.ts`.

## PR previews

**Must deploy only verified same-repository PR merge revisions touching Hosted or its shared build inputs.** Drafts qualify; forks receive no deployment credentials. Changed paths include rename sources and all API pages. Deployment runs serialize per PR without cancellation; close/merge cleanup ignores path filtering and tolerates absent resources.

**Must isolate each PR in three persistent workers.dev Workers (`dormouse-{hosted,relay,voice}-pr-N`), one uncached Hyperdrive all three share, and a Neon branch from an empty dedicated preview project**, all reused until close. Preview configs exclude production routes, triggers, and credentials; runtime bindings cannot enable OAuth, Postmark, or ElevenLabs. **Must give each relay preview its own Durable Object namespaces, the account preview's `RELAY_ROOM` binding its relay preview's, each preview preview-only rate-limit namespaces, and the relay preview an `ACCOUNT_ORIGIN` naming its account preview**, and delete every preview Worker with `force`. A preview's secrets derive from `PREVIEW_AUTH_SECRET` and its Worker's name (`previewSecrets`): the account's `AUTH_SECRET` and the relay's `RELAY_ENROLL_SECRET` are their HMAC, and the relay's VAPID scalar the HMAC of `<name>/vapid` (`previewVapidKeys`), so its subscriptions survive the PR's redeploys. The smoke checks what production's does ("Production releases"), with the captured-mail login in place of providers, retrying each part on its own.

**Must run cleanup from the base branch's checkout, never the closed PR's.**

**Must capture preview mail in Postgres and expose escaped text only.** The public inbox shows the newest 100 messages from the last 24 hours, prunes expired rows on capture, and accepts only the preview's configured origin. No test clock is deployed. Preview data is disposable; it is not access-controlled.

Source of truth: `touchesHosted` in `hosted/scripts/changed.mjs`; `.github/workflows/hosted-preview.yml`; `previewConfig` / `previewSecrets` / `previewVapidKeys` / `prepare` / `cleanup` in `hosted/scripts/preview.mjs`; `smokeAll` in `hosted/scripts/preview-smoke.mjs`; `postgresInbox` in `hosted/server/preview-inbox.ts`; `hosted/server/preview-worker.ts`; `hosted/server/voice-preview-worker.ts`. Pinned by `hosted/scripts/preview.test.mjs`, `hosted/scripts/changed.test.mjs`, and `hosted/server/tests/workers.test.ts`.

## Production releases

**Must deploy only manually selected main revisions after Hosted tests/build and accepted clean package provenance.** `verifyPackages` checks both installed packages' clean, matching provenance; `productionConfig` holds each config to its Worker's pinned name and origin and lone custom domain, and the relay's `ACCOUNT_ORIGIN` to the account's origin; preflight checks uncached Hyperdrive, matching migration/runtime database identity with distinct roles, and each Worker's own secret names (the voice's is `ELEVENLABS_API_KEY`, the relay's `RELAY_ENROLL_SECRET` and its VAPID pair) — names only, as Cloudflare exposes no value. Back up, encrypt, decrypt, and restore-test before applying migrations; upload only the encrypted archive. Deploy relay, voice, then account, stopping at a failure; the relay must pass its revision check, push config, and `oneTimeSmoke` before the next deploy (rationale). Production has no public candidate URL.

**Must only append Durable Object migrations**: a deployed tag is never edited or removed, and Cloudflare refuses a rollback across one, so each is a rollback floor. Migration inventories: `migrations` in the account and relay Wrangler configs. A deploy restarts every room, dropping links still waiting or mid-handshake, and every relay socket, which its end reconnects; a session already on its direct path never touches Hosted. Live verification checks each Worker's revision and, once the relay's passes, requires its `/api/push/config` to answer a key (`pushConfigSmoke`: both VAPID secrets set, as one pair) and runs `oneTimeSmoke` on it, whatever the account's outcome; a failed smoke reports every failed part.

**Must bound retries.** Health GETs require the selected revision, sharing six five-second retries for transport failures or healthy stale revisions. Retry rate-limited OAuth once; never replay POSTs after transport failures. Production repeats only the relay and voice smokes, up to six times 10 s apart (rationale).

**Must record an immutable annotated hosted/YYYY-MM-DD tag only after live verification.** Tags identify the deployed commit and verification run/attempt; retries are idempotent and redeployments get new tags. Dating and repeat-deployment suffixes: `recordDeployment`. Code rollback never reverses migrations.

Source of truth: `.github/workflows/hosted-production.yml`; `productionConfig` / `verifyPackages` / `preflight` / `productionSmoke` in `hosted/scripts/production.mjs`; `WORKERS` / `deployWorkers` in `hosted/scripts/workers.mjs`; `hosted/scripts/production-backup.mjs`; `smokeRequest` / `healthSmoke` / `pushConfigSmoke` / `smokeAll` in `hosted/scripts/preview-smoke.mjs`; `oneTimeSmoke` in `hosted/scripts/one-time-smoke.mjs`; `recordDeployment` in `hosted/scripts/production-tag.mjs`. Pinned by `hosted/scripts/production.test.mjs`, `hosted/scripts/smoke-request.test.mjs`, and `hosted/scripts/production-tag.test.mjs`.

## Future

1. Deploy the configured providers and pass real production acceptance. pgstencil includes the Microsoft fix; personal and work/school callbacks need acceptance.
2. Add per-browser login listing/revocation, sign-out-everywhere, and account recovery before broad paid use. Revisit the fixed 24-hour login lifetime for daily voice use.
3. Managed voice beyond the admin slice: a real entitlement or licence replacing `ADMIN_EMAIL`, credentials scoped for non-admin accounts, per-account quotas, usage accounting, and spending bounds beyond the fixed daily cap, and explicit text/redaction disclosure.
