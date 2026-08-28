# Deploy Spec

## What we ship

One version number and one changelog entry cover every artifact:

| Artifact | Format | Destination |
|----------|--------|-------------|
| VSCode extension | `.vsix` | VS Code Marketplace + OpenVSX |
| Standalone (Windows x64) | `.exe` (NSIS installer) | GitHub Release + Tauri updater |
| Standalone (macOS, Apple Silicon) | `.tar.gz` (contains signed `.app`) | GitHub Release + Tauri updater |
| Standalone (Linux x86_64) | `.AppImage` | GitHub Release + Tauri updater |

The GitHub Release carries exactly those three standalone bundles and nothing else; the `.vsix` ships only through the two marketplaces.

## Release checklist

Human-driven steps, in order:

1. **Update dependency snapshots** — run `node website/scripts/generate-deps.js` and review the diffs in `website/src/data/dependencies-npm.json`, `website/src/data/dependencies-cargo.json`, and `website/src/data/dependencies-runtime.json`. Commit if changed.
2. **Draft release notes and bump version** — run `/release-notes` in Claude Code at the repo root (defined in [.claude/commands/release-notes.md](../../.claude/commands/release-notes.md)). It walks the merge commits and squash-merged PRs since the last tag, recommends a `breaking.added.bugfix` version bump, runs `./scripts/bump-version.sh X.Y.Z`, and edits `CHANGELOG.md` for the same version. Review and edit the resulting diff if needed.
3. **Commit and tag** — `git commit -am "Release vX.Y.Z"` then `git tag vX.Y.Z`.
4. **Push** — `git push && git push origin vX.Y.Z`. This triggers CI (Stage 1).
5. **Run local signing** — plug in the PIV USB key, then `./scripts/sign-and-deploy.sh all X.Y.Z`. It waits for CI, downloads and verifies the unsigned artifacts, signs macOS + Windows, generates the Tauri update manifest into `website/public/standalone-latest.json`, and creates the GitHub Release. Each secret is read from the environment if set and prompted for otherwise (see [Environment / secrets](#environment--secrets)); `--help` lists the resume-after-failure subcommands.
   It refuses to start unless the working tree is clean, has no untracked files, and has no unpushed commits — CI builds the tag, so anything local is not in what gets signed.
6. **Deploy website** — commit the updated `website/public/standalone-latest.json` and deploy dormouse.sh so the updater endpoint is live.
7. **Verify the release**
   - Check GitHub Release assets are correct
   - On a Mac: extract the `.tar.gz`, open the `.app`, confirm no Gatekeeper warnings
   - On Windows: run the `.exe` installer, confirm no SmartScreen warnings
   - Confirm the Tauri auto-updater picks up the new version (test from a previous version)
   - Confirm the VSCode extension is live on Marketplace and OpenVSX

## Versioning

A single version number (`X.Y.Z`) applies to all artifacts. `scripts/bump-version.sh` is the source of truth for which files carry it; it also re-syncs `Cargo.lock` (via `cargo check --offline`) so the lockfile's `dormouse` entry does not ship out of step with the binary.

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

Both build jobs run in the `release-attest` environment, whose deployment policy admits `v*` tags and nothing else. That bounds the ref a provenance OIDC token can be minted from: the `Tag operations` ruleset restricts tag `creation` and `update` to admins across `~ALL` tag refs, so an environment scoped to `v*` is a ref no non-admin can produce. The environment carries **no secrets and no required reviewer** — a reviewer would stall every release on manual approval at its first jobs, and the build jobs have no business seeing credentials. This is also why neither existing `v*` environment is reused: `vscode-extension-publish` requires reviewers, and `security-audit` holds `AUDIT_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`.

The environment must exist **before** the `environment:` keys reference it. A workflow naming an environment that does not exist auto-creates an unprotected one on the next `v*` push, which would leave the OIDC token ungated and add a no-policy environment to clean up.

**Note:** We do NOT use `tauri-action`'s built-in GitHub Release creation. We create the release locally after signing.

The `build-standalone` artifact upload sets `include-hidden-files: true` — `actions/upload-artifact` v4.4+ silently drops dotfiles by default, but the zsh shell integration ships as ZDOTDIR dotfiles (`standalone/sidecar/shell-integration/zsh/.zshenv` etc.). Without the flag, the artifact is missing files that `artifact-manifest.sha256` hashed (the manifest is generated from the runner's disk, before upload), and Stage 2 hash verification fails. The `vscode-extension` upload keeps the safer default since it only contains `*.vsix` and the manifest.

The CI updater key exists only so Tauri emits updater-shaped artifacts during unsigned builds. It is generated inside the runner, is not stored in source control or GitHub Secrets, and its public key is not the public key trusted by shipped apps. The final release bundles are re-signed locally by `scripts/sign-and-deploy.sh` with the production Tauri updater key before upload.

### Job: `security-audit`

Dispatches the `security-audit.yaml` workflow on the release tag (via `gh workflow run`), polls for the resulting run, and waits for its conclusion with `gh run watch --exit-status`, so a failing audit fails this job. `publish-vscode` is gated on it, so a failing security audit blocks the VS Code Marketplace publish. It dispatches rather than calling the reusable workflow with `uses:` because `anthropics/claude-code-action` rejects the `push` event that a tag-triggered `workflow_call` would inherit (and `GITHUB_EVENT_NAME` is a default variable that cannot be overridden); a dispatched run sees a supported `workflow_dispatch` event — the same path the nightly audit uses. `workflow_dispatch` is the documented exception that still creates a run when triggered by the default `GITHUB_TOKEN`, so no extra PAT is needed.

### Job: `publish-vscode`

This runs in CI because VSCode Marketplace publishing uses PAT tokens (no hardware key needed). The `vscode-extension-publish` environment must require reviewer approval and allow deployments only from `v*` tags. Store `VSCE_PAT` and `OVSX_PAT` as environment secrets there, not broad repository secrets.

## Stage 2: Local script

`scripts/sign-and-deploy.sh` is the source of truth for the local pipeline (download, sign, notarize, package, release). Run with no args or `--help` to see subcommands. Downloads in `release-signed/downloads/` are never mutated — every signing step operates on a fresh copy in `release-signed/work/` — so any step can be re-run without re-downloading.

Before any local signing step runs, downloaded CI artifacts must pass three checks:

1. Every path listed in `artifact-manifest.sha256` must be relative and free of `..` segments, so a tampered manifest cannot make hash verification read outside the artifact directory.
2. `gh attestation verify` must prove the artifact manifest was attested by `.github/workflows/release.yml` in `diffplug/dormouse`, for `refs/tags/vX.Y.Z`, at the exact commit SHA resolved by the local tag.
3. `sha256sum -c` or `shasum -a 256 -c` must prove every downloaded file listed in `artifact-manifest.sha256` still has the hash CI recorded before upload.

The manifest itself is the attested subject, not the final signed app. This closes the gap between CI artifact production and the local machine that holds signing credentials: stale cached artifacts, wrong-tag artifacts, and tampered downloads are rejected before codesign, jsign, notarization, Tauri signing, or release upload can run. Cached artifacts are re-verified on every run, not trusted because the download marker exists.

The local script must also select release artifacts by strict expected paths (or a find that must match exactly one file) instead of broad `find | head` matches. Release signing fails closed unless the expected files exist at the expected locations. The exact expected paths are enforced in `scripts/sign-and-deploy.sh`.

Release upload likewise uses only the three stable output filenames (the `FNAME_*` constants in `scripts/sign-and-deploy.sh`) and fails if `release-signed/release-assets` contains any other files.

When rebuilding the Windows installer locally, the script rewrites the absolute CI-runner paths baked into the Tauri-generated NSIS `.nsi` script (via `scripts/patch-nsis-paths.pl`) and patches the `ADDITIONALPLUGINSPATH` and `OUTFILE` defines to the expected local plugin directory and installer path before running `makensis`.

The script runs on macOS only: it uses `codesign` / `xcrun notarytool` / `ditto`, and its in-place `sed -i ''` edits are BSD-sed form.

### One-time setup

```bash
brew install gh jsign makensis
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

Two macOS packaging edge cases are enforced in the script, because both ship a release that fails only on the user's machine:

- Nested binaries (the Node sidecar, node-pty prebuilds, `spawn-helper`) are signed individually before the outer `.app`, and the outer sign is **not** `--deep` — `--deep` would re-sign the Node sidecar and drop the hardened-runtime entitlements it needs to run. After signing, the script actually launches the signed sidecar and `require('node-pty')` from it.
- The `.tar.gz` is built with `COPYFILE_DISABLE=1`, and the result is re-scanned for `._*` entries. AppleDouble resource-fork sidecars make the Tauri updater's extraction fail with `failed to unpack ._Dormouse.app`.

### Packaged app logging

Windows release builds use the GUI subsystem, so launching `dormouse.exe` from a terminal returns immediately and does not stream stdout/stderr. The Tauri backend writes sidecar diagnostics to `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log` on Windows, or to `$TMPDIR/dormouse.log` on other platforms. `DORMOUSE_LOG_FILE` overrides the path on every platform and takes precedence over both defaults.

## Artifact filenames

All release assets use **stable filenames** (no version in the name), so dormouse.sh can hotlink through GitHub's `/latest/download/` redirect with no server-side logic:

```
https://github.com/diffplug/dormouse/releases/latest/download/Dormouse-macos-aarch64.tar.gz
```

The stable names are the `FNAME_*` constants in `scripts/sign-and-deploy.sh`.

## Tauri auto-updater

`docs/specs/auto-update.md` owns the client side (when the app checks, the approval prompt, install-on-quit). This section owns what the release pipeline produces.

### Configuration

Updater config lives in [tauri.conf.json](../../standalone/src-tauri/tauri.conf.json) (`bundle.createUpdaterArtifacts`, `plugins.updater.{pubkey,endpoints,windows}`) and the plugin is registered in [lib.rs](../../standalone/src-tauri/src/lib.rs) via `tauri_plugin_updater`.

Design notes that aren't obvious from the files:
- `createUpdaterArtifacts: true` is the Tauri v2 artifact mode: Windows updates use the NSIS installer `.exe` directly, Linux updates use the `.AppImage` directly, and macOS uses `.app.tar.gz`. There is no `.nsis.zip` or `.AppImage.tar.gz` to collect.
- Do **not** set `"v1Compatible"` unless you're intentionally producing legacy `.nsis.zip` / `.AppImage.tar.gz` bundles for old Tauri v1 clients.

### Update manifest (`standalone-latest.json`)

Written by `sign_updates` after signing, to `website/public/standalone-latest.json`, so it is served from `dormouse.sh/standalone-latest.json` (the `plugins.updater.endpoints` entry) via Cloudflare Pages. That gives us request analytics on every update check.

Shape: `version`, `notes` (a link to the GitHub release tag, not the changelog body), `pub_date`, and a `platforms` map keyed `darwin-aarch64` / `windows-x86_64` / `linux-x86_64`, each with `url` and `signature` (the verbatim contents of that bundle's `.sig`). The script fails rather than emitting a platform with an empty signature.

The manifest URLs put the version in the *path* (`/v0.1.0/`) while the *filenames* stay stable, which is why the website download links and the updater manifest can use different URL schemes for the same asset.

## Changelog

A single `CHANGELOG.md` at the repo root, following [Keep a Changelog](https://keepachangelog.com/) format, with one entry covering both standalone and VSCode changes. Entries are tagged with the artifact emoji defined in the file's own header (🖥️ standalone-only, 🔌 VS Code-only, no emoji for both). `create_release` extracts the `## [X.Y.Z]` section as the GitHub Release body, so the heading shape is load-bearing.

The website changelog page imports generated data from `website/src/data/changelog.json`, but `CHANGELOG.md` is the source of truth and the JSON is gitignored. You do not normally run `website/scripts/generate-changelog.js` by hand — the website's `prebuild`, `predev`, and `pretest` lifecycle scripts regenerate it, so clean checkouts work locally. Run it by hand only to preview a manual `CHANGELOG.md` edit, and never commit the result.

## Environment / secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `VSCE_PAT` | `vscode-extension-publish` GitHub environment secret | VS Code Marketplace publish |
| `OVSX_PAT` | `vscode-extension-publish` GitHub environment secret | OpenVSX publish |
| `GITHUB_TOKEN` | GitHub Actions (automatic) | `tauri-action`'s build steps; `gh` calls in `security-audit` |
| `APPLE_SIGN_PASS` | Local env / prompted | Notarization (app-specific password) |
| `EV_SIGN_PIN` | Local env / prompted | Windows PIV signing |
| `TAURI_SIGNING_PRIVATE_KEY` | Local env / prompted | Tauri update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Local env / prompted | Tauri update key password (optional) |

Non-secret signing identity — the Developer ID string, team ID, Apple ID, `jsign` alias, and TSA URL — is hardcoded at the top of `scripts/sign-and-deploy.sh`, not passed through the environment. The Developer ID cert itself lives in the local keychain and the EV cert on the YubiKey; neither is a value the script reads.

`SECURITY.md` -> "Desktop Releases" owns the argv-exposure rules for the three prompted secrets (which may sit on a command line and why).

## Future

**Analytics-backed download URLs.** The `/latest/download/` hotlinks could move to `dormouse.sh/download/...` backed by Cloudflare R2 for download analytics. Because the release filenames are stable, this changes only the website links and the `plugins.updater.endpoints` URL in `tauri.conf.json` — nothing in the shipped app.
