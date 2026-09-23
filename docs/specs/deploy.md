# Deploy Spec

> Owns the release process: artifact matrix, release checklist, the two-stage sign-and-release pipeline, the update manifest it publishes, and the changelog flow. The updater's client side is `docs/specs/auto-update.md`.

## What we ship

**Must use one version number and one changelog entry for every artifact:**

| Artifact | Format | Destination |
|----------|--------|-------------|
| VSCode extension | `.vsix` | VS Code Marketplace + OpenVSX |
| Standalone (Windows x64) | `.exe` (NSIS installer) | GitHub Release + Tauri updater |
| Standalone (macOS, Apple Silicon) | `.tar.gz` (contains signed `.app`) | GitHub Release + Tauri updater |
| Standalone (Linux x86_64) | `.AppImage` | GitHub Release + Tauri updater |

**Must upload exactly those three standalone bundles to the GitHub Release**; the `.vsix` ships only through the two marketplaces, and updater signatures live in the website manifest.

Source of truth: `create_release` in `scripts/sign-and-deploy.sh`; `publish-vscode` in `.github/workflows/release.yml`.

## Release checklist

Human-driven, in order:

1. **Update dependency snapshots** — run `node website/scripts/generate-deps.js`, review the diffs in `website/src/data/dependencies-{npm,cargo,runtime}.json`, commit if changed.
2. **Draft release notes and bump version** — run `/release-notes` at the repo root ([.claude/commands/release-notes.md](../../.claude/commands/release-notes.md)), which owns the steps. Review the diff.
3. **Commit and tag** — `git commit -am "Release vX.Y.Z"` then `git tag vX.Y.Z`.
4. **Push** — `git push && git push origin vX.Y.Z`, which triggers CI (Stage 1).
5. **Run local signing** — plug in the PIV USB key, then `./scripts/sign-and-deploy.sh all X.Y.Z`: it waits for CI, verifies and signs artifacts, writes the website update manifest, and creates the GitHub Release. Secrets follow [Environment / secrets](#environment--secrets). **Must reject a dirty tree, untracked files, or commits ahead of the configured upstream**; without an upstream the script warns that push status is unknown.
6. **Deploy website** — commit the updated `website/public/standalone-latest.json` and deploy dormouse.sh so the updater endpoint is live.
7. **Verify the release**
   - GitHub Release assets are correct
   - On a Mac: extract the `.tar.gz`, open the `.app`, no Gatekeeper warning
   - On Windows: run the `.exe` installer, no SmartScreen warning
   - The Tauri auto-updater picks up the new version, tested from a previous one with a Claude or Codex session open: its "Restart now" relaunches into the new version and resumes the agent
   - The VSCode extension is live on Marketplace and OpenVSX

## Versioning

**Must synchronize the four version files — `lib/package.json`, `vscode-ext/package.json`, `standalone/src-tauri/Cargo.toml`, `standalone/src-tauri/tauri.conf.json` — and Cargo.lock's `dormouse` entry with `scripts/bump-version.sh`** (`cargo check --offline`). **A version is `X.Y.Z`**: both the bump script and `sign-and-deploy.sh` reject a prerelease suffix, rather than one of them discovering it after the tag is pushed.

**A release is triggered by pushing one tag (`v0.1.0`)** — never separate `vscode-ext/v*` and `standalone/v*` tags, because one changelog entry covers both.

Source of truth: `scripts/bump-version.sh`; `on.push.tags` in `.github/workflows/release.yml`.

## Two-stage pipeline

**Both signing steps must run locally** — Windows code signing requires a physical USB hardware key (EV cert via PIV), macOS a local Developer ID cert.

- **Stage 1 (CI)** — build, attest, and upload the unsigned artifacts: the three Tauri bundles and the `.vsix`, which Stage 2 verifies but never signs.
- **Stage 2 (local, `sign-and-deploy.sh`)** — verify, sign, and release.

## Stage 1: CI workflow

Triggered by tag push `v*`: `build-standalone`, `build-vscode`, and `security-audit` run in parallel, then `publish-vscode` once all three succeed. Matrix targets, pnpm/Node versions, and step ordering live in [.github/workflows/release.yml](../../.github/workflows/release.yml).

Environment protection, secret placement, and token permissions follow `docs/specs/security-ci.md` → "GitHub Actions Policies", "Automated Maintainer (tend)", and "VS Code Extension Releases".

**Must create `release-attest` before referencing it in both build jobs**, with no required reviewer (rationale).

**Never use `tauri-action`'s built-in GitHub Release creation** — the release is created locally, after signing.

**The `build-standalone` artifact upload must set `include-hidden-files: true`** (rationale). The `vscode-extension` upload keeps the safer default — only `*.vsix` and the manifest.

**Must hash `artifact-executables.txt` into each standalone artifact manifest and upload it alongside the files**, recording their executable paths before ZIP transport loses permissions (rationale).

**The CI updater key never leaves the runner** — generated in-job, never in source control or GitHub Secrets, and not the key shipped apps trust. It exists only so Tauri emits updater-shaped artifacts during unsigned builds; Stage 2 re-signs the final bundles with the production key.

Source of truth: `build-standalone` / `build-vscode` in `.github/workflows/release.yml`.

### Job: `security-audit`

Dispatches `security-audit.yaml` on the release tag (`gh workflow run`), polls for the run, and waits with `gh run watch --exit-status`: a failing audit fails this job, and since `publish-vscode` is gated on it, blocks the Marketplace publish. **Dispatch, never `uses:` the reusable workflow**: `anthropics/claude-code-action` rejects the `push` event a tag-triggered `workflow_call` would inherit (rationale).

### Job: `publish-vscode`

Runs in CI because Marketplace publishing uses PAT tokens, no hardware key. **The `vscode-extension-publish` environment must require reviewer approval and admit deployments only from `v*` tags**, and **`VSCE_PAT` / `OVSX_PAT` must be environment secrets there**, never broad repository secrets.

Those three, and the `Tag operations` ruleset behind `v*`, are GitHub repository settings: nothing in the tree carries them and no lint can read them, so a checkout cannot prove the release path is gated. Verify them in the repository's settings when auditing it.

## Stage 2: Local script

**Never mutate `release-signed/downloads/`.** `all` and `resume` rebuild `release-signed/work/`; `sign-mac` and `sign-win` refresh only their platform, and `notarize` preserves the signed Mac copy. `--help` lists subcommands.

**Must require completed OS-signing/notarization stages before updater signing, and completed updater signing before release upload.** Re-running an earlier stage invalidates dependent bundles and completion markers. **Must reject a cached-version mismatch in resume subcommands without deleting work**; `all X.Y.Z` starts a different version. Release commands accept stable `X.Y.Z` versions only.

Downloaded CI artifacts must pass three checks before any signing step:

1. Every path is canonical and relative; the root manifest lists every downloaded file, including executable metadata. Reject symlinks, special files, duplicate records, missing files, and unlisted files or executable paths.
2. `gh attestation verify` proves the manifest was attested by `.github/workflows/release.yml` in `diffplug/dormouse`, for `refs/tags/vX.Y.Z`, at the exact commit SHA the local tag resolves to.
3. `sha256sum -c` (or `shasum -a 256 -c`) proves every downloaded file the manifest lists still has the hash CI recorded before upload.

**Must attest the manifest** (rationale). **Must re-verify cached artifacts and require a successful release workflow before every signing, notarization, or release subcommand**, then restore executable modes only in fresh working copies. CI run selection matches both tag and commit, including when every download is cached.

**Never select release artifacts with a broad `find | head`** — use strict expected paths or exactly-one matching. Release upload rejects unexpected local files or existing remote asset names.

**Must refuse a published release before spending a stage on it.** Immutable releases lock assets and tag at publication and burn the tag name even after deletion, so a botched publish is repaired by cutting the next version, and every command ending in a release upload checks before it downloads or signs. The retry path stays open only while the release is a draft (rationale).

**Must repoint the Tauri-generated `.nsi` at local paths before `makensis`** — it is baked with CI-runner absolutes; `rebuild_windows_installer` documents the rewrite.

**Runs on macOS only** — it uses `codesign` / `xcrun notarytool` / `ditto`, and its in-place `sed -i ''` edits are BSD form.

Source of truth: `main` / `verify_downloaded_artifact` / `prepare_artifact` / `require_unpublished_release` in `scripts/sign-and-deploy.sh`; `verifyInventory` / `restoreExecutables` in `scripts/release-artifact.mjs`; `scripts/patch-nsis-paths.pl`. Regression tests: `scripts/sign-and-deploy.test.mjs`.

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

**Must OS-sign the inner executable, package it, then Tauri-sign the final bundle.** Embed the generated `.sig` in the website manifest and remove the sidecar signature file before upload.

Two macOS packaging edge cases the script enforces, each of which would ship a release that fails only on the user's machine: **never `--deep`-sign the outer `.app`** — nested binaries (the Node sidecar, the node-pty and node-datachannel prebuilds, `spawn-helper`) are signed individually first, and the script then launches the signed sidecar and requires both native addons from it — and **build the `.tar.gz` with `COPYFILE_DISABLE=1`**, re-scanning the result for `._*`. Both carry their reasoning at `sign_macos_app` and `notarize_macos` in the script.

### Packaged app logging

Packaged-app log paths and `DORMOUSE_LOG_FILE` follow `docs/specs/standalone.md` → Logging.

## Artifact filenames

**All release assets use stable filenames** (no version in the name) — the `FNAME_*` constants in `scripts/sign-and-deploy.sh` — so a bundle URL differs only in its version path segment.

## Tauri auto-updater

### Configuration

Config lives in [tauri.conf.json](../../standalone/src-tauri/tauri.conf.json) (`bundle.createUpdaterArtifacts`, `plugins.updater.{pubkey,endpoints,windows}`); [lib.rs](../../standalone/src-tauri/src/lib.rs) registers `tauri_plugin_updater`.

- `createUpdaterArtifacts: true` selects the Tauri v2 artifact mode — Windows updates use the NSIS installer `.exe` directly, Linux the `.AppImage` directly, macOS `.app.tar.gz`, with no `.nsis.zip` or `.AppImage.tar.gz` to collect.
- **Never set `"v1Compatible"`** unless you intend legacy `.nsis.zip` / `.AppImage.tar.gz` bundles for old Tauri v1 clients.

### Update manifest (`standalone-latest.json`)

`sign_updates` writes it after signing to `website/public/standalone-latest.json`, served via Cloudflare Pages from `dormouse.sh/standalone-latest.json` (the `plugins.updater.endpoints` entry) — giving request analytics on every update check.

Shape: `version`, `notes` (a link to the GitHub release tag, not the changelog body), `pub_date`, and a `platforms` map keyed `darwin-aarch64` / `windows-x86_64` / `linux-x86_64`, each with `url` and `signature` (that bundle's `.sig`, verbatim). **The script fails rather than emit a platform with an empty signature.**

Manifest URLs carry the version in the *path* (`/v0.1.0/`) while the *filenames* stay stable. **The homepage's download buttons read their URLs from this same committed manifest**, so a release is only downloadable once step 6 has deployed it (`website/src/pages/Home.tsx`).

Source of truth: `sign_updates` in `scripts/sign-and-deploy.sh`; `plugins.updater` in `standalone/src-tauri/tauri.conf.json`.

## Changelog

One `CHANGELOG.md` at the repo root covers standalone and VSCode changes, tagged with the artifact emoji from its header. **Must retain `## [X.Y.Z]` headings**: `create_release` matches that version literally and extracts through the next level-two heading or EOF for the GitHub Release body.

The website changelog page imports `website/src/data/changelog.json`, but **`CHANGELOG.md` is the source of truth and the JSON is gitignored — never commit it**. The website's `prebuild`, `predev`, and `pretest` scripts regenerate it; run `website/scripts/generate-changelog.js` by hand only to preview a manual edit.

Source of truth: `create_release` in `scripts/sign-and-deploy.sh`; `website/scripts/generate-changelog.js`; lifecycle scripts in `website/package.json`.

## Environment / secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `VSCE_PAT` | `vscode-extension-publish` environment secret | VS Code Marketplace publish |
| `OVSX_PAT` | `vscode-extension-publish` environment secret | OpenVSX publish |
| `GITHUB_TOKEN` | GitHub Actions (automatic) | `tauri-action`'s build steps; `gh` calls in `security-audit` |
| `APPLE_SIGN_PASS` | Local env / prompted | Notarization (app-specific password) |
| `EV_SIGN_PIN` | Local env / prompted | Windows PIV signing |
| `TAURI_SIGNING_PRIVATE_KEY` | Local env / prompted | Tauri update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Local env | Tauri update key password (optional) |

**Non-secret signing identity is hardcoded at the top of `scripts/sign-and-deploy.sh`, never passed through the environment** — Developer ID string, team ID, Apple ID, `jsign` alias, TSA URL. The Developer ID cert lives in the local keychain, the EV cert on the YubiKey; neither is a value the script reads.

`docs/specs/security-ci.md` -> "Desktop Releases" owns the argv-exposure rules for the three prompted secrets.

## Hosted account releases

See `docs/specs/hosted.md` -> "Production releases" for the Hosted pipeline and `hosted/README.md` for provisioning and operator commands.

## Future

**Analytics-backed download URLs.** The GitHub release URLs could move to `dormouse.sh/download/...` behind Cloudflare R2. Changing website links and manifest bundle URLs needs no app update while the manifest endpoint remains stable.
