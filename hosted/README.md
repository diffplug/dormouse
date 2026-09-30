# Dormouse Hosted

Account frontend and Hono/Cloudflare Worker for `https://hosted.dormouse.sh`,
which also serves the one-time connection's rendezvous and its `/connect/`
phone page ([its spec](../docs/specs/one-time.md)). The marketing website is a separate
application. Managed voice exists only as an admin-only test slice; the managed
Relay is not implemented. See
[the spec](../docs/specs/hosted.md).

This file is the whole operator runbook, in the order an operator works: run
locally, update packages, set up GitHub, provision previews, provision
production, release, accept, recover. Marketing, desktop releases, Hosted
production, and PR previews have separate deployment credentials. A passing
local test implies no cloud resource and no real-provider acceptance.

## Run locally

From the repository root, with Docker running:

```sh
pnpm install
dor tool hosted
```

Outside Dormouse, use `pnpm dev:hosted` and open the `http://localhost:<port>`
URL it prints. Request a code for a test address and read it at
`/api/dev/emails` on that same origin. No real mail is sent, and the development database is isolated by
the worktree path; `docs/specs/hosted.md` -> "Development and release" owns what
the local entry serves and what production omits. The port is OS-assigned
unless you set `PORT`. Do not share this local inbox publicly. Set
`ELEVENLABS_API_KEY` in the environment of `pnpm dev:hosted` to hear real
speech; see `docs/specs/hosted.md` -> "Managed voice".

```sh
pnpm test:hosted
pnpm build:hosted
```

Tests run the production composition in real workerd with disposable Postgres
clones and a local OAuth simulator. `pnpm --filter dormouse-hosted test:one-time`
runs the rendezvous suite alone, without Docker. The build includes a Wrangler
dry-run; it does not deploy.

The one-time rendezvous and `/connect/` page run on their own, without Docker
or Postgres:

```sh
dor tool one-time      # outside Dormouse: pnpm dev:one-time
```

It serves `http://localhost:8787` (or `PORT`) and prints the
`DORMOUSE_ONE_TIME_ORIGIN` and `DORMOUSE_REMOTE_CONNECT_SRC` values that point a
local Burrow build at it; `docs/specs/one-time.md` -> "Dev loop" owns what it
runs. A phone cannot reach a loopback origin, so a real phone tests against a
PR preview.

## Update pgstencil

`hosted/package.json` installs released `pgstencil` and `@pgstencil/auth` from
npm. They share a version and Hosted declares their peer dependencies. Approved
pgstencil releases are exempt from the pnpm and Renovate cooldowns because the
release workflow requires a passing security audit, stages the archives, and
requires a maintainer's 2FA approval before publishing.

Run `pnpm install` and re-run Hosted's integration tests after an update. The
production preflight reads `dist/provenance.json` from the installed packages
and requires matching clean commits. `docs/specs/security-hosted.md` ->
"Deployment boundary" owns the upstream audit check. For an unreleased change,
pack pgstencil in a clean checkout and use a temporary pnpm override on a
branch.

## Resource inventory

| Boundary | Resources |
| --- | --- |
| Preview | Dedicated test Cloudflare account with a registered workers.dev subdomain; dedicated empty Neon project and parent branch; GitHub `hosted-preview` environment |
| Each PR | `dormouse-hosted-pr-N` Worker with its own `OneTimeRoom` Durable Object namespace, uncached Hyperdrive, and Neon branch, all reused until close; rate-limit namespaces `1001` and `1002` shared by every preview |
| Production | Dedicated Dormouse Postgres database, separate runtime/migration roles, uncached Hyperdrive, `dormouse-hosted` Worker with its `OneTimeRoom` Durable Object namespace and rate-limit namespaces `1` and `2`, and `hosted.dormouse.sh` custom domain; GitHub `hosted-production` environment |
| Email | Dedicated Postmark server, verified `signin@dormouse.sh`, SPF/DKIM/DMARC, Apple Private Email Relay registration |
| OAuth | Separate Dormouse GitHub, Google, Microsoft, and Apple registrations; exact callbacks below |
| Release history | `hosted-release-tag` GitHub environment, an admin identity's repository-scoped Contents-write fine-grained PAT, immutable annotated `hosted/` tags |
| Recovery | Neon backups/PITR enabled, encrypted pre-migration dumps retained as GitHub artifacts for 30 days, age identity also retained independently in a password manager |

Cloudflare Workers Scripts and Hyperdrive permissions are account-scoped, so
previews need their own test account. `docs/specs/security-ci.md` -> "Hosted
Deployments" owns the credential placement the audit checks.

### Production registration identifiers

Public identifiers recorded during provisioning on 2026-09-29; secret values
remain in the Worker, protected GitHub environments, and Bitwarden.

| Service | Dedicated registration |
| --- | --- |
| Cloudflare | Account `0a95e814ccf2b6a95d2dc3bea0a4a2b4`; Worker `dormouse-hosted`; Hyperdrive ID in `wrangler.jsonc` |
| Neon | Project `young-dust-56119072`; production branch `br-billowing-brook-b4cuf3y4`; database `neondb`; migration role `neondb_owner`; SQL-created runtime role `dormouse_app` |
| Postmark | Server `21034461`, `dormouse-hosted`; sender `signin@dormouse.sh`; return path `pm-bounces.dormouse.sh` |
| GitHub OAuth | DiffPlug organization app `3890420`; client ID `Ov23liX1HSz03AAN3Psf` |
| Google | Project `diffplug-dormouse`; client ID `168454028617-aecm16ka4nodv6a72u2aolgqurkr4gaj.apps.googleusercontent.com` |
| Microsoft | DiffPlug tenant `cf6a3474-e2f1-498a-9109-706289336d8a`; client ID `be9f84a1-fc52-4a50-afcb-c659c11a1f17` |
| Apple | Team `LXW8WAGWYX`; primary App ID `sh.dormouse.standalone`; Services ID `sh.dormouse.hosted`; signing key `UFV5N9DWJS` |

The Apple client-secret JWT expires **2027-03-28 05:33 UTC**; renew by
**2027-02-26** using the signing key in Bitwarden. Microsoft's secret was
created with a 180-day expiry; its exact expiry is saved with it in Bitwarden.
The release-tag PAT expires **2026-12-27**; renew it before that date in the
separately protected `hosted-release-tag` environment. Apple's private relay
has the exact sender and the Postmark return-path domain registered. Provisioning
these registrations does not establish acceptance.

The public policy pages are live. Google is external and in production; its
branding is verified and published, with only OpenID, email, and profile scopes.

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
Edit**, scoped only to that account; the first also deploys the Durable Object
and rate-limit bindings. No zone/DNS access is needed. In Neon,
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
accounts.

1. Create a dedicated Dormouse production Postgres database on Neon, on
   PostgreSQL 18; the backup/restore tooling pins PostgreSQL
   18.6. Keep development and previews separate. Enable backups and a
   suitable PITR window, and verify a restore into a separate database before
   accepting real accounts.
2. Create a Cloudflare Hyperdrive configuration for that database with **query
   caching disabled**, using the runtime role, and keep its connection host and
   database identical to the direct migration URL. Enter connection credentials
   directly in Cloudflare; replace the zero Hyperdrive ID in `wrangler.jsonc`
   with the resulting public ID for local operator deployment. CI overrides it
   with the `HYPERDRIVE_ID` variable.
3. Create the runtime role with SQL (`CREATE ROLE ... LOGIN PASSWORD ...`),
   not Neon’s Console/API role creation, which grants `neon_superuser`.
   Neon requires the password over the encrypted connection and rejects a
   precomputed password hash. Keep it out of command arguments and SQL-editor
   history. Give the runtime role only the auth-table and schema DML permissions plus
   sequence access the shipped tables need, including defaults for future
   migration-created tables and sequences. Keep a separate migration role that
   owns migrations and can dump the database. Supply its `DATABASE_URL` through
   a secret manager, never in a command argument, then run
   `pnpm --filter dormouse-hosted db:migrate` and `db:validate`. These commands
   never reset or drop an existing database.
4. Set up a dedicated Postmark server/token and verify the sending address
   `signin@dormouse.sh` (or update `EMAIL_FROM`). Configure SPF/DKIM and
   DMARC. Register the sender with Apple Private Email Relay for relay-address
   delivery.
5. Configure `hosted.dormouse.sh` as the Worker's custom domain. Exclude this
   hostname from Cloudflare Web Analytics, Zaraz, and other script injection
   or rewriting rules. Disable account API caching. Keep `workers_dev` and
   public preview URLs disabled.

Authenticate Wrangler to the intended Cloudflare account before provisioning.
Inside Dormouse, run `dor ensure -- pnpm exec wrangler login --browser=false --use-keyring`
from `hosted/`, then open the printed authorization link with `dor agent-browser`. Review
the account and requested access before granting it. Secrets remain in the OS
keychain. Authenticate in your own terminal; account/provider sign-in is operator-owned.

## Separate OAuth registrations

Create Dormouse registrations. Register these exact URLs with no trailing slash:

| Provider | Registration | Callback |
| --- | --- | --- |
| GitHub | Organization-owned OAuth App, identity/email scopes only | `https://hosted.dormouse.sh/api/auth/callback/github` |
| Google | Web application OAuth client under a Dormouse consent configuration | `https://hosted.dormouse.sh/api/auth/callback/google` |
| Microsoft | Entra application: personal and work/school accounts; Web platform | `https://hosted.dormouse.sh/api/auth/callback/microsoft` |
| Apple | Dormouse Services ID associated with a Sign in with Apple primary App ID | `https://hosted.dormouse.sh/api/auth/callback/apple` |

Use `https://hosted.dormouse.sh` as the application origin. Google's consent
homepage is `https://dormouse.sh/hosted/`, which describes the account service;
its privacy and terms URLs are `https://dormouse.sh/privacy/` and
`https://dormouse.sh/terms/`. Publish approved pages before submitting branding.
Configure consent branding, support contact, and production/test-user settings
before testing with ordinary accounts. For Google, add the exact callback under
authorized redirect URIs, and the Hosted origin under authorized JavaScript
origins if requested.

For Microsoft, request optional ID-token claims `email` and `xms_edov`. Store
the client-secret **Value**, not its identifier, and record its expiry. The
installed pgstencil release includes the callback fix. Verify real personal
and work/school callbacks during Dormouse acceptance.

The marketing site serves `website/public/.well-known/microsoft-identity-association.json`
at `https://dormouse.sh/.well-known/microsoft-identity-association.json` for
Microsoft publisher-domain verification. Promote the website before using
**Update domain** in Entra; publisher verification through Partner Center is
separate from domain verification.

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
Use a production Cloudflare token covering Workers deployment (which includes
the Durable Object migration and rate-limit bindings), Hyperdrive read, and the
custom-domain zone permissions required for that hostname.

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

Create `ELEVENLABS_API_KEY` in an ElevenLabs account dedicated to Dormouse
voice — the Worker deletes that account's entire speech history on a schedule,
so never point it at a shared account. Restrict the key to text-to-speech plus
speech-history access, and set a spending limit in the ElevenLabs console. How
the Worker uses the key is `docs/specs/hosted.md` -> "Managed voice".

Generate a fresh cryptographically random `AUTH_SECRET` with at least 32 bytes
of entropy in your secret manager. Client IDs are public but may be stored
through the same prompts as `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`,
`MICROSOFT_CLIENT_ID`, and `APPLE_CLIENT_ID`. The first secret can create the
initial Worker stub; it does not activate account service. Set all required
secrets before release; deployment preserves the ones already there.

Configure the sender and enable each ready provider in `OAUTH_PROVIDERS` in
`wrangler.jsonc`, comma separated, reviewed in a PR. The checked-in file enables
GitHub, Google, Microsoft, and Apple; `docs/specs/hosted.md` -> "Identity and login" owns what a name and a
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
7. Confirm the history sweep's Cron Trigger is registered: the deploy log lists
   `schedule: */5 * * * *`, and the dashboard shows it under Workers & Pages ->
   `dormouse-hosted` -> Settings -> Trigger Events. After the speak in step 6,
   the ElevenLabs console's speech history should be empty within a few
   minutes. The Worker's Cron Events list each run; a failed run means the key
   cannot list or delete history. Recheck them for failed runs after any key
   change.
8. Confirm `/api/dev/emails`, `/dev/emails`, and `/__test/time` are absent, and
   check the live responses against the origin, caching, and cookie rules in
   `docs/specs/security-hosted.md` -> "Origin boundary".
9. Confirm the release smoke's one-time half passed: `/connect/` answers the
   page under its own policy with its script beside it, and the rendezvous
   mints a room, is refused with a browser `Origin`, joins from the app origin,
   crosses a frame each way, and is refused a second phone. Load `/connect/`
   in a browser and confirm no injected script or third-party request.
10. With a desktop build pointed at this origin, open a one-time link on a real
    iPhone in Safari and a real Android phone in Chrome, each on the same Wi-Fi
    as the laptop and each by scanning the QR code with the native camera, which
    must keep the fragment. Connect, type the digits, run a command, and End
    from the laptop. Then turn the phone's Wi-Fi off mid-session: both ends
    report the end. On a guest or client-isolated network the attempt ends on
    the same-Wi-Fi copy.

Do not mark all five login methods complete until email and all four providers
pass in real browsers; a simulated callback certifies nothing. No real-provider
result is claimed by the initial implementation.

## Recovery

A failed migration or deployment may already have changed production state;
workflow failure does not automatically reverse it. Use the Worker's deployment
history for code rollback and investigate database compatibility first;
`docs/specs/hosted.md` -> "Production releases" owns what a code rollback does
not undo. Cloudflare refuses a rollback past the deploy that added the
`OneTimeRoom` migration, and every deploy or rollback drops the one-time links
still open; established sessions run directly and are unaffected. Restore a backup only after an explicit operator decision, into a
separate database first.

Current provisioning status is discoverable with `gh secret list --env NAME`,
`gh variable list --env NAME`, and each provider console. Configuration presence
alone is not acceptance. The account limitations an operator will be asked about
— login lifetime, no device revocation or sign-out-everywhere, no merge or
recovery, admin-only managed voice, no paid-service activation — are in `docs/specs/hosted.md`.
