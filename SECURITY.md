# Security

> **Audited automatically.** This spec is checked against the repository by [`security-audit.yaml`](.github/workflows/security-audit.yaml) on a 24-hour schedule (07:13 UTC) and as a required gate before every VS Code release. Each failure is filed as an issue labeled [`security-audit-failure`](https://github.com/diffplug/dormouse/issues?q=is%3Aissue+label%3Asecurity-audit-failure) — open ones are live, closed ones are the historical record of what tripped past audits and what changed to clear them.

Dormouse is a terminal, so users trust it with shells, source trees, credentials, and local files. The dependency graph and release pipeline is part of the product's security boundary.

## Dependency Supply Chain

Dormouse keeps its runtime dependency surface intentionally small. We add dependencies only when they are necessary, and we expect dependency changes to justify their value against their supply-chain risk.

Every production transitive dependency shipped in the end-user application is listed at <https://dormouse.sh/dependencies>

That page is generated from the lockfile and reviewed as part of release work. If a production dependency is added, removed, or upgraded, the dependency list must be regenerated and committed.

New npm package versions are not adopted immediately. The workspace uses pnpm's package maturity gate so newly published npm versions have time to be reported, yanked, or investigated before Dormouse resolves them into the lockfile. Dependabot also applies cooldown windows for npm and Cargo updates so routine dependency PRs do not chase brand-new releases unnecessarily.

- FAIL IF `node website/scripts/generate-deps.js` changes `website/src/data/dependencies.json` when run from a clean checkout.
- FAIL IF `pnpm-workspace.yaml` is missing `minimumReleaseAge: 1440`.
- FAIL IF `.github/dependabot.yml` is missing npm coverage for `/` or Cargo coverage for `/standalone/src-tauri`.
- FAIL IF `.github/dependabot.yml` is missing dependency cooldown windows.

## GitHub Actions Policies

GitHub Actions are always pinned by commit hash, not version tag. Dependabot will update the hashes as necessary.

The agent-managed workflows (`tend-*.yaml`, `workflow-audit.yaml`, and `security-audit.yaml`) are exempt from the two rules below because they run Claude-powered automation that requires modifying issues, PRs, or code, or fetching an OIDC token. Their scope is bounded separately in the "Automated Maintainer" section.

- FAIL IF `pull_request_target` appears in any `.github/workflows/**` file other than `tend-*.yaml`.
- FAIL IF a non-agent-managed workflow grants write permissions other than the explicitly scoped release provenance permissions `id-token: write` and `attestations: write`.

## Automated Maintainer (tend)

This repository runs the [tend](https://github.com/max-sixty/tend) agent harness as the GitHub user `dormouse-bot`. tend reviews PRs, triages issues, fixes CI failures, regenerates its own workflow files on a nightly schedule, and responds to mentions. The agent expands the project's attack surface. The boundaries we accept are codified below.

**Prompt-injection through user-supplied content.** tend's harness reads PR descriptions, code diffs, issue text, comments, and CI logs — all attacker-influenceable surfaces. A malicious prompt could direct the harness to push a workflow that references a repo-level secret to an external URL. The bot cannot merge to `main` or push tags, so admin-gated release paths stay sealed, but a workflow on a bot-pushed feature branch will still execute with repo-level secrets in scope.

**Bot collaborator authority.** `dormouse-bot` is a direct repo collaborator with `push` permission and 2FA enforced by org policy. Its PAT (`TEND_BOT_TOKEN`) carries the scopes `repo`, `workflow`, `notifications`, `write:discussion`, `gist`, and `user`. The `workflow` scope is required for the nightly regeneration of `tend-*.yaml` files; the same scope lets the harness add arbitrary new workflow files. Ref-protection rulesets restrict where bot-controlled commits can land but do not gate workflow execution on feature branches.

**Reachable repo-level secrets.** `CHROMATIC_PROJECT_TOKEN` is reachable by any workflow the bot can author, because `chromatic.yml` is `pull_request`-triggered and GitHub environment policies cannot distinguish a bot from a human contributor at the ref level. Chromatic project tokens are scoped to a single project, easy to rotate, and any abuse is detectable in Chromatic's own dashboard — this risk is accepted with rotation as the mitigation. `OVSX_PAT` and `VSCE_PAT` are protected: they live only in the `vscode-extension-publish` environment, whose deployment-branch-policy admits only `v*` tags, and tag creation is admin-only.

**Upstream compromise.** Tend's action is pinned by commit SHA (`max-sixty/tend@<sha>`) in every generated workflow, so silent updates to the running setup are not possible. `uvx tend@latest` runs only at install and during nightly regen; a compromise of that path would affect the next re-run, not the in-flight workflows.

**Audit visibility.** `workflow-audit.yaml` is a nightly job that walks every commit touching `.github/workflows/` since its previous successful run (using the GitHub API's timestamp as the lower bound, so a failed run pushes the window forward rather than dropping commits). It opens an issue summarizing each commit's author, refs, and changed files. A bot push that adds a new workflow file is visible in the next successful audit even if the bot tries to silently modify the audit workflow — the modification itself appears in the audit.

- FAIL IF the repository ruleset named `Merge access` is missing, doesn't target `~DEFAULT_BRANCH`, blocks anything other than `update`, or doesn't have admin (`RepositoryRole` actor `5`) as its sole bypass actor.
- FAIL IF the repository ruleset named `Tag operations` is missing, doesn't target `~ALL` tags, doesn't block both `creation` and `update`, or doesn't have admin-only bypass.
- FAIL IF `dormouse-bot` holds a permission higher than `push` on this repository.
- FAIL IF `OVSX_PAT` or `VSCE_PAT` appears as a repo-level secret. They must live only in the `vscode-extension-publish` environment.
- FAIL IF any GitHub environment's deployment-branch-policies admit a ref that is not admin-gated by the `Tag operations` or `Merge access` rulesets. Today this covers `vscode-extension-publish` (`v*` tag, admin-only via `Tag operations`) and `security-audit` (`main` admin-only via `Merge access`, plus `v*` tag).
- FAIL IF `AUDIT_PAT` is missing from the `security-audit` environment, or is present at the repo level instead. The audit refuses to run without it, and it must be env-scoped so a bot-pushed feature branch cannot reach it.
- FAIL IF `CHROMATIC_PROJECT_TOKEN` is missing from `secrets.allowed` in `.config/tend.yaml`. The allowlist entry is an explicit acknowledgment that the bot can read this token.
- FAIL IF `.github/workflows/workflow-audit.yaml` is missing, disabled, or has not produced a successful run in the last 48 hours.
- FAIL IF any `tend-*.yaml` workflow uses an unpinned action reference (e.g. `@main`, no version). Inside `tend-*.yaml`, both tag pins (`@v6`, `@0.0.25`) and SHA pins are accepted because the file is owned by the upstream generator (`max-sixty/tend`), which currently uses tag pins. All actions in every other workflow — including `workflow-audit.yaml` and `security-audit.yaml` — must follow the SHA-pin rule in "GitHub Actions Policies".
- FAIL IF any agent-managed workflow (`tend-*.yaml`, `workflow-audit.yaml`, `security-audit.yaml`) grants a permission beyond `contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`, `actions: read`, or any `read` permission.

## VS Code Extension Releases

The VS Code extension is published by GitHub Actions. The secrets which allow this publish are `VSCE_PAT` and `OVSX_PAT`. These secrets are contained only within a protected GitHub environment. The environment requires a human to manually approve, and it can't be the same account which triggered the publish. This prevents a single compromised tag or maintainer account from immediately publishing a new extension version without an explicit release approval.

- FAIL IF `.github/workflows/release.yml` is missing the `vscode-extension-publish` environment on the VS Code publish job.
- FAIL IF `VSCE_PAT` or `OVSX_PAT` are used anywhere except within the `vscode-extension-publish` environment.
- FAIL IF `.github/workflows/release.yml` uses production desktop signing secrets in CI.
- FAIL IF `.github/workflows/release.yml` stops generating an ephemeral Tauri updater key for unsigned CI artifacts.

## Desktop Releases

Desktop releases are not fully automated. GitHub Actions builds unsigned artifacts, publishes attestations and hash manifests, and uploads those unsigned artifacts for local release signing. Final desktop deployment is manual through `scripts/sign-and-deploy.sh`. Before signing, the script verifies the CI artifact attestations and the recorded SHA-256 hashes. The local machine then performs platform signing and uploads the final release assets. Windows Authenticode signing requires a physical YubiKey and the signing PIN. macOS signing and notarization also happen locally, outside GitHub Actions. CI must not have the production Tauri updater private key; CI uses only an ephemeral updater key so Tauri emits updater-shaped unsigned artifacts. Tauri updater signing is applied locally after OS signing so the updater signs the final release bundles that users will download.

- FAIL IF `scripts/sign-and-deploy.sh` stops verifying GitHub artifact attestations.
- FAIL IF `scripts/sign-and-deploy.sh` stops verifying artifact SHA-256 manifests.
- FAIL IF `scripts/sign-and-deploy.sh` stops using PIV-backed Windows signing.

## CI Validation Contract

The `security-audit` workflow at `.github/workflows/security-audit.yaml` enforces this document. It runs nightly and is a required dependency of the VS Code publish job in `release.yml`, so no release ships without a passing audit. The audit reads SECURITY.md, executes each `FAIL IF` as a mechanical check, and also does a qualitative pass for security holes the specs don't cover. On any `FAIL IF` violation or BLOCKER-severity finding, the workflow opens (or updates) an issue labeled `security-audit-failure` with the full audit report, and exits non-zero. When a subsequent audit passes, the open failure issue is auto-closed so the tracker matches the live state.

The audit job declares `environment: security-audit`, whose deployment-branch-policy admits only `main` and `v*` tags. Both ref classes are admin-only by §3's rulesets, so a write-scoped bot cannot reach the env's secrets (most importantly `AUDIT_PAT`, when provisioned) by pushing a workflow file to a feature branch.

As a consequence of that env-gating, audit changes are iterated on `main` directly. A `workflow_dispatch` from any other ref is rejected by the environment's deployment-policy before any step runs. To experiment on a branch, widen the env's policy temporarily and revert after.

`AUDIT_PAT` is **required**. The audit's first step verifies the secret is present and refuses to run otherwise — without it the audit cannot read the administration endpoints needed to verify ruleset bypass actors, repo-level secret listing, and environment policies, so the spec it claims to enforce would be unenforceable in its key sections. Mint a fine-grained PAT on an admin's account with read-only `Administration` + `Secrets` + `Environments` scoped to `diffplug/dormouse` only, then store it env-scoped:

```bash
gh secret set AUDIT_PAT --env security-audit --repo diffplug/dormouse --body 'github_pat_…'
```

- FAIL IF `.github/workflows/security-audit.yaml` is missing, disabled, or no longer invoked from `release.yml`'s publish path.
- FAIL IF the audit has been weakened — e.g. the prompt no longer requires the qualitative pass, a `FAIL IF` can be ignored, the failure-reporting step that opens a `security-audit-failure` issue and exits non-zero has been removed, or the `AUDIT_PAT` pre-check is removed or bypassed.