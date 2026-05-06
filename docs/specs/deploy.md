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

1. **Update dependencies page** — run `node website/scripts/generate-deps.js` and review the diff in `website/src/data/dependencies.json`. Commit if changed.
2. **Draft release notes and bump version** — run `/release-notes` in Claude Code at the repo root. The slash command (defined in [.claude/commands/release-notes.md](../../.claude/commands/release-notes.md)) walks the merge commits and squash-merged PRs since the last tag, recommends a `breaking.added.bugfix` version bump, runs `./scripts/bump-version.sh X.Y.Z`, and edits `CHANGELOG.md` for the same version. Review and edit the resulting diff if needed.
3. **Commit and tag** — `git commit -am "Release vX.Y.Z"` then `git tag vX.Y.Z`.
4. **Push** — `git push && git push origin vX.Y.Z`. This triggers CI (Stage 1).
5. **Set environment variables** — copy the relevant secrets into the terminal from your password manager (see [Environment / secrets](#environment--secrets) for the list).
6. **Run local signing** — plug in the PIV USB key, then `./scripts/sign-and-deploy.sh all X.Y.Z`. The script waits for CI, downloads unsigned artifacts, signs macOS + Windows, generates the Tauri update manifest into `website/public/standalone-latest.json`, and creates the GitHub Release. Run `./scripts/sign-and-deploy.sh --help` for resume-after-failure subcommands.
7. **Deploy website** — commit the updated `website/public/standalone-latest.json` and deploy mouseterm.com so the updater endpoint is live.
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
  → Build + publish VSCode extension
  → Upload unsigned Tauri artifacts

Stage 2: Local (sign-and-deploy.sh)
  → Download CI artifacts
  → Sign macOS (codesign + notarize)
  → Sign Windows (jsign + PIV hardware key)
  → Generate Tauri update manifest with signatures
  → Upload signed artifacts to GitHub Release
```

## Stage 1: CI workflow

Triggered by tag push `v*`. Three parallel jobs:

### Job: `build-standalone` (matrix)

Runs on `ubuntu-22.04` (linux), `macos-latest` (mac), and `windows-latest` (win). Uses `tauri-apps/tauri-action@v0`.

```yaml
strategy:
  matrix:
    include:
      - platform: ubuntu-22.04
        target: x86_64-unknown-linux-gnu
      - platform: macos-latest
        target: aarch64-apple-darwin
      - platform: windows-latest
        target: x86_64-pc-windows-msvc
```

Each matrix leg:
1. Checkout, setup Node 22, pnpm 10, Rust stable
2. Install workspace dependencies once from the repo root with `pnpm install --frozen-lockfile`
3. Install system deps (Linux: libgtk, libwebkit, etc.)
4. Build via `tauri-action` — but **skip signing** (no `APPLE_SIGNING_IDENTITY`, no `TAURI_SIGNING_PRIVATE_KEY`)
5. Upload artifacts (installers + bundles) via `actions/upload-artifact`

**Note:** We do NOT use `tauri-action`'s built-in GitHub Release creation. We create the release locally after signing.

### Job: `build-vscode`

Runs on `ubuntu-latest`:
1. Checkout, setup Node 22, pnpm 10
2. `pnpm install --frozen-lockfile` at the repo root
3. `pnpm --filter mouseterm-lib test`
4. `pnpm --filter mouseterm build:frontend && pnpm --filter mouseterm build`
5. `npx vsce package --no-dependencies`
6. Upload `.vsix` as artifact

### Job: `publish-vscode`

Runs after `build-vscode` succeeds:
1. Download `.vsix` artifact
2. `npx vsce publish --packagePath *.vsix --no-dependencies`
3. `npx ovsx publish --packagePath *.vsix --no-dependencies`

This runs in CI because VSCode Marketplace publishing uses PAT tokens (no hardware key needed).

**Migration note:** This replaces the existing `.github/workflows/publish-vscode.yml`, which was triggered by `vscode-ext/v*` tags and has never been run. That workflow should be deleted when the unified release workflow is created. Fixes from the old workflow: use `ubuntu-latest` instead of `macos-latest`, upgrade to Node 22, and unify under the `v*` tag convention.

## Stage 2: Local script

`scripts/sign-and-deploy.sh` is the source of truth for the local pipeline (download, sign, notarize, package, release). Run with no args or `--help` to see subcommands.

### One-time setup

```bash
brew install gh jsign
gh auth login
xcode-select --install
tauri signer generate  # creates the Tauri update signing keypair
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

Windows release builds use the GUI subsystem, so launching `mouseterm.exe` from a terminal returns immediately and does not stream stdout/stderr. The Tauri backend writes sidecar diagnostics to `%LOCALAPPDATA%\MouseTerm\mouseterm.log` on Windows, or to `$TMPDIR/mouseterm.log` on other platforms. Set `MOUSETERM_LOG_FILE` to override the path.

## Artifact filenames

All release assets use **stable filenames** (no version in the name). This allows hotlinking directly from mouseterm.com via GitHub's `/latest/download/` redirect, which always resolves to the most recent release.

| Asset | Filename | Purpose |
|-------|----------|---------|
| Windows | `MouseTerm-windows-x64-setup.exe` | Download + Tauri updater |
| macOS | `MouseTerm-macos-aarch64.tar.gz` | Download + Tauri updater |
| Linux | `MouseTerm-linux-x86_64.AppImage` | Download + Tauri updater |

### Download hotlinks

The mouseterm.com download page can link directly to the latest release with no server-side logic:

```
https://github.com/diffplug/mouseterm/releases/latest/download/MouseTerm-windows-x64-setup.exe
https://github.com/diffplug/mouseterm/releases/latest/download/MouseTerm-macos-aarch64.tar.gz
https://github.com/diffplug/mouseterm/releases/latest/download/MouseTerm-linux-x86_64.AppImage
```

These can later be migrated to `mouseterm.com/download/...` URLs backed by Cloudflare R2 (for analytics) without changing anything in the app — only the website links and the updater endpoint URL in `tauri.conf.json` would change.

## Tauri auto-updater

### Configuration

Updater config lives in [tauri.conf.json](../../standalone/src-tauri/tauri.conf.json) (`bundle.createUpdaterArtifacts`, `plugins.updater.{pubkey,endpoints}`) and the plugin is registered in [lib.rs](../../standalone/src-tauri/src/lib.rs) via `tauri_plugin_updater`.

Design notes that aren't obvious from the files:
- `createUpdaterArtifacts: true` is the Tauri v2 artifact mode: Windows updates use the NSIS installer `.exe` directly, Linux updates use the `.AppImage` directly, and macOS uses `.app.tar.gz`.
- Do **not** set `"v1Compatible"` unless you're intentionally producing legacy `.nsis.zip` / `.AppImage.tar.gz` bundles for old Tauri v1 clients.

### Update manifest (`standalone-latest.json`)

Generated by the local script after signing. The script writes it to `website/public/standalone-latest.json` so it's served from `mouseterm.com/standalone-latest.json` via Cloudflare Pages. This gives us request analytics on update checks.

```json
{
  "version": "0.1.0",
  "notes": "Release notes here",
  "pub_date": "2026-03-25T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/diffplug/mouseterm/releases/download/v0.1.0/MouseTerm-windows-x64-setup.exe",
      "signature": "<contents of .sig file>"
    },
    "darwin-aarch64": {
      "url": "https://github.com/diffplug/mouseterm/releases/download/v0.1.0/MouseTerm-macos-aarch64.tar.gz",
      "signature": "<contents of .sig file>"
    },
    "linux-x86_64": {
      "url": "https://github.com/diffplug/mouseterm/releases/download/v0.1.0/MouseTerm-linux-x86_64.AppImage",
      "signature": "<contents of .sig file>"
    }
  }
}
```

Note: the update manifest URLs include the version in the *path* (`/v0.1.0/`) but the *filenames* are stable. The manifest itself is served from `mouseterm.com/standalone-latest.json` — Cloudflare Pages analytics tracks every update check.

## Changelog

A single `CHANGELOG.md` at the repo root, following [Keep a Changelog](https://keepachangelog.com/) format. The `[Unreleased]` section is promoted to `[X.Y.Z]` at release time. The release notes include both standalone and VSCode changes in one entry.

The website changelog page imports generated data from `website/src/data/changelog.json`, but `CHANGELOG.md` is the source of truth and the JSON is gitignored. You do not normally run `website/scripts/generate-changelog.js` by hand:
- `pnpm --filter mouseterm-website build` runs it through the website `prebuild` script before Vite bundles the static site.
- `pnpm --filter mouseterm-website dev` and `pnpm --filter mouseterm-website test` also regenerate it through lifecycle scripts so clean checkouts work locally.

If you edit `CHANGELOG.md` manually outside `/release-notes` and want to preview the generated data immediately, run `node website/scripts/generate-changelog.js`. Do not commit `website/src/data/changelog.json`.

## Environment / secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `VSCE_PAT` | GitHub Actions secret | VS Code Marketplace publish |
| `OVSX_PAT` | GitHub Actions secret | OpenVSX publish |
| `GITHUB_TOKEN` | GitHub Actions (automatic) | Artifact upload |
| `APPLE_SIGNING_IDENTITY` | Local keychain | macOS codesign |
| `APPLE_ID` | Local env / prompted | Notarization |
| `APPLE_SIGN_PASS` | Local env / prompted | Notarization password |
| `APPLE_TEAM_ID` | Local env / hardcoded | Notarization |
| `EV_SIGN_PIN` | Local env / prompted | Windows PIV signing |
| `TAURI_SIGNING_PRIVATE_KEY` | Local env | Tauri update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Local env / prompted | Tauri update key password |
