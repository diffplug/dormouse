# Security

> **Audited automatically.** This spec is checked against the repository by [`security-audit.yaml`](.github/workflows/security-audit.yaml) on a 24-hour schedule (04:21 UTC) and as a required gate before every VS Code release. Each failure is filed as an issue labeled [`security-audit-failure`](https://github.com/diffplug/dormouse/issues?q=is%3Aissue+label%3Asecurity-audit-failure) — open ones are live, closed ones are the historical record of what tripped past audits and what changed to clear them.

Dormouse is a terminal, so users trust it with shells, source trees, credentials, and local files. The dependency graph and release pipeline is part of the product's security boundary.

## Dependency Supply Chain

Dormouse keeps its runtime dependency surface intentionally small. We add dependencies only when they are necessary, and we expect dependency changes to justify their value against their supply-chain risk. We use maturity gating inside our pnpm configuration and also inside our [Renovate configuration](.github/renovate.json).

Every dependency shipped in the end-user application is listed at <https://dormouse.sh/supply-chain>. This includes:

- every npm dependency (direct and transitive)
- every cargo dependency (direct is listed separately from transitive)
- the Node.js runtime bundled as a Tauri sidecar in the standalone app

Those dependency snapshots are generated from the lockfiles and reviewed as part of release work. If a production dependency is added, removed, or upgraded, the dependency lists must be regenerated and committed.

The standalone app ships a Node.js runtime binary (`standalone/src-tauri/build.rs` copies it into the bundle as a Tauri sidecar). Its version is pinned exactly in the root `package.json` under `devEngines.runtime.version`, and the build is the authority: `build.rs` runs `--version` on the binary it is about to bundle and fails the build unless it matches the pin. On Windows the build then flips one byte of the bundled `node.exe` — the PE Optional Header's `Subsystem` field from `IMAGE_SUBSYSTEM_WINDOWS_CUI` (3) to `IMAGE_SUBSYSTEM_WINDOWS_GUI` (2) — to suppress Windows Terminal's default-terminal handoff, which would otherwise spawn a stray terminal window behind the app. The version check runs before the byte flip and the patch leaves Node.js semantics unchanged (Node reads its stdio handles from `STARTUPINFO`, which is subsystem-agnostic); the bundled `node.exe` is therefore not byte-identical to the upstream archive — it differs at exactly the documented 2-byte field. The supply-chain page reads the same pin, so the version disclosed there provably equals the runtime users receive — it cannot drift to whatever Node happened to be on the build machine's PATH. Locally, pnpm honors `devEngines` (`onFail: "download"`) so scripts run under the pinned Node; CI extracts the same field to drive `actions/setup-node`. The version is a deliberate, manual pin (no automated ecosystem tracks it); the workflows that do not bundle the runtime are free to track the same pinned major.

- FAIL IF `node website/scripts/generate-deps.js` changes `website/src/data/dependencies-npm.json`, `website/src/data/dependencies-cargo.json`, or `website/src/data/dependencies-runtime.json` when run from a clean checkout.
- FAIL IF the root `package.json` is missing `devEngines.runtime.version`, or its value is not an exact Node.js version (a bare major such as `24` is not acceptable; it must be `MAJOR.MINOR.PATCH`).
- FAIL IF `standalone/src-tauri/build.rs` no longer verifies that the bundled Node.js binary matches `package.json`'s `devEngines.runtime.version` (this verification is what makes the disclosed runtime version provable).
- FAIL IF the `build-standalone` job in `.github/workflows/release.yml` does not install the pinned runtime by reading `devEngines.runtime.version` from `package.json` and passing it to `actions/setup-node` (other jobs may pin `node-version` inline since their interpreter is never bundled).
- FAIL IF `pnpm-workspace.yaml` is missing `minimumReleaseAge: 1440`.
- FAIL IF `.github/renovate.json` is missing `npm` or `cargo` from `enabledManagers` (npm covers `/`; cargo covers `/standalone/src-tauri`).
- FAIL IF `.github/renovate.json` is missing `minimumReleaseAge` package rules for `npm`/`cargo` updates (the Renovate equivalent of dependency cooldown windows).

## GitHub Actions Policies

GitHub Actions are always pinned by commit hash, not version tag. Renovate will update the hashes as necessary.

**Agent-managed workflows** are `tend-*.yaml`, `workflow-audit.yaml`, and `security-audit.yaml`. They implement the repo's automation and self-audit infrastructure, and are exempt from the two rules below because they need to modify issues, PRs, or code, or fetch an OIDC token. Their bounded scope is defined in the "Automated Maintainer" section.

**Release audit dispatch.** The `security-audit` job in `release.yml` holds `actions: write` — the one write permission a non-agent-managed workflow is granted beyond release provenance. It uses it solely to dispatch `security-audit.yaml` on the release tag and watch the resulting run, gating the VS Code publish on the result. Dispatch is required because `claude-code-action` rejects the `push` event that a tag-triggered `workflow_call` would inherit, and `GITHUB_EVENT_NAME` is a default variable that cannot be overridden — so a `workflow_dispatch` run is the only way to exercise the audit under a supported event. Blast radius is bounded: `actions: write` lets that job's `GITHUB_TOKEN` start or cancel workflow runs in this repo, but it cannot reach env-scoped secrets, merge to `main`, or push tags, and `release.yml` only runs on admin-gated `v*` tags — so exercising it already requires an admin-gated tag push.

- FAIL IF `pull_request_target` appears in any `.github/workflows/**` file other than `tend-*.yaml`.
- FAIL IF a non-agent-managed workflow grants write permissions other than the explicitly scoped release provenance permissions `id-token: write` and `attestations: write`, or the `actions: write` granted to the `security-audit` job in `release.yml` (see "Release audit dispatch" above).

## Automated Maintainer (tend)

This repository runs the [tend](https://github.com/max-sixty/tend) agent harness as the GitHub user `dormouse-bot`. tend reviews PRs, triages issues, fixes CI failures, regenerates its own workflow files on a nightly schedule, and responds to mentions. The agent expands the project's attack surface.

An attacker who lands a prompt injection in tend's harness can reach three secrets. None of them escalates directly into malicious content on the `main` branch or into any deployment-related secret — those paths stay admin-gated. The boundaries we accept are codified below.

- `TEND_BOT_TOKEN` (worst case): full `repo` + `workflow` write access *as a trusted collaborator*. Direct uses are issue/PR spam, force-pushing or deleting feature branches, and persistent compromise by authoring new workflows (persistent compromise mitigated by [`workflow-audit.yaml`](.github/workflows/workflow-audit.yaml)). Authoring a workflow is also the mechanism by which `CHROMATIC_PROJECT_TOKEN` is reached. **It cannot itself merge to `main`, push tags, or reach env-scoped secrets, but the bot's trusted identity can be used to social-engineer an admin toward a `main` merge.**
- `CLAUDE_CODE_OAUTH_TOKEN`: bounded Anthropic API-credit abuse, capped by the bot account's spend limit.
- `CHROMATIC_PROJECT_TOKEN`: lets the attacker corrupt snapshot testing; mitigated by rotation, and any abuse is visible in Chromatic's own dashboard.

**Prompt-injection through user-supplied content.** tend's harness reads PR descriptions, code diffs, issue text, comments, and CI logs — all attacker-influenceable surfaces. A malicious prompt could direct the harness to push a workflow that references a repo-level secret to an external URL. The bot cannot merge to `main` or push tags, so admin-gated release paths stay sealed, but a workflow on a bot-pushed feature branch will still execute with repo-level secrets in scope.

**Bot collaborator authority.** `dormouse-bot` is a direct repo collaborator with `push` permission and 2FA enforced by org policy. Its PAT (`TEND_BOT_TOKEN`) carries the scopes `repo`, `workflow`, `notifications`, `write:discussion`, `gist`, and `user`. The `workflow` scope is required for the nightly regeneration of `tend-*.yaml` files; the same scope lets the harness add arbitrary new workflow files. Ref-protection rulesets restrict where bot-controlled commits can land but do not gate workflow execution on feature branches.

**Reachable repo-level secrets.** `CHROMATIC_PROJECT_TOKEN` is reachable by any workflow the bot can author, because `chromatic.yml` is `pull_request`-triggered and GitHub environment policies cannot distinguish a bot from a human contributor at the ref level. Chromatic project tokens are scoped to a single project, easy to rotate, and any abuse is detectable in Chromatic's own dashboard — this risk is accepted with rotation as the mitigation. `OVSX_PAT` and `VSCE_PAT` are protected: they live only in the `vscode-extension-publish` environment, whose deployment-branch-policy admits only `v*` tags, and tag creation is admin-only.

**Inert secret plumbing.** Every generated `tend-*.yaml` passes `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` to `max-sixty/tend/claude`. No such secret exists at repo or org level, so today it resolves to the empty string and the harness authenticates with `CLAUDE_CODE_OAUTH_TOKEN` instead. The input is upstream-generated and cannot be removed locally without being overwritten by the next nightly regen, so the risk is handled by enforcement rather than deletion: the moment anyone adds an `ANTHROPIC_API_KEY` secret for an unrelated reason, eight bot-triggered workflows would start reading it with no code change and no review. The FAIL IF below makes that addition a deliberate, documented expansion of the bot's reach.

**Org-level secrets.** Secrets shared with this repo from the `diffplug` org are reachable by any workflow the bot can author, exactly like repo-level ones, and they do not appear in this repo's own secret listing (`gh api repos/diffplug/dormouse/actions/organization-secrets` is the check). Two are visible here: `BUILDCACHE_USER` and `NEXUS_USER`. Both are org-wide shares — visible to every `diffplug` repository, not grants made to this one — and neither is referenced by any workflow in `.github/workflows/`. They are accepted rather than unshared, because narrowing them is an org-wide change to accommodate one repo. The risk is bounded: they are usernames, not the paired credentials, so alone they authenticate nothing. Any *further* org secret becoming visible here is not covered by that reasoning and must be re-evaluated — hence the FAIL IF below names these two explicitly.

**Upstream compromise.** Tend's action is pinned by commit SHA (`max-sixty/tend@<sha>`) in every generated workflow, so silent updates to the running setup are not possible. `uvx tend@latest` runs only at install and during nightly regen; a compromise of that path would affect the next re-run, not the in-flight workflows.

**Audit visibility.** `workflow-audit.yaml` is a nightly job that walks every commit touching `.github/workflows/` since its previous successful run, opening an issue summarizing each. A bot push that disables or modifies the audit itself is caught in the next successful run's diff window.

- FAIL IF the repository ruleset named `Merge access` is missing, doesn't target `~DEFAULT_BRANCH`, blocks anything other than `update`, or doesn't have admin (`RepositoryRole` actor `5`) as its sole bypass actor.
- FAIL IF the repository ruleset named `Tag operations` is missing, doesn't target `~ALL` tags, doesn't block both `creation` and `update`, or doesn't have admin-only bypass.
- FAIL IF `dormouse-bot` holds a permission higher than `push` on this repository.
- FAIL IF `OVSX_PAT` or `VSCE_PAT` appears as a repo-level secret. They must live only in the `vscode-extension-publish` environment.
- FAIL IF any GitHub environment's deployment-branch-policies admit a ref that is not admin-gated by the `Tag operations` or `Merge access` rulesets. Today this covers `vscode-extension-publish` (`v*` tag, admin-only via `Tag operations`) and `security-audit` (`main` admin-only via `Merge access`, plus `v*` tag).
- FAIL IF `AUDIT_PAT` is missing from the `security-audit` environment, or is present at the repo level instead. The audit refuses to run without it, and it must be env-scoped so a bot-pushed feature branch cannot reach it.
- FAIL IF `CHROMATIC_PROJECT_TOKEN` is missing from `secrets.allowed` in `.config/tend.yaml`. The allowlist entry is an explicit acknowledgment that the bot can read this token.
- FAIL IF an `ANTHROPIC_API_KEY` secret is reachable at repo or org level while `tend-*.yaml` still passes `anthropic_api_key` to `max-sixty/tend/claude`. Every tend workflow already reads it, so provisioning it silently widens the bot's reach; landing it requires documenting the new secret in the reachable-secrets analysis above and amending this check.
- FAIL IF any org-level secret other than `BUILDCACHE_USER` and `NEXUS_USER` is visible to this repository. Org secrets are reachable by any workflow the bot can author but never appear in the repo-level secret listing, so each one is an accepted exposure that must be named here; those two are accepted per the analysis above.
- FAIL IF `.github/workflows/workflow-audit.yaml` is missing, disabled, or has not produced a successful run in the last 48 hours.
- FAIL IF any `tend-*.yaml` workflow uses an unpinned action reference (e.g. `@main`, no version). Tag pins are accepted inside `tend-*.yaml` because the file is owned by the upstream generator; every other workflow — agent-managed or not — must SHA-pin per the rule above.
- FAIL IF any agent-managed workflow grants a permission beyond `contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`, `actions: read`, or any `read` permission.

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
