#!/usr/bin/env bash
#
# Builds the standalone app and either launches or installs it.
#
# Usage:
#   pnpm dogfood:standalone              Build and launch from the build directory.
#   pnpm dogfood:standalone --install    Build and copy into the system install location.
#
# Launch mode (default):
#   Runs the built binary directly from target/release. Works on Windows, macOS,
#   and Linux with no prior setup. This is the fastest way to test changes.
#
# Install mode (--install):
#   Copies the built files over the system-installed copy, bypassing the slow
#   installer step. Requires a one-time install first (NSIS installer on Windows,
#   DMG on macOS) so that the install location exists.
#
set -euo pipefail

# Skip past "--" that pnpm injects when forwarding arguments
[[ "${1:-}" == "--" ]] && shift

RELEASE_DIR="standalone/src-tauri/target/release"

if [[ "${1:-}" == "--install" ]]; then
  # Full build with bundling, but disable updater artifact signing.
  # On macOS, build only the .app bundle (skip DMG creation).
  BUNDLE_ARGS=()
  case "$(uname -s)" in
    Darwin) BUNDLE_ARGS=(--bundles app) ;;
  esac
  pnpm --filter mouseterm-standalone tauri build \
    -c '{"bundle":{"createUpdaterArtifacts":false}}' "${BUNDLE_ARGS[@]}"
else
  # Fast build: skip bundling entirely since we just need the exe
  pnpm --filter mouseterm-standalone tauri build --no-bundle
fi

if [[ "${1:-}" == "--install" ]]; then
  # --- Install mode ---
  # Platform-specific: copy built files to system install location
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      INSTALL_DIR="$LOCALAPPDATA/Dormouse"
      if [[ ! -f "$INSTALL_DIR/uninstall.exe" ]]; then
        echo "Dormouse is not installed yet."
        echo "Run the installer once first:"
        echo "  $RELEASE_DIR/bundle/nsis/Dormouse_*-setup.exe"
        echo ""
        echo "After that, 'dogfood:standalone --install' will work from then on."
        exit 1
      fi
      # Kill any running Dormouse processes (the app + its sidecar node.exe,
      # plus orphan sidecars from a prior run) before we overwrite their files.
      # We can't use `taskkill //IM node.exe` here: that matches every node.exe
      # on the system, including the pnpm process that invoked this script,
      # and `//T` would then cascade and kill us. Filter by image path so we
      # only target processes loaded from the install dir.
      powershell.exe -NoProfile -Command \
        "Get-Process -Name dormouse,node -EA SilentlyContinue | Where-Object Path -Like '$LOCALAPPDATA\\Dormouse\\*' | Stop-Process -Force -EA SilentlyContinue" \
        >/dev/null 2>&1 || true
      # Wipe install-dir contents except uninstall.exe (managed by NSIS).
      # We delete *contents* rather than the directory itself so we don't trip
      # over Windows' "directory in use" if a process has it as cwd or loaded
      # an exe image from it.
      find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -not -name 'uninstall.exe' \
        -exec rm -rf {} +
      cp "$RELEASE_DIR/dormouse.exe" "$INSTALL_DIR/"
      cp "$RELEASE_DIR/node.exe" "$INSTALL_DIR/"
      cp -r "$RELEASE_DIR/_up_/" "$INSTALL_DIR/_up_/"
      echo "✦ Installed to $INSTALL_DIR"
      ;;
    Darwin)
      INSTALL_DIR="/Applications/Dormouse.app"
      if [[ ! -d "$INSTALL_DIR" ]]; then
        echo "Dormouse is not installed yet."
        echo "Install via the DMG first:"
        echo "  open $RELEASE_DIR/bundle/dmg/Dormouse_*.dmg"
        echo ""
        echo "After that, 'dogfood:standalone --install' will work from then on."
        exit 1
      fi
      rm -rf "$INSTALL_DIR"
      cp -r "$RELEASE_DIR/bundle/macos/Dormouse.app" "$INSTALL_DIR"
      echo "✦ Installed to $INSTALL_DIR"
      ;;
    *)
      echo "--install is not yet implemented for this platform."
      exit 1
      ;;
  esac
else
  # --- Launch mode (default) ---
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      "$RELEASE_DIR/dormouse.exe" ;;
    Darwin)
      "$RELEASE_DIR/dormouse" ;;
    Linux)
      "$RELEASE_DIR/dormouse" ;;
    *)
      echo "Unsupported platform: $(uname -s)"
      exit 1 ;;
  esac
fi
