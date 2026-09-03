# Deploy — Rationale

> Informative companion to [deploy.md](deploy.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Stage 1: CI workflow

**Why `release-attest` is its own environment, with no secrets and no reviewer.** A required reviewer would stall every release on manual approval at its first jobs, and the build jobs have no business seeing credentials. Neither existing `v*` environment fits: `vscode-extension-publish` requires reviewers, and `security-audit` holds `AUDIT_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`.

**Why a dropped dotfile fails the release instead of degrading it.** The dotfiles at stake are the ZDOTDIR files under `standalone/sidecar/shell-integration/zsh/` (`.zshenv`, `.zshrc`, `.zprofile`). `artifact-manifest.sha256` is generated from the runner's disk *before* upload, so a dotfile `actions/upload-artifact` silently omitted is still listed in the manifest, and Stage 2's hash verification then fails on an artifact CI reported green.

## Job: `security-audit`

**Why dispatch instead of `uses:`.** `GITHUB_EVENT_NAME` is a default variable that cannot be overridden, so a tag-triggered `workflow_call` would hand `anthropics/claude-code-action` the `push` event it rejects. A dispatched run sees a supported `workflow_dispatch` event — the same path the nightly audit uses, and the documented exception that still creates a run when triggered by the default `GITHUB_TOKEN`, so no extra PAT is needed.

## Stage 2: Local script

**Why the manifest is the attested subject rather than the signed app.** CI only ever produces unsigned artifacts — the signed app does not exist until Stage 2 — so what attestation must cover is the gap between CI artifact production and the local machine that holds the signing credentials. Verifying the manifest first means stale cached artifacts, wrong-tag artifacts, and tampered downloads are all rejected before codesign, jsign, notarization, Tauri signing, or release upload can run.

## Two signing layers

**What each layer actually proves.** OS signing proves the executable is from DiffPlug; Tauri signing proves the update bundle was not tampered with in transit. Neither substitutes for the other.

## Update manifest (`standalone-latest.json`)

**Why two URL schemes name the same asset.** The manifest points at versioned release paths (`/v0.1.0/`), while the website hotlinks the `/latest/download/` redirect. Because the filenames carry no version, both schemes resolve to the same file.
