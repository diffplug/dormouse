# Deploy Spec

> Owns the release process: artifact matrix, release checklist, the two-stage sign-and-release pipeline, the update manifest it publishes, and the changelog flow. The updater's client side is `docs/specs/auto-update.md`.

## What we ship

One version number and one changelog entry cover every artifact:

| Artifact | Format | Destination |
|----------|--------|-------------|
| VSCode extension | `.vsix` | VS Code Marketplace + OpenVSX |
| Standalone (Windows x64) | `.exe` (NSIS installer) | GitHub Release + Tauri updater |
| Standalone (macOS, Apple Silicon) | `.tar.gz` (contains signed `.app`) | GitHub Release + Tauri updater |
| Standalone (Linux x86_64) | `.AppImage` | GitHub Release + Tauri updater |

**The GitHub Release must carry exactly those three standalone bundles and nothing else**; the `.vsix` ships only through the two marketplaces.

## Release checklist

Human-driven, in order:

1. **Update dependency snapshots** — run `node website/scripts/generate-deps.js`, review the diffs in `website/src/data/dependencies-{npm,cargo,runtime}.json`, commit if changed.
2. **Draft release notes and bump version** — run `/release-notes` at the repo root ([.claude/commands/release-notes.md](../../.claude/commands/release-notes.md)): it recommends a `breaking.added.bugfix` bump from the merge commits and squash-merged PRs since the last tag, runs `./scripts/bump-version.sh X.Y.Z`, and edits `CHANGELOG.md` for that version. Review the diff.
3. **Commit and tag** — `git commit -am "Release vX.Y.Z"` then `git tag vX.Y.Z`.
4. **Push** — `git push && git push origin vX.Y.Z`, which triggers CI (Stage 1).
5. **Run local signing** — plug in the PIV USB key, then `./scripts/sign-and-deploy.sh all X.Y.Z`: it waits for CI, downloads and verifies the unsigned artifacts, signs macOS + Windows, writes the Tauri update manifest to `website/public/standalone-latest.json`, and creates the GitHub Release. Secrets come from the environment if set, otherwise a prompt ([Environment / secrets](#environment--secrets)). **It refuses to start on a dirty tree, untracked files, or unpushed commits** — CI builds the tag, so anything local is not in what gets signed.
6. **Deploy website** — commit the updated `website/public/standalone-latest.json` and deploy dormouse.sh so the updater endpoint is live.
7. **Verify the release**
   - GitHub Release assets are correct
   - On a Mac: extract the `.tar.gz`, open the `.app`, no Gatekeeper warning
   - On Windows: run the `.exe` installer, no SmartScreen warning
   - The Tauri auto-updater picks up the new version, tested from a previous one
   - The VSCode extension is live on Marketplace and OpenVSX

## Versioning

`scripts/bump-version.sh` is the source of truth for which files carry the single `X.Y.Z`; it also re-syncs `Cargo.lock` (via `cargo check --offline`) so the lockfile's `dormouse` entry does not ship out of step with the binary.

**A release is triggered by pushing one tag (`v0.1.0`)** — never separate `vscode-ext/v*` and `standalone/v*` tags, because one changelog entry covers both.

## Two-stage pipeline

**Both signing steps must run locally** — Windows code signing requires a physical USB hardware key (EV cert via PIV), macOS a local Developer ID cert.

- **Stage 1 (CI)** — build the unsigned Tauri apps (win, mac, linux) and the VSCode extension, generate and attest their artifact manifests, upload the unsigned Tauri artifacts, publish the extension after protected-environment approval.
- **Stage 2 (local, `sign-and-deploy.sh`)** — download the CI artifacts → verify attestations and hashes → sign macOS (codesign + notarize) → sign Windows (jsign + PIV hardware key) → generate the Tauri update manifest with signatures → upload the signed artifacts to the GitHub Release.

## Stage 1: CI workflow

Triggered by tag push `v*`: `build-standalone`, `build-vscode`, and `security-audit` run in parallel, then `publish-vscode` once all three succeed. Matrix targets, pnpm/Node versions, and step ordering live in [.github/workflows/release.yml](../../.github/workflows/release.yml).

`GITHUB_TOKEN` defaults to `contents: read`. Build jobs add provenance (`id-token: write` + `attestations: write`); `security-audit` adds `actions: write` to dispatch the audit workflow; `publish-vscode` keeps the default and is separately gated by the `vscode-extension-publish` environment.

**Both build jobs run in the `release-attest` environment**, whose deployment policy admits `v*` tags and nothing else — bounding the ref a provenance OIDC token can be minted from, because the `Tag operations` ruleset restricts tag `creation`/`update` to admins across `~ALL` tag refs, making `v*` a ref no non-admin can produce. **It carries no secrets and no required reviewer** (rationale). **The environment must exist before the `environment:` keys reference it** — naming a missing environment auto-creates an unprotected one on the next `v*` push, leaving the OIDC token ungated.

**Never use `tauri-action`'s built-in GitHub Release creation** — the release is created locally, after signing.

**The `build-standalone` artifact upload must set `include-hidden-files: true`** — `actions/upload-artifact` v4.4+ silently drops dotfiles, and the zsh shell integration ships as ZDOTDIR dotfiles (rationale). The `vscode-extension` upload keeps the safer default — only `*.vsix` and the manifest.

**The CI updater key never leaves the runner** — generated in-job, never in source control or GitHub Secrets, and not the key shipped apps trust. It exists only so Tauri emits updater-shaped artifacts during unsigned builds; Stage 2 re-signs the final bundles with the production key.

### Job: `security-audit`

Dispatches `security-audit.yaml` on the release tag (`gh workflow run`), polls for the run, and waits with `gh run watch --exit-status`: a failing audit fails this job, and since `publish-vscode` is gated on it, blocks the Marketplace publish. **Dispatch, never `uses:` the reusable workflow**: `anthropics/claude-code-action` rejects the `push` event a tag-triggered `workflow_call` would inherit (rationale).

### Job: `publish-vscode`

Runs in CI because Marketplace publishing uses PAT tokens, no hardware key. **The `vscode-extension-publish` environment must require reviewer approval and admit deployments only from `v*` tags**, and **`VSCE_PAT` / `OVSX_PAT` must be environment secrets there**, never broad repository secrets.

## Stage 2: Local script

`scripts/sign-and-deploy.sh` is the source of truth for the local pipeline (download, sign, notarize, package, release); no args or `--help` lists its resume-after-failure subcommands. **Downloads in `release-signed/downloads/` are never mutated** — every signing step works on a fresh copy in `release-signed/work/`, so any step re-runs without re-downloading.

Downloaded CI artifacts must pass three checks before any signing step:

1. Every path in `artifact-manifest.sha256` is relative and free of `..` segments, so a tampered manifest cannot make hash verification read outside the artifact directory.
2. `gh attestation verify` proves the manifest was attested by `.github/workflows/release.yml` in `diffplug/dormouse`, for `refs/tags/vX.Y.Z`, at the exact commit SHA the local tag resolves to.
3. `sha256sum -c` (or `shasum -a 256 -c`) proves every downloaded file the manifest lists still has the hash CI recorded before upload.

The attested subject is the manifest, not the final signed app (rationale). **Cached artifacts are re-verified on every run**, never trusted because the download marker exists.

**Never select release artifacts with a broad `find | head`** — the script uses strict expected paths (or a find that must match exactly one file) and fails closed. Release upload takes only the three stable `FNAME_*` filenames and fails if `release-signed/release-assets` holds anything else.

When rebuilding the Windows installer locally, the script rewrites the CI-runner absolute paths baked into the Tauri-generated `.nsi` (via `scripts/patch-nsis-paths.pl`) and repoints the `ADDITIONALPLUGINSPATH` and `OUTFILE` defines at the local plugin directory and installer path before `makensis`.

**Runs on macOS only** — it uses `codesign` / `xcrun notarytool` / `ditto`, and its in-place `sed -i ''` edits are BSD form.

### One-time setup

```bash
brew install gh jsign makensis
gh auth login
xcode-select --install
pnpm install --frozen-lockfile
pnpm --dir standalone exec tauri signer generate  # creates the Tauri update signing keypair
```

### Two signing layers

**Both layers are required** (rationale).

| Layer | What it signs | Who verifies | Without it |
|-------|--------------|--------------|------------|
| OS (codesign / jsign) | Executable (`.app` / `.exe`) | OS, on launch | Gatekeeper / SmartScreen warnings |
| Tauri updater (ed25519) | Update bundle (`.tar.gz` / `.exe` / `.AppImage`) | Running app, on update | Updater rejects the download |

**Order matters: OS-sign the inner executable, package it into the update bundle, then Tauri-sign the bundle** — the `.sig` must come from a final bundle that already contains the OS-signed binary. Bundle and `.sig` upload together to the GitHub Release.

Two macOS packaging edge cases the script enforces; each would ship a release that fails only on the user's machine:

- **Never `--deep`-sign the outer `.app`** — it would re-sign the Node sidecar and drop the hardened-runtime entitlements it needs. Nested binaries (the Node sidecar, node-pty prebuilds, `spawn-helper`) are signed individually first, and the script then launches the signed sidecar and `require('node-pty')` from it.
- **Build the `.tar.gz` with `COPYFILE_DISABLE=1`** and re-scan the result for `._*` entries — AppleDouble resource-fork files make the Tauri updater's extraction fail with `failed to unpack ._Dormouse.app`.

### Packaged app logging

Windows release builds use the GUI subsystem, so a terminal-launched `dormouse.exe` returns immediately, streaming nothing. The Tauri backend writes sidecar diagnostics to `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log` on Windows and `$TMPDIR/dormouse.log` elsewhere; **`DORMOUSE_LOG_FILE` overrides both on every platform**.

## Artifact filenames

**All release assets use stable filenames** (no version in the name), so dormouse.sh can hotlink through GitHub's `/latest/download/` redirect with no server-side logic — e.g. `https://github.com/diffplug/dormouse/releases/latest/download/Dormouse-macos-aarch64.tar.gz`. The stable names are the `FNAME_*` constants in `scripts/sign-and-deploy.sh`.

## Tauri auto-updater

### Configuration

Config lives in [tauri.conf.json](../../standalone/src-tauri/tauri.conf.json) (`bundle.createUpdaterArtifacts`, `plugins.updater.{pubkey,endpoints,windows}`); [lib.rs](../../standalone/src-tauri/src/lib.rs) registers `tauri_plugin_updater`.

- `createUpdaterArtifacts: true` selects the Tauri v2 artifact mode — Windows updates use the NSIS installer `.exe` directly, Linux the `.AppImage` directly, macOS `.app.tar.gz`, with no `.nsis.zip` or `.AppImage.tar.gz` to collect.
- **Never set `"v1Compatible"`** unless you intend legacy `.nsis.zip` / `.AppImage.tar.gz` bundles for old Tauri v1 clients.

### Update manifest (`standalone-latest.json`)

`sign_updates` writes it after signing to `website/public/standalone-latest.json`, served via Cloudflare Pages from `dormouse.sh/standalone-latest.json` (the `plugins.updater.endpoints` entry) — giving request analytics on every update check.

Shape: `version`, `notes` (a link to the GitHub release tag, not the changelog body), `pub_date`, and a `platforms` map keyed `darwin-aarch64` / `windows-x86_64` / `linux-x86_64`, each with `url` and `signature` (that bundle's `.sig`, verbatim). **The script fails rather than emit a platform with an empty signature.**

Manifest URLs carry the version in the *path* (`/v0.1.0/`) while the *filenames* stay stable (rationale).

## Changelog

One `CHANGELOG.md` at the repo root, in [Keep a Changelog](https://keepachangelog.com/) format, covers standalone and VSCode changes in one entry, tagged with the artifact emoji from the file's own header (🖥️ standalone-only, 🔌 VS Code-only, none for both). **`create_release` extracts the `## [X.Y.Z]` section as the GitHub Release body, so the heading shape is load-bearing.**

The website changelog page imports `website/src/data/changelog.json`, but **`CHANGELOG.md` is the source of truth and the JSON is gitignored — never commit it**. The website's `prebuild`, `predev`, and `pretest` scripts regenerate it; run `website/scripts/generate-changelog.js` by hand only to preview a manual edit.

## Environment / secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `VSCE_PAT` | `vscode-extension-publish` environment secret | VS Code Marketplace publish |
| `OVSX_PAT` | `vscode-extension-publish` environment secret | OpenVSX publish |
| `GITHUB_TOKEN` | GitHub Actions (automatic) | `tauri-action`'s build steps; `gh` calls in `security-audit` |
| `APPLE_SIGN_PASS` | Local env / prompted | Notarization (app-specific password) |
| `EV_SIGN_PIN` | Local env / prompted | Windows PIV signing |
| `TAURI_SIGNING_PRIVATE_KEY` | Local env / prompted | Tauri update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Local env / prompted | Tauri update key password (optional) |

**Non-secret signing identity is hardcoded at the top of `scripts/sign-and-deploy.sh`, never passed through the environment** — Developer ID string, team ID, Apple ID, `jsign` alias, TSA URL. The Developer ID cert lives in the local keychain, the EV cert on the YubiKey; neither is a value the script reads.

`docs/specs/security-ci.md` -> "Desktop Releases" owns the argv-exposure rules for the three prompted secrets.

## Future

**Analytics-backed download URLs.** The `/latest/download/` hotlinks could move to `dormouse.sh/download/...` behind Cloudflare R2 for download analytics. Because the filenames are stable, this changes only the website links and the `plugins.updater.endpoints` URL in `tauri.conf.json` — nothing in the shipped app.
