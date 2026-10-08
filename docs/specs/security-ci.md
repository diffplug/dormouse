# CI and Release Security

> - Owns the posture of GitHub Actions, the bot maintainer, and the two release paths — what each identity can reach and what stays admin-gated.
> - Defers the release procedure and the secrets table to `docs/specs/deploy.md` -> "Environment / secrets", and the audit machinery to `docs/specs/security-audit.md`.
> - Read `docs/specs/security.md` first; `docs/specs/security-audit.md` says how the `FAIL IF` lines here are run.

## GitHub Actions Policies

Renovate updates the commit pins; the generated `tend-*.yaml` pin `max-sixty/tend/claude` by version tag (see "Upstream compromise").

**Agent-managed workflows are `tend-*.yaml`, `.github/workflows/workflow-audit.yaml`, and `.github/workflows/security-audit.yaml`.** They are exempt from the `pull_request_target` and write-permission rules below because they must modify issues, PRs, or code, or fetch an OIDC token; "Automated Maintainer (tend)" bounds their scope.

**Release audit dispatch.** The `security-audit` job in `.github/workflows/release.yml` holds `actions: write` to dispatch `security-audit.yaml` on the release tag and watch that run, gating the VS Code publish on the result (rationale). That token can start or cancel workflow runs in this repo, but cannot reach env-scoped secrets, merge to `main`, or push tags, and `release.yml` runs only on admin-gated `v*` tags.

- **FAIL IF** a workflow under `.github/workflows/` references an action by anything but a commit hash, except `max-sixty/tend/claude` in `tend-*.yaml`. Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** `.github/workflows/release.yml` runs on anything but a pushed `v*` tag. Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** the `security-audit` job in `.github/workflows/release.yml` uses its `actions: write` for anything but dispatching `security-audit.yaml` on the release tag and watching that run. Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** `pull_request_target` appears as an `on:` trigger in any `.github/workflows/**` file other than `tend-*.yaml`. A mention in a comment is not a violation. Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** a non-agent-managed workflow has **effective** write permissions other than the release provenance permissions `id-token: write` and `attestations: write`, or the `actions: write` granted to the `security-audit` job in `release.yml` (see "Release audit dispatch"). Effective as in the agent-managed bullet below. Pinned by `scripts/workflow-lint.mjs`.

`.github/workflows/ci.yml` also runs actionlint and zizmor over every workflow; `.github/zizmor.yml` names each exception it accepts.

## Automated Maintainer (tend)

The [tend](https://github.com/max-sixty/tend) agent harness runs as the GitHub user `dormouse-bot`: it reviews PRs, triages issues, fixes CI failures, regenerates its own workflow files nightly, responds to mentions, and polls its notification feed. A prompt injection in that harness reaches the secrets below, and **none escalates directly into malicious content on `main` or into any deployment-related secret** — those paths stay admin-gated.

| Secret | What a compromise buys | What bounds it |
| --- | --- | --- |
| `TEND_BOT_TOKEN` (worst case) | full `repo` + `workflow` write *as a trusted collaborator*: issue/PR spam, force-pushing or deleting feature branches, persistent compromise by authoring new workflows — also how the repo-level secrets are reached | cannot itself merge to `main`, push tags, or reach env-scoped secrets; new workflows are caught by `.github/workflows/workflow-audit.yaml`; the trusted identity can still social-engineer an admin toward a `main` merge |
| `CLAUDE_CODE_OAUTH_TOKEN` | Anthropic API-credit abuse | the bot account's spend limit |
| `ARGOS_TOKEN`, the unused `CHROMATIC_PROJECT_TOKEN` | corrupted snapshot testing, a replaced Storybook deploy | rotation; abuse is visible in each service's own dashboard |

A prompt injection can push a workflow that sends a repo-level secret to an external URL: the harness reads PR descriptions, diffs, issue text, comments, and CI logs, all attacker-influenceable; admin-gated release paths stay sealed, but a workflow on a bot-pushed feature branch executes with repo-level secrets in scope.

A fork PR's tree reaches the agent's copy-on-write view while the privileged `pull_request_target` workspace holds the base tree, so tend's `shared/steps/restore-sensitive-config.sh` reverts the project-instruction paths (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`) from the reviewed base branch before the agent starts; **that control's completeness is a property of the pinned upstream version** (rationale).

Trusted runner steps receive the real `TEND_BOT_TOKEN` and Anthropic credentials and provision the credential-injecting proxy; setup strips the checkout credential before the separate, non-sudo agent starts (rationale).

**Must limit `.config/tend.yaml`'s `setup:` to `node scripts/setup-git.mjs` on the base-tree checkout**, which runs with those credentials present: it uses Node built-ins only, and the `md-sentences` merge driver it defines executes PR code only inside the agent's own merges, since no trusted runner step merges, rebases, or cherry-picks.

**Bot collaborator authority.** `dormouse-bot` is a direct repo collaborator with `push` permission and org-enforced 2FA; `TEND_BOT_TOKEN` carries the scopes `repo`, `workflow`, `notifications`, `write:discussion`, `gist`, and `user`. `workflow`, required to regenerate `tend-*.yaml`, also lets the harness add arbitrary workflow files. **Ref-protection rulesets restrict where bot commits land but do not gate workflow execution on feature branches.**

**The notifications poll widens its input.** `tend-notifications.yaml` alone takes its subjects from the bot's own unread feed, and its pre-check re-subscribes the bot to all repository activity (`PUT /repos/diffplug/dormouse/subscription`) every `*/15` cycle; its prompt decides whether to respond (rationale). On an undispatched thread the bot is still bounded by `author_association` tiering and the admin gate on `main`. Unwatching by hand does not stick: the lever is `tend-notifications.yaml`, not the Unwatch button.

**Reachable repo-level secrets.** Every repo-level secret is reachable by any workflow the bot can author: `.github/workflows/argos.yml` is `pull_request`-triggered, and environment policies cannot tell a bot from a human contributor at the ref level. Accepted for `ARGOS_TOKEN` and the unused `CHROMATIC_PROJECT_TOKEN` alone, each scoped to one project (`docs/specs/security.md` -> "What is not defended"); any other repo-level secret needs its own acceptance there. `OVSX_PAT` and `VSCE_PAT` live only in the `vscode-extension-publish` environment, which admits only admin-created `v*` tags.

No `ANTHROPIC_API_KEY` secret exists. Every generated `tend-*.yaml` passes `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` to `max-sixty/tend/claude`; with no such secret it resolves empty and the harness uses `CLAUDE_CODE_OAUTH_TOKEN`. The input cannot be deleted locally, so the inventory `FAIL IF` below makes adding one a deliberate expansion of the bot's reach (rationale).

**Org-level secrets.** An org secret shared with this repo is reachable exactly like a repo-level one but absent from this repo's own listing — `gh api repos/diffplug/dormouse/actions/organization-secrets` is the check. **None are visible today** (rationale); the inventory `FAIL IF` admits none, so one that becomes visible fails until it is evaluated and named.

**Upstream compromise.** Generated workflows reference `max-sixty/tend/claude@<version>` — a mutable **tag**, so upstream can change what our workflows execute with no commit here and `workflow-audit.yaml` seeing a byte-identical file (`docs/specs/security.md` -> "What is not defended"; rationale). **The version pin bounds deliberate upgrades, not a hostile upstream**; `uvx tend@latest` runs only at install and nightly regen, so a compromise of that path affects the next re-run, not in-flight workflows. `tend-mention` and `tend-notifications` also run `astral-sh/setup-uv`, whose `uv` interprets a `run:` step holding `TEND_BOT_TOKEN`; the generator pins that action by commit and the `uv` download by checksum.

**Audit visibility.** `.github/workflows/workflow-audit.yaml` walks nightly every commit touching `.github/workflows/`, `.config/tend.yaml`, `.github/audit/`, `.vscode/`, or the markdown merge driver (`.gitattributes`, `scripts/setup-git.mjs`, `scripts/md-merge.mjs`, `scripts/md-unwrap.mjs`) since its previous successful scheduled run on `main`, **across all branches**, so a workflow pushed to a feature branch is seen without a PR. (rationale) It reports the *unexplained*, classifying out routine sources on independently checked provenance or content; each source's residual is `docs/specs/security.md` -> "What is not defended":

| Source | Explained when |
| --- | --- |
| Renovate pin bump | GitHub-signed, authored `renovate[bot]`, committed `web-flow`, associated only with Renovate PRs, changing only the ref of an already-referenced action (rationale) |
| tend regeneration | byte-for-byte reproducible from `uvx tend@<version> init` at the files' own header version, without touching `.config/tend.yaml` (rationale) |
| clean merge | two-parent merge whose window paths equal `git merge-tree` of its parents |
| admin push | the earliest ref update containing it in the repository activity log (last quarter, server-set timestamps) is an admin's `push` or `branch_creation`, or an admin's `force_push` whose replaced window commits are each admin-introduced; and no author or committer field names a bot (rationale) |

- **FAIL IF** `WINDOW` in `.github/workflows/workflow-audit.yaml` names other paths than those above, or the walk stops covering all branches (rationale). `WINDOW` pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** an author or committer field the commit's GitHub signature does not bind explains a commit: `TEND_BOT_TOKEN` is the credential in question, so the pusher GitHub records, or a `web-flow` signature binding the author, is evidence, and self-declared identity only ever refuses.
- **FAIL IF** the audit stops reporting a commit whose earliest retained introduction is a PR merge (the admin reviewing, not pushing), a commit already merged to `main` (rationale), or one a classifier cannot decide — a failed API or Git call, an unresolvable tip, a missing activity-log entry — each as unexplained.
- **FAIL IF** tend regeneration materializes anything except regular `.config/tend.yaml` and workflow YAML blobs from the audited commit. Pinned by `scripts/workflow-audit.test.mjs` (rationale).
- **FAIL IF** the audit deduplicates by branch or file set, which lets a later force-push of malicious content to the same files pass unremarked, or keys liveness on anything but a successful run, such as an issue existing; a silent run is the healthy steady state.

The diff window's evasions are `docs/specs/security.md` -> "Known gaps".

- **FAIL IF** `.github/workflows/workflow-audit.yaml` derives its lower bound from anything but the server-set `created_at` of its previous successful `schedule` run on `main`, so neither a pusher-set date nor a run a branch or dispatch controls can move it (rationale). Pinned by `scripts/workflow-audit.test.mjs`.
- **FAIL IF** either admin-gating ruleset is missing or weakened. `Merge access` must target `~DEFAULT_BRANCH`, block exactly `creation`, `update`, and `deletion`, and carry admin (`RepositoryRole` actor `5`, `bypass_mode: exempt`) as its sole bypass actor; `Tag operations` must target `~ALL` tags except `refs/tags/hosted/**` ("Hosted Deployments"), block both `creation` and `update`, and carry the same admin-only bypass. Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** `.config/tend.yaml` does not set `merge: restricted`, or any `tend-*.yaml` passes another `merge:`; tend's `yolo` mode makes the bot a `Merge access` bypass actor. Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** `dormouse-bot` holds `maintain` or `admin` on this repository. `GET /collaborators/dormouse-bot/permission` spells `push` as `write` in both `permission` and `role_name`, so check that neither of those two roles appears rather than string-comparing against `push`. Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** any GitHub environment except `hosted-preview` admits, by its deployment-branch policy, a ref that is not admin-gated by the `Tag operations` or `Merge access` rulesets; an environment's `can_admins_bypass` is not judged here. Hosted environments follow "Hosted Deployments" below. Today: `vscode-extension-publish` and `release-attest` (`v*` tag, admin-only via `Tag operations`); `security-audit` (`main` admin-only via `Merge access`, plus `v*` tag); `tend` (`main` only, admin-only via `Merge access`). An environment `.github/audit/expected-github-state.json` does not name fails until it is evaluated and named there (rationale). Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** the secret inventory departs from this placement (rationale). It is exhaustive: a secret at repo, org, or environment level that no line names fails. One pass over `actions/secrets`, `actions/organization-secrets`, and each environment's secret listing answers every line:
  - `ARGOS_TOKEN` and `CHROMATIC_PROJECT_TOKEN` — repo level, the only secrets there; accepted with rotation (see "Reachable repo-level secrets"). No workflow reads `CHROMATIC_PROJECT_TOKEN` since Chromatic left CI; its absence is no violation.
  - `AUDIT_PAT` — in `security-audit`, absent at repo level.
  - `EMBARGO_TOKEN` — in `security-audit`, absent at repo level; read only by the steps `docs/specs/security-audit.md` -> "Embargo" names.
  - `TEND_BOT_TOKEN` — in `tend`, absent at repo level.
  - `CLAUDE_CODE_OAUTH_TOKEN` — in **both** `tend` and `security-audit`, absent at repo level. Environments do not inherit each other's secrets, so a rotation must set both.
  - `OVSX_PAT`, `VSCE_PAT` — in `vscode-extension-publish` only, absent at repo level.
  - `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`, `PREVIEW_AUTH_SECRET` — in `hosted-preview`; `CLOUDFLARE_API_TOKEN`, `DATABASE_URL`, `BACKUP_AGE_IDENTITY` — in `hosted-production`; `HOSTED_TAG_APP_PRIVATE_KEY` — in `hosted-release-tag`. Each absent at repo level; the two `CLOUDFLARE_API_TOKEN`s are separate values.
  - `ANTHROPIC_API_KEY` — absent at repo *and* org level, for as long as `tend-*.yaml` passes `anthropic_api_key` to `max-sixty/tend/claude`.
  - `release-attest`'s own secret listing is empty **and** it declares no environment variables, so `id-token: write` stays the only credential `release.yml`'s two build jobs can reach.
  - No org-level secret visible to this repository at all (see "Org-level secrets").
  - Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** a repo-level secret is missing from `secrets.allowed` in `.config/tend.yaml` (rationale). Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** `.github/workflows/workflow-audit.yaml` is missing, disabled, or has not produced a successful `schedule` run on `main` in the last 48 hours. One skipped run inside that window passes and is reported as INFO, a signal rather than slack (rationale). Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** Renovate's `github-actions` manager can update `.github/workflows/tend-*.yaml`; the tend generator owns every dependency pin (rationale). Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** any `tend-*.yaml` pins `max-sixty/tend` below `0.1.19`, the release that pins instruction files by glob at any depth (rationale). Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** the pinned `max-sixty/tend/claude` starts the agent on a workflow's fork-PR checkout before reverting the project-instruction paths, or hands the agent's environment, disk, or `.git/config` the real `TEND_BOT_TOKEN` or an Anthropic credential; or a `tend-*.yaml` sets workflow- or job-level `env:`, which the harness forwards to the agent, or writes a secret to `$GITHUB_ENV`. Read the action at the tag the workflows pin: `claude/action.yaml` and the shared steps it runs for checkout ordering, instruction pinning, and sandbox setup (rationale). A fork PR the agent checks out itself is `docs/specs/security.md` -> "Known gaps". The `env:` and `$GITHUB_ENV` halves pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** any `tend-*.yaml` references `max-sixty/tend/claude` unpinned (e.g. `@main`, no version). Every other action reference is "GitHub Actions Policies"'s. Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** any job in an agent-managed workflow has **effective** `GITHUB_TOKEN` permissions beyond `contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`, `actions: read`, or any `read` permission. Effective, not declared: apply job permissions over workflow permissions over the repository default; omitted scopes in an explicit block become `none` (rationale). Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** `default_workflow_permissions` for this repository is not `read`, or `can_approve_pull_request_reviews` is not `false` (`gh api repos/diffplug/dormouse/actions/permissions/workflow`) — the backstop for every permission bullet in this spec (rationale). Pinned by `scripts/github-state-check.mjs`.

Source of truth: `packageRules` in `.github/renovate.json`; `.github/workflows/workflow-audit.yaml`; `scripts/workflow-audit.test.mjs`.

## Hosted Deployments

Hosted credentials live only in the three Hosted environments the secret inventory above places them in. `hosted-production` and `hosted-release-tag` admit only `main`; `hosted-preview` admits only `main` and `refs/pull/*/merge`. `hosted-preview` and `hosted-production` require Ned or Edgar's review with administrator bypass disabled; self-review is allowed. Preview approval authorizes the PR code to receive test-resource credentials only. `hosted-release-tag` requires no review: approving the deploy approves its tag, which runs only after that deploy's live verification succeeds, so a `hosted/` tag records what is live.

- **FAIL IF** a Hosted environment lacks those branch restrictions, or `hosted-preview` or `hosted-production` lacks required reviewers or disabled administrator bypass. Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** Hosted credentials appear at repository/org scope, or production credentials appear in `hosted-preview`. Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** `hosted-release-tag` is used by a job other than `tag` in `.github/workflows/hosted-production.yml`, a workflow reads `HOSTED_TAG_TOKEN`, or `tag` hands `hosted/scripts/production-tag.mjs` any credential but the token its `actions/create-github-app-token` step mints with `owner: diffplug`, `repositories: dormouse`, and only `permission-contents: write` (rationale). Pinned by `scripts/workflow-lint.mjs`.

The App itself holds only `contents: write` and `metadata: read` and subscribes to no event. No audit run can read that: the App is private, and listing its installation takes an organization administrator (rationale; `## Future` -> Tagger App audit).

- **FAIL IF** the App (`Integration` actor `5228264`) bypasses any ruleset but `Hosted tag creation`, which must target only `refs/tags/hosted/**`, block only `creation`, and be bypassed otherwise only by admin; or `Hosted tag history` stops blocking `update` and `deletion` on `refs/tags/hosted/**` with an admin-only bypass. A leaked key adds `hosted/` tags, never moves or deletes one. Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** a Hosted preview deploy accepts a fork or a failing verification, preview cleanup checks out a PR ref rather than `main`, or a Hosted production tag can run before live verification succeeds; inspect the workflow dependency/condition graph.

Source of truth: `hosted/scripts/setup-github.mjs`; `.github/workflows/hosted-preview.yml`; `.github/workflows/hosted-production.yml`.

## VS Code Extension Releases

GitHub Actions publishes the extension only after human approval from an account other than the triggering account, with administrator bypass disabled; `VSCE_PAT` and `OVSX_PAT` live only in that protected environment.

- **FAIL IF** `vscode-extension-publish` lacks nonempty required reviewers, `prevent_self_review: true`, or `can_admins_bypass: false`. Pinned by `scripts/github-state-check.mjs`.
- **FAIL IF** `.github/workflows/release.yml` is missing the `vscode-extension-publish` environment on the VS Code publish job, or if `VSCE_PAT` / `OVSX_PAT` are referenced anywhere under `.github/workflows/**` from a job not bound to that environment. The second clause is repo-wide on purpose (rationale). Pinned by `scripts/workflow-lint.mjs`.
- **FAIL IF** `.github/workflows/release.yml` uses production desktop signing secrets in CI, or stops generating an ephemeral Tauri updater key for unsigned CI artifacts. Pinned by `scripts/workflow-lint.mjs`.

## Desktop Releases

**Production signing is local, never in CI.** GitHub Actions builds unsigned artifacts, publishes attestations and hash manifests, and uploads them; `scripts/sign-and-deploy.sh` verifies the CI artifact attestations and the recorded SHA-256 hashes before signing, then signs each platform locally (Windows Authenticode needs a physical YubiKey and the signing PIN; macOS signing and notarization run locally too) and uploads the release assets. CI never holds the production Tauri updater private key: it uses an ephemeral key, and **Tauri updater signing is applied locally after OS signing**, so the updater signs the bundles users download. Procedure: `docs/specs/deploy.md` -> "Two-stage pipeline".

**Signing credentials and argv.** Three secrets reach `scripts/sign-and-deploy.sh` through the environment; argv is readable via `ps` by any process on the machine for the lifetime of a call (rationale).

| Secret | Where it travels | What bounds it |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | **env-only** | — |
| `EV_SIGN_PIN` | **env-only** (`jsign --storepass env:EV_SIGN_PIN`) | the physical YubiKey |
| `APPLE_SIGN_PASS` | argv — `xcrun notarytool` offers no environment form | none (`docs/specs/security.md` -> "Known gaps") |

Its remedy is staged under `## Future` → Notarization credentials.

- **FAIL IF** `scripts/sign-and-deploy.sh` stops doing any of three things: verifying GitHub artifact attestations, verifying artifact SHA-256 manifests, or using PIV-backed Windows signing. Pinned by `scripts/sign-and-deploy.test.mjs`.
- **FAIL IF** `TAURI_SIGNING_PRIVATE_KEY` is passed on a command line anywhere in `scripts/sign-and-deploy.sh` rather than through the environment, or `EV_SIGN_PIN` is passed literally to `jsign --storepass` instead of by environment-variable reference.
- **FAIL IF** `plugins.updater` in `standalone/src-tauri/tauri.conf.json` trusts any key but minisign `AC5A7E8D541A64DB`, asks any endpoint but `https://dormouse.sh/standalone-latest.json`, or sets `dangerousInsecureTransportProtocol`; a `tauri.<platform>.conf.json` overlay configures the updater; or a platform in `website/public/standalone-latest.json` is signed under another key. Every install takes its next update on that key's word. Pinned by `standalone/scripts/updater-trust-root.test.mjs`.
- **FAIL IF** `standalone/src-tauri/entitlements-macos-node.plist` grants anything beyond `allow-jit`, `allow-unsigned-executable-memory`, and `disable-library-validation`, or `scripts/sign-and-deploy.sh` signs anything but `Contents/MacOS/node` with it (rationale). Pinned by `standalone/scripts/macos-entitlements.test.mjs` and `scripts/sign-and-deploy.test.mjs`.

## Future

**Scope: notarization-profile** — [Notarization credentials](#notarization-credentials).

**Scope: tagger-app-audit** — [Tagger App audit](#tagger-app-audit).

### Notarization credentials

Use `notarytool store-credentials` plus `--keychain-profile` to move password exposure to one short provisioning call instead of every submission. Update the release runbook and verify with live Apple credentials before promotion.

### Tagger App audit

Give the audit an organization-administration read — a scope on `AUDIT_PAT` or a token of its own in `security-audit` — so `scripts/github-state-check.mjs` reads `GET /orgs/diffplug/installations` and fails when the tagger App holds a permission beyond `contents: write` and `metadata: read` or subscribes to an event. Today it only warns, when an administrator's own login runs it.
