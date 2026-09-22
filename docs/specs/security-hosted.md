# Hosted account security

> See `docs/specs/glossary.md` for Burrow, Client, and Relay vocabulary.
> Owns the account application's security checks. Defers identity behavior to `docs/specs/hosted.md` and terminal access to `docs/specs/remote-security-model.md`.
> Read `docs/specs/security.md` first; provisioning and real-provider acceptance are pending.

## Origin boundary

- **FAIL IF** Hosted accepts a request URL outside configured `APP_ORIGIN`, grants marketing-origin credentialed CORS, or permits a state-changing auth request without exact Origin and CSRF checks; inspect `hosted/server/worker-app.ts` and the packed adapter.
- **FAIL IF** authentication cookies have a Domain attribute, lack `__Host-`, Secure, HttpOnly, or Path=/ in HTTPS, or session tokens appear in browser JSON or persistent browser storage; inspect the adapter and `hosted/src/api.ts`.
- **FAIL IF** the production HTML permits third-party scripts, framing, or inline script execution, any response bypasses `secureHeaders` including a misconfigured deployment's error, or anything but a content-hashed `/assets/` file is cacheable, the SPA fallback's shell included; inspect `secureHeaders` in `hosted/server/headers.ts`, binding resolution in `hosted/server/worker-app.ts`, and asset routing in `hosted/wrangler.jsonc`.
- **FAIL IF** marketing scripts, analytics, provider avatars, or remote fonts enter the Hosted frontend; inspect the frontend import graph and deployed response when available. Cloudflare script injection must be excluded for the Hosted hostname at provisioning.

Pinned by `hosted/server/tests/workers.test.ts`.

## Account boundary

- **FAIL IF** the consumer changes `authPolicy` away from explicit linking or multiple independent logins, or accepts an explicit connection callback after its initiating login was revoked; inspect `hosted/server/policy.ts` and the packed adapter.
- **FAIL IF** an unused provider credential enables login, an unknown provider name is accepted, or incomplete enabled credentials silently degrade; inspect `providerBindings` in `hosted/server/policy.ts`.
- **FAIL IF** Hosted account login mints a Burrow ACL grant or substitutes for the existing encrypted pairing/presence proof. No Hosted endpoint currently implements terminal access.

Pinned by `hosted/server/tests/workers.test.ts` and `hosted/server/tests/policy.test.ts`.

## Deployment boundary

**Must vendor pgstencil from a commit on its `main`.** A Dormouse branch may vendor a pgstencil branch while a cross-repo change is in flight; `main` must not merge it until pgstencil has.

- **FAIL IF** a production Worker exposes the captured-email inbox or deterministic clock controls, or imports the testing injection module; inspect `hosted/server/worker.ts`, the build configuration, and `hosted/server/tests/worker-entry.ts`.
- **FAIL IF** an archive's SHA-256 differs from `vendor/build.json`, `build.json` records `dirty`, either archive's `package/dist/provenance.json` is missing, records `dirty`, or names a commit other than `build.json`'s, the core/auth pnpm overrides cease resolving to those archives, or a runtime import depends on a sibling source checkout.
- **FAIL IF** `vendor/build.json`'s commit is not on pgstencil `main` (`gh api repos/diffplug/pgstencil/compare/<commit>...main`, status `ahead` or `identical`), or that commit's `security-audit` check run (`gh api repos/diffplug/pgstencil/commits/<commit>/check-runs`) is missing or not `success`. pgstencil's own audit is the evidence for the packed code; Dormouse audits only how Hosted configures it.
- **FAIL IF** the local email inbox accepts a foreign Host or Origin or cross-site Fetch Metadata; inspect `allowedDevRequest` in `hosted/server/dev-host-guard.ts`, including the upgrade guard in `hosted/server/dev.ts`.

- **FAIL IF** preview mail or OAuth calls reach external providers, preview configuration copies production routes/bindings, or a preview exposes deterministic time controls; inspect `hosted/server/preview-worker.ts`, `hosted/scripts/preview.mjs`, and `hosted/server/tests/workers.test.ts`.

Pinned by `hosted/server/tests/artifacts.test.ts`, `hosted/server/tests/workers.test.ts`, `hosted/server/tests/policy.test.ts`.

Production activation must verify uncached Hyperdrive, separate credentials, and excluded marketing injection (`hosted/README.md`); checked-in placeholders prove none of them.

## Future

Public hosted voice and Relay need their own abuse, authorization, data-disclosure, and recovery checks first; `docs/specs/hosted.md` owns the staged work.
