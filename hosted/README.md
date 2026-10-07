# Dormouse Hosted

Three Hono/Cloudflare Workers built from this package: the account frontend and auth at `https://hosted.dormouse.sh` (`dormouse-hosted`), the Hosted Relay's account-scoped routes with Pocket at the root, and the one-time connection's rendezvous and `/connect/` phone page at `https://relay.dormouse.sh` (`dormouse-relay`; [the one-time spec](../docs/specs/one-time.md)), and managed-voice speech at `https://voice.dormouse.sh` (`dormouse-voice`). The marketing website is a separate application. Managed voice and the Relay admit only the admin account; device-code Burrow enrollment and account-scoped encrypted terminal routing are implemented. Real-provider and live production acceptance remain separate release gates. See [the spec](../docs/specs/hosted.md), whose "Application boundary" owns what each Worker serves.

This file is the whole operator runbook, in the order an operator works: run locally, update packages, set up GitHub, provision previews, provision production, release, accept, recover. Marketing, desktop releases, Hosted production, and PR previews have separate deployment credentials. A passing local test implies no cloud resource and no real-provider acceptance.

## Run locally

From the repository root, with Docker running:

```sh
pnpm install
dor tool hosted
```

Outside Dormouse, use `pnpm dev:hosted` and open the `http://localhost:<port>` URL it prints. Request a code for a test address and read it at `/api/dev/emails` on that same origin. No real mail is sent, and the development database is isolated by the worktree path; `docs/specs/hosted.md` -> "Development and release" owns what the local entry serves and what production omits. The port is OS-assigned unless you set `PORT`. Do not share this local inbox publicly. The local origin serves the voice token routes but not speak: a Hosted build speaks only at `https://voice.dormouse.sh` (`docs/specs/hosted.md` -> "Development and release").

```sh
pnpm test:hosted
pnpm build:hosted
```

Tests run each production Worker in real workerd, the account's with disposable Postgres clones and a local OAuth simulator. `pnpm --filter dormouse-hosted test:miniflare` runs the rendezvous, Pocket, and boundary suites alone, without Docker. The build writes each Worker's static files under `dist/<worker>/` (Pocket at `dist/relay/`, `/connect/` at `dist/relay/connect/`) and dry-runs all three Workers; it does not deploy. Production deploys only through the release workflow.

The relay Worker's one-time rendezvous and `/connect/` page run on their own, without Docker or Postgres (its Relay routes answer 503 there):

```sh
dor tool one-time      # outside Dormouse: pnpm dev:one-time
```

It serves `http://localhost:8787` (or `PORT`) and prints the `DORMOUSE_RELAY_ORIGIN` and `DORMOUSE_RELAY_IS_HOSTED=1` values that point a local dev Burrow build at it; `docs/specs/one-time.md` -> "Dev loop" owns what it runs. A phone cannot reach a loopback origin, so a real phone tests against a PR preview.

## Update pgstencil

`hosted/package.json` installs released `pgstencil` and `@pgstencil/auth` from npm. They share a version and Hosted declares their peer dependencies. Approved pgstencil releases are exempt from the pnpm and Renovate cooldowns because the release workflow requires a passing security audit, stages the archives, and requires a maintainer's 2FA approval before publishing.

Run `pnpm install` and re-run Hosted's integration tests after an update. The production preflight reads `dist/provenance.json` from the installed packages and requires matching clean commits. `docs/specs/security-hosted.md` -> "Deployment boundary" owns the upstream audit check. For an unreleased change, pack pgstencil in a clean checkout and use a temporary pnpm override on a branch.

## Resource inventory

| Boundary | Resources |
| --- | --- |
| Preview | Dedicated test Cloudflare account with a registered workers.dev subdomain; dedicated empty Neon project and parent branch; GitHub `hosted-preview` environment |
| Each PR | `dormouse-hosted-pr-N`, `dormouse-relay-pr-N` (with its own `OneTimeRoom` and `RelayRoom` Durable Object namespaces), and `dormouse-voice-pr-N` Workers, one uncached Hyperdrive all three share as the branch's owner role, and a Neon branch, all reused until close; rate-limit namespaces `1001`–`1007` shared by every relay and account preview |
| Production | Dedicated Dormouse Postgres database, a migration role and one runtime role per Worker, three uncached Hyperdrives, one per Worker connecting as its role; Workers `dormouse-hosted` (`hosted.dormouse.sh`, with rate-limit namespace `7`), `dormouse-relay` (`relay.dormouse.sh`, with its `OneTimeRoom` and `RelayRoom` Durable Object namespaces and rate-limit namespaces `1`–`6`), and `dormouse-voice` (`voice.dormouse.sh`, with the history-sweep Cron Trigger), each on its custom domain; GitHub `hosted-production` environment |
| Email | Dedicated Postmark server, verified `signin@dormouse.sh`, SPF/DKIM/DMARC, Apple Private Email Relay registration |
| OAuth | Separate Dormouse GitHub, Google, Microsoft, and Apple registrations; exact callbacks below |
| Release history | `hosted-release-tag` GitHub environment, the `dormouse-hosted-tagger` GitHub App, the `Hosted tag creation` and `Hosted tag history` tag rulesets, immutable annotated `hosted/` tags |
| Recovery | Neon backups/PITR enabled, encrypted pre-migration dumps retained as GitHub artifacts for 30 days, age identity also retained independently in a password manager |

Cloudflare Workers Scripts and Hyperdrive permissions are account-scoped, so previews need their own test account. `docs/specs/security-ci.md` -> "Hosted Deployments" owns the credential placement the audit checks.

### Production registration identifiers

Public identifiers recorded during provisioning on 2026-09-29; secret values remain in the Worker, protected GitHub environments, and Bitwarden.

| Service | Dedicated registration |
| --- | --- |
| Cloudflare | Account `0a95e814ccf2b6a95d2dc3bea0a4a2b4`; Workers `dormouse-hosted`, `dormouse-relay`, `dormouse-voice`; the account's Hyperdrive ID in `wrangler.jsonc`, the relay's and voice's in `wrangler.relay.jsonc` and `wrangler.voice.jsonc` once provisioned (all zeros until then) |
| Neon | Project `young-dust-56119072`; production branch `br-billowing-brook-b4cuf3y4`; database `neondb`; migration role `neondb_owner`; SQL-created runtime role `dormouse_app`, the account Worker's; `dormouse_relay` and `dormouse_voice`, created NOLOGIN and granted by the release, then given LOGIN by hand for the relay's and voice's Hyperdrives |
| Postmark | Server `21034461`, `dormouse-hosted`; sender `signin@dormouse.sh`; return path `pm-bounces.dormouse.sh` |
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

A qualifying PR runs Hosted tests and builds before provisioning; `docs/specs/hosted.md` -> "PR previews" owns which PRs qualify and what each one gets. The URL is in the deployment environment link and job summary; no PR comment bot or write-scoped workflow token is needed.

Open `https://dormouse-hosted-pr-N.SUBDOMAIN.workers.dev/`, request a code for a disposable address, and read it at `/dev/emails`. The PR's one-time page is at `https://dormouse-relay-pr-N.SUBDOMAIN.workers.dev/connect/`; its voice Worker has no ElevenLabs key, so speak never reaches ElevenLabs. This inbox is public to anyone with the URL. No real email or OAuth provider is contacted. A preview's Hyperdrive connects as its branch's owner role, so a preview never exercises the relay's and voice's restricted roles: a missing grant passes there, and `pnpm test:hosted`, which binds those Workers to their roles, is what catches it. The database stores messages across Worker restarts.

New commits retain the URL and test accounts. Migrations are append-only; to change an already-applied migration, close the PR, wait for successful cleanup, then reopen. Closing or merging deletes the three Workers, the Hyperdrive, and the Neon branch. Rerun failed cleanup. Keep previews enabled until all live previews are removed. Manual cleanup uses `node hosted/scripts/preview.mjs cleanup` with the preview environment's credentials and `PR_NUMBER`. These credentials cannot be downloaded back from GitHub; retain independent copies in your password manager.

## Provision the production boundary

Use dedicated Dormouse resources in the existing Cloudflare, Neon, and Postmark accounts.

1. Create a dedicated Dormouse production Postgres database on Neon, on PostgreSQL 18; the backup/restore tooling pins PostgreSQL 18.6. Keep development and previews separate. Enable backups and a suitable PITR window, and verify a restore into a separate database before accepting real accounts.
2. Create three Cloudflare Hyperdrive configurations for that database, each with **query caching disabled** and its connection host, port, and database identical to the direct migration URL: the account's as `dormouse_app`, the relay's as `dormouse_relay`, and the voice's as `dormouse_voice` (step 3 makes each role). Enter connection credentials directly in Cloudflare; set the resulting public IDs in `wrangler.jsonc`, `wrangler.relay.jsonc`, and `wrangler.voice.jsonc` respectively for local operator deployment. CI overrides them with the `HYPERDRIVE_ID`, `RELAY_HYPERDRIVE_ID`, and `VOICE_HYPERDRIVE_ID` variables, and the release's preflight checks each one's caching, database, and role before it backs up anything.
3. Create the runtime role with SQL (`CREATE ROLE ... LOGIN PASSWORD ...`), not Neon’s Console/API role creation, which grants `neon_superuser`. Neon requires the password over the encrypted connection and rejects a precomputed password hash. Keep it out of command arguments and SQL-editor history. Give the runtime role only the auth-table and schema DML permissions plus sequence access the shipped tables need, including defaults for future migration-created tables and sequences. Keep a separate migration role that owns migrations and can dump the database. Supply its `DATABASE_URL` through a secret manager, never in a command argument, then run `pnpm --filter dormouse-hosted db:migrate` and `db:validate`. These commands never reset or drop an existing database. `db:migrate` then applies `hosted/server/runtime-roles.sql` (alone: `db:roles`), which creates `dormouse_relay` and `dormouse_voice` NOLOGIN and resets their grants; its header states what it never changes. Before creating their Hyperdrives, run `db:roles` once if no release has applied the file yet, then give each a password with SQL as the migration role over the encrypted connection (`ALTER ROLE dormouse_relay LOGIN PASSWORD ...`, likewise `dormouse_voice`), never Neon's Console, whose roles the file refuses.
4. Set up a dedicated Postmark server/token and verify the sending address `signin@dormouse.sh` (or update `EMAIL_FROM`). Configure SPF/DKIM and DMARC. Register the sender with Apple Private Email Relay for relay-address delivery.
5. Each Worker's config claims its own custom domain — `hosted.dormouse.sh`, `relay.dormouse.sh`, `voice.dormouse.sh` — and the first deploy of each creates it. Exclude all three hostnames from Cloudflare Web Analytics, Zaraz, and other script injection or rewriting rules. Disable account API caching. Keep `workers_dev` and public preview URLs disabled.

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

`DATABASE_URL` is the direct migration-role Postgres URL. Generate the age identity with `age-keygen` into private password-manager storage, then enter it at the hidden prompt; preserve that independent copy and old keys on rotation. Use a production Cloudflare token covering Workers deployment (which includes the Durable Object migrations, rate-limit bindings, and Cron Triggers), Workers secret listing, Hyperdrive read, and the custom-domain zone permissions for all three hostnames.

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

Create `ELEVENLABS_API_KEY` in an ElevenLabs account dedicated to Dormouse voice — the Worker deletes that account's entire speech history on a schedule, so never point it at a shared account. Restrict the key to text-to-speech plus speech-history access, and set a spending limit in the ElevenLabs console. How the Worker uses the key is `docs/specs/hosted.md` -> "Managed voice".

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

Configure the sender and enable each ready provider in `OAUTH_PROVIDERS` in `wrangler.jsonc`, comma separated, reviewed in a PR. The checked-in file enables GitHub, Google, Microsoft, and Apple; `docs/specs/hosted.md` -> "Identity and login" owns what a name and a credential pair do and do not enable. Facebook is outside this milestone.

## Release

1. Review the exact package provenance and code revision. Run `pnpm test:hosted`, `pnpm build:hosted`, and the repository lints. Validate production migrations.
2. Merge reviewed code to `main`, then run **Hosted production release**:

   ```sh
   gh workflow run hosted-production.yml --repo diffplug/dormouse --ref main -f promote=true
   ```

   Default `promote=false` verifies and builds only. `promote=true` enters the protected production environment and runs the preflight, backup and restore-test, migration, deployment, and live-verification sequence in `docs/specs/hosted.md` -> "Production releases", deploying the relay, voice, and account Workers in that order. The relay's revision, readiness, and one-time checks pass before the voice or account deploys, and all three are checked again after the account deploys. No real mail is sent by its smoke checks, and passing them is not acceptance.

   The release needs all three Hyperdrive variables. A missing one, two Workers on one Hyperdrive, or a Hyperdrive that caches, reaches another database, or connects as anything but its Worker's role stops it at preflight, before the backup, so nothing in production changes. Preflight reads only Cloudflare's side: a role Postgres refuses (no LOGIN, a wrong password, a missing grant) passes it. A refused relay role stops the release at the relay's readiness, right after the relay deploys and before the voice or account; a refused voice or account role is caught only by the live verification after all three deploy. Either way the new Worker is already serving and its lookups fail, so before the first release on a new role, confirm it connects with `psql` as that role; on a failure, fix the role at once and rerun.

   The first release after the split creates the relay's `OneTimeRoom` (`v1`), then deletes the account Worker's (its append-only migration `v2`): links open at that moment drop, and both become rollback floors. Its smokes repeat the relay and voice checks up to six times, 10 s apart, while their new custom domains' certificates issue.
3. Tagging runs only after live verification, on the terms in `docs/specs/hosted.md` -> "Production releases". If only tagging fails, rerun failed jobs: it records the original deployment without deploying again. These tags do not trigger the desktop `v*` release workflows, and they are code history, not database backups.

## Acceptance

1. Check `/api/health` and `/api/ready` on all three hostnames. Inspect the actual HTML response/CSP and browser network requests for injected marketing scripts or unexpected third-party assets.
2. Request a real email, enter its code, reload, and log out. Enter a code in a second browser to verify that mail access is not tied to the first browser.
3. For each enabled provider, test first login, consent cancellation, repeat login, and logout. Include GitHub private email and Apple Hide My Email; Microsoft needs personal and work/school accounts after the shared fix.
4. Start with email, attempt the same-address provider from another browser, and confirm no automatic linking. Connect it from the signed-in account, then confirm both methods return the same account ID. Connect Apple with its different relay address. Confirm an identity belonging to another account does not transfer, and that a connection started before logout fails on return.
5. Log in on two devices and confirm both remain signed in. Log out on one; the other must remain signed in. Provider-only accounts display no email and repeat login preserves their account ID.
6. Sign in as the admin address, create a voice token, and speak one short phrase with it from Dormouse desktop; revoke it and confirm the next speak fails. Confirm another account sees no Voice tokens section.
7. Confirm the history sweep's Cron Trigger is registered on the voice Worker alone: the deploy log lists `schedule: */5 * * * *`, the dashboard shows it under Workers & Pages -> `dormouse-voice` -> Settings -> Trigger Events, and `dormouse-hosted` lists none. After the speak in step 6, the ElevenLabs console's speech history should be empty within a few minutes. The Worker's Cron Events list each run; a failed run means the key cannot list or delete history. Recheck them for failed runs after any key change.
8. Confirm `/api/dev/emails`, `/dev/emails`, and `/__test/time` are absent, and check the live responses against the origin, caching, and cookie rules in `docs/specs/security-hosted.md` -> "Origin boundary".
9. Confirm the release smoke's one-time half passed against `relay.dormouse.sh`: `/connect/` answers the page under its own policy with its script beside it, and the rendezvous mints a room, is refused with a browser `Origin`, joins from the relay origin, crosses a frame each way, and is refused a second phone. Load `https://relay.dormouse.sh/connect/` in a browser and confirm no injected script or third-party request, and that `https://relay.dormouse.sh/` answers Pocket's shell under Pocket's policy.
10. With a desktop build pointed at this origin, open a one-time link on a real iPhone in Safari and a real Android phone in Chrome, each on the same Wi-Fi as the laptop and each by scanning the QR code with the native camera, which must keep the fragment. Connect, type the digits, run a command, and End from the laptop. Then turn the phone's Wi-Fi off mid-session: both ends report the end. On a guest or client-isolated network the attempt ends on the same-Wi-Fi copy.

Do not mark all five login methods complete until email and all four providers pass in real browsers; a simulated callback certifies nothing. No real-provider result is claimed by the initial implementation.

## Recovery

A failed migration or deployment may already have changed production state; workflow failure does not automatically reverse it. Use the Worker's deployment history for code rollback and investigate database compatibility first; `docs/specs/hosted.md` -> "Production releases" owns what a code rollback does not undo. Cloudflare refuses a rollback of `dormouse-relay` past its `OneTimeRoom` migration, or of `dormouse-hosted` past the deletion of its own; every relay deploy or rollback drops the one-time links still open, and established sessions run directly and are unaffected. Restore a backup only after an explicit operator decision, into a separate database first.

Current provisioning status is discoverable with `gh secret list --env NAME`, `gh variable list --env NAME`, and each provider console. Configuration presence alone is not acceptance. The account limitations an operator will be asked about — login lifetime, no device revocation or sign-out-everywhere, no merge or recovery, admin-only managed voice, no paid-service activation — are in `docs/specs/hosted.md`.
