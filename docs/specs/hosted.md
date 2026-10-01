# Dormouse Hosted accounts

> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the Hosted account application, the Hosted Relay's account-scoped routes, and the deployment of Hosted's three Workers. The one-time rendezvous the relay Worker serves belongs to `docs/specs/one-time.md` -> "Hosted rendezvous"; the Relay's shared route semantics to `docs/specs/relay.md` -> "HTTP API"; remote authorization to `docs/specs/remote-security-model.md`.

## Application boundary

**Must serve Hosted as three Workers from `hosted/`, one origin each:**

| Worker | Origin | Serves | Holds |
|---|---|---|---|
| `dormouse-hosted` | `https://hosted.dormouse.sh` | the account frontend, `/api/auth/*`, `/api/providers`, `/api/ready`, voice tokens | the login cookie, auth secrets, Hyperdrive |
| `dormouse-relay` | `https://relay.dormouse.sh` | the Hosted Relay and Pocket ("Relay"), the one-time rendezvous and `/connect/` (`docs/specs/one-time.md` -> "Hosted rendezvous") | Hyperdrive, `OneTimeRoom`, the one-time, sign-in, and setup rate limits |
| `dormouse-voice` | `https://voice.dormouse.sh` | speak and the history sweep ("Managed voice") | `ELEVENLABS_API_KEY`, Hyperdrive |

Every Worker answers `/api/health`, 404s anything else under its non-page prefixes (`/api`, and the relay's `/ws` too), `/dev/*`, or `/__test/*`, and answers a thrown request 503 under `secureHeaders`. The account falls back to its SPA assets, the relay to Pocket's. The 421 origin gate, each Worker's bindings mapper, and the cookie routes' exact-`Origin` check are `docs/specs/security-hosted.md` -> "Origin boundary" (rationale).

Marketing is a separate bundle and deployment. `remote-lib-common` is compiled in from source through `hosted/tsconfig.json` `paths`, which every esbuild bundle and Wrangler honor.

**Must run committed Better Auth migrations before deploying code that needs them, never during a Worker request.** Postgres is reached through an uncached Hyperdrive binding. The runtime creates and closes its database pool within each request.

**Must install released core/auth packages from npm and commit their lockfile integrity hashes.** The installed packages' `dist/provenance.json` must name the same clean pgstencil commit; no runtime import depends on a sibling checkout. The auth migrations remain owned by the package; Dormouse's own tables migrate from `hosted/server/dormouse-migrations/`.

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

**Must show configured sign-in methods only.** Email has send, existing-code, verify, resend, and change-address paths. The account screen lists connected methods and explains recent-login requirements and provider-only recovery limits. Failed callbacks display a recoverable error and remove query parameters from browser history.

**Must check the account on return to the page and serialize submitted actions.** Authenticated data remains in memory; login tokens never enter local storage. Only public identity fields are rendered, without provider images or external assets. The Voice tokens section renders only when `GET /api/voice/tokens` succeeds, and its failure never fails the account page; a minted token stays in memory and is shown once.

**Must inherit Dormouse product theme tokens before mounting React.** The OS light/dark preference selects bundled Light Visual Studio or Kimbie Dark. Its type scale and touch sizing are in `hosted/src/style.css`. It loads no marketing styles, fonts, or analytics.

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

Source of truth: `isAdmin` in `hosted/server/admin.ts`; `voiceTokenRoutes` / `speakRoute` / `elevenLabs` / `sweepOnCron` / `sweepAfterSpeech` in `hosted/server/voice.ts`; `scheduled` in `hosted/server/voice-app.ts` and `hosted/server/worker-app.ts`; `triggers` in `hosted/wrangler.voice.jsonc`; `hosted/server/dormouse-migrations/001_voice_tokens.sql`; `preflight` in `hosted/scripts/production.mjs`. Pinned by `hosted/server/tests/workers.test.ts`, `hosted/server/tests/boundary.test.ts`, `hosted/scripts/production.test.mjs`, and `hosted/scripts/preview.test.mjs`.

## Relay

The relay Worker serves the self-host Relay's HTTP API to many accounts: the paths, shapes, statuses, and error strings of `docs/specs/relay.md` -> "HTTP API", "Setup tokens and the pairing QR", and "WebAuthn without a WebAuthn library", so a Burrow and Pocket cannot tell the two apart; both run the checks and bounds in `remote-lib-common/src/remote/relay-common.ts`. Assertions demand presence, not verification. Security checks: `docs/specs/security-hosted.md` -> "Relay boundary". Only the differences:

| Route | On Hosted |
|---|---|
| `POST /api/setup/begin`, `/finish` | The passkey joins the account owning the token's Burrow: `accountId` is its user ID, `existingCredentialIds` its passkeys; 409 at `MAX_PASSKEYS_PER_ACCOUNT` |
| `POST /api/setup/retire` | Spends only a token one of the session's account's Burrows minted |
| `POST /api/signin/finish` | The asserted credential's account; `accountId` is its user ID. 401 `NOT_ENTITLED_ERROR`, and no session, for an account not entitled |
| `POST /api/reauth/begin`, `/finish` | Only the session's account's credentials and nonces |
| `GET /api/burrows` | The session's account's unrevoked Burrows, each `online: false`: no relay socket reaches Hosted yet |
| `POST /api/burrow/setup-token` | 401 for a revoked Burrow, 403 `NOT_ENTITLED_ERROR` for an owner not entitled |
| `POST /api/burrow/enroll` | Always 401 `UNAUTHORIZED_ERROR`: Hosted has no setup password, and no route enrolls a Burrow yet (Future) |
| `GET /api/push/config` | `{ applicationServerKey: null }`: push is off; every other push route, `/ws/*`, and `GET /api/hello` (the self-host installers' probe) are 404 |
| `GET /*` | Pocket (below) |

A session-gated route answers a session of an account no longer entitled with the expired session's 401 `UNAUTHORIZED_ERROR`, so Pocket returns to sign-in.

- **Must keep the Relay's state in Postgres** (`hosted/server/dormouse-migrations/002_relay.sql`). A sign-in challenge is the challenge row with no Burrow.
- **Must resolve each bearer and its owner's entitlement in one query joining `"user"`** (`sessionByToken`, `burrowByToken`). The entitlement is `isAdmin` ("Managed voice"). Reserved: the relay socket upgrades (Future item 4) call the same lookups with the query-parameter token.
- **Must cap every table a caller grows, keyed by whoever grows it**, as `docs/specs/relay.md` -> "Guardrails" does: setup tokens and setup challenges per Burrow (`MAX_TOKENS_PER_BURROW`), presence nonces per session (`MAX_PENDING_REAUTH_NONCES_PER_SESSION`), and sessions per account (`MAX_SESSIONS_PER_ACCOUNT`), each evicting its key's own oldest; passkeys per account are refused at the cap (rationale). A capped insert runs under its key's advisory lock and, in one statement, prunes that key's own expired rows, trims its live rows, and inserts; it never touches another key's rows.
- **Must sweep every Relay table's expired rows from the relay's hourly Cron Trigger** (rationale); sign-in challenges, minted unauthenticated and flat, are bounded by it and the per-address limit.
- **Must answer 429 with `Retry-After` past the per-address limit on `signin/*` (`RELAY_SIGNIN_LIMIT`) and `setup/begin`/`finish` (`RELAY_SETUP_LIMIT`)**, before the body limit and any database read: 30 a minute, a ceremony's two routes sharing one budget (rationale).
- **Must restore a token a refused `finish` spent on its original expiry, within the Burrow's cap, and never once that expiry has passed.**

**Pocket at the root.** `build` stages `lib/dist-pocket` at the root of the relay's assets and the one-time page beside it, checking both shells. Pocket is served per `docs/specs/pocket-app.md` -> "Serving the built bundle", except that a path naming no file (no extension, outside `/diagnostics`) gets the shell in one asset fetch.

Source of truth: `relayApiRoutes` / `sweepExpired` in `hosted/server/relay-api.ts`; `sessionByToken` / `burrowByToken` / `requireSession` / `requireBurrow` in `hosted/server/relay-auth.ts`; `hosted/server/dormouse-migrations/002_relay.sql`; `triggers` and `ratelimits` in `hosted/wrangler.relay.jsonc`; `pocketRoutes` in `hosted/server/pocket.ts`; `relayRules` / `relayPathKind` in `hosted/server/headers.ts`; `stageRelay` in `hosted/scripts/stage-relay.mjs`; `checkRegistration` / `verifySigninAssertion` in `remote-lib-common/src/remote/relay-common.ts`. Pinned by `hosted/server/tests/relay.test.ts`, `hosted/server/tests/pocket.test.ts`, `hosted/server/tests/boundary.test.ts`, `hosted/scripts/stage-relay.test.mjs`, and `remote-lib-common/test/relay-common.test.mjs`.

## Development and release

**Must run local development with `dor tool hosted` inside Dormouse.** A single `http://localhost:<port>` origin, bound to loopback on an OS-assigned port unless `PORT` pins one, serves Vite and Node auth, with a disposable development database, and the voice token routes but never speak, which every Hosted build reaches only at `https://voice.dormouse.sh`. Host, Origin, and Fetch Metadata checks guard the local captured-email inbox; no production entry imports an inbox or test-control handler. `dor tool one-time` runs the relay Worker on loopback without a database, so its Relay routes answer 503 (`docs/specs/one-time.md` -> "Dev loop").

**Must verify the three production Worker bundles and run the consumer's integration suite before release.** Root `pnpm test` runs the `hosted/scripts/*.test.mjs` deploy suites and `test:miniflare`, the Docker-free Miniflare suites (the rendezvous, Pocket's serving, and the three Workers' boundary); the rest of `pnpm test:hosted`'s vitest half runs only there, `workers.test.ts` and `relay.test.ts` needing Docker. The test entry alone injects the packed Better Auth deterministic module. Simulated callbacks do not certify provider registrations; production acceptance requires real browser login with each enabled provider and email delivery.

**Must keep production, test, and preview databases and credentials separate.** The development and preview entries are email-only. Production configuration and operator steps live in `hosted/README.md`.

Source of truth: `allowedDevRequest` in `hosted/server/dev-host-guard.ts`; `hosted/server/dev.ts`; `hosted/server/tests/workers.test.ts`; `build` in `hosted/package.json`. Pinned by `the local development entry serves no speak` in `hosted/server/tests/boundary.test.ts`.

## PR previews

**Must deploy only verified same-repository PR merge revisions touching Hosted or its shared build inputs.** Drafts qualify; forks receive no deployment credentials. Changed paths include rename sources and all API pages. Deployment runs serialize per PR without cancellation; close/merge cleanup ignores path filtering and tolerates absent resources.

**Must isolate each PR in three persistent workers.dev Workers (`dormouse-{hosted,relay,voice}-pr-N`), one uncached Hyperdrive all three share, and a Neon branch from an empty dedicated preview project**, all reused until close. Preview configs exclude production routes, triggers, and credentials; runtime bindings cannot enable OAuth, Postmark, or ElevenLabs. **Must give each relay preview its own Durable Object namespace and preview-only rate-limit namespaces**, and delete every preview Worker with `force`. The smoke checks what production's does ("Production releases"), with the captured-mail login in place of providers, retrying each part on its own.

**Must run cleanup from the base branch's checkout, never the closed PR's.**

**Must capture preview mail in Postgres and expose escaped text only.** The public inbox shows the newest 100 messages from the last 24 hours, prunes expired rows on capture, and accepts only the preview's configured origin. No test clock is deployed. Preview data is disposable; it is not access-controlled.

Source of truth: `touchesHosted` in `hosted/scripts/changed.mjs`; `.github/workflows/hosted-preview.yml`; `previewConfig` / `prepare` / `cleanup` in `hosted/scripts/preview.mjs`; `smokeAll` in `hosted/scripts/preview-smoke.mjs`; `postgresInbox` in `hosted/server/preview-inbox.ts`; `hosted/server/preview-worker.ts`; `hosted/server/voice-preview-worker.ts`. Pinned by `hosted/scripts/preview.test.mjs`, `hosted/scripts/changed.test.mjs`, and `hosted/server/tests/workers.test.ts`.

## Production releases

**Must deploy only manually selected main revisions after Hosted tests/build and accepted clean package provenance.** `verifyPackages` checks both installed packages' clean, matching provenance; `productionConfig` holds each config to its Worker's pinned name and origin and lone custom domain; preflight checks uncached Hyperdrive, matching migration/runtime database identity with distinct roles, and each Worker's own secret names (the voice's is `ELEVENLABS_API_KEY`; the relay has none). Back up, encrypt, decrypt, and restore-test before applying migrations; upload only the encrypted archive. Deploy relay, voice, then account, stopping at a failure; the relay must pass its revision check and `oneTimeSmoke` before the next deploy (rationale). Production has no public candidate URL.

**Must only append Durable Object migrations**: a deployed tag is never edited or removed, and Cloudflare refuses a rollback across one, so each is a rollback floor. The account keeps the `v1` that created `OneTimeRoom` and appends `v2` deleting it; the relay starts its own `v1`. A deploy restarts every room, dropping links still waiting or mid-handshake; a session already on its direct path never touches Hosted. Live verification checks each Worker's revision and runs `oneTimeSmoke` on the relay once the relay's revision check passes, whatever the account's outcome; a failed smoke reports every failed part.

**Must bound retries.** Health GETs require the selected revision, sharing six five-second retries for transport failures or healthy stale revisions. Retry rate-limited OAuth once; never replay POSTs after transport failures. Production repeats only the relay and voice smokes, up to six times 10 s apart (rationale).

**Must record an immutable annotated hosted/YYYY-MM-DD tag only after live verification.** Tags identify the deployed commit and verification run/attempt; retries are idempotent and redeployments get new tags. Dating and repeat-deployment suffixes: `recordDeployment`. Code rollback never reverses migrations.

Source of truth: `.github/workflows/hosted-production.yml`; `productionConfig` / `verifyPackages` / `preflight` / `deployProduction` / `productionSmoke` in `hosted/scripts/production.mjs`; `WORKERS` / `deployWorkers` in `hosted/scripts/workers.mjs`; `hosted/scripts/production-backup.mjs`; `smokeRequest` / `healthSmoke` / `relaySmoke` / `smokeAll` in `hosted/scripts/preview-smoke.mjs`; `oneTimeSmoke` in `hosted/scripts/one-time-smoke.mjs`; `recordDeployment` in `hosted/scripts/production-tag.mjs`. Pinned by `hosted/scripts/production.test.mjs`, `hosted/scripts/smoke-request.test.mjs`, and `hosted/scripts/production-tag.test.mjs`.

## Future

1. Deploy the configured providers and pass real production acceptance. pgstencil includes the Microsoft fix; personal and work/school callbacks need acceptance.
2. Add per-browser login listing/revocation, sign-out-everywhere, and account recovery before broad paid use. Revisit the fixed 24-hour login lifetime for daily voice use.
3. Managed voice beyond the admin slice: a real entitlement or licence replacing `ADMIN_EMAIL`, credentials scoped for non-admin accounts, per-account quotas, usage accounting, and spending bounds beyond the fixed daily cap, and explicit text/redaction disclosure.
4. Hosted Relay beyond "Relay": Burrow enrollment, relay sockets and `online`, and push — **saas-multitenant** in `docs/specs/relay.md` and **remote-network** in `docs/specs/remote-network.md`. Account login never replaces Burrow pairing and authorization. Paid security claims require independent review.
