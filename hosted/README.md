# Dormouse Hosted

Account frontend and Hono/Cloudflare Worker for `https://hosted.dormouse.sh`.
The marketing website is a separate application. Managed voice exists only as
an admin-only test slice; the managed Relay is not implemented. See
[the spec](../docs/specs/hosted.md).

This file is the whole operator runbook, in the order an operator works: run
locally, refresh packages, set up GitHub, provision previews, provision
production, release, accept, recover. Marketing, desktop releases, Hosted
production, and PR previews have separate deployment credentials. A passing
local test implies no cloud resource and no real-provider acceptance.

## Run locally

From the repository root, with Docker running:

```sh
pnpm install
dor ensure -- pnpm dev:hosted
```

Outside Dormouse, use `pnpm dev:hosted`. Open `http://127.0.0.1:5188`.
Request a code for a test address and read it at `/api/dev/emails` on that
same origin. No real mail is sent, and the development database is isolated by
the worktree path; `docs/specs/hosted.md` -> "Development and release" owns what
the local entry serves and what production omits. Use another `PORT` if 5188 is
occupied. Do not share this local inbox publicly. Set `ELEVENLABS_API_KEY` in
the environment of `pnpm dev:hosted` to hear real speech; see
`docs/specs/hosted.md` -> "Managed voice".

```sh
pnpm test:hosted
pnpm build:hosted
```

Tests run the production composition in real workerd with disposable Postgres
clones and a local OAuth simulator. The build includes a Wrangler dry-run; it
does not deploy.

## Refresh private packages

```sh
node scripts/sync-pgstencil.mjs /path/to/pgstencil
```

This runs `pnpm packages:pack` in pgstencil, vendors core/auth, records source
commit/dirty state and SHA-256 hashes in `vendor/build.json`, and installs. The
direct Node command also works before the archives exist (pnpm may otherwise
auto-install first). See `docs/specs/hosted.md` -> "Application boundary" for
what has to be committed together.

Re-run integration tests after every refresh. The initial vendored pgstencil
manifest is dirty; production preflight rejects it until it is refreshed from an
accepted clean revision with matching archive hashes.

## Resource inventory

| Boundary | Resources |
| --- | --- |
| Preview | Dedicated test Cloudflare account with a registered workers.dev subdomain; dedicated empty Neon project and parent branch; GitHub `hosted-preview` environment |
| Each PR | `dormouse-hosted-pr-N` Worker, uncached Hyperdrive, and Neon branch, all reused until close |
| Production | Dedicated Dormouse Postgres database, separate runtime/migration roles, uncached Hyperdrive, `dormouse-hosted` Worker and `hosted.dormouse.sh` custom domain; GitHub `hosted-production` environment |
| Email | Dedicated Postmark server, verified `signin@hosted.dormouse.sh`, SPF/DKIM/DMARC, Apple Private Email Relay registration |
| OAuth | Separate Dormouse GitHub, Google, Microsoft, and Apple registrations; exact callbacks below |
| Release history | `hosted-release-tag` GitHub environment, an admin identity's repository-scoped Contents-write fine-grained PAT, immutable annotated `hosted/` tags |
| Recovery | Neon backups/PITR enabled, encrypted pre-migration dumps retained as GitHub artifacts for 30 days, age identity also retained independently in a password manager |

Cloudflare Workers Scripts and Hyperdrive permissions are account-scoped, so
previews need their own test account. Production deployment isolation likewise
requires a boundary marketing's existing credentials cannot reach; coordinate
the hostname/zone placement before choosing an account. Do not reuse TTR's Neon
project, mail token, or OAuth registrations. `docs/specs/security-ci.md` ->
"Hosted Deployments" owns the credential isolation the audit checks.

## GitHub setup

Run once from the repository root with the operator's existing `gh` login:

```sh
node hosted/scripts/setup-github.mjs
```

The script creates or updates the three environments with the branch policies,
required reviewers, and disabled administrator bypass that
`docs/specs/security-ci.md` -> "Hosted Deployments" owns. Repository branch and
tag protections are unchanged.

## Provision PR previews

In Cloudflare, create the dedicated preview account, register its workers.dev
subdomain, and create a token with **Workers Scripts: Edit** and **Hyperdrive:
Edit**, scoped only to that account. No zone/DNS access is needed. In Neon,
create a dedicated preview project with an empty parent branch, default `neondb`
database and `neondb_owner` role. Use a project-scoped API key where supported.
Record the project and parent branch IDs; never select a production parent.

These commands prompt invisibly for tokens; the generated auth secret goes
directly to GitHub:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo diffplug/dormouse --env hosted-preview
gh secret set NEON_API_KEY --repo diffplug/dormouse --env hosted-preview
openssl rand -hex 32 | gh secret set PREVIEW_AUTH_SECRET --repo diffplug/dormouse --env hosted-preview
```

Replace the public placeholders below. The subdomain is just its label, with
no dots, protocol, or `.workers.dev` suffix:

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --repo diffplug/dormouse --env hosted-preview --body 'PREVIEW_ACCOUNT_ID'
gh variable set CLOUDFLARE_WORKERS_SUBDOMAIN --repo diffplug/dormouse --env hosted-preview --body 'SUBDOMAIN'
gh variable set NEON_PROJECT_ID --repo diffplug/dormouse --env hosted-preview --body 'PREVIEW_PROJECT_ID'
gh variable set NEON_PREVIEW_PARENT_BRANCH --repo diffplug/dormouse --env hosted-preview --body 'EMPTY_PARENT_BRANCH_ID'
# Enable last, at repository scope so job selection can read it before entering an environment.
gh variable set HOSTED_PREVIEWS_ENABLED --repo diffplug/dormouse --body true
```

A qualifying PR runs Hosted tests and builds before provisioning;
`docs/specs/hosted.md` -> "PR previews" owns which PRs qualify and what each one
gets. The URL is in the deployment environment link and job summary; no PR
comment bot or write-scoped workflow token is needed.

Open `https://dormouse-hosted-pr-N.SUBDOMAIN.workers.dev/`, request a code for a
disposable address, and read it at `/dev/emails`. This inbox is public to anyone
with the URL. No real email or OAuth provider is contacted. The database stores
messages across Worker restarts.

New commits retain the URL and test accounts. Migrations are append-only; to
change an already-applied migration, close the PR, wait for successful cleanup,
then reopen. Closing or merging deletes the Worker, Hyperdrive, and Neon branch.
Rerun failed cleanup. Keep previews enabled until all live previews are removed.
Manual cleanup uses `node hosted/scripts/preview.mjs cleanup` with the preview
environment's credentials and `PR_NUMBER`. These credentials cannot be downloaded
back from GitHub; retain independent copies in your password manager.

## Provision the production boundary

Use dedicated Dormouse resources in the existing Cloudflare, Neon, and Postmark
accounts. Do not reuse TTR's database, mail server/token, or OAuth registrations.

1. Create a dedicated Dormouse production Postgres database (Neon is the TTR
   precedent) on PostgreSQL 17; the backup/restore tooling pins PostgreSQL
   17.11. Keep TTR, development, and previews separate. Enable backups and a
   suitable PITR window, and verify a restore into a separate database before
   accepting real accounts.
2. Create a Cloudflare Hyperdrive configuration for that database with **query
   caching disabled**, using the runtime role, and keep its connection host and
   database identical to the direct migration URL. Enter connection credentials
   directly in Cloudflare; replace the zero Hyperdrive ID in `wrangler.jsonc`
   with the resulting public ID for local operator deployment. CI overrides it
   with the `HYPERDRIVE_ID` variable.
3. Give the runtime role only the auth-table and schema DML permissions plus
   sequence access the shipped tables need, including defaults for future
   migration-created tables and sequences. Keep a separate migration role that
   owns migrations and can dump the database. Supply its `DATABASE_URL` through
   a secret manager, never in a command argument, then run
   `pnpm --filter dormouse-hosted db:migrate` and `db:validate`. These commands
   never reset or drop an existing database.
4. Set up a dedicated Postmark server/token and verify the sending address
   `signin@hosted.dormouse.sh` (or update `EMAIL_FROM`). Configure SPF/DKIM and
   DMARC. Register the sender with Apple Private Email Relay for relay-address
   delivery.
5. Use a deployment identity separate from marketing, with access limited to
   the Hosted deployment resources. If a Cloudflare account token cannot express
   that isolation, use a separate account/deployment boundary.
6. Configure `hosted.dormouse.sh` as the Worker's custom domain. Exclude this
   hostname from Cloudflare Web Analytics, Zaraz, and other script injection
   or rewriting rules. Disable account API caching. Keep `workers_dev` and
   public preview URLs disabled.

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
the client-secret **Value**, not its identifier, and record its expiry. Its real
callback failure is tracked in the separate pgstencil investigation
(`docs/specs/hosted.md` -> "Future"): prepare the Dormouse registration now, but
enable Microsoft only after consuming the accepted fix and passing a real
Dormouse callback.

For Apple, register domain `hosted.dormouse.sh` and the return URL above. The
client ID is the Services ID; the client secret is an ES256 JWT signed with
the Apple key (Team ID issuer, Services ID subject, Apple audience, key ID
header). Keep the signing key in your secret manager, generate the JWT locally,
and renew it before expiry (at most six months). The callback accepts Apple's
form POST and uses the package's browser-bound relay; do not replace it with a
generic JSON/CSRF handler. Schedule secret-expiry reminders before activation.

## Enter secrets yourself

Never paste secrets into chat, source files, URLs, command arguments, or build
logs. `.dev.vars*` and `.env` under `hosted/` are ignored; use only isolated
test credentials there.

### Deployment credentials in GitHub

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --repo diffplug/dormouse --env hosted-production --body 'PRODUCTION_ACCOUNT_ID'
gh variable set HYPERDRIVE_ID --repo diffplug/dormouse --env hosted-production --body 'PRODUCTION_HYPERDRIVE_ID'
gh secret set CLOUDFLARE_API_TOKEN --repo diffplug/dormouse --env hosted-production
gh secret set DATABASE_URL --repo diffplug/dormouse --env hosted-production
gh secret set BACKUP_AGE_IDENTITY --repo diffplug/dormouse --env hosted-production
gh secret set HOSTED_TAG_TOKEN --repo diffplug/dormouse --env hosted-release-tag
```

`DATABASE_URL` is the direct migration-role Postgres URL. Generate the age
identity with `age-keygen` into private password-manager storage, then enter it
at the hidden prompt; preserve that independent copy and old keys on rotation.
Use a production Cloudflare token covering Workers deployment, Hyperdrive read,
and the custom-domain zone permissions required for that hostname.

The tag PAT belongs to a repository admin and selects only this repository with
Contents write. It can bypass the existing tag ruleset and can also write code,
so it is isolated from the deploy job in a separately approved main-only
environment (`docs/specs/security-ci.md` -> "Hosted Deployments"). Record its
expiry; do not grant tag bypass to the bot or Actions generally.

### Runtime secrets in the Worker

Auth, mail, and OAuth secrets live in the Worker, not GitHub. In your own
terminal, from `hosted/`, authenticate Wrangler to the production account and
use its hidden prompt, never a command-line value:

```sh
pnpm exec wrangler secret put AUTH_SECRET
pnpm exec wrangler secret put POSTMARK_SERVER_TOKEN
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put MICROSOFT_CLIENT_SECRET
pnpm exec wrangler secret put APPLE_CLIENT_SECRET
pnpm exec wrangler secret put ELEVENLABS_API_KEY
```

Create `ELEVENLABS_API_KEY` in a Dormouse-owned ElevenLabs workspace, restricted
to text-to-speech, with a spending limit set in the ElevenLabs console. How the
Worker uses it is `docs/specs/hosted.md` -> "Managed voice".

Generate a fresh cryptographically random `AUTH_SECRET` with at least 32 bytes
of entropy in your secret manager. Client IDs are public but may be stored
through the same prompts as `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`,
`MICROSOFT_CLIENT_ID`, and `APPLE_CLIENT_ID`. The first secret can create the
initial Worker stub; it does not activate account service. Set all required
secrets before release; deployment preserves the ones already there.

Configure the sender and enable each ready provider in `OAUTH_PROVIDERS` in
`wrangler.jsonc`, comma separated, reviewed in a PR. The checked-in file enables
none; `docs/specs/hosted.md` -> "Identity and login" owns what a name and a
credential pair do and do not enable. Facebook is outside this milestone.

## Release

1. Review the exact package provenance and code revision. Run `pnpm test:hosted`,
   `pnpm build:hosted`, and the repository lints. Validate production migrations.
2. Merge reviewed code to `main`, then run **Hosted production release**:

   ```sh
   gh workflow run hosted-production.yml --repo diffplug/dormouse --ref main -f promote=true
   ```

   Default `promote=false` verifies and builds only. `promote=true` enters the
   protected production environment and runs the preflight, backup and
   restore-test, migration, deployment, and live-verification sequence in
   `docs/specs/hosted.md` -> "Production releases". No real mail is sent by its
   smoke checks, and passing them is not acceptance.
3. Tagging runs only after live verification, on the terms in
   `docs/specs/hosted.md` -> "Production releases". If only tagging fails, rerun
   failed jobs: it records the original deployment without deploying again.
   These tags do not trigger the desktop `v*` release workflows, and they are
   code history, not database backups.

## Acceptance

1. Check `/api/health` and `/api/ready` on the canonical hostname. Inspect the
   actual HTML response/CSP and browser network requests for injected marketing
   scripts or unexpected third-party assets.
2. Request a real email, enter its code, reload, and log out. Enter a code in a
   second browser to verify that mail access is not tied to the first browser.
3. For each enabled provider, test first login, consent cancellation, repeat
   login, and logout. Include GitHub private email and Apple Hide My Email;
   Microsoft needs personal and work/school accounts after the shared fix.
4. Start with email, attempt the same-address provider from another browser,
   and confirm no automatic linking. Connect it from the signed-in account,
   then confirm both methods return the same account ID. Connect Apple with
   its different relay address. Confirm an identity belonging to another account
   does not transfer, and that a connection started before logout fails on
   return.
5. Log in on two devices and confirm both remain signed in. Log out on one;
   the other must remain signed in. Provider-only accounts display no email
   and repeat login preserves their account ID.
6. Sign in as the admin address, create a voice token, and speak one short
   phrase with it from Dormouse desktop; revoke it and confirm the next speak
   fails. Confirm another account sees no Voice tokens section.
7. Confirm `/api/dev/emails`, `/dev/emails`, and `/__test/time` are absent, and
   check the live responses against the origin, caching, and cookie rules in
   `docs/specs/security-hosted.md` -> "Origin boundary".

Do not mark all five login methods complete until email and all four providers
pass in real browsers; a simulated callback certifies nothing. No real-provider
result is claimed by the initial implementation.

## Recovery

A failed migration or deployment may already have changed production state;
workflow failure does not automatically reverse it. Use the Worker's deployment
history for code rollback and investigate database compatibility first;
`docs/specs/hosted.md` -> "Production releases" owns what a code rollback does
not undo. Restore a backup only after an explicit operator decision, into a
separate database first.

Current provisioning status is discoverable with `gh secret list --env NAME`,
`gh variable list --env NAME`, and each provider console. Configuration presence
alone is not acceptance. The account limitations an operator will be asked about
— login lifetime, no device revocation or sign-out-everywhere, no merge or
recovery, admin-only managed voice, no paid-service activation — are in `docs/specs/hosted.md`.
