# Security

Dormouse is a terminal, so users trust it with shells, source trees, credentials, and local files. The dependency graph and release pipeline is part of the product's security boundary.

The policies described in this document are enforced on every PR.

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

The agent-managed workflows (`tend-*.yaml` and `workflow-audit.yaml`) are exempt from the two rules below because the maintainer agent's job requires modifying issues, PRs, and code. Their scope is bounded separately in the "Automated Maintainer" section.

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
- FAIL IF the `vscode-extension-publish` environment's deployment-branch-policies allow any ref pattern that is not admin-gated by the `Tag operations` or `Merge access` rulesets.
- FAIL IF `CHROMATIC_PROJECT_TOKEN` is missing from `secrets.allowed` in `.config/tend.yaml`. The allowlist entry is an explicit acknowledgment that the bot can read this token.
- FAIL IF `.github/workflows/workflow-audit.yaml` is missing, disabled, or has not produced a successful run in the last 48 hours.
- FAIL IF any `tend-*.yaml` workflow references `max-sixty/tend` with anything other than a pinned version tag matching a published release (e.g. `@0.0.25`). The other actions inside tend's workflows must still be SHA-pinned per the rule above. The tag-pin exception for `max-sixty/tend` itself is accepted because that reference is owned by the upstream generator.
- FAIL IF any agent-managed workflow (`tend-*.yaml`, `workflow-audit.yaml`) grants a permission beyond `contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`, `actions: read`, or any `read` permission.

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

- FAIL IF `.github/workflows/security-audit.yaml` is missing, disabled, or no longer invoked from `release.yml`'s publish path.
- FAIL IF the audit has been weakened — e.g. the prompt no longer requires the qualitative pass, a `FAIL IF` can be ignored, or the failure-reporting step that opens a `security-audit-failure` issue and exits non-zero has been removed.