# Dormouse Hosted accounts

> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the Hosted account application. Remote authorization belongs to `docs/specs/remote-security-model.md`; the multi-tenant Relay remains in `docs/specs/relay.md` -> Future.

## Application boundary

**Must serve the account frontend and its API from `https://hosted.dormouse.sh`.** The Hono Worker serves Vite assets and pgstencil's request-scoped Better Auth adapter. Requests addressed to another origin receive 421. Marketing remains a separate bundle and deployment; no marketing component is imported.

**Must run committed Better Auth migrations before deploying code that needs them, never during a Worker request.** Postgres is reached through an uncached Hyperdrive binding. The runtime creates and closes its database pool within each request.

**Must pin locally packed core/auth packages through root pnpm overrides and commit archives, provenance, and lockfile together.** `vendor/build.json` records the source commit, dirty state, and archive hashes. No runtime import depends on a sibling checkout. The auth migrations remain owned by the package.

Source of truth: `auth` in `hosted/server/worker.ts`; `migrations` in `hosted/server/migrations.ts`; `scripts/sync-pgstencil.mjs`.

## Identity and login

**Must retain independent simultaneous browser logins.** Login lifetime is 24 hours without refresh or cookie caching; logout revokes only the current login. These authentication records are not terminal Sessions.

**Must require explicit provider connection from a login less than ten minutes old.** The callback must retain that same live login. Matching email alone never connects an unbound OAuth identity. Different verified provider emails are allowed; an identity already attached to another account cannot be claimed.

**May create provider-only accounts without verified email.** Public email is null; pgstencil's internal placeholder is never a delivery address. Email-code login remains an access path to an account's canonical verified mailbox. There is no merge, email adoption, unlink, or account-recovery interface.

**Must identify accounts by immutable user ID, never email.** Provider-only accounts keep their identity when a provider subsequently supplies email.

**Must enable providers explicitly in `OAUTH_PROVIDERS`.** The allowed set is GitHub, Google, Microsoft, and Apple. Missing paired credentials or unknown names fail closed; unused credentials enable nothing. Email uses Postmark in production and local capture in development.

**Must discard provider tokens after identity verification and omit login tokens from browser JSON.** Cookies and upstream identity verification follow the packed adapter; `hosted/server/tests/workers.test.ts` pins the consumer's browser contract in workerd with real Postgres and simulated providers.

Source of truth: `authPolicy` / `providerBindings` in `hosted/server/policy.ts`; `App` in `hosted/src/App.tsx`.

## Interface

**Must show configured sign-in methods only.** Email has send, existing-code, verify, resend, and change-address paths. The account screen lists connected methods and explains recent-login requirements and provider-only recovery limits. Failed callbacks display a recoverable error and remove query parameters from browser history.

**Must check the account on return to the page and serialize submitted actions.** Authenticated data remains in memory; login tokens never enter local storage. Only public identity fields are rendered, without provider images or external assets.

**Must inherit Dormouse product theme tokens before mounting React.** The OS light/dark preference selects bundled Light Visual Studio or Kimbie Dark. Hosted uses a narrow single-column form, 44px controls, 16px inputs, and 13px body copy; its page heading is 18px. It loads no marketing styles, fonts, or analytics.

Source of truth: `App` in `hosted/src/App.tsx`; `restoreTheme` in `hosted/src/main.tsx`; `hosted/src/style.css`.

## Development and release

**Must run local development with `dor ensure -- pnpm dev:hosted` inside Dormouse.** A single loopback origin serves Vite and Node auth, with a disposable development database. Host, Origin, and Fetch Metadata checks guard the local captured-email inbox; the production entry imports no inbox or test-control handler.

**Must verify the production Worker bundle and run the consumer's integration suite before release.** The test entry alone injects the actual packed Better Auth deterministic module. Simulated callbacks do not certify provider registrations; production acceptance requires real browser login with each enabled provider and email delivery.

**Must keep production, test, and preview databases and credentials separate.** The current development entry is email-only; public PR preview deployment is not implemented. Production configuration and operator steps live in `hosted/README.md`.

Source of truth: `allowedDevRequest` in `hosted/server/dev-host-guard.ts`; `hosted/server/dev.ts`; `hosted/server/tests/workers.test.ts`; `hosted/wrangler.jsonc`.

## Future

1. Complete separate Dormouse OAuth registrations, Postmark sender, Postgres/Hyperdrive provisioning, and real production acceptance. Microsoft callback diagnosis and shared logging are coordinated in pgstencil separately.
2. Add per-browser login listing/revocation, sign-out-everywhere, and account recovery before broad paid use. Revisit the fixed 24-hour login lifetime for daily voice use.
3. Hosted ElevenLabs: desktop authorization, scoped revocable credentials, quotas, usage accounting, spending bounds, and explicit text/redaction disclosure.
4. Hosted Relay: follow the **saas-multitenant** scope in `docs/specs/relay.md`; account login never replaces Burrow pairing and authorization. Paid security claims retain the independent-review precondition.
