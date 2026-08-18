# Deploy Spec

## What we ship

Every release produces three artifact groups under one version and changelog:

| Artifact | Format | Destination |
|----------|--------|-------------|
| VSCode extension | `.vsix` | VS Code Marketplace + OpenVSX |
| Standalone (Windows) | `.exe` (NSIS installer) | GitHub Release + Tauri updater |
| Standalone (macOS, Apple Silicon) | `.tar.gz` (contains signed `.app`) | GitHub Release + Tauri updater |
| Standalone (Linux) | `.AppImage` | GitHub Release + Tauri updater |

## Release checklist

Human-driven steps, in order:

1. **Update dependency snapshots** — run `node website/scripts/generate-deps.js` and review the diffs in `website/src/data/dependencies-npm.json` and `website/src/data/dependencies-cargo.json`. Commit if changed.
2. **Draft release notes and bump version** — run `/release-notes` in Claude Code at the repo root. The slash command (defined in [.claude/commands/release-notes.md](../../.claude/commands/release-notes.md)) walks the merge commits and squash-merged PRs since the last tag, recommends a `breaking.added.bugfix` version bump, runs `./scripts/bump-version.sh X.Y.Z`, and edits `CHANGELOG.md` for the same version. Review and edit the resulting diff if needed.
3. **Commit and tag** — `git commit -am "Release vX.Y.Z"` then `git tag vX.Y.Z`.
4. **Push** — `git push && git push origin vX.Y.Z`. This triggers CI (Stage 1).
5. **Set environment variables** — copy the relevant secrets into the terminal from your password manager (see [Environment / secrets](#environment--secrets) for the list).
6. **Run local signing** — plug in the PIV USB key, then `./scripts/sign-and-deploy.sh all X.Y.Z`. The script waits for CI, downloads unsigned artifacts, signs macOS + Windows, generates the Tauri update manifest into `website/public/standalone-latest.json`, and creates the GitHub Release. Run `./scripts/sign-and-deploy.sh --help` for resume-after-failure subcommands.
7. **Deploy website** — commit the updated `website/public/standalone-latest.json` and deploy dormouse.sh so the updater endpoint is live.
8. **Verify the release**
   - Check GitHub Release assets are correct
   - On a Mac: extract the `.tar.gz`, open the `.app`, confirm no Gatekeeper warnings
   - On Windows: run the `.exe` installer, confirm no SmartScreen warnings
   - Confirm Tauri auto-updater picks up the new version (test from a previous version)
   - Confirm VSCode extension is live on Marketplace and OpenVSX

## Versioning

A single version number (`X.Y.Z`) applies to all artifacts. `bump-version.sh` is the source of truth for which files carry it.

A release is triggered by pushing a tag: `v0.1.0`. This is intentionally a single tag (not separate `vscode-ext/v*` and `standalone/v*` tags) because we want one changelog entry for both.

## Two-stage pipeline

Code signing for Windows requires a physical USB hardware key (EV cert via PIV). macOS signing uses a local Developer ID cert. Both must happen locally. So:

```
Stage 1: CI (GitHub Actions)
  → Build unsigned Tauri apps (win, mac, linux)
  → Build VSCode extension
  → Generate and attest artifact manifests
  → Publish VSCode extension after protected environment approval
  → Upload unsigned Tauri artifacts

Stage 2: Local (sign-and-deploy.sh)
  → Download CI artifacts
  → Verify artifact attestations and hashes
  → Sign macOS (codesign + notarize)
  → Sign Windows (jsign + PIV hardware key)
  → Generate Tauri update manifest with signatures
  → Upload signed artifacts to GitHub Release
```

## Stage 1: CI workflow

Triggered by tag push `v*`. Three jobs run in parallel — `build-standalone`, `build-vscode`, and `security-audit` — and `publish-vscode` runs after all three succeed.

Jobs, matrix targets, pnpm/Node versions, and step ordering are defined in [.github/workflows/release.yml](../../.github/workflows/release.yml).

The workflow defaults `GITHUB_TOKEN` to read-only repository access (`contents: read`). The build jobs request provenance permissions (`id-token: write` + `attestations: write`), and the `security-audit` job requests `actions: write` so it can dispatch the audit workflow. The publish job stays on the workflow read-only default and is separately gated by the `vscode-extension-publish` environment.

**Note:** We do NOT use `tauri-action`'s built-in GitHub Release creation. We create the release locally after signing.

The `build-standalone` artifact upload sets `include-hidden-files: true` — `actions/upload-artifact` v4.4+ silently drops dotfiles by default, but the zsh shell integration ships as ZDOTDIR dotfiles (`standalone/sidecar/shell-integration/zsh/.zshenv` etc.). Without the flag, the artifact is missing files that `artifact-manifest.sha256` hashed (the manifest is generated from the runner's disk, before upload), and Stage 2 hash verification fails. The `vscode-extension` upload keeps the safer default since it only contains `*.vsix` and the manifest.

The CI updater key exists only so Tauri emits updater-shaped artifacts during unsigned builds. It is generated inside the runner, is not stored in source control or GitHub Secrets, and its public key is not the public key trusted by shipped apps. The final release bundles are re-signed locally by `scripts/sign-and-deploy.sh` with the production Tauri updater key before upload.

### Job: `security-audit`

Dispatches the `security-audit.yaml` workflow on the release tag (via `gh workflow run`), polls for the resulting run, and waits for its conclusion with `gh run watch --exit-status`, so a failing audit fails this job. `publish-vscode` is gated on it, so a failing security audit blocks the VS Code Marketplace publish. It dispatches rather than calling the reusable workflow with `uses:` because `anthropics/claude-code-action` rejects the `push` event that a tag-triggered `workflow_call` would inherit (and `GITHUB_EVENT_NAME` is a default variable that cannot be overridden); a dispatched run sees a supported `workflow_dispatch` event — the same path the nightly audit uses. `workflow_dispatch` is the documented exception that still creates a run when triggered by the default `GITHUB_TOKEN`, so no extra PAT is needed.

### Job: `publish-vscode`

This runs in CI because VSCode Marketplace publishing uses PAT tokens (no hardware key needed). The `vscode-extension-publish` environment must require reviewer approval and allow deployments only from `v*` tags. Store `VSCE_PAT` and `OVSX_PAT` as environment secrets there, not broad repository secrets.

## Stage 2: Local script

`scripts/sign-and-deploy.sh` is the source of truth for the local pipeline (download, sign, notarize, package, release). Run with no args or `--help` to see subcommands.

Before any local signing step runs, downloaded CI artifacts must pass two checks:

1. `gh attestation verify` must prove the artifact manifest was attested by `.github/workflows/release.yml` in `diffplug/dormouse`, for `refs/tags/vX.Y.Z`, at the exact commit SHA resolved by the local tag.
2. `sha256sum -c` or `shasum -a 256 -c` must prove every downloaded file listed in `artifact-manifest.sha256` still has the hash CI recorded before upload.

The manifest itself is the attested subject, not the final signed app. This closes the gap between CI artifact production and the local machine that holds signing credentials: stale cached artifacts, wrong-tag artifacts, and tampered downloads are rejected before codesign, jsign, notarization, Tauri signing, or release upload can run.

The local script must also select release artifacts by strict expected paths instead of broad `find | head` matches. Release signing fails closed unless the expected files exist at the expected locations. The exact expected paths are enforced in `scripts/sign-and-deploy.sh`.

Release upload likewise uses only the three stable output filenames (the `FNAME_*` constants in `scripts/sign-and-deploy.sh`) and fails if `release-signed/release-assets` contains any other files.

When rebuilding the Windows installer locally, the script rewrites the absolute CI-runner paths baked into the Tauri-generated NSIS `.nsi` script (via `scripts/patch-nsis-paths.pl`) and patches the `ADDITIONALPLUGINSPATH` and `OUTFILE` defines to the expected local plugin directory and installer path before running `makensis`.

### One-time setup

```bash
brew install gh jsign
gh auth login
xcode-select --install
pnpm install --frozen-lockfile
pnpm --dir standalone exec tauri signer generate  # creates the Tauri update signing keypair
```

### Two signing layers

OS signing proves the executable is from DiffPlug; Tauri signing proves the update bundle hasn't been tampered with in transit. Both are required — they protect different things at different points in time.

| Layer | What it signs | Who verifies | What happens without it |
|-------|--------------|--------------|------------------------|
| OS (codesign / jsign) | The executable (`.app` / `.exe`) | The OS, on launch | Gatekeeper / SmartScreen warnings |
| Tauri updater (ed25519) | The update bundle (`.tar.gz` / `.exe` / `.AppImage`) | The running app, on update | Updater rejects the download |

**Order matters:** OS-sign the inner executable first, then package it into the update bundle, then Tauri-sign the bundle. The `.sig` file is generated from the final bundle that already contains the OS-signed binary.

```
codesign/jsign the executable
  → package into update bundle (.tar.gz for macOS; installer/AppImage directly on Windows/Linux)
    → Tauri-sign the bundle → produces .sig file
      → upload bundle + .sig to GitHub Release
```

### Packaged app logging

Windows release builds use the GUI subsystem, so launching `dormouse.exe` from a terminal returns immediately and does not stream stdout/stderr. The Tauri backend writes sidecar diagnostics to `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log` on Windows, or to `$TMPDIR/dormouse.log` on other platforms. Set `DORMOUSE_LOG_FILE` to override the path.

## Artifact filenames

All release assets use **stable filenames** (no version in the name). This allows hotlinking directly from dormouse.sh via GitHub's `/latest/download/` redirect, which always resolves to the most recent release. Stable output filenames are the `FNAME_*` constants in `scripts/sign-and-deploy.sh`.

### Download hotlinks

The dormouse.sh download page can link directly to the latest release with no server-side logic, e.g.:

```
https://github.com/diffplug/dormouse/releases/latest/download/Dormouse-macos-aarch64.tar.gz
```

These can later be migrated to `dormouse.sh/download/...` URLs backed by Cloudflare R2 (for analytics) without changing anything in the app — only the website links and the updater endpoint URL in `tauri.conf.json` would change.

## Tauri auto-updater

### Configuration

Updater config lives in [tauri.conf.json](../../standalone/src-tauri/tauri.conf.json) (`bundle.createUpdaterArtifacts`, `plugins.updater.{pubkey,endpoints}`) and the plugin is registered in [lib.rs](../../standalone/src-tauri/src/lib.rs) via `tauri_plugin_updater`.

Design notes that aren't obvious from the files:
- `createUpdaterArtifacts: true` is the Tauri v2 artifact mode: Windows updates use the NSIS installer `.exe` directly, Linux updates use the `.AppImage` directly, and macOS uses `.app.tar.gz`.
- Do **not** set `"v1Compatible"` unless you're intentionally producing legacy `.nsis.zip` / `.AppImage.tar.gz` bundles for old Tauri v1 clients.

### Update manifest (`standalone-latest.json`)

Generated by the local script after signing. The script writes it to `website/public/standalone-latest.json` so it's served from `dormouse.sh/standalone-latest.json` via Cloudflare Pages. This gives us request analytics on update checks.

```json
{
  "version": "0.1.0",
  "notes": "Release notes here",
  "pub_date": "2026-03-25T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/diffplug/dormouse/releases/download/v0.1.0/Dormouse-windows-x64-setup.exe",
      "signature": "<contents of .sig file>"
    },
    "darwin-aarch64": {
      "url": "https://github.com/diffplug/dormouse/releases/download/v0.1.0/Dormouse-macos-aarch64.tar.gz",
      "signature": "<contents of .sig file>"
    },
    "linux-x86_64": {
      "url": "https://github.com/diffplug/dormouse/releases/download/v0.1.0/Dormouse-linux-x86_64.AppImage",
      "signature": "<contents of .sig file>"
    }
  }
}
```

Note: the update manifest URLs include the version in the *path* (`/v0.1.0/`) but the *filenames* are stable. The manifest itself is served from `dormouse.sh/standalone-latest.json` — Cloudflare Pages analytics tracks every update check.

## Changelog

A single `CHANGELOG.md` at the repo root, following [Keep a Changelog](https://keepachangelog.com/) format. The `[Unreleased]` section is promoted to `[X.Y.Z]` at release time. The release notes include both standalone and VSCode changes in one entry.

The website changelog page imports generated data from `website/src/data/changelog.json`, but `CHANGELOG.md` is the source of truth and the JSON is gitignored. You do not normally run `website/scripts/generate-changelog.js` by hand:
- `pnpm --filter dormouse-website build` runs it through the website `prebuild` script before Vite bundles the static site.
- `pnpm --filter dormouse-website dev` and `pnpm --filter dormouse-website test` also regenerate it through lifecycle scripts so clean checkouts work locally.

If you edit `CHANGELOG.md` manually outside `/release-notes` and want to preview the generated data immediately, run `node website/scripts/generate-changelog.js`. Do not commit `website/src/data/changelog.json`.

## Environment / secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `VSCE_PAT` | `vscode-extension-publish` GitHub environment secret | VS Code Marketplace publish |
| `OVSX_PAT` | `vscode-extension-publish` GitHub environment secret | OpenVSX publish |
| `GITHUB_TOKEN` | GitHub Actions (automatic) | Artifact upload |
| `APPLE_SIGNING_IDENTITY` | Local keychain | macOS codesign |
| `APPLE_ID` | Hardcoded in `sign-and-deploy.sh` | Notarization |
| `APPLE_SIGN_PASS` | Local env / prompted | Notarization password |
| `APPLE_TEAM_ID` | Local env / hardcoded | Notarization |
| `EV_SIGN_PIN` | Local env / prompted | Windows PIV signing |
| `TAURI_SIGNING_PRIVATE_KEY` | Local env / prompted | Tauri update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Local env / prompted | Tauri update key password |
