# Dormouse Hosted

Account frontend and Hono/Cloudflare Worker for `https://hosted.dormouse.sh`.
The marketing website is a separate application. Hosted voice and the managed
Relay are not implemented. See [the spec](../docs/specs/hosted.md).

## Run locally

From the repository root, with Docker running:

```sh
pnpm install
dor ensure -- pnpm dev:hosted
```

Outside Dormouse, use `pnpm dev:hosted`. Open `http://127.0.0.1:5188`.
Request a code for a test address and read it at `/api/dev/emails` on that
same origin. No real mail is sent. OAuth is disabled in this local entry;
the development database is isolated by the worktree path. Use another
`PORT` if 5188 is occupied. Do not share this local inbox publicly.

```sh
pnpm test:hosted
pnpm build:hosted
```

Tests run the production composition in real workerd with disposable Postgres
clones and a local OAuth simulator. The build includes a Wrangler dry-run; it
does not deploy. The production entry contains neither the inbox nor test clock.

## Refresh private packages

```sh
node scripts/sync-pgstencil.mjs /path/to/pgstencil
```

This runs `pnpm packages:pack` in pgstencil, vendors core/auth, records source
commit/dirty state and SHA-256 hashes in `vendor/build.json`, and installs.
Commit archives, provenance, and lockfile together. The direct Node command
also works before the archives exist (pnpm may otherwise auto-install first).
Re-run integration tests after every refresh. A dirty-source snapshot must be
reviewed and replaced with an accepted revision before production activation.

## Provision the production boundary

Use dedicated Dormouse resources in the existing Cloudflare, Neon, and Postmark
accounts. Do not reuse TTR's database, mail server/token, or OAuth registrations.

1. Create a dedicated Dormouse production Postgres database (Neon is the TTR
   precedent). Keep TTR, development, and previews separate. Enable backups and
   verify a restore into a separate database before accepting real accounts.
2. Create a Cloudflare Hyperdrive configuration for that database with **query
   caching disabled**. Enter connection credentials directly in Cloudflare;
   replace the zero Hyperdrive ID in `wrangler.jsonc` with the resulting public ID.
3. Give the runtime only the data permissions required by the shipped auth
   tables. Keep a separate migration credential. Supply its `DATABASE_URL`
   through a secret manager, then run `pnpm --filter dormouse-hosted db:migrate`
   and `db:validate`. These commands never reset or drop an existing database.
4. Set up a dedicated Postmark server/token and verify the sending address
   `signin@hosted.dormouse.sh` (or update `EMAIL_FROM`). Configure SPF/DKIM and
   DMARC. Register the sender with Apple Private Email Relay for relay-address
   delivery.
5. Use a deployment identity separate from marketing, with access limited to
   the Hosted deployment resources. Do not give marketing CI the Hosted auth,
   database, email, OAuth, or deployment secrets. If a Cloudflare account token
   cannot express that isolation, use a separate account/deployment boundary.
6. Configure `hosted.dormouse.sh` as the Worker's custom domain. Exclude this
   hostname from Cloudflare Web Analytics, Zaraz, and other script injection
   or rewriting rules. Disable account API caching. Keep `workers_dev` and
   public preview URLs disabled.

PR previews and production releases use the workflows and isolated GitHub
environments in [DEPLOYMENT.md](DEPLOYMENT.md). The checked-in deployment has
a placeholder Hyperdrive ID and enables no OAuth providers until configured.

Authenticate Wrangler to the intended Cloudflare account before provisioning.
Inside Dormouse, run `dor ensure -- pnpm exec wrangler login --browser=false --use-keyring`
from `hosted/`, then open the printed authorization link with `dor ab`. Review
the account and requested access before granting it. Secrets remain in the OS
keychain. Authenticate in your own terminal; account/provider sign-in is operator-owned.

## Separate OAuth registrations

Create Dormouse registrations; do not reuse TTR credentials or replace TTR's
callbacks. Register these exact URLs with no trailing slash:

| Provider | Registration | Callback |
| --- | --- | --- |
| GitHub | Organization-owned OAuth App, identity/email scopes only | `https://hosted.dormouse.sh/api/auth/callback/github` |
| Google | Web application OAuth client under a Dormouse consent configuration | `https://hosted.dormouse.sh/api/auth/callback/google` |
| Microsoft | Entra application: personal and work/school accounts; Web platform | `https://hosted.dormouse.sh/api/auth/callback/microsoft` |
| Apple | Dormouse Services ID associated with a Sign in with Apple primary App ID | `https://hosted.dormouse.sh/api/auth/callback/apple` |

Use `https://hosted.dormouse.sh` as the application origin/homepage where the
provider requests it. Configure consent branding, support contact, privacy
policy, and production/test-user settings before testing with ordinary accounts.
For Google, add the exact callback under authorized redirect URIs, and the
Hosted origin under authorized JavaScript origins if requested.

For Microsoft, request optional ID-token claims `email` and `xms_edov`. Store
the client-secret **Value**, not its identifier, and record its expiry.
Microsoft's existing real callback failure belongs to the separate pgstencil
investigation. Prepare the Dormouse registration now, but enable Microsoft
only after consuming the accepted fix and passing a real Dormouse callback.

For Apple, register domain `hosted.dormouse.sh` and the return URL above. The
client ID is the Services ID; the client secret is an ES256 JWT signed with
the Apple key (Team ID issuer, Services ID subject, Apple audience, key ID
header). Keep the signing key in your secret manager, generate the JWT locally,
and renew it before expiry (at most six months). The callback accepts Apple's
form POST and uses the package's browser-bound relay; do not replace it with a
generic JSON/CSRF handler. Schedule secret-expiry reminders before activation.

## Enter secrets yourself

From `hosted/`, use Wrangler's hidden prompt, never a command-line value:

```sh
pnpm exec wrangler secret put AUTH_SECRET
pnpm exec wrangler secret put POSTMARK_SERVER_TOKEN
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put MICROSOFT_CLIENT_SECRET
pnpm exec wrangler secret put APPLE_CLIENT_SECRET
```

Generate a fresh cryptographically random `AUTH_SECRET` with at least 32 bytes
of entropy in your secret manager. Client IDs are public but may be stored
through the same prompts as `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`,
`MICROSOFT_CLIENT_ID`, and `APPLE_CLIENT_ID`. Never paste secrets into chat,
source files, URLs, command arguments, or build logs. `.dev.vars*` and `.env`
under `hosted/` are ignored; use only isolated test credentials there.

Enable each ready provider in `OAUTH_PROVIDERS` in `wrangler.jsonc`, comma
separated. Paired credentials alone do not enable it; unknown names and missing
credentials fail closed. Facebook is outside this milestone.

## Release and acceptance

1. Review the exact package provenance and code revision. Run `pnpm test:hosted`,
   `pnpm build:hosted`, and the repository lints. Validate production migrations.
2. Run the production workflow in [DEPLOYMENT.md](DEPLOYMENT.md). Check `/api/health` and `/api/ready` on the
   canonical hostname. Inspect the actual HTML response/CSP and browser network
   requests for injected marketing scripts or unexpected third-party assets.
3. Request a real email, enter its code, reload, and log out. Enter a code in a
   second browser to verify that mail access is not tied to the first browser.
4. For each enabled provider, test first login, consent cancellation, repeat
   login, and logout. Include GitHub private email and Apple Hide My Email;
   Microsoft needs personal and work/school accounts after the shared fix.
5. Start with email, attempt the same-address provider from another browser,
   and confirm no automatic linking. Connect it from the signed-in account,
   then confirm both methods return the same account ID. Connect Apple with
   its different relay address. An identity belonging to another account must
   never transfer. A connection started before logout must fail on return.
6. Log in on two devices and confirm both remain signed in. Log out on one;
   the other must remain signed in. Provider-only accounts display no email
   and repeat login preserves their account ID.
7. Confirm `/api/dev/emails`, `/dev/emails`, and `/__test/time` are absent.
   Confirm marketing-origin auth POSTs fail, auth JSON is not cached, and
   cookies are host-only, Secure, HttpOnly, and SameSite=Lax.

Do not mark all five login methods complete until email and all four providers
pass in real browsers. Simulated Microsoft tests do not resolve its known
production issue. No real-provider result is claimed by the initial implementation.

Use the Worker's deployment history for code rollback; migrations are append-only
and are not reversed by a code rollback. Database restoration requires an
explicit operator decision and a tested backup. Current limitations: fixed
24-hour logins, no device-revocation screen or sign-out-everywhere, no account
merge/recovery, no paid-service activation. PR preview provisioning is documented in
[DEPLOYMENT.md](DEPLOYMENT.md).
