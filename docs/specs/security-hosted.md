# Hosted account security

> See `docs/specs/glossary.md` for Burrow, Client, and Relay vocabulary.
> Owns the account application's security checks. Defers identity behavior to `docs/specs/hosted.md` and terminal access to `docs/specs/remote-security-model.md`.
> Read `docs/specs/security.md` first; provisioning and real-provider acceptance are pending.

## Origin boundary

- **FAIL IF** Hosted accepts a request URL outside configured `APP_ORIGIN`, grants marketing-origin credentialed CORS, or permits a state-changing auth request without exact Origin and CSRF checks; inspect `hosted/server/worker-app.ts` and the packed adapter.
- **FAIL IF** authentication cookies have a Domain attribute, lack `__Host-`, Secure, HttpOnly, or Path=/ in HTTPS, or session tokens appear in browser JSON or persistent browser storage; inspect the adapter and `hosted/src/api.ts`.
- **FAIL IF** the production HTML permits third-party scripts, framing, inline script execution, or any worker (`worker-src 'none'` origin-wide), any response but a 101 WebSocket upgrade bypasses `secureHeaders` including a misconfigured deployment's error, or anything but a content-hashed file under `/assets/` or `/connect/assets/` is cacheable, the SPA fallback's shell included; inspect `secureHeaders` in `hosted/server/headers.ts`, binding resolution in `hosted/server/worker-app.ts`, and asset routing in `hosted/wrangler.jsonc`.
- **FAIL IF** marketing scripts, analytics, provider avatars, or remote fonts enter the Hosted frontend; inspect the frontend import graph and deployed response when available.

Pinned by `hosted/server/tests/workers.test.ts`.

## Account boundary

- **FAIL IF** the consumer changes `authPolicy` away from explicit linking or multiple independent logins, or accepts an explicit connection callback after its initiating login was revoked; inspect `hosted/server/policy.ts` and the packed adapter.
- **FAIL IF** an unused provider credential enables login, an unknown provider name is accepted, or incomplete enabled credentials silently degrade; inspect `providerBindings` in `hosted/server/policy.ts`.
- **FAIL IF** Hosted account login mints a Burrow ACL grant or substitutes for the existing encrypted pairing/presence proof. The one-time rendezvous carries only handshake ciphertext and authorizes nothing; the ends' handshake and the laptop's confirmation do.

Pinned by `hosted/server/tests/workers.test.ts` and `hosted/server/tests/policy.test.ts`.

## Rendezvous boundary

**The one-time room is a counter with two sockets**: `docs/specs/one-time.md` -> "Hosted rendezvous" owns its routes and lifecycle, and "Phone page" the page beside them; these are the checks on them.

- **FAIL IF** `OneTimeRoom` in `hosted/server/one-time-room.ts` parses, decodes, stores, or logs a forwarded frame; it bounds one by raw length and count alone. `scripts/e2e-lint.mjs` holds it textually.
- **FAIL IF** a binary frame, one longer than `MAX_ONE_TIME_FRAME_LENGTH`, or one past `MAX_ONE_TIME_FORWARDED` is forwarded rather than closing both ends with 4015, the count omits a frame the room received, or either bound is redeclared rather than imported from `remote-lib-common`.
- **FAIL IF** a second phone can join: the join must read and set `joined` with no await between, in the Burrow socket's hibernation attachment rather than memory.
- **FAIL IF** a room can outlive `expiresAt + ONE_TIME_EXPIRY_GRACE_MS`, or admit a phone after `expiresAt`: the alarm is set before the Burrow socket is accepted, and closes every socket.
- **FAIL IF** the Burrow route admits a request carrying any `Origin` header, or the client route an `Origin` other than exactly `APP_ORIGIN`; inspect `oneTimeRoutes` in `hosted/server/one-time.ts`.
- **FAIL IF** a room id comes from anything but 16 fresh random bytes the Worker mints per Burrow socket, the Burrow route takes a room from the request, or a room opens twice.
- **FAIL IF** either route reaches the room before its per-address rate limit (`cf-connecting-ip`, IPv6 by /64), or a production rate-limit `namespace_id` reaches `PREVIEW_RATELIMIT_OFFSET` in `hosted/scripts/preview.mjs`.
- **FAIL IF** a one-time route or the room reads a cookie, reaches Hyperdrive or auth, mounts ahead of the 421 gate, or hands the room any header of the caller's but the upgrade.
- **FAIL IF** the `/connect/` page's policy admits a source outside `APP_ORIGIN`'s `/connect/`, a script outside `/connect/assets/`, or a connection but the client route; permits inline or off-origin script, framing, forms, or popups; or takes an `APP_ORIGIN` that is not exactly an origin. Inspect `contentSecurityPolicy` in `hosted/server/headers.ts`.
- **FAIL IF** a path under `/connect/` is served but the page and its hashed assets, a missing asset gets the SPA shell, or a shell failing `assertPocketShell`'s one-time mode can ship; `build:one-time` in `lib/package.json` and `stageOneTime` in `hosted/scripts/stage-one-time.mjs` each run it. Inspect `oneTimePageRoutes` in `hosted/server/one-time.ts`.

`scripts/e2e-lint.mjs` also holds `hosted/server/` to the Relay's absences: no protocol-v1 type, no direct-path signal or SDP, no ICE server (`docs/specs/security-remote.md` -> "Direct path"). Pinned by `hosted/server/tests/one-time.test.ts`, `hosted/scripts/stage-one-time.test.mjs`, `lib/src/remote/pocket-app/assert-pocket-worker.test.ts`, and `hosted/scripts/production.test.mjs`.

## Deployment boundary

**Must depend on a released pgstencil** whose installed `dist/provenance.json` names a commit on pgstencil `main` with a passing `security-audit`. The core and auth packages must name the same clean commit.

- **FAIL IF** a production Worker exposes the captured-email inbox or deterministic clock controls, or imports the testing injection module; inspect `hosted/server/worker.ts`, the build configuration, and `hosted/server/tests/worker-entry.ts`.
- **FAIL IF** either installed pgstencil package lacks `dist/provenance.json`, records `dirty`, or names a different commit; `pnpm-lock.yaml` resolves either package from outside npm; or a runtime import depends on a sibling pgstencil checkout. Inspect `verifyPackages` in `hosted/scripts/production.mjs`, `hosted/server/tests/artifacts.test.ts`, and Hosted runtime imports.
- **FAIL IF** either installed package lacks a verified npm SLSA provenance attestation whose Fulcio certificate SAN names `diffplug/pgstencil` `.github/workflows/release.yml` on `refs/heads/main`, whose source-repository digest (OID `1.3.6.1.4.1.57264.1.13`) equals `dist/provenance.json`'s commit, or whose signed subject/payload disagrees with the installed package, certificate, or commit.
- **FAIL IF** that commit is not on pgstencil `main` (`gh api repos/diffplug/pgstencil/compare/<commit>...main`, status `ahead` or `identical`), or its `security-audit` check runs (`gh api repos/diffplug/pgstencil/commits/<commit>/check-runs`) include no `success`, or any conclusion other than `success` and `cancelled`. pgstencil audits the released code; Dormouse audits only how Hosted configures it.
- **FAIL IF** the local email inbox accepts a foreign Host or Origin or cross-site Fetch Metadata; inspect `allowedDevRequest` in `hosted/server/dev-host-guard.ts`, including the upgrade guard in `hosted/server/dev.ts`.

- **FAIL IF** the production deploy can proceed without `preflight` establishing an uncached Hyperdrive, a matching migration/runtime database, and distinct runtime and migration roles; inspect `preflight` in `hosted/scripts/production.mjs` and its ordering ahead of the deploy step in `.github/workflows/hosted-production.yml`.
- **FAIL IF** preview mail or OAuth calls reach external providers, preview configuration copies production routes/bindings, or a preview exposes deterministic time controls; inspect `hosted/server/preview-worker.ts`, `hosted/scripts/preview.mjs`, and `hosted/server/tests/workers.test.ts`.

Pinned by `hosted/server/tests/artifacts.test.ts`, `hosted/server/tests/workers.test.ts`, `hosted/server/tests/policy.test.ts`, `hosted/scripts/production.test.mjs`.

## Future

**Production activation**, not checked until Hosted is provisioned: the live Hyperdrive and role values that `preflight` reads, and Cloudflare script injection excluded for the Hosted hostname (`hosted/README.md`). Checked-in placeholders prove none of them.

Public hosted voice and Relay need their own abuse, authorization, data-disclosure, and recovery checks first; `docs/specs/hosted.md` owns the staged work.
