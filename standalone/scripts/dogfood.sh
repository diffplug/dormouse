#!/usr/bin/env bash
#
# Builds the standalone app and either installs or launches it.
#
# Usage:
#   pnpm dogfood:standalone                Build and copy into the system install location.
#   pnpm dogfood:standalone --no-install   Build and launch from the build directory.
#
# Install mode (default):
#   Copies the built files over the system-installed copy, bypassing the slow
#   installer step. This mirrors `dogfood:vscode`, which also installs by default.
#   Requires a one-time install first (NSIS installer on Windows, DMG on macOS)
#   so that the install location exists.
#
#   macOS swaps the bundle in place and leaves a running Dormouse alone; run
#   `dor app restart` in any Dormouse terminal to switch to the new build and
#   resume your Claude and Codex sessions. Windows cannot replace files the
#   running app holds, so it still kills Dormouse before copying.
#
# Launch mode (--no-install):
#   Runs the built binary directly from target/release. Works on Windows, macOS,
#   and Linux with no prior setup. This is the fastest way to test changes.
#
set -euo pipefail

# Skip past "--" that pnpm injects when forwarding arguments
[[ "${1:-}" == "--" ]] && shift

RELEASE_DIR="standalone/src-tauri/target/release"

if [[ "${1:-}" != "--no-install" ]]; then
  # Full build with bundling, but disable updater artifact signing.
  # On macOS, build only the .app bundle (skip DMG creation).
  BUNDLE_ARGS=()
  case "$(uname -s)" in
    Darwin) BUNDLE_ARGS=(--bundles app) ;;
  esac
  pnpm --filter dormouse-standalone tauri build \
    -c '{"bundle":{"createUpdaterArtifacts":false}}' "${BUNDLE_ARGS[@]}"
else
  # Fast build: skip bundling entirely since we just need the exe
  pnpm --filter dormouse-standalone tauri build --no-bundle
fi

if [[ "${1:-}" != "--no-install" ]]; then
  # --- Install mode (default) ---
  # Platform-specific: copy built files to system install location
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      INSTALL_DIR="$LOCALAPPDATA/Dormouse Terminal"
      if [[ ! -f "$INSTALL_DIR/uninstall.exe" ]]; then
        echo "Dormouse is not installed yet."
        echo "Run the installer once first:"
        echo "  $RELEASE_DIR/bundle/nsis/Dormouse\\ Terminal_*-setup.exe"
        echo ""
        echo "After that, 'dogfood:standalone' will work from then on."
        exit 1
      fi
      # Kill any running Dormouse processes (the app + its sidecar node.exe,
      # plus orphan sidecars from a prior run) before we overwrite their files.
      # We can't use `taskkill //IM node.exe` here: that matches every node.exe
      # on the system, including the pnpm process that invoked this script,
      # and `//T` would then cascade and kill us. Filter by image path so we
      # only target processes loaded from the install dir.
      powershell.exe -NoProfile -Command \
        "Get-Process -Name dormouse,node -EA SilentlyContinue | Where-Object Path -Like '$LOCALAPPDATA\\Dormouse Terminal\\*' | Stop-Process -Force -EA SilentlyContinue" \
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
      INSTALL_DIR="/Applications/Dormouse Terminal.app"
      if [[ ! -d "$INSTALL_DIR" ]]; then
        echo "Dormouse is not installed yet."
        echo "Move the freshly built app into place first:"
        echo "  mv $RELEASE_DIR/bundle/macos/Dormouse\\ Terminal.app /Applications"
        echo ""
        echo "After that, 'dogfood:standalone' will work from then on."
        exit 1
      fi
      # Swap the bundle in place, leaving a running Dormouse up: renames keep
      # its mapped binary and sidecar alive, and `dor app restart` relaunches
      # it from the new bundle through the normal quit (sessions saved, agent
      # resume captured). Until then, terminals it spawns already pick up the
      # new bundle's `dor`, node-pty spawn-helper, and shell integration.
      # The staging names do not end in `.app`, so LaunchServices ignores them.
      STAGED="/Applications/.dormouse-dogfood-new"
      RETIRED="/Applications/.dormouse-dogfood-old"
      rm -rf "$STAGED" "$RETIRED"
      ditto "$RELEASE_DIR/bundle/macos/Dormouse Terminal.app" "$STAGED"
      mv "$INSTALL_DIR" "$RETIRED"
      if ! mv "$STAGED" "$INSTALL_DIR"; then
        mv "$RETIRED" "$INSTALL_DIR"
        echo "Could not move the new build into place; kept the installed one."
        exit 1
      fi
      rm -rf "$RETIRED"
      touch "$INSTALL_DIR"
      /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
        -f "$INSTALL_DIR" >/dev/null 2>&1 || true
      echo "✦ Installed to $INSTALL_DIR"
      if pgrep -f "$INSTALL_DIR/Contents/MacOS/" >/dev/null 2>&1; then
        echo "  Dormouse is still running the previous build. To switch, run this in any"
        echo "  Dormouse terminal (Claude and Codex sessions resume):"
        echo ""
        echo "    dor app restart"
      fi
      ;;
    *)
      echo "Install mode is not yet implemented for this platform."
      echo "Use 'dogfood:standalone --no-install' to launch from the build dir instead."
      exit 1
      ;;
  esac
else
  # --- Launch mode (--no-install) ---
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
