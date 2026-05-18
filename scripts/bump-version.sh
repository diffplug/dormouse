#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Bump version across all release artifacts and sync Cargo.lock.
# =============================================================================
# Edits the four version files in lockstep, then runs cargo so Cargo.lock's
# `dormouse` entry follows along. Print a diff stat for review.
#
# Usage: ./scripts/bump-version.sh <version>
#   Example: ./scripts/bump-version.sh 0.9.0
# =============================================================================

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>" >&2
  echo "  Example: $0 0.9.0" >&2
  exit 2
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver (X.Y.Z or X.Y.Z-prerelease)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CARGO_TOML="standalone/src-tauri/Cargo.toml"
TAURI_CONF="standalone/src-tauri/tauri.conf.json"
VSCODE_PKG="vscode-ext/package.json"
LIB_PKG="lib/package.json"
CARGO_LOCK="standalone/src-tauri/Cargo.lock"

# Cargo.toml: the `[package]` version line. Anchored to column 0 so we can't
# match `version = "..."` inside an inline dependency table.
toml_matches=$(grep -c '^version = ' "$CARGO_TOML")
if [[ "$toml_matches" -ne 1 ]]; then
  echo "Error: expected exactly 1 '^version = ' line in $CARGO_TOML, found $toml_matches" >&2
  exit 1
fi
perl -i -pe 's/^version\s*=\s*".*"/version = "'"$VERSION"'"/' "$CARGO_TOML"

# package.json / tauri.conf.json: replace only the first `"version": "..."`
# (the package version), leaving any nested deps or schema versions alone.
for f in "$TAURI_CONF" "$VSCODE_PKG" "$LIB_PKG"; do
  if ! grep -q '"version":' "$f"; then
    echo "Error: no '\"version\":' line in $f" >&2
    exit 1
  fi
  perl -i -pe 'if (!$done && s/"version":\s*"[^"]*"/"version": "'"$VERSION"'"/) { $done = 1 }' "$f"
done

# Sync Cargo.lock by running cargo. `cargo check` is idempotent and updates
# the lockfile's dormouse entry to match the bumped Cargo.toml. Without this,
# Cargo.lock keeps the old version and ships out of sync with the binary.
echo "Syncing Cargo.lock (cargo check)…"
( cd standalone/src-tauri && cargo check --offline >/dev/null )

echo
echo "Bumped to v$VERSION."
git --no-pager diff --stat -- \
  "$CARGO_TOML" "$TAURI_CONF" "$VSCODE_PKG" "$LIB_PKG" "$CARGO_LOCK"
echo
echo "Review:  git diff -- $CARGO_TOML $TAURI_CONF $VSCODE_PKG $LIB_PKG $CARGO_LOCK"
echo "Commit:  git commit -am 'Release v$VERSION'"
echo "Tag:     git tag v$VERSION"
