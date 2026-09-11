# Hosted deployments

The account application is `hosted.dormouse.sh`. Marketing, desktop releases,
Hosted production, and PR previews have separate deployment credentials.
[README.md](README.md) owns provider registration and real-login acceptance.
No cloud resources or real-provider acceptance are implied by a passing local test.

## Resource inventory

| Boundary | Resources |
| --- | --- |
| Preview | Dedicated test Cloudflare account with a registered workers.dev subdomain; dedicated empty Neon project and parent branch; GitHub `hosted-preview` environment |
| Each PR | `dormouse-hosted-pr-N` Worker, uncached Hyperdrive, and Neon branch, all reused until close |
| Production | Dedicated Dormouse Postgres database, separate runtime/migration roles, uncached Hyperdrive, `dormouse-hosted` Worker and `hosted.dormouse.sh` custom domain; GitHub `hosted-production` environment |
| Email | Dedicated Postmark server, verified `signin@hosted.dormouse.sh`, SPF/DKIM/DMARC, Apple Private Email Relay registration |
| OAuth | Separate Dormouse GitHub, Google, Microsoft, and Apple registrations; exact callbacks in README |
| Release history | `hosted-release-tag` GitHub environment, an admin identity's repository-scoped Contents-write fine-grained PAT, immutable annotated `hosted/` tags |
| Recovery | Neon backups/PITR enabled, encrypted pre-migration dumps retained as GitHub artifacts for 30 days, age identity also retained independently in a password manager |

Cloudflare Workers Scripts and Hyperdrive permissions are account-scoped. A
preview token must not reach production, TTR, or marketing resources. Use a
separate test account. Production deployment isolation also requires a boundary
marketing's existing credentials cannot reach; coordinate the hostname/zone
placement before choosing an account. Naming Workers differently does not limit
a token. Do not reuse TTR's Neon project, mail token, or OAuth registrations.

## GitHub setup

Run once from the repository root with the operator's existing `gh` login:

```sh
node hosted/scripts/setup-github.mjs
```

The script creates/updates the three environments. Ned or Edgar must approve
credentialed jobs, including previews; administrator bypass is disabled.
Production and release tagging admit only `main`. Preview admits `main` and
`refs/pull/*/merge`; same-repository PRs alone can deploy. Self-approval is allowed
for an operator's own deployment. Repository branch/tag protections are unchanged.

### Preview configuration

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

A PR touching `hosted/`, the workflow, vendored packages, or shared build inputs
runs Hosted tests and builds the exact PR merge revision before provisioning.
Forks verify without credentials.
The changed-files check paginates the entire PR and includes renamed source paths.
The URL is in the deployment environment link and job summary; no PR comment bot
or write-scoped workflow token is needed. Draft PRs receive previews too.

Open `https://dormouse-hosted-pr-N.SUBDOMAIN.workers.dev/`, request a code for a
disposable address, and read it at `/dev/emails`. This inbox is public to anyone
with the URL. No real email or OAuth provider is contacted. It shows at most 100
messages from the last 24 hours and renders escaped text only. The database
stores messages across Worker restarts; old mail is pruned on capture.

New commits retain the URL and test accounts. Migrations are append-only; to
change an already-applied migration, close the PR, wait for successful cleanup,
then reopen. Closing or merging deletes the Worker, Hyperdrive and Neon branch
even if the final diff no longer touches Hosted. Per-PR runs serialize without
canceling in-flight provisioning. Rerun failed cleanup; already-absent resources
are tolerated. Keep previews enabled until all live previews are removed.
Manual cleanup uses `node hosted/scripts/preview.mjs cleanup` with the preview
environment's credentials and `PR_NUMBER`. These credentials cannot be downloaded
back from GitHub; retain independent copies in your password manager.

### Production configuration

Follow README's production database, runtime-role, mail, domain, and OAuth
steps. Create a Hyperdrive with query caching disabled using the runtime role;
keep its connection host and database identical to the direct migration URL.
The runtime role needs auth-table/schema DML permissions and sequence access;
the migration role owns migrations and can dump the database. Grant defaults for
future migration-created tables/sequences as well. Never put a connection URL
in a command argument. Keep Neon backups and a suitable PITR window enabled.

Store the public IDs and deployment/migration credentials:

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
and the custom-domain zone permissions required for that hostname. The tag PAT
belongs to a repository admin and selects only this repository with Contents
write. It can bypass the existing tag ruleset and can also write code, so it is
isolated from the deploy job in a separately approved main-only environment.
Record its expiry; do not grant tag bypass to the bot or Actions generally.

Runtime auth/mail/OAuth secrets live in the Worker, not GitHub. In your own
terminal, from `hosted/`, authenticate Wrangler to the production account and
run README's hidden `wrangler secret put` commands. The first secret can create
the initial Worker stub; it does not activate account service. Set all required
secrets before release. Replace the checked-in Hyperdrive placeholder for local
operator deployment; CI overrides it with `HYPERDRIVE_ID`. Configure sender and
enabled providers in `wrangler.jsonc`, reviewed in a PR. Deployment preserves
existing Worker secrets and preflight checks required names before migrations.
Microsoft remains disabled until its upstream fix and real callback pass.

## Release and recovery

Merge reviewed code to `main`, then run **Hosted production release**. Default
`promote=false` verifies and builds only. `promote=true` enters the protected
production environment, checks package provenance, database identity, uncached
Hyperdrive and required secret names, creates an encrypted dump and verifies its
decryption/restore into disposable PostgreSQL, uploads the encrypted artifact,
applies/validates migrations, deploys, then checks the live revision, database,
CSRF/cookies, provider start URLs and absent preview/test routes. No real mail is
sent by these smoke checks. README's real-provider acceptance is still required.
Production uses no public candidate hostname or workers.dev alias.

```sh
gh workflow run hosted-production.yml --repo diffplug/dormouse --ref main -f promote=true
```

Only successful live verification unlocks tagging. The exact deployed SHA gets
`hosted/YYYY-MM-DD` in America/Los_Angeles time, followed by `--r2`, `--r3`, etc.
Tags are annotated with verification time and workflow run/attempt, never moved
or overwritten. If only tagging fails, rerun failed jobs: it records the original
deployment without deploying again. Retrying a tag reuses it; redeploying the
same commit records a new deployment. These tags do not trigger desktop `v*`
release workflows and are code history, not database backups.

A failed migration or deployment may already have changed production state;
workflow failure does not automatically reverse it. Use Worker deployment
history for code rollback and investigate database compatibility first.
Restore a backup only after an explicit operator decision, into a separate
database first. Migrations are never rolled back by the release workflow.
Use PostgreSQL 17 for the production database; the backup/restore tooling pins
PostgreSQL 17.11. Preview and auth integration tests exercise disposable databases.

Current provisioning status is discoverable with `gh secret list --env NAME`,
`gh variable list --env NAME`, and each provider console. Configuration presence
alone is not acceptance. The initial vendored pgstencil manifest is dirty;
production preflight intentionally rejects it until refreshed from an accepted
clean revision with matching archive hashes.
