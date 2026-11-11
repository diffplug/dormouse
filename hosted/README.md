# Dormouse Hosted

Four Hono/Cloudflare Workers and the frame Worker `dormouse-frames` on `*.dormouseusercontent.com` are built from this package: the account frontend and auth at `https://hosted.dormouse.sh` (`dormouse-hosted`), the Hosted Relay's account-scoped routes with Pocket at the root and the one-time connection's Burrow route at `https://relay.dormouse.sh` (`dormouse-relay`), the one-time `/connect/` phone page and its client route at `https://try.dormouse.sh` (`dormouse-try`; [the one-time spec](../docs/specs/one-time.md)), and managed-voice speech at `https://voice.dormouse.sh` (`dormouse-voice`). The marketing website is a separate application. Managed voice and the Relay admit a subscribed account, and the admin account as a standing comp (`docs/specs/hosted.md` -> "Entitlement"); billing stays closed until the account Worker holds its Stripe bindings, so until then only the admin gets them. Device-code Burrow enrollment and account-scoped encrypted terminal routing are implemented. Real-provider and live production acceptance remain separate release gates. See [the spec](../docs/specs/hosted.md), whose "Application boundary" owns what each Worker serves.

This file is the whole operator runbook, in the order an operator works: run locally, update packages, set up GitHub, provision previews, provision production, support customers, release, accept, recover. Marketing, desktop releases, Hosted production, and PR previews have separate deployment credentials. A passing local test implies no cloud resource and no real-provider acceptance.

## Run locally

From the repository root, with Docker running:

```sh
pnpm install
dor tool hosted
```

Outside Dormouse, use `pnpm dev:hosted` and open the `http://localhost:<port>` URL it prints. Request a code for a test address and read it at `/api/dev/emails` on that same origin. No real mail is sent, and the development database is isolated by the worktree path; `docs/specs/hosted.md` -> "Development and release" owns what the local entry serves and what production omits. The port is OS-assigned unless you set `PORT`. Do not share this local inbox publicly. The local origin serves the account's Natural Voice routes but not the voice origin's: a Hosted build speaks only at `https://voice.dormouse.sh` (`docs/specs/hosted.md` -> "Development and release").

The same command runs the relay Worker on this database at `http://localhost:8787` (or `RELAY_PORT`), so a dev desktop build enrolls by device code end to end. Start one with `DORMOUSE_RELAY_IS_HOSTED=1 DORMOUSE_RELAY_ORIGIN=http://localhost:8787 pnpm innerdogfood`, choose Local networks only or Anywhere in its Settings → Network, then unfold Hosted Relay and press Enroll remote control (or Turn on Natural Voice) and approve the code at the account origin. Approval needs the entitlement, so sign in there as `ADMIN_EMAIL` (`hosted/server/entitlement.ts`); its code lands in the local inbox. Its port is not OS-assigned, and the try Worker takes the next one, so don't also run `dor tool one-time`, or another checkout's `dor tool hosted`, beside it.

```sh
pnpm test:hosted
pnpm build:hosted
```

Tests run each production Worker in real workerd, the account's with disposable Postgres clones and a local OAuth simulator. `pnpm --filter dormouse-hosted test:miniflare` runs the rendezvous, Pocket, boundary, and push-egress suites alone, without Docker. `test:server-unit` runs the server tests that need neither Docker nor workerd. The build writes each Worker's static files under `dist/<worker>/` (Pocket at `dist/relay/`, `/connect/` at `dist/try/connect/`) and dry-runs every Worker; it does not deploy. Production deploys only through the release workflow.

The one-time rendezvous and `/connect/` page run on their own, without Docker or Postgres (the relay Worker's Relay routes answer 503 there):

```sh
dor tool one-time      # outside Dormouse: pnpm dev:one-time
```

It serves the relay at `http://localhost:8787` (or `PORT`) and the try Worker on the next port, and prints the `DORMOUSE_RELAY_ORIGIN` and `DORMOUSE_RELAY_IS_HOSTED=1` values that point a local dev Burrow build at it; `docs/specs/one-time.md` -> "Dev loop" owns what it runs. A phone cannot reach a loopback origin, so a real phone tests against a PR preview.

### Run against Stripe test mode

The local entry uses StripeDev unless all five `STRIPE_*` bindings are in its environment, then real Stripe with the key's mode; it refuses a live key. Mail still lands in the local inbox. Use a sandbox's secret key and test-mode Prices.

`stripe listen` cannot carry billing's webhook: it forwards events at the account's default API version even with `--use-configured-webhooks`, and the Worker answers any version but the SDK's pinned `STRIPE_API_VERSION` with 400. Create an endpoint with `--api-version` set to the pinned version, the events under "Stripe setup", and a URL on a temporary tunnel, and use its signing secret as `STRIPE_WEBHOOK_SECRET`. The tunnel must reach only `POST /api/billing/webhook`, through a proxy that sends `Host: localhost:$PORT`, because the local origin holds login codes (`hosted/server/dev-host-guard.ts`) and refuses other hosts. That guard also refuses Stripe's cross-site return to `/billing`, so reopen the page by hand; a deployed origin has no such guard.

A test clock needs its customer from the start: after the first checkout creates the account's customer, expire that session, set `customer_id` in `pgstencil_billing.accounts` to a customer on the clock with the same `pgstencil_owner` metadata, delete the account's `pgstencil_billing.checkouts` row, and check out again. A clock moves only Stripe's dates, never Hosted's notice or withdrawal windows.

## Update pgstencil

`hosted/package.json` installs released `pgstencil`, `@pgstencil/auth`, and `@pgstencil/stripe` from npm. They share a version and Hosted declares their peer dependencies. Approved pgstencil releases are exempt from the pnpm and Renovate cooldowns because the release workflow requires a passing security audit, stages the archives, and requires a maintainer's 2FA approval before publishing.

Run `pnpm install` and re-run Hosted's integration tests after an update. A new migration source in a package goes into `hosted/pgstencil.json`, the list the `pgstencil` command behind `db:*` and `hosted/server/migrations.ts` both read. The production preflight reads `dist/provenance.json` from the installed packages and requires matching clean commits. `docs/specs/security-hosted.md` -> "Deployment boundary" owns the upstream audit check. For an unreleased change, pack pgstencil in a clean checkout and use a temporary pnpm override on a branch.

## Resource inventory

| Boundary | Resources |
| --- | --- |
| Preview | Dedicated test Cloudflare account with a registered workers.dev subdomain; dedicated empty Neon project and parent branch; GitHub `hosted-preview` environment |
| Each PR | `dormouse-hosted-pr-N`, `dormouse-relay-pr-N` (with its own `RelayRoom` Durable Object namespace), `dormouse-try-pr-N` (with its own `OneTimeRoom` one), and `dormouse-voice-pr-N` Workers, one uncached Hyperdrive all three share as the branch's owner role, and a Neon branch, all reused until close; rate-limit namespaces `1001`–`1007` shared by every preview |
| Production | Dedicated Dormouse Postgres database, a migration role and one runtime role per Worker, three uncached Hyperdrives, one per Worker connecting as its role; Workers `dormouse-hosted` (`hosted.dormouse.sh`, with rate-limit namespace `7`), `dormouse-relay` (`relay.dormouse.sh`, with its `RelayRoom` Durable Object namespace and rate-limit namespaces `1` and `3`–`6`), `dormouse-try` (`try.dormouse.sh`, with its `OneTimeRoom` Durable Object namespace and rate-limit namespace `2`, and no Hyperdrive), `dormouse-voice` (`voice.dormouse.sh`, with the history-sweep and idle-token Cron Triggers), each on its custom domain, and `dormouse-frames` (the `*.dormouseusercontent.com/*` route, with no Hyperdrive); GitHub `hosted-production` environment |
| Email | Dedicated Postmark server, verified `signin@dormouse.sh` and `support@dormouse.sh`, SPF/DKIM/DMARC, Apple Private Email Relay registration |
| OAuth | Separate Dormouse GitHub, Google, Microsoft, and Apple registrations; exact callbacks below |
| Release history | `hosted-release-tag` GitHub environment, the `dormouse-hosted-tagger` GitHub App, the `Hosted tag creation` and `Hosted tag history` tag rulesets, immutable annotated `hosted/` tags |
| Recovery | Neon backups/PITR enabled, encrypted pre-migration dumps retained as GitHub artifacts for 30 days, age identity also retained independently in a password manager |

Cloudflare Workers Scripts and Hyperdrive permissions are account-scoped, so previews need their own test account. `docs/specs/security-ci.md` -> "Hosted Deployments" owns the credential placement the audit checks.

### Production registration identifiers

Public identifiers recorded during provisioning on 2026-09-29; secret values remain in the Worker, protected GitHub environments, and Bitwarden.

| Service | Dedicated registration |
| --- | --- |
| Cloudflare | Account `0a95e814ccf2b6a95d2dc3bea0a4a2b4`; Workers `dormouse-hosted`, `dormouse-relay`, `dormouse-try`, `dormouse-voice`, `dormouse-frames`; the account's Hyperdrive ID in `wrangler.jsonc`, the relay's and voice's in `wrangler.relay.jsonc` and `wrangler.voice.jsonc` once provisioned (all zeros until then) |
| Neon | Project `young-dust-56119072`; production branch `br-billowing-brook-b4cuf3y4`; database `neondb`; migration role `neondb_owner`; SQL-created runtime role `dormouse_app`, the account Worker's; `dormouse_relay` and `dormouse_voice`, created NOLOGIN and granted by the release, then given LOGIN by hand for the relay's and voice's Hyperdrives |
| Postmark | Server `21034461`, `dormouse-hosted`; senders `signin@dormouse.sh` and `support@dormouse.sh`, each also an Apple Private Email Relay source; return path `pm-bounces.dormouse.sh` |
| GitHub OAuth | DiffPlug organization app `3890420`; client ID `Ov23liX1HSz03AAN3Psf` |
| Google | Project `diffplug-dormouse`; client ID `168454028617-aecm16ka4nodv6a72u2aolgqurkr4gaj.apps.googleusercontent.com` |
| Microsoft | DiffPlug tenant `cf6a3474-e2f1-498a-9109-706289336d8a`; client ID `be9f84a1-fc52-4a50-afcb-c659c11a1f17` |
| Apple | Team `LXW8WAGWYX`; primary App ID `sh.dormouse.standalone`; Services ID `sh.dormouse.hosted`; signing key `UFV5N9DWJS` |

The Apple client-secret JWT expires **2027-03-28 05:33 UTC**; renew by **2027-02-26** using the signing key in Bitwarden. Microsoft's secret was created with a 180-day expiry; its exact expiry is saved with it in Bitwarden. Apple's private relay has the exact sender and the Postmark return-path domain registered. Provisioning these registrations does not establish acceptance.

The public policy pages are live. Google is external and in production; its branding is verified and published, with only OpenID, email, and profile scopes.

## GitHub setup

Run once from the repository root with the operator's existing `gh` login:

```sh
node hosted/scripts/setup-github.mjs
```

The script creates or updates the three environments with the branch policies, required reviewers (none on the tag environment), and disabled administrator bypass that `docs/specs/security-ci.md` -> "Hosted Deployments" owns. Repository branch and tag protections are unchanged.

## Provision PR previews

In Cloudflare, create the dedicated preview account, register its workers.dev subdomain, and create a token with **Workers Scripts: Edit** and **Hyperdrive: Edit**, scoped only to that account; the first also deploys the Durable Object and rate-limit bindings. No zone/DNS access is needed. In Neon, create a dedicated preview project with an empty parent branch, default `neondb` database and `neondb_owner` role. Use a project-scoped API key where supported. Record the project and parent branch IDs; never select a production parent.

These commands prompt invisibly for tokens; the generated auth secret goes directly to GitHub:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo diffplug/dormouse --env hosted-preview
gh secret set NEON_API_KEY --repo diffplug/dormouse --env hosted-preview
openssl rand -hex 32 | gh secret set PREVIEW_AUTH_SECRET --repo diffplug/dormouse --env hosted-preview
```

Replace the public placeholders below. The subdomain is just its label, with no dots, protocol, or `.workers.dev` suffix:

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --repo diffplug/dormouse --env hosted-preview --body 'PREVIEW_ACCOUNT_ID'
gh variable set CLOUDFLARE_WORKERS_SUBDOMAIN --repo diffplug/dormouse --env hosted-preview --body 'SUBDOMAIN'
gh variable set NEON_PROJECT_ID --repo diffplug/dormouse --env hosted-preview --body 'PREVIEW_PROJECT_ID'
gh variable set NEON_PREVIEW_PARENT_BRANCH --repo diffplug/dormouse --env hosted-preview --body 'EMPTY_PARENT_BRANCH_ID'
# Enable last, at repository scope so job selection can read it before entering an environment.
gh variable set HOSTED_PREVIEWS_ENABLED --repo diffplug/dormouse --body true
```

A PR touching Hosted runs its tests and builds; adding the `hosted-preview` label provisions a preview, which still waits for an environment reviewer's approval; `docs/specs/hosted.md` -> "PR previews" owns which PRs qualify and what each one gets. The URL is in the deployment environment link and job summary; no PR comment bot or write-scoped workflow token is needed.

Open `https://dormouse-hosted-pr-N.SUBDOMAIN.workers.dev/`, request a code for a disposable address, and read it at `/dev/emails`. The PR's one-time page is at `https://dormouse-try-pr-N.SUBDOMAIN.workers.dev/connect/`; its voice Worker has no ElevenLabs key, so speak never reaches ElevenLabs. This inbox is public to anyone with the URL. No real email or OAuth provider is contacted. A preview's Hyperdrive connects as its branch's owner role, so a preview never exercises the relay's and voice's restricted roles: a missing grant passes there, and `pnpm test:hosted`, which binds those Workers to their roles, is what catches it. The database stores messages across Worker restarts.

New commits retain the URL and test accounts. Once a PR closes or loses the label, the next approved preview deploy of any PR deletes its four Workers, Hyperdrive, and Neon branch first. Migrations are append-only; to change an already-applied migration, delete the preview with `node hosted/scripts/preview.mjs cleanup`, given the preview environment's credentials and `PR_NUMBER`, then redeploy. A preview database also holds `hosted/server/preview-migrations/`, so inspect one with `db:status:preview` and `db:validate:preview`; the plain scripts report that file missing. Keep previews enabled until all live previews are removed. These credentials cannot be downloaded back from GitHub; retain independent copies in your password manager.

## Provision the production boundary

Use dedicated Dormouse resources in the existing Cloudflare, Neon, and Postmark accounts.

1. Create a dedicated Dormouse production Postgres database on Neon, on PostgreSQL 18; the backup/restore tooling pins PostgreSQL 18.6. Keep development and previews separate. Enable backups and a suitable PITR window, and verify a restore into a separate database before accepting real accounts.
2. Create three Cloudflare Hyperdrive configurations for that database, each with **query caching disabled** and its connection host, port, and database identical to the direct migration URL: the account's as `dormouse_app`, the relay's as `dormouse_relay`, and the voice's as `dormouse_voice` (step 3 makes each role). Enter connection credentials directly in Cloudflare; set the resulting public IDs in `wrangler.jsonc`, `wrangler.relay.jsonc`, and `wrangler.voice.jsonc` respectively for local operator deployment. CI overrides them with the `HYPERDRIVE_ID`, `RELAY_HYPERDRIVE_ID`, and `VOICE_HYPERDRIVE_ID` variables, and the release's preflight checks each one's caching, database, and role before it backs up anything.
3. Create the runtime role with SQL (`CREATE ROLE ... LOGIN PASSWORD ...`), not Neon’s Console/API role creation, which grants `neon_superuser`. Neon requires the password over the encrypted connection and rejects a precomputed password hash. Keep it out of command arguments and SQL-editor history. Give the runtime role only the auth-table and schema DML permissions plus sequence access the shipped tables need, including defaults for future migration-created tables and sequences. Keep a separate migration role that owns migrations and can dump the database. Supply its `DATABASE_URL` through a secret manager, never in a command argument, then run `pnpm --filter dormouse-hosted db:migrate` and `db:validate`. These commands never reset or drop an existing database. `db:migrate` then applies `hosted/server/runtime-roles.sql` (alone: `db:roles`), which creates `dormouse_relay` and `dormouse_voice` NOLOGIN and resets their grants; its header states what it never changes. Before creating their Hyperdrives, run `db:roles` once if no release has applied the file yet, then give each a password with SQL as the migration role over the encrypted connection (`ALTER ROLE dormouse_relay LOGIN PASSWORD ...`, likewise `dormouse_voice`), never Neon's Console, whose roles the file refuses.
4. Set up a dedicated Postmark server/token and verify the sending address `signin@dormouse.sh` (or update `EMAIL_FROM`). Configure SPF/DKIM and DMARC. Register the sender with Apple Private Email Relay for relay-address delivery.
5. Each Worker's config claims its own custom domain — `hosted.dormouse.sh`, `relay.dormouse.sh`, `try.dormouse.sh`, `voice.dormouse.sh` — and the first deploy of each creates it, refusing a hostname that already has a DNS record. Exclude all four hostnames from Cloudflare Web Analytics, Zaraz, and other script injection or rewriting rules. Disable account API caching. Keep `workers_dev` and public preview URLs disabled.
6. The frame Worker's route needs a proxied wildcard record on the `dormouseusercontent.com` zone before its first deploy: `*`, type `AAAA`, content `100::`, Proxied. Universal SSL covers one label, which is all a frame origin uses. Keep nothing else on this zone.

Authenticate Wrangler to the intended Cloudflare account before provisioning. Inside Dormouse, run `dor ensure -- pnpm exec wrangler login --browser=false --use-keyring` from `hosted/`, then open the printed authorization link with `dor agent-browser`. Review the account and requested access before granting it. Secrets remain in the OS keychain. Authenticate in your own terminal; account/provider sign-in is operator-owned.

## Separate OAuth registrations

Create Dormouse registrations. Register these exact URLs with no trailing slash; every callback stays on the account Worker's `hosted.dormouse.sh`:

| Provider | Registration | Callback |
| --- | --- | --- |
| GitHub | Organization-owned OAuth App, identity/email scopes only | `https://hosted.dormouse.sh/api/auth/callback/github` |
| Google | Web application OAuth client under a Dormouse consent configuration | `https://hosted.dormouse.sh/api/auth/callback/google` |
| Microsoft | Entra application: personal and work/school accounts; Web platform | `https://hosted.dormouse.sh/api/auth/callback/microsoft` |
| Apple | Dormouse Services ID associated with a Sign in with Apple primary App ID | `https://hosted.dormouse.sh/api/auth/callback/apple` |

Use `https://hosted.dormouse.sh` as the application origin. Google's consent homepage is `https://dormouse.sh/hosted/`, which describes the account service; its privacy and terms URLs are `https://dormouse.sh/privacy/` and `https://dormouse.sh/terms/`. Publish approved pages before submitting branding. Configure consent branding, support contact, and production/test-user settings before testing with ordinary accounts. For Google, add the exact callback under authorized redirect URIs, and the Hosted origin under authorized JavaScript origins if requested.

For Microsoft, request optional ID-token claims `email` and `xms_edov`. Store the client-secret **Value**, not its identifier, and record its expiry. The installed pgstencil release includes the callback fix. Verify real personal and work/school callbacks during Dormouse acceptance.

The marketing site serves `website/public/.well-known/microsoft-identity-association.json` at `https://dormouse.sh/.well-known/microsoft-identity-association.json` for Microsoft publisher-domain verification. Promote the website before using **Update domain** in Entra; publisher verification through Partner Center is separate from domain verification.

For Apple, register domain `hosted.dormouse.sh` and the return URL above. The client ID is the Services ID; the client secret is an ES256 JWT signed with the Apple key (Team ID issuer, Services ID subject, Apple audience, key ID header). Keep the signing key in your secret manager, generate the JWT locally, and renew it before expiry (at most six months). The callback accepts Apple's form POST and uses the package's browser-bound relay; do not replace it with a generic JSON/CSRF handler. Schedule secret-expiry reminders before activation.

## Enter secrets yourself

Never paste secrets into chat, source files, URLs, command arguments, or build logs. `.dev.vars*` and `.env` under `hosted/` are ignored; use only isolated test credentials there.

### Deployment credentials in GitHub

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --repo diffplug/dormouse --env hosted-production --body 'PRODUCTION_ACCOUNT_ID'
gh variable set HYPERDRIVE_ID --repo diffplug/dormouse --env hosted-production --body 'ACCOUNT_HYPERDRIVE_ID'
gh variable set RELAY_HYPERDRIVE_ID --repo diffplug/dormouse --env hosted-production --body 'RELAY_HYPERDRIVE_ID'
gh variable set VOICE_HYPERDRIVE_ID --repo diffplug/dormouse --env hosted-production --body 'VOICE_HYPERDRIVE_ID'
gh secret set CLOUDFLARE_API_TOKEN --repo diffplug/dormouse --env hosted-production
gh secret set DATABASE_URL --repo diffplug/dormouse --env hosted-production
gh secret set BACKUP_AGE_IDENTITY --repo diffplug/dormouse --env hosted-production
gh variable set HOSTED_TAG_APP_CLIENT_ID --repo diffplug/dormouse --env hosted-release-tag --body 'Iv23liADZP0hPRZCYRz8'
gh secret set HOSTED_TAG_APP_PRIVATE_KEY --repo diffplug/dormouse --env hosted-release-tag < PATH_TO_DOWNLOADED_KEY.pem
```

`DATABASE_URL` is the direct migration-role Postgres URL. Generate the age identity with `age-keygen` into private password-manager storage, then enter it at the hidden prompt; preserve that independent copy and old keys on rotation. Use a production Cloudflare token covering Workers deployment (which includes the Durable Object migrations, rate-limit bindings, and Cron Triggers), Workers secret listing, Hyperdrive read, the custom-domain zone permissions for all four hostnames, and Workers Routes edit on the `dormouseusercontent.com` zone.

The tag job authenticates as `dormouse-hosted-tagger`, a private GitHub App owned by `diffplug` (App ID `5228264`) (client ID `Iv23liADZP0hPRZCYRz8`) with Contents write, Metadata read, no webhook or events, and one installation selecting only this repository. The App is a bypass actor on `Hosted tag creation` alone, so it can create `hosted/` tags but never move or delete one, and `v*` tags stay admin-only; `docs/specs/security-ci.md` -> "Hosted Deployments" owns these checks. Do not grant tag bypass to the bot or Actions generally.

Rotate the key yearly and on any suspected exposure, with a reminder in Bitwarden: generate a new private key on the App's settings page, set it with the `gh secret set HOSTED_TAG_APP_PRIVATE_KEY` line above, delete the local `.pem`, and delete the old key on the settings page. A tag job that fails on a bad key can be re-run alone once the secret is fixed; it never records a deployment twice.

### Runtime secrets in the Workers

Auth, mail, and OAuth secrets live in the account Worker, the enrollment secret and the Web Push (VAPID) pair in the relay Worker, and the ElevenLabs key in the voice Worker, never GitHub. In your own terminal, from `hosted/`, authenticate Wrangler to the production account and use its hidden prompt, never a command-line value:

```sh
pnpm exec wrangler secret put AUTH_SECRET
pnpm exec wrangler secret put POSTMARK_SERVER_TOKEN
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put MICROSOFT_CLIENT_SECRET
pnpm exec wrangler secret put APPLE_CLIENT_SECRET
pnpm exec wrangler secret put RELAY_ENROLL_SECRET --config wrangler.relay.jsonc
pnpm exec wrangler secret put ELEVENLABS_API_KEY --config wrangler.voice.jsonc
```

The voice Worker's first secret creates its stub, so set it before the first release that deploys `dormouse-voice`: preflight reads it there. Once that release is live, delete the copy the account Worker held before the split (`pnpm exec wrangler secret delete ELEVENLABS_API_KEY`); its mapper no longer reads it, but a secret should live only where it is used.

Create `ELEVENLABS_API_KEY` for an ElevenLabs service account dedicated to Dormouse voice, with history access isolated from other workspace usage — the Worker deletes every speech-history item its key can see on a schedule. Restrict the key to text-to-speech, speech-history access, and reading the subscription (the admin page's ElevenLabs plan, which warns when it cannot read it), and set a spending limit in the ElevenLabs console. How the Worker uses the key is `docs/specs/hosted.md` -> "Managed voice".

Generate a fresh cryptographically random `AUTH_SECRET`, and separately `RELAY_ENROLL_SECRET`, each with at least 32 bytes of entropy in your secret manager. Rotating `RELAY_ENROLL_SECRET` only voids enrollments in progress. Client IDs are public but may be stored through the same prompts as `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, and `APPLE_CLIENT_ID`. The first secret can create the initial Worker stub; it does not activate account service. Set all required secrets before release; deployment preserves the ones already there.

Generate the relay's VAPID pair once, in a private directory, and load both halves as relay secrets without printing them; keep a copy of the JSON in your secret manager, then delete it:

```sh
umask 077
node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto";
const { d, x, y } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ format: "jwk" });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
console.log(JSON.stringify({
  RELAY_VAPID_PUBLIC_KEY: point.toString("base64url"),
  RELAY_VAPID_PRIVATE_KEY: d,
}));' > vapid.json
pnpm exec wrangler secret bulk vapid.json --config wrangler.relay.jsonc
rm vapid.json
```

The public half is public (`GET /api/push/config` serves it); the private half signs every push. Both are required for a production deploy: preflight refuses a relay Worker missing either. Cloudflare exposes a secret's name, never its value, so preflight cannot tell whether the two match; the relay answers push off for a pair that does not, and the release's live verification fails unless `/api/push/config` answers the key. Rotating the pair makes every phone's subscription stale until Pocket re-registers it, so rotate only on compromise. Previews derive their own pair and never need this one.

Billing stays closed, and its Cron Trigger idle, until the account Worker holds all five Stripe bindings: the secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and the vars `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and `STRIPE_PRICES_FOUNDING` in `wrangler.jsonc` (`docs/specs/hosted.md` -> "Billing"). Set none of them before checkout opens. `db:migrate` grants `dormouse_app` the `pgstencil_billing` schema itself (`hosted/server/runtime-roles.sql`), since that schema is the package's and no hand grant can precede it. Before opening checkout, turn on Stripe's customer emails for successful payments: the `/billing` confirmation tells a buyer Stripe sends each receipt. Turn on cancellation in the customer portal too: the confirmation sends a member to Manage billing to cancel. The account Worker emails purchase confirmations, withdrawal acknowledgements, subscription notices (renewal and annual reminders, price changes, dispute suspensions and restorations), and the [billing alert](#billing-alert) through the same Postmark server as sign-in codes, from `support@dormouse.sh`, so that sender must be verified there.

Configure the sender and enable each ready provider in `OAUTH_PROVIDERS` in `wrangler.jsonc`, comma separated, reviewed in a PR. The checked-in file enables GitHub, Google, Microsoft, and Apple; `docs/specs/hosted.md` -> "Identity and login" owns what a name and a credential pair do and do not enable. Facebook is outside this milestone.

## Stripe setup

One Stripe account holds only Dormouse, because retries, customer emails, and the default portal are account-wide. Do this in its sandbox first, then live. Checked against a sandbox on 2026-11-03.

- **Product:** one, with a tax code. **Prices:** recurring, USD, `tax_behavior=exclusive`, whole dollars matching `website/src/lib/hosted-pricing.ts`: `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and `STRIPE_PRICES_FOUNDING`, comma-separated in `FOUNDING_LADDER` order.
- **Stripe Tax:** head office, default tax code, and a registration everywhere the business must collect. It collects only where registered.
- **Customer portal, the default configuration:** cancel at period end with no proration or reason, payment methods, invoice history, email and address; **plan switching off**, since a Price billing does not know fails that owner's webhooks and leaving founding loses the lock.
- **Revenue recovery:** Settings → Billing → Subscriptions and emails → Manage failed payments → Card payments: **Smart Retries, up to 8 times within 2 months**; on the first failed renewal attempt, leave the subscription past due; if all retries fail, cancel it; if a dispute is opened, leave it past due. The window must stay at least 30 days, since a founder keeps the lock only while Stripe retries (`docs/specs/pricing.md`); 1 month is 28 days, too short. Set on 2026-11-10 in the main account's test mode and the sandbox; **recheck it in live mode once live exists**, since whether live inherits it is unknown. Failed-payment emails on, since Hosted sends none, with a Stripe-hosted link.
- **Customer emails:** successful payments and refunds on.
- **Link:** on. Its instant bank payments come with it, with no separate switch, so Checkout offers "Pay with Bank" beside cards; a refund to a bank account takes a few days to succeed, and a withdrawal or closure it pays stays unsettled until then.
- **Webhook endpoint:** `https://hosted.dormouse.sh/api/billing/webhook`, created through the API with `api_version` set to the SDK's pinned `STRIPE_API_VERSION`, since any other version is refused with 400. Its events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `invoice.paid`, `invoice.payment_failed`.

## Move the Stripe API version

The webhook accepts only events at the installed `stripe` SDK's pinned API version (`STRIPE_API_VERSION`, re-exported by `@pgstencil/stripe`), and the endpoint renders events at the version it was created with. The SDK moves that version in minor releases, so `hosted/server/tests/stripe-api-version.test.ts` pins the literal, `stripe` is held to its minor with a `~` range, and Renovate holds `stripe` and `@pgstencil/stripe` for approval on the dependency dashboard. A move is this procedure, never a routine update.

**Exercised twice in the sandbox, 2026-11-10 and 2026-11-11** (stripe 22.6.2 at `2026-08-26.dahlia` to 23.1.0 at `2026-10-28.endive`, the second time with the released pgstencil 0.5.1: two local builds on one database behind a tunnel); not yet in live mode, nor on the Workers. In the sandbox first, then live:

1. Move `@pgstencil/stripe` and `stripe` together, to releases that pin the same new API version, changing the literal in `stripe-api-version.test.ts` in the same change.
2. Create a second webhook endpoint at the new version, with the events under "Webhook endpoint" above, while the old one stays enabled. Give its URL a query string naming the version (`/api/billing/webhook?endpoint=endive`; the route ignores it), because Stripe's event page merges the attempts of two endpoints that share a URL into one row. Stripe delivers each event to every enabled endpoint, and the Worker still on the old SDK answers the new endpoint's copies 400, which Stripe retries.
3. Run `pnpm db:status` and `pnpm db:validate` from the new build against the database, then deploy the Worker built against the new SDK with the new endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. From here the old endpoint's copies get 400 and the new one's 200.
4. Reconcile every owner at once, without waiting for Stripe: from `hosted/`, with the migration role's `DATABASE_URL` and the five `STRIPE_*` bindings in the environment from your secret manager, run `pnpm billing:reconcile --dry-run`, then `pnpm billing:reconcile`; a live key also needs `--allow-live`. It prints one line per owner whose stored subscriptions changed, each one event the webhook has not applied, and the counts, and exits non-zero if any owner failed. The account cron's resync (`resyncBilling` in `hosted/server/billing.ts`) finds only owners holding a current subscription without access, so it never repairs a cancellation or refund.
5. Confirm the new endpoint's deliveries succeed in Stripe's dashboard.
6. Run `pnpm billing:reconcile --dry-run` again. No owner changing is the proof that nothing was lost; then disable the old endpoint.

What the rehearsals established:

- An event delivered to both endpoints is applied once: the copy that arrives second answers 200 and writes nothing.
- An event that fails at both endpoints while nothing serves is repaired by step 4 at once. Left to Stripe, the new endpoint's retry repairs it too, but late: the sandbox retried once after about 14 seconds and next after about an hour.
- The old endpoint's refused copies show as failed deliveries with a next retry until it is disabled, and stay pending on their events afterwards; nothing else alerts.
- On the new version, against Stripe itself: Checkout, a withdrawal with its full refund, a dispute lost and a dispute won, and a portal session.
- Rollback is open until step 6: this move added no migration (the new build's `db:validate` matched the old build's database and `db:migrate` found nothing pending) and Hosted stores no Stripe object, so the old build runs on the same database with the old endpoint's secret.

Not covered: an event that had already failed at the old endpoint before the new one existed is retried only to the old endpoint, which the new Worker refuses, so only step 4 repairs it. Live mode's retry schedule differs from the sandbox's and is unobserved. A price change's move to its new Price and an account closure have not run at the new version.

## Change a price

A list price change for existing monthly or yearly subscribers is one row in `dormouse_price_changes`; the account cron sends each subscriber's notice and moves them to the new Price from their first renewal that notice reached in time (`docs/specs/hosted.md` -> "Billing notices"). Founding Prices never change, and the cron refuses a row naming one.

1. In Stripe, create the new recurring Price on the same product: USD, the same interval, a whole-dollar amount.
2. Insert the row as the migration role. `effectiveAt` is the first moment a renewal may charge the new price. Notices go out 21 days before each subscriber's renewal, or at once for one renewing sooner, and a subscriber whose renewal is within 8 days moves at the one after:

   ```sql
   INSERT INTO dormouse_price_changes (id, plan, "fromPriceId", "toPriceId", "fromUsd", "toUsd", "effectiveAt")
   VALUES ('monthly-2027', 'monthly', 'price_old', 'price_new', 10, 12, '2027-03-01T00:00:00Z');
   ```

   From then on, both Prices grant the plan. Each run checks the row against Stripe and fails, sending no notice, until both Prices match their amounts and interval; the [billing alert](#billing-alert) says so.
3. On `effectiveAt`, in one reviewed release, point `STRIPE_PRICE_MONTHLY` (or `STRIPE_PRICE_YEARLY`) at the new Price and change the published price in `website/src/lib/hosted-pricing.ts`, so new checkouts sell it. Keep the row afterwards: it is what still recognizes the old Price for anyone not yet moved.

Never edit a row once its notices have gone out; schedule a further change as a new row from the new Price.

## Billing alert

When the account cron's billing pass fails, the Worker emails `support@dormouse.sh` through Postmark with each error message, leading with anything overdue: a withdrawal unsettled a day after its notice, with its 14-day refund deadline; a closure unsettled after a day; a withdrawal's acknowledgement unsent after a day. A distinct error mails at most once a day, so a persistent failure repeats daily, and the run fails either way. `docs/specs/hosted.md` -> "Billing alert" owns the rules.

| The mail says | Do |
| --- | --- |
| `paid outside Stripe`, `refund awaits the customer's action` | [Refund by hand](#refund-by-hand), before the deadline it names |
| `refund not yet succeeded` | Nothing unless a deadline is near: Stripe is completing it, and the cron settles it. Near one, ask Stripe why |
| `acknowledgement unsent`, `gave no billing email`, or the same `Notice` line (`withdrawal` or `purchase`) for days | [Acknowledgement by hand](#acknowledgement-by-hand) |
| `Price change` | [Change a price](#change-a-price): fix or delete the row |
| Anything else | Usually a Stripe, Postmark, or database outage, which the next runs clear. Past a day, the same line returns, and it is a bug to fix |

The alert cannot report a cron that stopped running, or mail Postmark refuses: `observability` is off, so a failed alert leaves only the failed run in the account Worker's Cron Events. Look there weekly while any withdrawal is open.

Exercise it before opening checkout, and after any Postmark change. With billing's bindings set, add a price change the cron refuses, as the migration role; within 10 minutes the mail arrives, then delete the row:

```sql
INSERT INTO dormouse_price_changes (id, plan, "fromPriceId", "toPriceId", "fromUsd", "toUsd", "effectiveAt") VALUES ('alert-test', 'yearly', 'price_alert_test', '<a founding Price>', 50, 60, now());
DELETE FROM dormouse_price_changes WHERE id = 'alert-test';
```

## Refund by hand

A whole-charge refund ends the subscription it paid for. To correct a billing mistake and keep the subscription, make the refund with the metadata on it, from the Stripe CLI or Workbench rather than the Dashboard's refund form, whose `charge.refunded` event would arrive before any metadata you add afterwards: `stripe refunds create --live --charge=<charge id> -d "metadata[dormouse_keep_subscription]=true"`. Only the refund that completes the charge counts, so split refunds need it on the last one.

A withdrawal or account closure is stamped settled only once every payment it refunds is refunded in full by refunds Stripe lists as `succeeded`. Until then its cron keeps retrying it and failing, naming the invoice, for as long as it stays unsettled, which the [billing alert](#billing-alert) reports. A `pending` refund settles on its own once Stripe completes it, and the account Worker makes a `failed` or `canceled` one again. Two cases need the operator:

- **Paid outside Stripe.** Stripe cannot refund a payment it did not collect: an invoice marked paid out of band, or paid by a payment record. The error names the invoice and the amount.
- **A refund awaiting the customer's action.** Stripe holds the refund in `requires_action` until the customer gives it what their payment method needs; the error names the invoice and the payment. Once they do and it succeeds, the cron settles it on its own. To refund another way instead, do step 2 first, so the cron makes no new refund, then cancel that refund in the Stripe Dashboard, then step 1.

1. Refund the named amount to the customer the way it was paid, outside Stripe.
2. As the migration role, mark a withdrawal settled by the id the error names; for a closure, drop the subscription id the error names from it, and the cron's next pass refunds any other subscription the closure ended and stamps it settled once none is left:

   ```sql
   UPDATE dormouse_withdrawals SET "settledAt" = now() WHERE id = '<withdrawal id>';
   UPDATE dormouse_account_closures SET "canceledSubscriptions" = array_remove("canceledSubscriptions", '<subscription id>') WHERE '<subscription id>' = ANY ("canceledSubscriptions") AND "settledAt" IS NULL;
   ```

## Acknowledgement by hand

A withdrawal's acknowledgement email is retried until it is sent, and the cron fails every run once one is a day overdue, naming the withdrawal. It cannot send while Stripe holds no billing email for the customer (the address was removed, or the customer deleted), which the cron's errors also say.

1. Send the acknowledgement another way, to an address the customer gave: the withdrawal's plan, the date it was submitted, and that the subscription ends and is refunded.
2. Record it as sent, with the address it went to, as the migration role, by the withdrawal id the error names:

   ```sql
   UPDATE dormouse_billing_notices SET "sentAt" = now(), email = '<address it was sent to>' WHERE "withdrawalId" = '<withdrawal id>' AND "sentAt" IS NULL;
   ```

A purchase's confirmation is retried until sent too, with no overdue line, so one Postmark refuses (an address it holds inactive after a bounce or a spam complaint) fails every run, naming the notice. Send what the customer agreed to another way, then record it as sent by the notice id the error names:

```sql
UPDATE dormouse_billing_notices SET "sentAt" = now(), email = '<address it was sent to>' WHERE id = '<notice id>' AND kind = 'purchase' AND "sentAt" IS NULL;
```

## Support runbooks

Owner: `support@dormouse.sh`, which answers every request within 24 hours. A deadline that needs sooner says so.

SQL runs as the migration role. `stripe` commands run from the Stripe CLI logged in to the live account (add `--live`), or the Dashboard's Workbench shell.

### Find and verify the customer

The Terms let us verify ownership, and forbid requiring account recovery. Most runbooks below start here.

1. Find the Stripe customer by the sender's email in the Dashboard's search, or by a charge they describe (`last4:4242`). Its `metadata.pgstencil_owner` is the Hosted account id.
2. Take either as proof, and nothing more: a reply from the Stripe customer's email to a message you sent it, or the last4, date, and amount of a charge on that customer. Never ask for a full card number, a password, or a sign-in. Say nothing to an unverified sender about whether an address has an account.
3. Read the account's subscriptions; a current one has a status of `active`, `trialing`, `past_due`, `unpaid`, `paused`, or `incomplete`:

   ```sql
   SELECT s.owner_id, a.customer_id, s.id, s.price_id, s.status, s.started_at, s.ended_at, s.period_end, s.cancel_at_period_end, s.end_reason FROM pgstencil_billing.accounts a JOIN pgstencil_billing.subscriptions s ON s.owner_id = a.owner_id WHERE a.customer_id = '<customer id>' ORDER BY s.started_at;
   ```

### Cancel for someone who cannot sign in

Deadline: the Terms state no number of days, but the cancellation must land before the next renewal, so do it within those 24 hours. If a renewal charged after their request arrived, refund it in full, which also ends the plan.

1. [Find and verify the customer](#find-and-verify-the-customer).
2. Stop the renewal, keeping access through the period they paid for: in the Dashboard, cancel the subscription at the end of the current period, or:

   ```sh
   stripe subscriptions update <subscription id> -d cancel_at_period_end=true
   ```

   A `past_due`, `unpaid`, or `paused` subscription has no paid period left, so cancel it at once: `stripe subscriptions cancel <subscription id> -d prorate=false -d invoice_now=false`.
3. Confirm the webhook arrived: step 3 of finding the customer shows `cancel_at_period_end` true, or the status `canceled`.
4. Email them, at the address they proved: no further charge, and the date access ends. Mention the 30-day refund if a payment is inside it.

### Close an account by email

Deadline: the Terms state no number of days. Closing takes effect as soon as they confirm, so act within those 24 hours. The refunds are the cron's.

1. [Find and verify the customer](#find-and-verify-the-customer). An account with no Stripe customer has only its sign-in email to reply from (`SELECT id FROM "user" WHERE email = '...' AND "emailVerified";`). A provider-only account with neither has nothing to verify against: never delete it on the request. Reply that it can be closed from the account page after signing in with that provider, which needs no recovery, and that without a sign-in nothing shows the account is theirs.
2. Explain, then wait for their yes, as the account page does before it closes (`closureTerms` in `hosted/src/Closure.tsx`): the plan ends now and never renews; a first payment, or a yearly or founding renewal, inside the last 30 days is refunded in full with tax, and otherwise the time left is not; withdrawal and the 30-day guarantee for an earlier payment stay open by email; cancelling renewal instead keeps access through the period.
3. End each current subscription in Stripe, without a refund or a final invoice, then confirm with step 3 of finding the customer that it shows `ended_at`:

   ```sh
   stripe subscriptions cancel <subscription id> -d prorate=false -d invoice_now=false
   ```

4. Record the closure and delete the account in one statement, as the route does. `<subscription ids>` is an array literal of what step 3 ended, `{sub_a,sub_b}`, or `{}` for none:

   ```sql
   WITH recorded AS (INSERT INTO dormouse_account_closures ("userId", "canceledSubscriptions", "settledAt") VALUES ('<account id>', '<subscription ids>'::text[], CASE WHEN cardinality('<subscription ids>'::text[]) = 0 THEN now() END)) DELETE FROM "user" WHERE id = '<account id>';
   ```

5. Within 10 minutes the cron refunds what closing owes and stamps `settledAt`; a failure reaches the [billing alert](#billing-alert). The account's Relay sockets close at the Relay's next sweep. Email them what ended and what was refunded.

### Voluntary 30-day refund

Deadline: they must ask within 30 days of the payment, counted to the day their email arrived. The Terms state no number of days for paying it. Pay it within those 24 hours, and a founding first payment asked about on its 30th day that same day: a founding seat returns only if the subscription ends within 30 days of its start.

| Payment | Refund it? |
| --- | --- |
| The first payment of the customer's first subscription | Yes |
| A yearly or founding renewal | Yes |
| A monthly renewal | No: the guarantee excludes it, though a statutory right may not |
| The first payment of a later subscription, after a cancel or plan change | No: that does not restart the window |

1. [Find and verify the customer](#find-and-verify-the-customer). If they are in the EEA or UK inside 14 days, tell them withdrawal refunds every payment. Find the payment on the customer's page in the Dashboard; the invoice shows why it was billed and when it was paid.
2. Refund the full charge in the Dashboard (**Refund payment**, full amount, reason **Requested by customer**). The charge includes its tax, and Stripe Tax reverses that with it.
3. Stripe's `charge.refunded` ends the subscription at once. Confirm within a minute that it shows `canceled` and `end_reason` `refund`. No cron pass repairs a lost event, so if it still shows current after Stripe's retries, run the cancel command from the closure runbook. A refund of an earlier subscription's charge ends nothing; if they want the current plan ended too, cancel it the same way.
4. Email them: the plan has ended, the amount refunded with tax, and that their bank decides when the credit appears.

A founding refund on a renewal, or one ending after the subscription's 30th day, does not return the seat, because Hosted counts it as a kept purchase. A refund of a whole charge ends the plan whatever it was for; to correct a billing mistake and keep the plan, mark the refund as [Refund by hand](#refund-by-hand) says.

### Withdrawal by email or post

Deadline: refund every payment for the subscription within 14 days after **receiving** the notice, by the original payment method, with no fee or deduction for use. The clock starts when the email or letter arrives, not when someone reads it, so post to DiffPlug's address must be collected well inside that.

They may withdraw within 14 days after the contract, ending at the end of the 14th day in their time zone and later if that is a weekend or public holiday; a notice sent inside that counts, however late it arrives. It needs only to be an unambiguous statement: no reason, no particular form, no account access. If the period has passed or they are outside the EEA and UK, the 30-day refund may still apply, and doubt resolves toward honoring it.

1. Locate the purchase with [Find and verify the customer](#find-and-verify-the-customer), by whatever the notice gives. Ask for more only if you cannot tell whose contract it is; asking does not move the deadline.
2. Record it, so the cron does what the online function does. `<received at>` is when the notice arrived, with its zone, and `<country>` is the customer's billing country, or use `NULL`. This works on an account already closed:

   ```sql
   WITH recorded AS (INSERT INTO dormouse_withdrawals (id, "userId", "subscriptionId", plan, "priceId", "contractStartedAt", country, "submittedAt") SELECT gen_random_uuid()::text, owner_id, id, '<monthly, yearly, or founding>', price_id, started_at, '<country>', '<received at>'::timestamptz FROM pgstencil_billing.subscriptions WHERE id = '<subscription id>' RETURNING id, "userId", "submittedAt") INSERT INTO dormouse_billing_notices (id, "userId", kind, "withdrawalId", "createdAt") SELECT gen_random_uuid()::text, "userId", 'withdrawal', id, "submittedAt" FROM recorded;
   ```

3. In Stripe, do nothing by hand: within 10 minutes the cron ends the subscription at once, refunds every paid invoice with its tax, emails the acknowledgement to the billing email, and stamps `settledAt`. Check that the subscription shows `canceled` and each payment shows refunded. A refund already made by hand counts toward it, so nothing is paid twice.
4. Reply to the sender, whatever address they wrote from: their statement in their own words, when it arrived, that the plan has ended, and the refund. The emailed acknowledgement quotes the online function's statement and goes only to the billing email.
5. From a day after the notice, the [billing alert](#billing-alert) names the withdrawal and its deadline until it settles. A payment Stripe cannot refund is [Refund by hand](#refund-by-hand), by the withdrawal id it names. An acknowledgement that cannot send is [Acknowledgement by hand](#acknowledgement-by-hand).

### Unused-period refund

Owed if we permanently discontinue Hosted, end paid access for a reason other than the customer's material breach, or, during a prepaid term, materially reduce the paid service or materially change the Terms and they choose to end instead of accepting.

Deadline: the Terms state no number of days; the refund runs from when paid access ends, so pay it then. The 30-day window does not apply: this is a separate promise for time we no longer provide, and the Terms say the guarantee does not limit it. No code computes it.

1. End the plan by hand first, as in the closure runbook, without proration: a partial refund leaves a subscription running, and Hosted ends one only when a charge is refunded in full (seen in the sandbox, 2026-11-03). Its `ended_at` is when paid access ended.
2. Compute it from the latest paid invoice alone, as earlier periods were used. On that invoice in the Dashboard, `paid` is the amount paid in cents, tax included, and the period is its line's start and end:

   ```text
   refund = round(paid × (period end − ended_at) / (period end − period start))
   ```

   For example, $119.00 paid with VAT for a 365-day period, ended with 183 days left: 11900 × 183 / 365 = 5966, so $59.66. Subtract nothing for use, and refund no more than the payment has left after any earlier refund.
3. Refund that amount of the invoice's payment in the Dashboard (**Refund payment**, partial, reason **Requested by customer**), never a tax-only amount: Stripe Tax splits a refund between net and tax in proportion, which is the corresponding tax the Terms promise.
4. Email them: when access ended, the arithmetic, and the amount with tax. On discontinuation, do this for every current subscription and leave the Stripe bindings in place until the last refund succeeds and the last event is delivered.

### Restore a founding lock

For a billing-provider migration or a payment failure DiffPlug caused; a founder who cancelled, or whose own failed renewal ran out, subscribes again at list. Deadline: the Terms promise "a reasonable opportunity to restore payment", with no number of days. Offer at least the 30 days a founder gets to fix their own failed renewal, and say the date in writing. Checkout may refuse founding to a lapsed founder, so this is by hand. Checked in a Stripe sandbox on 2026-11-06.

1. [Find and verify the customer](#find-and-verify-the-customer). Their locked Price is the old subscription's `price_id`, which must be in `STRIPE_PRICES_FOUNDING`; after moving to a new Stripe account, those are the new account's Prices at the same ladder steps. Confirm no subscription is current: `owner_access` grants access only for exactly one.
2. Email the offer, plan, base price, renewal date, and how to cancel, and get their written yes: this starts an automatically renewing charge.
3. Create it on that Price. The metadata key is what makes Hosted see it, on the customer `pgstencil_billing.accounts` holds, and the Dashboard's **Create subscription** can set the same fields:

   ```sh
   stripe subscriptions create -d customer=<customer id> -d "items[0][price]=<locked Price>" -d "items[0][quantity]=1" -d "metadata[pgstencil_owner]=<account id>" -d "automatic_tax[enabled]=true" -d payment_behavior=default_incomplete -d "payment_settings[save_default_payment_method]=on_subscription" -d "payment_settings[payment_method_types][0]=card" -d "expand[0]=latest_invoice"
   ```

   Send them the answer's `latest_invoice.hosted_invoice_url`, where they pay and save a card, the only method it offers; Stripe expires an unpaid first invoice after about 23 hours (`incomplete_expired`), and you then create it again. To charge a card they agreed to keep, use `-d default_payment_method=<payment method id> -d payment_behavior=error_if_incomplete` instead. If they already paid through a date, as in a migration, use that card and add `-d billing_cycle_anchor=<period end, Unix time> -d proration_behavior=none`: nothing is charged until then, and it must be under a year away.
4. Verify webhook acceptance. In Developers → Webhooks, `customer.subscription.created` for it must have answered 200: a Price Hosted does not recognize, a quantity other than 1, or the wrong mode makes it, and every later event for that owner, answer 503. Then step 3 of finding the customer must show the new subscription on the locked Price, `active` once paid.
5. Email them the renewal date and price. The new subscription counts as one more purchase at its cohort, an overcount of one seat that is accepted.

### Notices the first time

We must give at least 30 days' notice before we permanently discontinue Hosted, materially reduce paid service during a prepaid term, or materially change the Terms, unless an urgent legal or security requirement prevents it, then as soon as reasonably possible. Nothing sends these yet: the billing notices have no such kind, and sign-in shows no notice to an account without a contact email.

Before the first one, either build a recorded notice to the billing and contact emails, with sign-in presentation for accounts without one, or do this by hand:

1. List who it reaches. A subscriber's goes to the Stripe customer's email. Every account's also goes to its contact email: `SELECT id, email FROM "user" WHERE "emailVerified";`.
2. An account with no contact email and no subscription can only be told at sign-in, which is not built, and a notice not shown starts no period for it. Build the sign-in presentation first, or leave that account on its previous terms.
3. Send each one through Postmark, from `support@dormouse.sh`: what changes, the effective date, how to end the subscription, and the unused-period refund if they do. Record per account the id, address, time, and Postmark message id in private storage; Postmark's own history expires. Resend or follow up a bounce, as an undelivered notice starts nothing.
4. Set the effective date at least 30 days after the last notice actually went out. A new version's date never backdates: `TERMS_VERSION` and the page's date are its revision, publishing it replaces nothing for an existing account, and that account stays on its previous terms until the effective date, or until it expressly agrees sooner. A change never applies to a dispute already begun.

## Release

1. Review the exact package provenance and code revision. Run `pnpm test:hosted`, `pnpm build:hosted`, and the repository lints. Validate production migrations.
2. Merge reviewed code to `main`, then run **Hosted production release**:

   ```sh
   gh workflow run hosted-production.yml --repo diffplug/dormouse --ref main -f promote=true
   ```

   Default `promote=false` verifies and builds only. `promote=true` enters the protected production environment and runs the preflight, backup and restore-test, migration, deployment, and live-verification sequence in `docs/specs/hosted.md` -> "Production releases", deploying the frames, try, relay, voice, and account Workers in that order. The try Worker's revision and page checks pass before the relay deploys, the relay's revision, readiness, and one-time checks before the voice or account deploys, and every Worker is checked again after the account deploys. No real mail is sent by its smoke checks, and passing them is not acceptance.

   The release needs all three Hyperdrive variables. A missing one, two Workers on one Hyperdrive, or a Hyperdrive that caches, reaches another database, or connects as anything but its Worker's role stops it at preflight, before the backup, so nothing in production changes. Preflight reads only Cloudflare's side: a role Postgres refuses (no LOGIN, a wrong password, a missing grant) passes it. A refused relay role stops the release at the relay's readiness, right after the relay deploys and before the voice or account; a refused voice or account role is caught only by the live verification after all three deploy. Either way the new Worker is already serving and its lookups fail, so before the first release on a new role, confirm it connects with `psql` as that role; on a failure, fix the role at once and rerun.

   The smokes repeat the frames, try, relay, and voice checks up to six times, 10 s apart, while a newly attached custom domain's certificate issues.
3. Tagging runs only after live verification, on the terms in `docs/specs/hosted.md` -> "Production releases". If only tagging fails, rerun failed jobs: it records the original deployment without deploying again. These tags do not trigger the desktop `v*` release workflows, and they are code history, not database backups.

## Acceptance

1. Check `/api/health` on all four hostnames and `/api/ready` on all but `try.dormouse.sh`. Inspect the actual HTML response/CSP and browser network requests for injected marketing scripts or unexpected third-party assets.
2. Request a real email, enter its code, reload, and log out. Enter a code in a second browser to verify that mail access is not tied to the first browser.
3. For each enabled provider, test first login, consent cancellation, repeat login, and logout. Include GitHub private email and Apple Hide My Email; Microsoft needs personal and work/school accounts after the shared fix.
4. Start with email, attempt the same-address provider from another browser, and confirm no automatic linking. Connect it from the signed-in account, then confirm both methods return the same account ID. Connect Apple with its different relay address. Confirm an identity belonging to another account does not transfer, and that a connection started before logout fails on return.
5. Log in on two devices and confirm both remain signed in. Log out on one; the other must remain signed in. Provider-only accounts display no email and repeat login preserves their account ID.
6. Sign in as the admin address, turn on Natural Voice from Dormouse desktop, and speak one short phrase. Turn it off on the account page and confirm the next alarm uses the system voice and Settings offers to turn it on again. Turn it on again, then off from Dormouse, and confirm the account page says it is off. Confirm another account sees no Natural Voice section.
7. Confirm the voice Worker registers its two Cron Triggers: the deploy log lists `schedule: */5 * * * *` (the history sweep) and `schedule: 0 4 * * *` (idle tokens), the dashboard shows it under Workers & Pages -> `dormouse-voice` -> Settings -> Trigger Events, and `dormouse-hosted` lists only billing's `*/10 * * * *`. After the speak in step 6, the ElevenLabs console's speech history should be empty within a few minutes. The Worker's Cron Events list each run; a failed run means the key cannot list or delete history. Recheck them for failed runs after any key change.
8. Confirm `/api/dev/emails`, `/dev/emails`, and `/__test/time` are absent, and check the live responses against the origin, caching, and cookie rules in `docs/specs/security-hosted.md` -> "Origin boundary".
9. Confirm the release smoke's one-time half passed: `https://try.dormouse.sh/connect/` answers the page under its own policy with its script beside it, `https://relay.dormouse.sh/connect/` answers only the 308 to it, and the rendezvous mints a room on the relay, is refused with a browser `Origin`, refuses a join from the relay's origin, joins from the try origin, crosses a frame each way, and is refused a second phone. Load `https://try.dormouse.sh/connect/` in a browser and confirm no injected script or third-party request, and that `https://relay.dormouse.sh/` answers Pocket's shell under Pocket's policy.
10. With a desktop build pointed at this origin, open a one-time link on a real iPhone in Safari and a real Android phone in Chrome, each on the same Wi-Fi as the laptop and each by scanning the QR code with the native camera, which must keep the fragment. Connect, type the digits, run a command, and End from the laptop. Then turn the phone's Wi-Fi off mid-session: both ends report the end. On a guest or client-isolated network the attempt ends on the same-Wi-Fi copy.

Do not mark all five login methods complete until email and all four providers pass in real browsers; a simulated callback certifies nothing. No real-provider result is claimed by the initial implementation.

## Recovery

A failed migration or deployment may already have changed production state; workflow failure does not automatically reverse it. Use the Worker's deployment history for code rollback and investigate database compatibility first; `docs/specs/hosted.md` -> "Production releases" owns what a code rollback does not undo. Cloudflare refuses a rollback of a Worker past its latest Durable Object migration: `dormouse-relay`'s `v3`, `dormouse-try`'s `v1`, and `dormouse-hosted`'s `v2`. The same section says what a deploy drops. Restore a backup only after an explicit operator decision, into a separate database first.

Current provisioning status is discoverable with `gh secret list --env NAME`, `gh variable list --env NAME`, and each provider console. Configuration presence alone is not acceptance. The account limitations an operator will be asked about — login lifetime, no device revocation or sign-out-everywhere, no merge or recovery — and billing, closed until its bindings are set, are in `docs/specs/hosted.md`.
