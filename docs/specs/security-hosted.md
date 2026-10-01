# Hosted account security

> See `docs/specs/glossary.md` for Burrow, Client, and Relay vocabulary.
> Owns the security checks of Hosted's three Workers, account, relay, and voice. Defers identity behavior and the Worker split to `docs/specs/hosted.md` and terminal access to `docs/specs/remote-security-model.md`.
> Read `docs/specs/security.md` first; provisioning and real-provider acceptance are pending.

## Origin boundary

- **FAIL IF** a Worker routes a request whose URL origin is not its own `APP_ORIGIN`, a sibling's included, rather than answering 421; inspect `workerApp` in `hosted/server/worker-app.ts`.
- **FAIL IF** a cookie route admits any `Origin` but its own exactly, sibling origins under `dormouse.sh` included — they are same-site, so the browser sends them the `SameSite=Lax` login cookie — or a state-changing auth request skips the CSRF check, or any Worker grants credentialed CORS; inspect `voiceTokenRoutes` in `hosted/server/voice.ts` and the packed adapter.
- **FAIL IF** the relay or voice Worker's bindings mapper passes an auth secret (`AUTH_SECRET`, a provider credential, or `POSTMARK_SERVER_TOKEN`), the account's or relay's passes `ELEVENLABS_API_KEY`, or the relay or voice entry imports Better Auth; inspect `hosted/server/bindings.ts` and each entry's import graph.
- **FAIL IF** authentication cookies have a Domain attribute, lack `__Host-`, Secure, HttpOnly, or Path=/ in HTTPS, or session tokens appear in browser JSON or persistent browser storage; inspect the adapter and `hosted/src/api.ts`.
- **FAIL IF** the account origin's policy permits third-party scripts, framing, inline script execution, or any worker (`worker-src 'none'`); a voice response, or a relay response under `/api/` or `/ws/`, carries any policy but `RUNS_NOTHING_POLICY`; any response but a 101 WebSocket upgrade bypasses `secureHeaders`, a misconfigured deployment's error included; or a response is cached past its class: immutable only for a content-hashed file under the account's `/assets/` or the relay's `/assets/` and `/connect/assets/`, `no-cache` only on Pocket's other paths, `no-store` everywhere else, the account's SPA shell included. Inspect `secureHeaders` / `ACCOUNT_HASHED_ASSETS` / `RELAY_HASHED_ASSETS` / `isPocketPath` in `hosted/server/headers.ts`, binding resolution in `hosted/server/worker-app.ts`, and asset routing in `hosted/wrangler.jsonc` and `hosted/wrangler.relay.jsonc`.
- **FAIL IF** marketing scripts, analytics, provider avatars, or remote fonts enter the Hosted frontend; inspect the frontend import graph and deployed response when available.

Pinned by `hosted/server/tests/boundary.test.ts`, `hosted/server/tests/workers.test.ts`, and `hosted/server/tests/one-time.test.ts`.

## Account boundary

- **FAIL IF** the consumer changes `authPolicy` away from explicit linking or multiple independent logins, or accepts an explicit connection callback after its initiating login was revoked; inspect `hosted/server/policy.ts` and the packed adapter.
- **FAIL IF** an unused provider credential enables login, an unknown provider name is accepted, or incomplete enabled credentials silently degrade; inspect `providerBindings` in `hosted/server/policy.ts`.
- **FAIL IF** a managed-voice route admits any account but the verified `ADMIN_EMAIL` without rechecking per request, stores a voice token other than as its SHA-256, logs speak text, forwards an ElevenLabs body or status, or lets a binding or request field choose the upstream URL; inspect `hosted/server/admin.ts` and `hosted/server/voice.ts`.
- **FAIL IF** Hosted account login mints a Burrow ACL grant or substitutes for the existing encrypted pairing/presence proof. The one-time rendezvous carries only handshake ciphertext and authorizes nothing; the ends' handshake and the laptop's confirmation do.

Pinned by `hosted/server/tests/workers.test.ts` and `hosted/server/tests/policy.test.ts`.

## Rendezvous boundary

**The one-time room is a counter with two sockets** on the relay Worker: `docs/specs/one-time.md` -> "Hosted rendezvous" owns its routes and lifecycle, and "Phone page" the page beside them; these are the checks on them.

- **FAIL IF** `OneTimeRoom` in `hosted/server/one-time-room.ts` parses, decodes, stores, or logs a forwarded frame; it bounds one by raw length and count alone. `scripts/e2e-lint.mjs` holds it textually.
- **FAIL IF** a binary frame, one longer than `MAX_ONE_TIME_FRAME_LENGTH`, or one past `MAX_ONE_TIME_FORWARDED` is forwarded rather than closing both ends with 4015, the count omits a frame the room received, or either bound is redeclared rather than imported from `remote-lib-common`.
- **FAIL IF** a second phone can join: the join must read and set `joined` with no await between, in the Burrow socket's hibernation attachment rather than memory.
- **FAIL IF** a room can outlive `expiresAt + ONE_TIME_EXPIRY_GRACE_MS`, or admit a phone after `expiresAt`: the alarm is set before the Burrow socket is accepted, and closes every socket.
- **FAIL IF** the Burrow route admits a request carrying any `Origin` header, or the client route an `Origin` other than exactly the relay's `APP_ORIGIN`; inspect `oneTimeRoutes` in `hosted/server/one-time.ts`.
- **FAIL IF** a room id comes from anything but 16 fresh random bytes the Worker mints per Burrow socket, the Burrow route takes a room from the request, or a room opens twice.
- **FAIL IF** either route reaches the room before its per-address rate limit (`cf-connecting-ip`, IPv6 by /64, IPv4-mapped IPv6 by its IPv4), or a production rate-limit `namespace_id` reaches `PREVIEW_RATELIMIT_OFFSET` in `hosted/scripts/preview.mjs`.
- **FAIL IF** a one-time route or the room reads a cookie, reaches Hyperdrive or auth, mounts ahead of the 421 gate, or hands the room any header of the caller's but the upgrade.
- **FAIL IF** the `/connect/` page's policy admits a source outside the relay `APP_ORIGIN`'s `/connect/`, a script outside `/connect/assets/`, or a connection but the client route; permits inline or off-origin script, framing, forms, or popups; or takes an `APP_ORIGIN` that is not exactly an origin. Inspect `relayPolicy` in `hosted/server/headers.ts`.
- **FAIL IF** the relay serves anything under `/connect/` but the page and its hashed assets, a missing asset gets HTML, the relay's assets hold anything but the staged page and Pocket, or a shell failing `assertPocketShell`'s one-time mode can ship; `build:one-time` in `lib/package.json` and `stageRelay` in `hosted/scripts/stage-relay.mjs` each run it. Inspect `oneTimePageRoutes` in `hosted/server/one-time.ts` and `hosted/server/relay-worker.ts`.

`scripts/e2e-lint.mjs` also holds `hosted/server/` to the Relay's absences: no protocol-v1 type, no direct-path signal or SDP, no ICE server — the page's STUN is client code (`docs/specs/security-remote.md` -> "Direct path"). Pinned by `hosted/server/tests/one-time.test.ts`, `hosted/scripts/stage-relay.test.mjs`, `lib/src/remote/pocket-app/assert-pocket-worker.test.ts`, and `hosted/scripts/production.test.mjs`.

## Relay boundary

**The Hosted Relay** on the relay Worker: `docs/specs/hosted.md` -> "Relay" owns its routes; these are the checks on them. Inspect `relayApiRoutes` in `hosted/server/relay-api.ts` and `hosted/server/dormouse-migrations/002_relay.sql`.

- **FAIL IF** a session, Burrow, or setup token or an enrollment device code is stored other than as its SHA-256, or an account's Relay rows outlive its user row.
- **FAIL IF** a query reading a Burrow, passkey, presence nonce, or setup token is not scoped to the caller's account (the session's user, or the Burrow token's owner), a passkey registers to any account but the minting Burrow's owner, or a setup challenge redeems with another Burrow's token.
- **FAIL IF** a setup token, challenge, or presence nonce is checked and spent in separate statements, so two concurrent redeemers can both win, or a restored setup token outlives its original expiry.
- **FAIL IF** a Burrow-authenticated request or setup redemption skips rechecking the owner's entitlement (`isAdmin` on its user row) in that request, or a revoked Burrow's bearer or setup tokens still act.
- **FAIL IF** a table a caller can grow has no cap keyed by whoever grows it; `signin/begin` reaches the database before its per-address limit; or a production `RELAY_SIGNIN_LIMIT` `namespace_id` reaches `PREVIEW_RATELIMIT_OFFSET`.
- **FAIL IF** the relay Worker reads a cookie, asks auth, or reads a user column but the entitlement's; inspect the relay bundle's imports.
- **FAIL IF** a Pocket path's response lacks Pocket's policy (`pocketContentSecurityPolicy` in `remote-lib-common/src/remote/relay-common.ts`, taken only from an `APP_ORIGIN` that is exactly an origin), or any response but a Pocket path's allows the camera, `/connect/` included; inspect `relayPolicy` / `relayPermissions` in `hosted/server/headers.ts`.

Pinned by `hosted/server/tests/relay.test.ts`, `hosted/server/tests/pocket.test.ts`, and `hosted/server/tests/boundary.test.ts`.

## Deployment boundary

**Must depend on a released pgstencil** whose installed `dist/provenance.json` names a commit on pgstencil `main` with a passing `security-audit`. The core and auth packages must name the same clean commit.

- **FAIL IF** a production Worker exposes the captured-email inbox or deterministic clock controls, or imports the testing injection module; inspect `hosted/server/worker.ts`, `hosted/server/relay-worker.ts`, `hosted/server/voice-worker.ts`, the build configuration, and `hosted/server/tests/worker-entry.ts`.
- **FAIL IF** either installed pgstencil package lacks `dist/provenance.json`, records `dirty`, or names a different commit; `pnpm-lock.yaml` resolves either package from outside npm; or a runtime import depends on a sibling pgstencil checkout. Inspect `verifyPackages` in `hosted/scripts/production.mjs`, `hosted/server/tests/artifacts.test.ts`, and Hosted runtime imports.
- **FAIL IF** either installed package lacks a verified npm SLSA provenance attestation whose Fulcio certificate SAN names `diffplug/pgstencil` `.github/workflows/release.yml` on `refs/heads/main`, whose source-repository digest (OID `1.3.6.1.4.1.57264.1.13`) equals `dist/provenance.json`'s commit, or whose signed subject/payload disagrees with the installed package, certificate, or commit.
- **FAIL IF** that commit is not on pgstencil `main` (`gh api repos/diffplug/pgstencil/compare/<commit>...main`, status `ahead` or `identical`), or its `security-audit` check runs (`gh api repos/diffplug/pgstencil/commits/<commit>/check-runs`) include no `success`, or any conclusion other than `success` and `cancelled`. pgstencil audits the released code; Dormouse audits only how Hosted configures it.
- **FAIL IF** the local email inbox accepts a foreign Host or Origin or cross-site Fetch Metadata; inspect `allowedDevRequest` in `hosted/server/dev-host-guard.ts`, including the upgrade guard in `hosted/server/dev.ts`.

- **FAIL IF** the production deploy can proceed without `preflight` establishing an uncached Hyperdrive, a matching migration/runtime database, distinct runtime and migration roles, and each Worker's required secrets on that Worker's own script; inspect `preflight` in `hosted/scripts/production.mjs` and its ordering ahead of the deploy step in `.github/workflows/hosted-production.yml`.
- **FAIL IF** preview mail, OAuth, or ElevenLabs calls reach external providers, a preview configuration copies production routes, bindings, or triggers, or a preview exposes deterministic time controls; inspect `hosted/server/preview-worker.ts`, `hosted/server/voice-preview-worker.ts`, `hosted/scripts/preview.mjs`, and `hosted/server/tests/workers.test.ts`.

Pinned by `hosted/server/tests/artifacts.test.ts`, `hosted/server/tests/workers.test.ts`, `hosted/server/tests/policy.test.ts`, `hosted/scripts/production.test.mjs`, `hosted/scripts/preview.test.mjs`.

## Future

**Production activation**, not checked until Hosted is provisioned: the live Hyperdrive and role values that `preflight` reads, and Cloudflare script injection excluded for the Hosted hostname (`hosted/README.md`). Checked-in placeholders prove none of them.

Public hosted voice and Relay need their own abuse, authorization, data-disclosure, and recovery checks first, and paid use an independent review of the remote model; `docs/specs/hosted.md` owns the staged work.
