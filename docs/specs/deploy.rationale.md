# Deploy — Rationale

> Informative companion to [deploy.md](deploy.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Stage 1: CI workflow

**Why `release-attest` is its own environment, with no secrets and no reviewer.** A required reviewer would stall every release on manual approval at its first jobs, and build jobs have no business seeing credentials. Neither existing `v*` environment fits: `vscode-extension-publish` requires reviewers; `security-audit` holds `AUDIT_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`.

**Why a dropped dotfile fails the release instead of degrading it.** The dotfiles are the ZDOTDIR files under `standalone/sidecar/shell-integration/zsh/`: `.zshenv`, `.zshrc`, `.zprofile`. `artifact-manifest.sha256` is generated from the runner's disk *before* upload, so a dotfile `actions/upload-artifact` silently omitted is still listed in the manifest, and Stage 2's hash verification fails on an artifact CI reported green.

**Why executable metadata travels with the hashes.** `actions/upload-artifact` ZIP transport restores files as `0644` ([upstream documentation](https://github.com/actions/upload-artifact#permission-loss), reviewed 2026-09-05). Without an attested executable inventory, the Mac Node sidecar and `dor` launcher lose their executable bits, and the signer's executable-file scan misses nested binaries. Restoring permissions on working copies preserves the downloaded evidence.

## Job: `security-audit`

**Why dispatch instead of `uses:`.** `GITHUB_EVENT_NAME` is a default variable that cannot be overridden, so a tag-triggered `workflow_call` inherits `push`. A dispatched run sees a supported `workflow_dispatch` — the same path the nightly audit uses, and the documented exception where the default `GITHUB_TOKEN` still creates a run, so no extra PAT is needed.

## Stage 2: Local script

**Why the manifest is the attested subject rather than the signed app.** The signed app does not exist until Stage 2, so what attestation must cover is the gap between CI's unsigned artifact production and the local machine holding the signing credentials. Verifying the manifest first rejects stale cached artifacts, wrong-tag artifacts, and tampered downloads before codesign, jsign, notarization, Tauri signing, or release upload can run.

The 2026-09-05 audit found that standalone resume commands reset every working artifact; `notarize` even replaced the signed Mac app with its unsigned download. Per-platform refresh and completion markers keep retries ordered and prevent stale updater bundles from being published after a partial signing failure. Exact inventory checks also close the gap where valid listed hashes coexisted with extra unverified code in a cached app.

**Why only the retry branch changed.** `gh release create` with assets is already safe to publish into an immutable-releases repo: it creates the release as a draft, uploads every asset, publishes only once all of them succeed, and deletes the draft if one fails (`createRun` in `cli/cli` `pkg/cmd/release/create/create.go`, v2.100.0). Only the retry branch, which replaces assets on a release that may already be published, needed a guard. That branch is narrow: `cleanupDraftRelease` also runs when `gh`'s own publish step fails, so a draft survives to be retried only where the cleanup did not run — the process was killed mid-publish, the delete itself failed, or the draft was created by hand. Refusing there beats letting the API reject the upload: immutability is enforced at publication and deleting the release does not free its tag name for reuse ([immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)), so a version bump is the only repair either way — and the operator discovers it mid-release with signing hardware attached.

**Why the setting is unverifiable from CI.** The repository-level `immutable_releases` field is admin-gated: it is absent from `GET /repos/{owner}/{repo}` for a token without admin, including on repositories where the setting is demonstrably on (`cli/cli`'s latest release reports `"immutable": true`, checked 2026-09-23). Its absence is not evidence the setting is off; the per-release `immutable` field is what a non-admin can read.

## Two signing layers

**What each layer actually proves.** OS signing proves the executable is from DiffPlug; Tauri signing proves the update bundle was not tampered with in transit.
