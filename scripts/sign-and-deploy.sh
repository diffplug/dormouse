#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Local Code Signing and GitHub Release Script
# =============================================================================
# Downloads unsigned CI artifacts, signs macOS and Windows binaries locally,
# generates Tauri update manifest, and creates a GitHub Release.
#
# Usage: ./scripts/sign-and-deploy.sh all <version>
#   Example: ./scripts/sign-and-deploy.sh all 0.1.0
#
# INVARIANT: Downloaded artifacts in $DOWNLOAD_DIR are NEVER modified.
# All signing/patching operates on copies in $SIGN_DIR.
# This allows re-running any signing step without re-downloading.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$REPO_ROOT/release-signed"
DOWNLOAD_DIR="$WORK_DIR/downloads"
SIGN_DIR="$WORK_DIR/work"

# Known artifact names (must match release.yml matrix artifact-name values)
ARTIFACT_NAMES=(
    standalone-mac-aarch64
    standalone-win-x64
    standalone-linux-x64
    vscode-extension
)

# =============================================================================
# Configuration
# =============================================================================

# macOS Signing Identity
MACOS_IDENTITY="Developer ID Application: DiffPlug LLC (LXW8WAGWYX)"
MACOS_TEAM_ID="LXW8WAGWYX"
APPLE_ID="edgar.twigg@gmail.com"
MACOS_NODE_ENTITLEMENTS="$REPO_ROOT/standalone/src-tauri/entitlements-macos-node.plist"

# Windows Signing (jsign with PIV)
JSIGN_ALIAS="AUTHENTICATION"
TSA_URL="http://ts.ssl.com"

# GitHub repo
GITHUB_REPO="diffplug/dormouse"

# Stable filenames for release assets (update bundles only)
FNAME_WIN="Dormouse-windows-x64-setup.exe"
FNAME_MAC="Dormouse-macos-aarch64.tar.gz"
FNAME_LINUX="Dormouse-linux-x86_64.AppImage"

# =============================================================================
# Helper Functions
# =============================================================================

log() { echo "[$(date '+%H:%M:%S')] $*"; }
error() { echo "[ERROR] $*" >&2; exit 1; }
warn() { echo "[WARN] $*" >&2; }

prompt_secret() {
    local varname="$1"
    local prompt="$2"
    if [[ -z "${!varname:-}" ]]; then
        read -rsp "$prompt: " "$varname"
        echo
        export "$varname"
    fi
}

prompt_secret_multiline() {
    local varname="$1"
    local prompt="$2"
    local sentinel="__EOF_${varname}__"
    if [[ -z "${!varname:-}" ]]; then
        cat >&2 <<EOF
$prompt
Paste the value, then finish with a line containing only: $sentinel
EOF

        local value=""
        local line=""
        while IFS= read -rs line; do
            if [[ "$line" == "$sentinel" ]]; then
                break
            fi
            value+="$line"$'\n'
        done

        if [[ -z "$value" ]]; then
            error "$varname was not provided"
        fi

        printf -v "$varname" '%s' "${value%$'\n'}"
        export "$varname"
    fi
}

check_command() {
    command -v "$1" &>/dev/null || error "Required command not found: $1. Install with: $2"
}

check_gh_attestation_support() {
    gh attestation verify --help &>/dev/null \
        || error "GitHub CLI does not support 'gh attestation verify'. Upgrade gh before signing release artifacts."
}

# Returns 0 if a specific artifact has already been downloaded
artifact_downloaded() {
    local name="$1"
    [[ -f "$DOWNLOAD_DIR/.downloaded-$name" ]]
}

# Returns 0 if ALL known artifacts have been downloaded
all_artifacts_downloaded() {
    for name in "${ARTIFACT_NAMES[@]}"; do
        artifact_downloaded "$name" || return 1
    done
    return 0
}

ensure_version() {
    local version="$1"
    local version_file="$WORK_DIR/.version"

    if [[ -f "$version_file" ]]; then
        local existing
        existing=$(cat "$version_file")
        if [[ "$existing" != "$version" ]]; then
            log "Version mismatch: found $existing, expected $version. Clearing release-signed/..."
            rm -rf "$WORK_DIR"
        fi
    fi

    mkdir -p "$WORK_DIR"
    echo "$version" > "$version_file"
}

check_git_clean() {
    log "Checking git status..."

    if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
        error "Local changes detected. Commit or stash changes before deploying."
    fi

    if [[ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]]; then
        error "Untracked files detected. Commit or remove them before deploying."
    fi

    local upstream
    upstream=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null) || true

    if [[ -n "$upstream" ]]; then
        local ahead
        ahead=$(git -C "$REPO_ROOT" rev-list --count "$upstream..HEAD")
        if [[ "$ahead" -gt 0 ]]; then
            error "You have $ahead unpushed commit(s). Push changes before deploying."
        fi
    else
        warn "No upstream branch set. Cannot verify commits are pushed."
    fi

    log "Git status clean."
}

# Copies downloaded artifacts to $SIGN_DIR for mutation.
# Call this before any signing step to get a fresh working copy.
prepare_sign_dir() {
    log "Preparing working copies from downloaded artifacts..."
    rm -rf "$SIGN_DIR"
    mkdir -p "$SIGN_DIR"
    # Copy only the artifact directories (not marker files)
    for name in "${ARTIFACT_NAMES[@]}"; do
        if [[ -d "$DOWNLOAD_DIR/$name" ]]; then
            cp -R "$DOWNLOAD_DIR/$name" "$SIGN_DIR/$name"
        fi
    done
}

find_nsis_script() {
    find "$SIGN_DIR/standalone-win-x64" \
        -name "installer.nsi" \
        -print \
        | head -1
}

rebuild_windows_installer() {
    local signed_exe="$1"
    local installer_path="$2"

    check_command makensis "Install NSIS: brew install makensis"

    local script_path
    script_path=$(find_nsis_script)
    [[ -n "$script_path" ]] || error "NSIS script not found in downloaded artifacts; ensure release.yml uploads the nsis staging directory."

    local script_dir
    script_dir="$(cd "$(dirname "$script_path")" && pwd)"

    # The .nsi contains ~60 absolute Windows paths from the CI runner.
    # Replace them all with local artifact paths using the helper script.
    local artifact_dir
    artifact_dir="$(cd "$SIGN_DIR/standalone-win-x64" && pwd)"
    perl "$SCRIPT_DIR/patch-nsis-paths.pl" "$script_path" "$artifact_dir"

    # Patch ADDITIONALPLUGINSPATH separately — it is outside the checkout tree.
    local plugin_dir
    plugin_dir=$(find "$SIGN_DIR/standalone-win-x64" -name "nsis_tauri_utils.dll" -exec dirname {} \; | head -1)
    if [[ -n "$plugin_dir" ]]; then
        local abs_plugin_dir
        abs_plugin_dir="$(cd "$plugin_dir" && pwd)"
        sed -i '' "s|^!define ADDITIONALPLUGINSPATH .*|!define ADDITIONALPLUGINSPATH \"$abs_plugin_dir\"|" "$script_path"
    else
        warn "nsis_tauri_utils.dll not found in artifacts; makensis may fail"
    fi

    local installer_name
    installer_name="$(basename "$installer_path")"

    rm -f "$installer_path"
    log "Rebuilding NSIS installer: $installer_name"
    (
        cd "$script_dir"
        makensis -NOCD "$(basename "$script_path")"
    )

    # makensis outputs whatever filename the .nsi defines; find it
    local output_exe
    output_exe=$(find "$script_dir" -maxdepth 1 -name "*.exe" -newer "$script_path" | head -1)
    [[ -n "$output_exe" ]] || error "NSIS rebuild did not produce an installer"
    log "NSIS produced: $(basename "$output_exe")"
    mv "$output_exe" "$installer_path"
}

resolve_tag_sha() {
    local tag="$1"
    local tag_sha

    tag_sha=$(git -C "$REPO_ROOT" rev-list -n 1 "$tag^{commit}" 2>/dev/null) \
        || error "Tag $tag not found locally. Fetch tags or create it first."

    [[ -n "$tag_sha" ]] || error "Could not resolve commit for tag $tag"
    printf '%s\n' "$tag_sha"
}

find_release_run_id() {
    local tag="$1"
    local tag_sha="$2"

    gh run list \
        --repo "$GITHUB_REPO" \
        --workflow release.yml \
        --event push \
        --commit "$tag_sha" \
        --limit 5 \
        --json databaseId,displayTitle,headSha \
        --jq ".[] | select(.displayTitle == \"$tag\" or .headSha == \"$tag_sha\") | .databaseId" \
        | head -1
}

validate_sha256_manifest_paths() {
    local manifest="$1"

    awk '
        NF < 2 { exit 1 }
        {
            path = $0
            sub(/^[0-9a-fA-F]+[[:space:]]+[* ]?/, "", path)
            if (path == "" || path ~ /^\// || path ~ /(^|\/)\.\.($|\/)/) {
                exit 1
            }
        }
    ' "$manifest"
}

check_sha256_manifest() {
    local artifact_dir="$1"
    local manifest_rel="$2"

    if command -v sha256sum &>/dev/null; then
        (cd "$artifact_dir" && sha256sum -c "$manifest_rel" >/dev/null)
    elif command -v shasum &>/dev/null; then
        (cd "$artifact_dir" && shasum -a 256 -c "$manifest_rel" >/dev/null)
    else
        error "Required command not found: sha256sum or shasum"
    fi
}

verify_downloaded_artifact() {
    local name="$1"
    local tag="$2"
    local tag_sha="$3"
    local artifact_dir="$DOWNLOAD_DIR/$name"

    [[ -d "$artifact_dir" ]] || error "$name: artifact directory not found at $artifact_dir"

    local manifest_count
    manifest_count=$(find "$artifact_dir" -name artifact-manifest.sha256 -type f | wc -l | tr -d '[:space:]')
    [[ "$manifest_count" == "1" ]] \
        || error "$name: expected exactly one artifact-manifest.sha256, found $manifest_count"

    local manifest
    manifest=$(find "$artifact_dir" -name artifact-manifest.sha256 -type f -print | head -1)
    [[ -s "$manifest" ]] || error "$name: artifact-manifest.sha256 is empty"

    local manifest_rel="${manifest#"$artifact_dir"/}"
    [[ "$manifest_rel" != "$manifest" ]] || error "$name: could not resolve manifest path relative to artifact directory"

    validate_sha256_manifest_paths "$manifest" \
        || error "$name: artifact manifest contains an absolute or parent-relative path"

    local identity="https://github.com/$GITHUB_REPO/.github/workflows/release.yml@refs/tags/$tag"

    log "  $name: verifying artifact attestation"
    gh attestation verify "$manifest" \
        --repo "$GITHUB_REPO" \
        --cert-identity "$identity" \
        --cert-oidc-issuer "https://token.actions.githubusercontent.com" \
        --source-ref "refs/tags/$tag" \
        --source-digest "$tag_sha" >/dev/null \
        || error "$name: artifact manifest attestation failed"

    log "  $name: verifying artifact hashes"
    check_sha256_manifest "$artifact_dir" "$manifest_rel" \
        || error "$name: downloaded artifact hash verification failed"
}

verify_downloaded_artifacts() {
    local tag="$1"
    local tag_sha="$2"

    log "Verifying artifact attestations and hashes..."
    for name in "${ARTIFACT_NAMES[@]}"; do
        verify_downloaded_artifact "$name" "$tag" "$tag_sha"
    done
}

# =============================================================================
# Download CI Artifacts (per-artifact caching)
# =============================================================================

# Downloads artifacts individually, skipping any already cached.
# Artifacts are stored in $DOWNLOAD_DIR and NEVER modified after download.
download_artifacts_from_run() {
    local run_id="$1"
    local tag="$2"
    local tag_sha="$3"

    mkdir -p "$DOWNLOAD_DIR"

    for name in "${ARTIFACT_NAMES[@]}"; do
        if artifact_downloaded "$name"; then
            log "  $name: already downloaded, verifying"
            verify_downloaded_artifact "$name" "$tag" "$tag_sha"
            continue
        fi

        log "  $name: downloading..."
        rm -rf "$DOWNLOAD_DIR/$name"
        if gh run download "$run_id" \
            --repo "$GITHUB_REPO" \
            --name "$name" \
            --dir "$DOWNLOAD_DIR/$name"; then
            verify_downloaded_artifact "$name" "$tag" "$tag_sha"
            touch "$DOWNLOAD_DIR/.downloaded-$name"
            log "  $name: done"
        else
            rm -rf "$DOWNLOAD_DIR/$name"
            warn "  $name: download failed (will retry on next run)"
        fi
    done

    if all_artifacts_downloaded; then
        log "All artifacts downloaded to $DOWNLOAD_DIR"
    else
        error "Some artifacts failed to download. Re-run to retry."
    fi
}

download_artifacts() {
    local version="$1"
    local tag="v$version"

    local tag_sha
    tag_sha=$(resolve_tag_sha "$tag")

    log "Finding workflow run for tag $tag ($tag_sha)..."

    check_command gh "brew install gh && gh auth login"
    check_gh_attestation_support

    if all_artifacts_downloaded; then
        log "All artifacts already downloaded, verifying cache"
        verify_downloaded_artifacts "$tag" "$tag_sha"
        return
    fi

    local run_id=""
    local attempts=0
    local max_attempts=60  # 5 minutes of retries

    while [[ -z "$run_id" ]] && [[ $attempts -lt $max_attempts ]]; do
        run_id=$(find_release_run_id "$tag" "$tag_sha")

        if [[ -z "$run_id" ]]; then
            attempts=$((attempts + 1))
            log "Workflow not found yet, waiting... (attempt $attempts/$max_attempts)"
            sleep 5
        fi
    done

    [[ -z "$run_id" ]] && error "Could not find workflow run for tag $tag"

    log "Found workflow run: $run_id"
    log "Waiting for workflow to complete (this may take several minutes)..."

    gh run watch "$run_id" --repo "$GITHUB_REPO" --exit-status \
        || error "Workflow failed. Check: https://github.com/$GITHUB_REPO/actions/runs/$run_id"

    log "Workflow completed successfully!"
    log "Downloading artifacts..."
    download_artifacts_from_run "$run_id" "$tag" "$tag_sha"
}

resume_download() {
    local version="$1"
    local tag="v$version"

    local tag_sha
    tag_sha=$(resolve_tag_sha "$tag")

    log "Finding completed workflow run for tag $tag ($tag_sha)..."

    check_command gh "brew install gh && gh auth login"
    check_gh_attestation_support

    if all_artifacts_downloaded; then
        log "All artifacts already downloaded, verifying cache"
        verify_downloaded_artifacts "$tag" "$tag_sha"
        return
    fi

    local run_id=""
    run_id=$(find_release_run_id "$tag" "$tag_sha")

    [[ -z "$run_id" ]] && error "Could not find workflow run for tag $tag"

    local conclusion
    conclusion=$(gh run view "$run_id" --repo "$GITHUB_REPO" --json conclusion --jq '.conclusion')
    if [[ "$conclusion" != "success" ]]; then
        error "Workflow run $run_id has conclusion '$conclusion' (expected 'success'). Check: https://github.com/$GITHUB_REPO/actions/runs/$run_id"
    fi

    log "Found completed workflow run: $run_id"
    log "Downloading artifacts..."
    download_artifacts_from_run "$run_id" "$tag" "$tag_sha"
}

# =============================================================================
# Sign macOS App Bundles
# =============================================================================

sign_macos_app() {
    local app_path="$1"
    local arch_label="$2"

    log "Signing macOS app ($arch_label): $app_path"

    [[ -d "$app_path" ]] || error "macOS app not found at $app_path"

    # Verify signing identity is available
    security find-identity -v -p codesigning | grep -q "$MACOS_IDENTITY" \
        || error "Signing identity not found: $MACOS_IDENTITY"

    # Sign all nested binaries first (node sidecar, node-pty prebuilds, etc.)
    # --deep doesn't reliably reach into Resources subdirectories
    log "Signing nested binaries..."
    [[ -f "$MACOS_NODE_ENTITLEMENTS" ]] || error "Node entitlements not found: $MACOS_NODE_ENTITLEMENTS"

    find "$app_path/Contents/MacOS" "$app_path/Contents/Resources" -type f \
        \( -perm -111 -o -name "*.node" -o -name "*.dylib" -o -name "spawn-helper" \) | while read -r binary; do
        log "  Signing: ${binary#"$app_path/"}"

        if [[ "$binary" == "$app_path/Contents/MacOS/node" ]]; then
            codesign --force --sign "$MACOS_IDENTITY" \
                --options runtime \
                --entitlements "$MACOS_NODE_ENTITLEMENTS" \
                --timestamp \
                "$binary"
        else
            codesign --force --sign "$MACOS_IDENTITY" \
                --options runtime \
                --timestamp \
                "$binary"
        fi
    done

    # Sign the outer .app bundle after nested code. Do not use --deep here:
    # it would re-sign the Node sidecar and drop the entitlements it needs to run.
    codesign --force --sign "$MACOS_IDENTITY" \
        --options runtime \
        --timestamp \
        "$app_path"

    # Verify
    codesign --verify --deep --strict --verbose=2 "$app_path" \
        || error "Signature verification failed for $app_path"

    local node_sidecar="$app_path/Contents/MacOS/node"
    local sidecar_dir=""
    for candidate in "$app_path/Contents/Resources/_up_/sidecar" "$app_path/Contents/Resources/sidecar"; do
        if [[ -d "$candidate" ]]; then
            sidecar_dir="$candidate"
            break
        fi
    done

    [[ -x "$node_sidecar" ]] || error "Node sidecar missing or not executable: $node_sidecar"
    [[ -n "$sidecar_dir" ]] || error "Sidecar resources not found in $app_path"

    "$node_sidecar" -p "process.version" >/dev/null \
        || error "Signed Node sidecar failed to launch"
    (cd "$sidecar_dir" && "$node_sidecar" -e "require('node-pty')") \
        || error "Signed Node sidecar failed to load node-pty"

    log "macOS signing complete ($arch_label)"
}

sign_macos() {
    log "Starting macOS code signing..."

    local app
    app=$(find "$SIGN_DIR/standalone-mac-aarch64" -name "*.app" -type d | head -1)

    [[ -n "$app" ]] && sign_macos_app "$app" "aarch64"

    log "All macOS signing complete"
}

# =============================================================================
# Notarize macOS Apps
# =============================================================================

notarize_macos_app() {
    local app_path="$1"
    local arch_label="$2"

    log "Notarizing macOS app ($arch_label)..."

    local zip_path="$SIGN_DIR/notarize-${arch_label}.zip"

    ditto -c -k --keepParent "$app_path" "$zip_path"

    xcrun notarytool submit "$zip_path" \
        --apple-id "$APPLE_ID" \
        --team-id "$MACOS_TEAM_ID" \
        --password "$APPLE_SIGN_PASS" \
        --wait \
        --timeout 30m

    rm -f "$zip_path"

    xcrun stapler staple "$app_path"
    xcrun stapler validate "$app_path" \
        || warn "Stapler validation warning for $arch_label (may still work)"

    log "Notarization complete ($arch_label)"
}

notarize_macos() {
    log "Starting macOS notarization..."

    check_command xcrun "xcode-select --install"
    prompt_secret APPLE_SIGN_PASS "Enter Apple ID password (or app-specific password)"

    local app
    app=$(find "$SIGN_DIR/standalone-mac-aarch64" -name "*.app" -type d | head -1)

    [[ -n "$app" ]] && notarize_macos_app "$app" "aarch64"

    # Re-package signed+notarized app into .dmg and .tar.gz
    if [[ -n "$app" ]]; then
        local app_name
        app_name=$(basename "$app")

        log "Creating $FNAME_MAC..."
        # COPYFILE_DISABLE=1 stops macOS's tar from writing ._* AppleDouble
        # sidecar files (resource-fork metadata) into the archive. Without
        # this the Tauri updater's extraction fails with
        # `failed to unpack ._Dormouse.app`.
        COPYFILE_DISABLE=1 tar -czf "$SIGN_DIR/$FNAME_MAC" -C "$(dirname "$app")" "$app_name"

        # Defense in depth: if any ._* slipped in anyway, fail loudly here
        # rather than shipping a tarball the updater can't unpack.
        if tar -tzf "$SIGN_DIR/$FNAME_MAC" | grep -E '(^|/)\._' >/dev/null; then
            error "$FNAME_MAC contains AppleDouble (._*) entries — macOS metadata leaked into the archive"
        fi
    fi

    log "All macOS notarization and packaging complete"
}

# =============================================================================
# Sign Windows Executable
# =============================================================================

sign_windows() {
    log "Starting Windows code signing..."

    check_command jsign "brew install jsign"
    prompt_secret EV_SIGN_PIN "Enter PIV PIN for Windows signing"

    # Find the inner exe
    local exe_path
    exe_path=$(find "$SIGN_DIR/standalone-win-x64" \( -name "Dormouse.exe" -o -name "dormouse.exe" \) -not -name "*setup*" -not -name "*install*" | head -1)
    [[ -n "$exe_path" ]] || error "Windows executable not found"

    log "Signing inner executable: $exe_path"
    jsign \
        --storetype PIV \
        --storepass "$EV_SIGN_PIN" \
        --alias "$JSIGN_ALIAS" \
        --tsaurl "$TSA_URL" \
        --tsmode RFC3161 \
        "$exe_path"

    # Find the NSIS installer
    local installer_path
    installer_path=$(find "$SIGN_DIR/standalone-win-x64" -name "*setup*.exe" -o -name "*install*.exe" | head -1)

    if [[ -n "$installer_path" ]]; then
        rebuild_windows_installer "$exe_path" "$installer_path"
        log "Signing installer: $installer_path"
        jsign \
            --storetype PIV \
            --storepass "$EV_SIGN_PIN" \
            --alias "$JSIGN_ALIAS" \
            --tsaurl "$TSA_URL" \
            --tsmode RFC3161 \
            "$installer_path"

    fi

    log "Windows signing complete"
}

# =============================================================================
# Sign Update Bundles (Tauri Layer)
# =============================================================================

sign_updates() {
    local version="$1"

    log "Signing update bundles with Tauri key..."

    check_command pnpm "Install pnpm with corepack: corepack enable pnpm"
    pnpm --dir "$REPO_ROOT/standalone" exec tauri --version &>/dev/null \
        || error "Tauri CLI not found in workspace dependencies. Run 'pnpm install --frozen-lockfile' before signing updates."

    prompt_secret_multiline TAURI_SIGNING_PRIVATE_KEY "Enter Tauri signing private key"

    local release_dir="$WORK_DIR/release-assets"
    rm -rf "$release_dir"
    mkdir -p "$release_dir"

    # Collect update bundles with stable filenames
    # macOS .tar.gz (created by notarize step from signed+notarized .app)
    [[ -f "$SIGN_DIR/$FNAME_MAC" ]] || error "macOS update bundle not found at $SIGN_DIR/$FNAME_MAC. Run signing and notarization first."
    cp "$SIGN_DIR/$FNAME_MAC" "$release_dir/"

    # Windows NSIS installer. With Tauri v2 createUpdaterArtifacts=true,
    # the installer itself is the updater bundle; there is no .nsis.zip.
    local signed_setup
    signed_setup=$(find "$SIGN_DIR/standalone-win-x64" \
        -path "*/release/bundle/nsis/*setup*.exe" \
        -type f \
        | head -1)
    [[ -n "$signed_setup" ]] || error "Windows NSIS installer not found. Run Windows signing first."
    cp "$signed_setup" "$release_dir/$FNAME_WIN"

    # Linux AppImage. With Tauri v2 createUpdaterArtifacts=true,
    # the AppImage itself is the updater bundle; there is no .AppImage.tar.gz.
    local linux_update
    linux_update=$(find "$SIGN_DIR/standalone-linux-x64" \
        -path "*/release/bundle/appimage/*.AppImage" \
        -type f \
        | head -1)
    [[ -n "$linux_update" ]] || error "Linux AppImage not found in signed work directory."
    cp "$linux_update" "$release_dir/$FNAME_LINUX"

    # Generate .sig files for update bundles using Tauri CLI
    for bundle in "$release_dir/$FNAME_MAC" \
                  "$release_dir/$FNAME_WIN" \
                  "$release_dir/$FNAME_LINUX"; do
        if [[ -f "$bundle" ]]; then
            log "Tauri-signing: $(basename "$bundle")"
            # Use tauri signer to sign the bundle
            TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY" \
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
                pnpm --dir "$REPO_ROOT/standalone" exec tauri signer sign \
                    --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
                    "$bundle"
        fi
    done

    # Build latest.json manifest
    local base_url="https://github.com/$GITHUB_REPO/releases/download/v$version"
    local pub_date
    pub_date=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    # Read .sig file contents
    local sig_mac="" sig_win="" sig_linux=""
    [[ -f "$release_dir/$FNAME_MAC.sig" ]] && { sig_mac=$(cat "$release_dir/$FNAME_MAC.sig"); rm "$release_dir/$FNAME_MAC.sig"; }
    [[ -f "$release_dir/$FNAME_WIN.sig" ]] && { sig_win=$(cat "$release_dir/$FNAME_WIN.sig"); rm "$release_dir/$FNAME_WIN.sig"; }
    [[ -f "$release_dir/$FNAME_LINUX.sig" ]] && { sig_linux=$(cat "$release_dir/$FNAME_LINUX.sig"); rm "$release_dir/$FNAME_LINUX.sig"; }

    [[ -n "$sig_mac" ]] || error "Missing Tauri signature for $FNAME_MAC"
    [[ -n "$sig_win" ]] || error "Missing Tauri signature for $FNAME_WIN"
    [[ -n "$sig_linux" ]] || error "Missing Tauri signature for $FNAME_LINUX"

    local website_manifest="$REPO_ROOT/website/public/standalone-latest.json"
    cat > "$website_manifest" <<EOF
{
  "version": "$version",
  "notes": "See https://github.com/$GITHUB_REPO/releases/tag/v$version",
  "pub_date": "$pub_date",
  "platforms": {
    "darwin-aarch64": {
      "url": "$base_url/$FNAME_MAC",
      "signature": "$sig_mac"
    },
    "windows-x86_64": {
      "url": "$base_url/$FNAME_WIN",
      "signature": "$sig_win"
    },
    "linux-x86_64": {
      "url": "$base_url/$FNAME_LINUX",
      "signature": "$sig_linux"
    }
  }
}
EOF

    log "Update manifest written to $website_manifest — commit and deploy website to make it live"

    log "Update bundle signing complete"
}

# =============================================================================
# Create GitHub Release
# =============================================================================

create_release() {
    local version="$1"
    local tag="v$version"
    local release_dir="$WORK_DIR/release-assets"

    log "Creating GitHub Release $tag..."

    check_command gh "brew install gh && gh auth login"

    [[ -d "$release_dir" ]] || error "Release assets not found at $release_dir. Run signing steps first."
    for asset in "$FNAME_MAC" "$FNAME_WIN" "$FNAME_LINUX"; do
        [[ -f "$release_dir/$asset" ]] || error "Release asset missing: $release_dir/$asset. Run sign-updates first."
    done

    # Extract changelog for this version
    local notes_file="$WORK_DIR/release-notes.md"
    if [[ -f "$REPO_ROOT/CHANGELOG.md" ]]; then
        # Extract section between [X.Y.Z] and the next ## heading.
        # Drop the leading version heading (GitHub already shows the tag as the title)
        # and the trailing next-version heading line.
        sed -n "/^## \[$version\]/,/^## \[/p" "$REPO_ROOT/CHANGELOG.md" \
            | sed '1d;$d' \
            | sed '/./,$!d' > "$notes_file"
    fi

    if [[ ! -s "$notes_file" ]]; then
        echo "Release $tag" > "$notes_file"
    fi

    # Create or update the release
    if gh release view "$tag" --repo "$GITHUB_REPO" &>/dev/null; then
        log "Release $tag already exists — updating assets..."
        gh release upload "$tag" \
            --repo "$GITHUB_REPO" \
            --clobber \
            "$release_dir"/*
        gh release edit "$tag" \
            --repo "$GITHUB_REPO" \
            --title "$tag" \
            --verify-tag \
            --draft=false \
            --notes-file "$notes_file"
    else
        gh release create "$tag" \
            --repo "$GITHUB_REPO" \
            --title "$tag" \
            --verify-tag \
            --notes-file "$notes_file" \
            "$release_dir"/*
    fi

    rm -f "$notes_file"

    log "GitHub Release created: https://github.com/$GITHUB_REPO/releases/tag/$tag"
}

# =============================================================================
# Main Entry Point
# =============================================================================

usage() {
    cat <<EOF
Usage: $(basename "$0") COMMAND [OPTIONS]

Commands:
    all VERSION         Full pipeline: wait for CI, download, sign, release
    resume VERSION      Resume: download completed CI artifacts, sign, release
    sign-mac            Re-sign macOS app bundles
    notarize            Re-notarize macOS apps
    sign-win            Re-sign Windows executable
    sign-updates VER    Re-generate Tauri update signatures and manifest from existing signed work
    release VERSION     Re-create GitHub Release from existing signed assets

Environment Variables:
    APPLE_SIGN_PASS     Apple ID password (or app-specific password)
    EV_SIGN_PIN         PIV PIN for Windows code signing
    TAURI_SIGNING_PRIVATE_KEY           Tauri update signing key
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD  Tauri update key password (optional)

Examples:
    $(basename "$0") all 0.1.0       # Full pipeline
    $(basename "$0") resume 0.1.0    # Resume after CI completed
    $(basename "$0") sign-mac        # Re-sign macOS only
    $(basename "$0") sign-updates 0.1.0 # Re-sign update bundles only
    $(basename "$0") release 0.1.0   # Re-create GitHub Release
EOF
}

main() {
    local cmd="${1:-}"

    if [[ -z "$cmd" ]]; then
        usage
        exit 1
    fi

    case "$cmd" in
        -h|--help|help)
            usage
            exit 0
            ;;
        all)
            local version="${2:-}"
            [[ -z "$version" ]] && error "Usage: $(basename "$0") all <version>"

            ensure_version "$version"
            check_git_clean
            download_artifacts "$version"
            prepare_sign_dir
            sign_macos
            notarize_macos
            sign_windows
            sign_updates "$version"
            create_release "$version"
            ;;
        resume)
            local version="${2:-}"
            [[ -z "$version" ]] && error "Usage: $(basename "$0") resume <version>"

            ensure_version "$version"
            resume_download "$version"
            prepare_sign_dir
            sign_macos
            notarize_macos
            sign_windows
            sign_updates "$version"
            create_release "$version"
            ;;
        sign-mac)
            prepare_sign_dir
            sign_macos
            ;;
        notarize)
            prepare_sign_dir
            notarize_macos
            ;;
        sign-win)
            prepare_sign_dir
            sign_windows
            ;;
        sign-updates)
            local version="${2:-}"
            [[ -z "$version" ]] && error "Usage: $(basename "$0") sign-updates <version>"
            ensure_version "$version"
            [[ -d "$SIGN_DIR" ]] || error "Signed work directory not found at $SIGN_DIR. Run all/resume first."
            sign_updates "$version"
            ;;
        release)
            local version="${2:-}"
            [[ -z "$version" ]] && error "Usage: $(basename "$0") release <version>"
            ensure_version "$version"
            create_release "$version"
            ;;
        *)
            error "Unknown command: $cmd. Use --help for usage."
            ;;
    esac

    log "Done!"
}

main "$@"
