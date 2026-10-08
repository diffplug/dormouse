# Dormouse Blyg

[Public changelog](https://blyg.dormouse.sh/) · [Studio](https://blyg.dormouse.sh/studio) · [RSS](https://blyg.dormouse.sh/feed.xml)

This directory deploys the official, unmodified Blygger Studio Worker to Cloudflare account `ned.twigg@diffplug.com`. `wrangler.jsonc` owns the domain and resource IDs. `release.json` pins the upstream archive and its SHA-256. The downloaded bundle, local credentials and backups are ignored; posts and private Studio state live in D1, and media live in R2.

The publication contract is in `docs/specs/deploy.md` → “Blyg changelog”; CI credential placement is in `docs/specs/security-ci.md` → “Automated Maintainer (tend)”. This installation receives Webmentions even when nobody has Studio open. Use Studio to read and moderate responses; public display starts disabled.

## Publishing

`.github/workflows/blyg-publish.yml` synchronizes on GitHub release publication, changes to `CHANGELOG.md` on `main`, or manual dispatch. It checks out reviewed `main` and needs no package installation. `scripts/publish-blyg.mjs` supports the initial historical import and later corrections through the same path. Entries without a stable, published GitHub release are skipped, including historical extension-only versions without a GitHub release. Old entries retain their release dates in the text; their Blyg publication timestamps are the import time because stock Studio has no backdating API.

Run these from the repository root:

```sh
node scripts/publish-blyg.mjs --plan
node scripts/publish-blyg.mjs --dry-run
node scripts/publish-blyg.mjs
```

`--plan` checks public GitHub release eligibility without Studio credentials. `--dry-run` reads Studio to compare entries but makes no writes or pins. The other two commands need `BLYG_API_TOKEN` in their environment. Never paste credentials into command arguments or Git. The renewal helper below passes its token to a local synchronization without saving it.

Make release corrections in `CHANGELOG.md`. Studio remains useful for responses, subscriptions, settings and independently authored posts. The publisher identifies its entries by their opening “Dormouse VERSION” heading and matching GitHub release link; retain both. Do not run local publication while the Actions publisher is running. After a failed or timed-out write, rerun the publisher: it reconciles existing drafts and versions before doing more work. A conflicting draft or deliberately withdrawn item stops the run for operator review.

## Renew publishing access

Stock Studio grants expire after 30 days; OAuth refresh does not extend that deadline. Renew before expiry or after a workflow reports HTTP 401:

```sh
python3 deploy/blyg/authorize.py --publish
```

The helper prompts for the Studio owner password with terminal echo disabled, logs in over HTTPS, creates a REST token with read/draft/publish permissions, and pipes it directly to GitHub's `blyg-publish` environment secret `BLYG_API_TOKEN`. It revokes the previous grants named “Dormouse release publisher” after saving the replacement, then synchronizes pending releases. It never saves the password, session cookie or token to disk. Requires Python 3, Node, and `gh` authenticated with permission to set this environment's secrets. Run between publisher jobs so rotating the token does not interrupt an active run.

Only for a new installation, `--initialize --publish` first sets the chosen owner password through Wrangler's stdin. It requires the separate random `COOKIE_SECRET` to already exist. Do not use `--initialize` during ordinary token renewal: it changes the owner password. No AI-provider credential is needed for release publication.

## Deploy and update Studio

Commands below start at the repository root. Run Wrangler from a temporary directory with an absolute config path, or under the repository's pinned Node runtime; ambient `npx` inside this monorepo may reject pnpm's `devEngines` setting.

```sh
node deploy/blyg/install-bundle.mjs
pnpm exec npx --yes wrangler@4.141.0 deploy --dry-run --config deploy/blyg/wrangler.jsonc
pnpm exec npx --yes wrangler@4.141.0 deploy --config deploy/blyg/wrangler.jsonc
```

`install-bundle.mjs` downloads the exact official GitHub archive, verifies its pinned hash, checks archive paths and file types, and extracts the bundle without running upstream hooks. It does not deploy. The upstream MIT license and installation guide are retained in `.bundle/LICENSE` and `.bundle/README.md`.

For an update, read every intervening [upstream changelog entry](https://github.com/blygger/blygger-studio/blob/main/CHANGELOG.md) and the target release instructions. Verify its published checksum, update `release.json`, and run the installer. Preserve this installation's configuration and secrets, incorporating only required config changes. Back up D1 and original R2 media before migrations; apply the official migrations with `d1 migrations apply DB --remote --config deploy/blyg/wrangler.jsonc`, then deploy. A Git revert does not reverse database migrations. Check the manifest's generator version, RSS, archive index, existing posts and pins, Studio login, and anonymous `/api/settings` returning 401. Commit the release pin and verified deployment record together.

## Backups

Git backs up configuration and publisher code, not posts, grants or media. D1 exports contain private data. Keep them outside Git with restricted permissions and store an encrypted copy off this computer. R2 originals need a separate backup; `media.r2_key` enumerates uploads in the current schema. The feed cache can be rebuilt.

```sh
mkdir -p deploy/blyg/backups
chmod 700 deploy/blyg/backups
(umask 077; pnpm exec npx --yes wrangler@4.141.0 d1 export DB --remote --config deploy/blyg/wrangler.jsonc --output "deploy/blyg/backups/$(date -u +%Y%m%dT%H%M%SZ).sql")
```

No scheduled data-backup job is configured. Changing `COOKIE_SECRET` invalidates Studio sessions and delegated grants. Changing `OWNER_PASSWORD` invalidates owner sessions; revoke delegated grants in Studio separately if required.

## Read from your personal Studio

Subscribe to `https://blyg.dormouse.sh/` in `blyg.nedshed.dev`. Once imported, quote a release or selected passage through Studio's normal transclusion controls. Dormouse's receiver collects responses targeting Dormouse entries; the personal receiver collects responses targeting personal posts.
