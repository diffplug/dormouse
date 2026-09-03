# Deploy — Rationale

> Informative companion to [deploy.md](deploy.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Stage 1: CI workflow

**Why `release-attest` is its own environment, with no secrets and no reviewer.** A required reviewer would stall every release on manual approval at its first jobs, and build jobs have no business seeing credentials. Neither existing `v*` environment fits: `vscode-extension-publish` requires reviewers; `security-audit` holds `AUDIT_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`.

**Why a dropped dotfile fails the release instead of degrading it.** The dotfiles are the ZDOTDIR files under `standalone/sidecar/shell-integration/zsh/`: `.zshenv`, `.zshrc`, `.zprofile`. `artifact-manifest.sha256` is generated from the runner's disk *before* upload, so a dotfile `actions/upload-artifact` silently omitted is still listed in the manifest, and Stage 2's hash verification fails on an artifact CI reported green.

## Job: `security-audit`

**Why dispatch instead of `uses:`.** `GITHUB_EVENT_NAME` is a default variable that cannot be overridden, so a tag-triggered `workflow_call` inherits `push`. A dispatched run sees a supported `workflow_dispatch` — the same path the nightly audit uses, and the documented exception where the default `GITHUB_TOKEN` still creates a run, so no extra PAT is needed.

## Stage 2: Local script

**Why the manifest is the attested subject rather than the signed app.** The signed app does not exist until Stage 2, so what attestation must cover is the gap between CI's unsigned artifact production and the local machine holding the signing credentials. Verifying the manifest first rejects stale cached artifacts, wrong-tag artifacts, and tampered downloads before codesign, jsign, notarization, Tauri signing, or release upload can run.

## Two signing layers

**What each layer actually proves.** OS signing proves the executable is from DiffPlug; Tauri signing proves the update bundle was not tampered with in transit.

## Update manifest (`standalone-latest.json`)

**Why two URL schemes name the same asset.** The manifest points at versioned release paths (`/v0.1.0/`) while the website hotlinks the `/latest/download/` redirect; with no version in the filenames, both resolve to the same file.
