#!/bin/bash
#
# Install the Dormouse coordinating server on this Mac as a per-login
# LaunchAgent, fronted by `tailscale serve` on the node's own HTTPS name.
#
# Running this a second time updates the installed release from the current
# checkout. It never pulls, fetches, switches branches, or installs an updater:
# the checkout you are standing in is the release source.
#
# See SELF_HOST.md for the runbook and docs/specs/server.md for the runtime
# contract this installs.
#
# Usage:
#   ./deploy/local/install-macos.sh [--yes]
#
# Environment:
#   DORMOUSE_INSTALL_TEST=1   Build, stage, health-check and switch releases,
#                             but do not touch launchd or the Serve config.
#   DORMOUSE_INSTALL_ROOT     A throwaway install root (requires the above), so
#                             path quoting and release switching can be tested.

set -euo pipefail

# macOS ships bash 3.2; nothing here may use bash 4+ syntax.

LABEL="sh.dormouse.server"
INSTALL_ROOT="$HOME/Library/Application Support/Dormouse Server"
LOG_DIR="$HOME/Library/Logs/Dormouse Server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOOPBACK_PORT=3100

ASSUME_YES=0
[ "${DORMOUSE_INSTALL_ASSUME_YES:-0}" = "1" ] && ASSUME_YES=1
TEST_MODE=0
[ "${DORMOUSE_INSTALL_TEST:-0}" = "1" ] && TEST_MODE=1

# A throwaway install root, for exercising path quoting, plist generation,
# release switching and cleanup without touching the real installation. Gated to
# test mode on purpose: a real install belongs in the documented location, and
# an overridden root would leave `manage` and the LaunchAgent disagreeing about
# where the service lives. Overriding HOME instead would break pnpm, whose store
# and downloaded runtime live under the real home.
if [ -n "${DORMOUSE_INSTALL_ROOT:-}" ]; then
  if [ "$TEST_MODE" != "1" ]; then
    echo "DORMOUSE_INSTALL_ROOT is only honored with DORMOUSE_INSTALL_TEST=1" >&2
    exit 64
  fi
  INSTALL_ROOT="$DORMOUSE_INSTALL_ROOT"
  LOG_DIR="$INSTALL_ROOT/logs"
  PLIST="$INSTALL_ROOT/LaunchAgents/$LABEL.plist"
fi

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

# ---------------------------------------------------------------- output ----

if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'
  C_YEL=$'\033[33m'; C_BLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_RED=""; C_GRN=""; C_YEL=""; C_BLD=""; C_OFF=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLD" "$C_OFF" "$C_BLD" "$1" "$C_OFF"; }
info() { printf '    %s\n' "$1"; }
detail() { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
ok() { printf '    %s✓%s %s\n' "$C_GRN" "$C_OFF" "$1"; }
warn() { printf '    %s!%s %s\n' "$C_YEL" "$C_OFF" "$1" >&2; }
die() { printf '\n%serror:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2; exit 1; }

confirm() {
  # $1 = prompt. Returns 0 for yes.
  if [ "$ASSUME_YES" = "1" ]; then
    detail "$1 [auto-yes]"
    return 0
  fi
  if [ ! -t 0 ]; then
    die "$1 — refusing to assume an answer with no terminal. Re-run with --yes if that is what you want."
  fi
  printf '    %s [y/N] ' "$1"
  local reply=""
  read -r reply || true
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ------------------------------------------------------------- preflight ----

[ "$(uname -s)" = "Darwin" ] || die "this installer is macOS-only (found $(uname -s)). See SELF_HOST.md Prerequisites — design the native service manager with the user rather than translating LaunchAgent commands."

[ "$(id -u)" != "0" ] || die "do not run this as root. It installs only into \$HOME and needs no sudo."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$REPO_ROOT/pnpm-workspace.yaml" ] || die "cannot locate the repository root from $SCRIPT_DIR"
cd "$REPO_ROOT"

JSON_RUNNER=""
if command -v node >/dev/null 2>&1; then
  JSON_RUNNER="node"
elif [ -x /usr/bin/python3 ]; then
  JSON_RUNNER="python3"
else
  die "need either node or /usr/bin/python3 to read package.json and the Tailscale status."
fi

# json_query <file> <dotted.path> -> value on stdout, exit 1 if absent.
# Arrays are joined with commas.
json_query() {
  case "$JSON_RUNNER" in
    node)
      node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let v = j;
for (const k of process.argv[2].split(".")) { if (v == null) break; v = v[k]; }
if (v == null) process.exit(1);
process.stdout.write(Array.isArray(v) ? v.join(",") : String(v));
' "$1" "$2"
      ;;
    python3)
      /usr/bin/python3 -c '
import json, sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    if v is None: break
    v = v.get(k) if isinstance(v, dict) else None
if v is None: sys.exit(1)
sys.stdout.write(",".join(v) if isinstance(v, list) else str(v))
' "$1" "$2"
      ;;
  esac
}

# Replace a symlink atomically, without following it.
#
# `mv -f tmp link` FOLLOWS an existing symlink-to-directory: it moves the temp
# link *inside* the directory the old link points at, leaving `current` aimed
# where it already was. The update then silently becomes a no-op — and the
# prune, reading `current`, deletes the release nothing points at. rename(2) on
# the link path replaces the link itself and has no such behavior.
# $1 = target, $2 = link path, $3 = node binary
atomic_symlink() {
  "$3" -e '
const fs = require("fs");
const target = process.argv[1];
const link = process.argv[2];
const tmp = link + ".swap." + process.pid;
try { fs.unlinkSync(tmp); } catch (e) { /* no stale temp link */ }
fs.symlinkSync(target, tmp);
fs.renameSync(tmp, link);
' "$1" "$2"
}

# Which release is the process listening on $1 actually running?
#
# A 200 from /api/hello proves only that SOMETHING answers on the port. This is
# what separates the release that is supposed to be serving from an orphan of an
# older one still holding it.
#
# Deliberately lsof's `txt` record and not `ps -o comm=`. run-server execs
# "$INSTALL_ROOT/current/runtime/node", and ps reports that path verbatim,
# symlink and all — so a ps-based check would resolve `current` a second time
# and "confirm" whatever it points at now, agreeing with itself no matter which
# release is answering. lsof reports the vnode's real path, which names the
# release.
listening_release() {
  local pid path root
  # lsof reports the vnode's PHYSICAL path, but $INSTALL_ROOT is logical — it is
  # $HOME/... or DORMOUSE_INSTALL_ROOT verbatim, never canonicalized. Comparing
  # the two directly is a check that can never pass, the exact mirror of the
  # `ps` trap above. It bites a DORMOUSE_INSTALL_ROOT under `mktemp -d`, which
  # on macOS sits below /var -> /private/var.
  root="$(cd "$INSTALL_ROOT" 2>/dev/null && pwd -P)" || return 0
  pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 0
  while IFS= read -r path; do
    case "$path" in
      "n$root/releases/"*)
        path="${path#"n$root/releases/"}"
        printf '%s\n' "${path%%/*}"
        return 0
        ;;
    esac
  done < <(lsof -p "$pid" -a -d txt -Fn 2>/dev/null || true)
}

# --------------------------------------------------------------- tailscale --

TS_BIN=""
TS_VIA_BUNDLE=0
if command -v tailscale >/dev/null 2>&1; then
  TS_BIN="$(command -v tailscale)"
else
  for candidate in \
    "/Applications/Tailscale.app/Contents/MacOS/tailscale" \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
    if [ -x "$candidate" ]; then
      TS_BIN="$candidate"
      TS_VIA_BUNDLE=1
      break
    fi
  done
fi
[ -n "$TS_BIN" ] || die "tailscale CLI not found on PATH or in /Applications/Tailscale.app. Install Tailscale and sign in first — this installer will not install or reauthenticate it for you. https://tailscale.com/docs/install/mac"

# TAILSCALE_BE_CLI=1 stops the bundled app executable from launching the GUI
# instead of acting as the CLI. Harmless for a real CLI binary.
ts() {
  if [ "$TS_VIA_BUNDLE" = "1" ]; then
    TAILSCALE_BE_CLI=1 "$TS_BIN" "$@"
  else
    "$TS_BIN" "$@"
  fi
}

# ------------------------------------------------------------------ start ----

printf '%sDormouse selfhost server — macOS installer%s\n' "$C_BLD" "$C_OFF"
[ "$TEST_MODE" = "1" ] && warn "DORMOUSE_INSTALL_TEST=1 — launchd and Serve will not be touched."

step "Checking Tailscale"

TS_STATUS_JSON="$(mktemp -t dormouse-ts-status)"
trap 'rm -f "$TS_STATUS_JSON"' EXIT
ts status --json > "$TS_STATUS_JSON" 2>/dev/null || die "\`tailscale status --json\` failed. Is Tailscale running and signed in?"

TS_BACKEND="$(json_query "$TS_STATUS_JSON" "BackendState" || echo "")"
[ "$TS_BACKEND" = "Running" ] || die "Tailscale backend state is '${TS_BACKEND:-unknown}', expected 'Running'. Sign in and connect, then re-run."

TS_DNS_RAW="$(json_query "$TS_STATUS_JSON" "Self.DNSName" || echo "")"
[ -n "$TS_DNS_RAW" ] || die "Tailscale reports no MagicDNS name for this node. Enable MagicDNS for the tailnet: https://login.tailscale.com/admin/dns"
# MagicDNS names arrive fully qualified with a trailing dot.
TS_DNS="${TS_DNS_RAW%.}"

MAGIC_DNS_ENABLED="$(json_query "$TS_STATUS_JSON" "CurrentTailnet.MagicDNSEnabled" || echo "false")"
[ "$MAGIC_DNS_ENABLED" = "true" ] || warn "MagicDNS is not reported as enabled for this tailnet; the HTTPS name may not resolve for other devices."

ORIGIN="https://$TS_DNS"
ok "node: $TS_DNS"
ok "external origin: $ORIGIN"

CERT_DOMAINS="$(json_query "$TS_STATUS_JSON" "CertDomains" || echo "")"
case ",$CERT_DOMAINS," in
  *",$TS_DNS,"*) ok "tailnet HTTPS certificates enabled for this name" ;;
  *)
    warn "tailnet HTTPS certificates do not list $TS_DNS."
    warn "Enable HTTPS at https://login.tailscale.com/admin/dns — Serve cannot get a certificate without it."
    warn "Tailscale may also prompt for consent the first time Serve requests one."
    ;;
esac

# --------------------------------------------------------- origin identity ---

CONFIG_DIR="$INSTALL_ROOT/config"
ENV_FILE="$CONFIG_DIR/server.env"
STATE_DIR="$INSTALL_ROOT/state"
RELEASES_DIR="$INSTALL_ROOT/releases"
BIN_DIR="$INSTALL_ROOT/bin"
CURRENT_LINK="$INSTALL_ROOT/current"
PREVIOUS_LINK="$INSTALL_ROOT/previous"

FIRST_INSTALL=1
if [ -f "$ENV_FILE" ]; then
  FIRST_INSTALL=0
  EXISTING_ORIGIN="$(sed -n 's/^DORMOUSE_ORIGIN=//p' "$ENV_FILE" | head -1 | sed 's/^"//; s/"$//')"
  if [ -n "$EXISTING_ORIGIN" ] && [ "$EXISTING_ORIGIN" != "$ORIGIN" ]; then
    printf '\n' >&2
    warn "This machine already has an installation bound to a DIFFERENT origin."
    warn "  installed: $EXISTING_ORIGIN"
    warn "  derived:   $ORIGIN"
    warn ""
    warn "DORMOUSE_ORIGIN is durable WebAuthn identity: it is the source of the"
    warn "passkey rpId and of the Host's ConnectionPolicy. Rewriting it invalidates"
    warn "the registered passkey and every enrolled Host — they must be re-enrolled."
    warn ""
    warn "This usually means the Tailscale node was renamed or re-enrolled."
    die "refusing to silently rewrite the origin. Decide deliberately: restore the old node name, or plan the passkey + Host re-enrollment and remove $ENV_FILE by hand."
  fi
fi

# ----------------------------------------------------------------- source ----

step "Checking the source checkout"

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"
GIT_SHORT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
GIT_DIRTY="false"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  GIT_DIRTY="true"
fi
ARCH="$(uname -m)"

info "checkout: $REPO_ROOT"
info "branch:   $GIT_BRANCH"
info "commit:   $GIT_SHA"
info "arch:     $ARCH"
if [ "$GIT_DIRTY" = "true" ]; then
  warn "the worktree is DIRTY — the installed release will not be identified by its SHA alone."
  git -C "$REPO_ROOT" status --short | sed 's/^/      /'
  confirm "Install this dirty worktree?" || die "aborted at the user's request."
else
  ok "worktree clean"
fi

NODE_PIN="$(json_query "$REPO_ROOT/package.json" "devEngines.runtime.version" || echo "")"
[ -n "$NODE_PIN" ] || die "root package.json has no devEngines.runtime.version. SECURITY.md keys a mechanical FAIL IF to that exact field."
case "$NODE_PIN" in
  *.*.*) : ;;
  *) die "devEngines.runtime.version must be an exact MAJOR.MINOR.PATCH version, got '$NODE_PIN'." ;;
esac
PNPM_PIN="$(json_query "$REPO_ROOT/package.json" "packageManager" || echo "")"
[ -n "$PNPM_PIN" ] || die "root package.json has no packageManager field."
ok "node pin: $NODE_PIN"
ok "pnpm pin: $PNPM_PIN"

command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH. Install pnpm $PNPM_PIN (or enable Corepack) and re-run."
PNPM_ACTUAL="$(pnpm --version 2>/dev/null || echo "unknown")"
if [ "$PNPM_PIN" != "pnpm@$PNPM_ACTUAL" ]; then
  warn "pnpm on PATH is $PNPM_ACTUAL but the repository pins $PNPM_PIN."
  confirm "Continue with the mismatched pnpm?" || die "aborted at the user's request."
else
  ok "pnpm on PATH matches the pin"
fi

# --------------------------------------------------- workspace-state guard ---
#
# `pnpm deploy --prod --legacy` rewrites the ROOT workspace state file
# (node_modules/.pnpm-workspace-state-v1.json) to production:true / dev:false.
# Every later pnpm command in this checkout then decides the workspace is stale
# and tries to run `pnpm install --production`, which would strip the developer's
# devDependencies. Snapshot the file and restore it unconditionally on exit, so
# a failed install cannot leave the checkout poisoned either.

WS_STATE="$REPO_ROOT/node_modules/.pnpm-workspace-state-v1.json"
WS_STATE_BACKUP=""
restore_workspace_state() {
  if [ -n "$WS_STATE_BACKUP" ] && [ -f "$WS_STATE_BACKUP" ]; then
    cp -p "$WS_STATE_BACKUP" "$WS_STATE" 2>/dev/null || true
    rm -f "$WS_STATE_BACKUP"
  fi
}
cleanup() {
  restore_workspace_state
  rm -f "$TS_STATUS_JSON"
}
trap cleanup EXIT

# ------------------------------------------------------------------ build ----

step "Building the release from this checkout"

info "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile >/dev/null 2>&1 || die "pnpm install --frozen-lockfile failed. Run it by hand to see why."
ok "dependencies installed"

info "building lib/dist-pocket"
pnpm --filter dormouse-lib build:pocket >/dev/null 2>&1 || die "pocket build failed. Run: pnpm --filter dormouse-lib build:pocket"
[ -f "$REPO_ROOT/lib/dist-pocket/index.html" ] || die "lib/dist-pocket/index.html missing after the pocket build."
ok "pocket app built"

info "building server (and server-lib-common)"
pnpm --filter server build >/dev/null 2>&1 || die "server build failed. Run: pnpm --filter server build"
[ -f "$REPO_ROOT/server/dist/index.js" ] || die "server/dist/index.js missing after the server build."
ok "server built"

# Resolve the exact Node the build ran under. pnpm honors devEngines
# (onFail: download), so this is the pinned runtime, not whatever is on PATH.
# Write it to a file: pnpm can emit progress chatter on stdout, which would
# contaminate a command substitution.
EXECPATH_FILE="$(mktemp -t dormouse-execpath)"
pnpm exec node -e 'require("fs").writeFileSync(process.argv[1], process.execPath)' "$EXECPATH_FILE" >/dev/null 2>&1 \
  || die "could not resolve the pinned Node runtime via pnpm exec."
NODE_BIN="$(cat "$EXECPATH_FILE")"
rm -f "$EXECPATH_FILE"
[ -x "$NODE_BIN" ] || die "resolved Node runtime is not executable: $NODE_BIN"

NODE_BUILD_VERSION="$("$NODE_BIN" -e 'process.stdout.write(process.version)')"
NODE_BUILD_ARCH="$("$NODE_BIN" -e 'process.stdout.write(process.arch)')"
[ "$NODE_BUILD_VERSION" = "v$NODE_PIN" ] || die "the build ran under Node $NODE_BUILD_VERSION but the repository pins v$NODE_PIN."
ok "pinned runtime: $NODE_BUILD_VERSION ($NODE_BUILD_ARCH)"

# ------------------------------------------------------------- stage build ---

step "Staging the new release"

mkdir -p "$RELEASES_DIR" "$BIN_DIR"
mkdir -p "$CONFIG_DIR" "$STATE_DIR"
chmod 0700 "$CONFIG_DIR" "$STATE_DIR"
mkdir -p "$LOG_DIR"

BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$GIT_SHORT"
[ "$GIT_DIRTY" = "true" ] && RELEASE_ID="$RELEASE_ID-dirty"
STAGE="$RELEASES_DIR/$RELEASE_ID"

rm -rf "$STAGE"
mkdir -p "$STAGE/lib" "$STAGE/runtime"

info "pnpm deploy --prod --legacy"
WS_STATE_BACKUP=""
if [ -f "$WS_STATE" ]; then
  WS_STATE_BACKUP="$(mktemp -t dormouse-wsstate)"
  cp -p "$WS_STATE" "$WS_STATE_BACKUP"
fi
pnpm --filter server deploy --prod --legacy "$STAGE/server" >/dev/null 2>&1 \
  || die "pnpm deploy failed. Run: pnpm --filter server deploy --prod --legacy /tmp/dormouse-deploy-probe"
restore_workspace_state
[ -f "$STAGE/server/dist/index.js" ] || die "the deployed server tree has no dist/index.js."
[ -d "$STAGE/server/node_modules/server-lib-common" ] || die "the deployed server tree is missing the injected server-lib-common workspace package."
ok "production server tree staged"

# server/src/config.ts resolves the pocket dir two levels up from
# server/dist/config.js, i.e. <release>/lib/dist-pocket. Match that layout so no
# DORMOUSE_POCKET_DIR override is needed.
cp -R "$REPO_ROOT/lib/dist-pocket" "$STAGE/lib/dist-pocket"
[ -f "$STAGE/lib/dist-pocket/index.html" ] || die "pocket app did not land in the release."
ok "pocket app staged"

cp "$NODE_BIN" "$STAGE/runtime/node"
chmod 0755 "$STAGE/runtime/node"
STAGED_NODE_VERSION="$("$STAGE/runtime/node" -e 'process.stdout.write(process.version)')"
STAGED_NODE_ARCH="$("$STAGE/runtime/node" -e 'process.stdout.write(process.arch)')"
[ "$STAGED_NODE_VERSION" = "v$NODE_PIN" ] || die "the copied runtime reports $STAGED_NODE_VERSION, expected v$NODE_PIN."
case "$ARCH:$STAGED_NODE_ARCH" in
  arm64:arm64|x86_64:x64) : ;;
  *) die "the copied runtime is $STAGED_NODE_ARCH but this Mac is $ARCH." ;;
esac
ok "self-contained runtime staged ($STAGED_NODE_VERSION $STAGED_NODE_ARCH)"

cat > "$STAGE/RELEASE" <<RELEASE_EOF
release_id=$RELEASE_ID
git_sha=$GIT_SHA
git_short=$GIT_SHORT
git_branch=$GIT_BRANCH
git_dirty=$GIT_DIRTY
built_at=$BUILT_AT
node_version=$STAGED_NODE_VERSION
node_arch=$STAGED_NODE_ARCH
pnpm_version=$PNPM_ACTUAL
source_checkout=$REPO_ROOT
origin=$ORIGIN
RELEASE_EOF
chmod 0644 "$STAGE/RELEASE"
if [ "$GIT_DIRTY" = "true" ]; then
  detail "RELEASE records git_dirty=true — this build is NOT reproducibly identified by its SHA."
fi
ok "release $RELEASE_ID staged"

# ------------------------------------------------------------------ config ---

step "Runtime configuration"

if [ ! -f "$ENV_FILE" ]; then
  SETUP_PASSWORD=""
  if [ -x /usr/bin/xxd ]; then
    SETUP_PASSWORD="$(/usr/bin/xxd -p -l 32 -c 32 /dev/urandom)"
  elif [ -x /usr/bin/openssl ]; then
    SETUP_PASSWORD="$(/usr/bin/openssl rand -hex 32)"
  else
    die "no way to generate a high-entropy password (need /usr/bin/xxd or /usr/bin/openssl)."
  fi
  # Both generators above produce 32 random bytes, i.e. 64 hex characters. The
  # guard counts characters, so it must be 64 — checking for 32 would pass a
  # regression to `-l 16`, which is half the entropy SECURITY.md claims.
  [ ${#SETUP_PASSWORD} -ge 64 ] || die "generated setup password is implausibly short; refusing to install it."

  umask 077
  cat > "$ENV_FILE" <<ENV_EOF
# Dormouse selfhost server — installer-owned runtime configuration.
# Generated $BUILT_AT. Preserved byte-for-byte across updates.
#
# DORMOUSE_ORIGIN is durable WebAuthn identity (passkey rpId + Host
# ConnectionPolicy). Changing it invalidates the registered passkey and every
# enrolled Host. See docs/specs/server.md, "Configuration".
DORMOUSE_SETUP_PASSWORD=$SETUP_PASSWORD
DORMOUSE_ORIGIN=$ORIGIN
DORMOUSE_STATE_DIR=$STATE_DIR
DORMOUSE_BIND_HOST=127.0.0.1
PORT=$LOOPBACK_PORT
NODE_ENV=production
ENV_EOF
  chmod 0600 "$ENV_FILE"
  unset SETUP_PASSWORD
  ok "generated config/server.env (mode 0600) with a locally generated setup password"
  detail "the password was not printed; retrieve it with: manage show-password"
else
  chmod 0600 "$ENV_FILE"
  ok "preserved the existing config/server.env"
fi

# The bind host is a security boundary whenever the TLS proxy is local: Serve
# reaches the app over loopback, so an unbound socket would also publish the
# plaintext port to the LAN and to the tailnet.
grep -q '^DORMOUSE_BIND_HOST=127\.0\.0\.1$' "$ENV_FILE" \
  || die "config/server.env must set DORMOUSE_BIND_HOST=127.0.0.1. Fix it before continuing — Tailscale access control is not a reason to expose the plaintext backend."
grep -q "^PORT=$LOOPBACK_PORT$" "$ENV_FILE" \
  || die "config/server.env must set PORT=$LOOPBACK_PORT to match the Serve mapping."

# ------------------------------------------------------------- bin scripts ---

step "Installing the service wrapper and management helper"

cat > "$BIN_DIR/run-server" <<'RUNSERVER_EOF'
#!/bin/bash
# Installed by deploy/local/install-macos.sh. Stable across releases.
#
# launchd does not read interactive shell startup files, so this must not depend
# on the user's PATH, on Homebrew/nvm/Volta, on pnpm's store, or on the source
# checkout. It loads only the installer-owned env file and execs the runtime
# copied into the current release.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/config/server.env"

[ -r "$ENV_FILE" ] || { echo "run-server: cannot read $ENV_FILE" >&2; exit 78; }

# Parse KEY=VALUE lines. Deliberately not `source`/`eval`: this file holds the
# setup password, and a config file should not be able to execute code.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    [A-Za-z_]*) ;;
    *) continue ;;
  esac
  case "$value" in
    '"'*'"') value="${value#\"}"; value="${value%\"}" ;;
  esac
  export "$key=$value"
done < "$ENV_FILE"

NODE_BIN="$ROOT/current/runtime/node"
ENTRY="$ROOT/current/server/dist/index.js"
[ -x "$NODE_BIN" ] || { echo "run-server: missing runtime $NODE_BIN" >&2; exit 78; }
[ -f "$ENTRY" ] || { echo "run-server: missing entrypoint $ENTRY" >&2; exit 78; }

exec "$NODE_BIN" "$ENTRY"
RUNSERVER_EOF
chmod 0700 "$BIN_DIR/run-server"
ok "bin/run-server"

cat > "$BIN_DIR/manage" <<'MANAGE_EOF'
#!/bin/bash
# Installed by deploy/local/install-macos.sh.
set -euo pipefail

LABEL="sh.dormouse.server"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/config/server.env"
STATE_DIR="$ROOT/state"
LOG_DIR="$HOME/Library/Logs/Dormouse Server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# A test install (DORMOUSE_INSTALL_ROOT) keeps its logs and plist inside its own
# root, so `manage` must follow them there rather than at the real HOME paths.
[ -d "$ROOT/logs" ] && LOG_DIR="$ROOT/logs"
[ -f "$ROOT/LaunchAgents/$LABEL.plist" ] && PLIST="$ROOT/LaunchAgents/$LABEL.plist"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_OFF=""
fi

pass() { printf '  %s✓%s %s\n' "$C_GRN" "$C_OFF" "$1"; }
fail() { printf '  %s✗%s %s\n' "$C_RED" "$C_OFF" "$1"; FAILURES=$((FAILURES + 1)); }
note() { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
warn() { printf '  %s!%s %s\n' "$C_YEL" "$C_OFF" "$1"; }

env_value() {
  [ -r "$ENV_FILE" ] || return 1
  sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | sed 's/^"//; s/"$//'
}

PORT="$(env_value PORT || echo 3100)"
ORIGIN="$(env_value DORMOUSE_ORIGIN || echo "")"

TS_BIN=""
TS_VIA_BUNDLE=0
if command -v tailscale >/dev/null 2>&1; then
  TS_BIN="$(command -v tailscale)"
else
  for candidate in \
    "/Applications/Tailscale.app/Contents/MacOS/tailscale" \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/tailscale" \
    "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
    if [ -x "$candidate" ]; then TS_BIN="$candidate"; TS_VIA_BUNDLE=1; break; fi
  done
fi
ts() {
  [ -n "$TS_BIN" ] || return 127
  if [ "$TS_VIA_BUNDLE" = "1" ]; then TAILSCALE_BE_CLI=1 "$TS_BIN" "$@"; else "$TS_BIN" "$@"; fi
}

# Replace a symlink atomically, without following it. `mv -f tmp link` follows
# an existing symlink-to-directory and would deposit the temp link inside the
# old release, leaving `current` unmoved. rename(2) on the link path does not.
# $1 = target, $2 = link path, $3 = node binary
atomic_symlink() {
  "$3" -e '
const fs = require("fs");
const target = process.argv[1];
const link = process.argv[2];
const tmp = link + ".swap." + process.pid;
try { fs.unlinkSync(tmp); } catch (e) { /* no stale temp link */ }
fs.symlinkSync(target, tmp);
fs.renameSync(tmp, link);
' "$1" "$2"
}

release_field() {
  local target="$ROOT/current/RELEASE"
  [ -f "$target" ] || return 1
  sed -n "s/^$1=//p" "$target" | head -1
}

# Which release is the process listening on $1 actually running? Empty if
# nothing is, or if the answer does not come from this install root.
#
# Deliberately lsof's `txt` record and not `ps -o comm=`, and deliberately a
# physical root — see the full rationale on the installer's copy of this
# function, and the `ps` trap in docs/specs/server.md.
listening_release() {
  local pid path root
  # lsof reports the vnode's PHYSICAL path, but $ROOT is logical — it keeps
  # whatever symlink the caller walked through (`pwd`, not `pwd -P`). Comparing
  # the two directly is a check that can never pass, the exact mirror of the
  # `ps` trap above. It bites a DORMOUSE_INSTALL_ROOT under `mktemp -d`, which
  # on macOS sits below /var -> /private/var.
  root="$(cd "$ROOT" 2>/dev/null && pwd -P)" || return 0
  pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 0
  while IFS= read -r path; do
    case "$path" in
      "n$root/releases/"*)
        path="${path#"n$root/releases/"}"
        printf '%s\n' "${path%%/*}"
        return 0
        ;;
    esac
  done < <(lsof -p "$pid" -a -d txt -Fn 2>/dev/null || true)
}

# Healthy means the CURRENT release answers, not that anything does: an orphan
# of an older release replies to /api/hello identically (see listening_release).
# Waiting on that identity rather than asserting it after the first 200 also
# absorbs the window where a process still shutting down answers one curl.
# An empty `want` — no `current` at all — is never healthy.
#
# On timeout this explains which of the two failures happened, so callers can
# keep reporting only their own context.
wait_for_health() {
  local deadline=$((SECONDS + ${1:-30})) want serving
  want="$(basename "$(readlink "$ROOT/current" 2>/dev/null || true)")"
  while [ $SECONDS -lt $deadline ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/hello" &&
      [ -n "$want" ] && [ "$(listening_release "$PORT")" = "$want" ]; then
      return 0
    fi
    sleep 0.5
  done
  serving="$(listening_release "$PORT")"
  if [ -n "$serving" ] && [ "$serving" != "$want" ]; then
    printf "%sport %s is held by release '%s', not by %s — a stale process is answering%s\n" \
      "$C_RED" "$PORT" "$serving" "${want:-the current release}" "$C_OFF" >&2
  fi
  return 1
}

cmd_status() {
  printf '\nDormouse selfhost server\n'
  printf '  install root : %s\n' "$ROOT"
  printf '  origin       : %s\n' "${ORIGIN:-<unset>}"
  printf '  loopback     : http://127.0.0.1:%s\n' "$PORT"
  if [ -L "$ROOT/current" ]; then
    printf '  release      : %s\n' "$(basename "$(readlink "$ROOT/current")")"
    printf '  commit       : %s (dirty=%s)\n' "$(release_field git_sha || echo '?')" "$(release_field git_dirty || echo '?')"
    printf '  built at     : %s\n' "$(release_field built_at || echo '?')"
    printf '  node         : %s %s\n' "$(release_field node_version || echo '?')" "$(release_field node_arch || echo '')"
  else
    printf '  release      : %s(none — current symlink missing)%s\n' "$C_RED" "$C_OFF"
  fi
  if [ -L "$ROOT/previous" ]; then
    printf '  previous     : %s\n' "$(basename "$(readlink "$ROOT/previous")")"
  else
    printf '  previous     : (none — rollback unavailable)\n'
  fi
  printf '\nLaunchAgent\n'
  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    # Only the top-level fields: launchctl indents them with a single tab, and
    # the nested endpoint dictionaries carry their own `state =` lines.
    launchctl print "gui/$UID/$LABEL" 2>/dev/null \
      | awk -F ' = ' '$1 ~ /^\t(state|pid|last exit code)$/ { printf "  %s = %s\n", substr($1, 2), $2 }'
  else
    printf '  %snot loaded%s\n' "$C_RED" "$C_OFF"
  fi
  printf '\nHealth\n'
  if curl -sf "http://127.0.0.1:$PORT/api/hello" >/dev/null 2>&1; then
    printf '  loopback /api/hello : %sok%s\n' "$C_GRN" "$C_OFF"
  else
    printf '  loopback /api/hello : %sunreachable%s\n' "$C_RED" "$C_OFF"
  fi
  printf '\nTailscale Serve\n'
  ts serve status 2>&1 | sed 's/^/  /' || printf '  %stailscale CLI unavailable%s\n' "$C_RED" "$C_OFF"
  printf '\nState files (%s)\n' "$STATE_DIR"
  if [ -d "$STATE_DIR" ]; then
    ls -la "$STATE_DIR" | sed 's/^/  /'
  else
    printf '  %smissing%s\n' "$C_RED" "$C_OFF"
  fi
  printf '\n'
}

cmd_verify() {
  FAILURES=0
  printf '\nVerifying the installed service\n\n'

  if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    pass "LaunchAgent $LABEL is loaded in gui/$UID"
  else
    fail "LaunchAgent $LABEL is not loaded"
  fi

  if [ -f "$PLIST" ] && plutil -lint "$PLIST" >/dev/null 2>&1; then
    pass "LaunchAgent plist is valid"
    if grep -q "<key>RunAtLoad</key>" "$PLIST" && grep -q "<key>KeepAlive</key>" "$PLIST"; then
      pass "plist declares RunAtLoad and KeepAlive"
    else
      fail "plist is missing RunAtLoad or KeepAlive"
    fi
    if grep -q "DORMOUSE_SETUP_PASSWORD" "$PLIST"; then
      fail "plist contains the setup password — it must live only in config/server.env"
    else
      pass "plist carries no credential"
    fi
  else
    fail "LaunchAgent plist missing or invalid: $PLIST"
  fi

  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/hello"; then
    pass "http://127.0.0.1:$PORT/api/hello responds"
  else
    fail "loopback /api/hello is unreachable"
  fi

  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
    pass "Pocket app is served on loopback"
  else
    fail "Pocket index is not served — is lib/dist-pocket in the release?"
  fi

  local listeners
  listeners="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
  if [ -z "$listeners" ]; then
    fail "nothing is listening on port $PORT"
  elif printf '%s\n' "$listeners" | grep -qv '127\.0\.0\.1:'"$PORT"; then
    fail "port $PORT is bound off-loopback — fix DORMOUSE_BIND_HOST=127.0.0.1"
    printf '%s\n' "$listeners" | sed 's/^/      /'
  else
    pass "port $PORT is bound only to 127.0.0.1"
  fi

  # The check that separates "something answers" from "the current release
  # answers". An orphaned node from an older release holds the port and replies
  # to /api/hello exactly like the current one, so every other health check here
  # passes while stale code serves. Only meaningful once something is listening
  # — otherwise an empty result would report a foreign process where the line
  # above has already said the port is dead.
  if [ -n "$listeners" ]; then
    local serving cur_id
    serving="$(listening_release "$PORT")"
    cur_id="$(basename "$(readlink "$ROOT/current" 2>/dev/null || true)")"
    if [ -z "$serving" ]; then
      fail "the process on port $PORT is not from this install root"
    elif [ "$serving" = "$cur_id" ]; then
      pass "the process on port $PORT is the current release"
    else
      fail "port $PORT is served by release '$serving', but current is '$cur_id' — a stale process is answering"
    fi
  fi

  local tsip
  tsip="$(ts ip -4 2>/dev/null | head -1 || true)"
  if [ -n "$tsip" ]; then
    if curl -s --max-time 3 -o /dev/null "http://$tsip:$PORT/api/hello" 2>/dev/null; then
      fail "plaintext port $PORT is reachable on the Tailscale IP $tsip"
    else
      pass "plaintext port $PORT is not reachable on the Tailscale IP"
    fi
  else
    note "skipped the off-loopback probe (no Tailscale IPv4 address)"
  fi

  local serve_out
  serve_out="$(ts serve status 2>/dev/null || true)"
  if [ -z "$serve_out" ]; then
    fail "tailscale serve reports no configuration"
  else
    if printf '%s' "$serve_out" | grep -q "127.0.0.1:$PORT"; then
      pass "Serve proxies to 127.0.0.1:$PORT"
    else
      fail "Serve does not proxy to 127.0.0.1:$PORT"
      printf '%s\n' "$serve_out" | sed 's/^/      /'
    fi
    if [ -n "$ORIGIN" ] && printf '%s' "$serve_out" | grep -q "${ORIGIN#https://}"; then
      pass "Serve origin matches DORMOUSE_ORIGIN ($ORIGIN)"
    else
      fail "Serve origin does not match DORMOUSE_ORIGIN ($ORIGIN)"
    fi
  fi

  # Serve and Funnel are one configuration surface, and Funnel publishes this
  # exact origin to the public internet. The whole security analysis of the
  # selfhost server assumes a tailnet-only origin — most of all the setup
  # password, whose hardening is a constant-time compare and a 250ms delay
  # (SECURITY.md, "The setup password"). So this is checked, never assumed.
  local funnel_out
  funnel_out="$(ts funnel status 2>/dev/null || true)"
  if printf '%s\n%s' "$serve_out" "$funnel_out" | grep -qi 'funnel on'; then
    fail "tailscale funnel is ON — this origin is published to the public internet"
    printf '%s\n' "$funnel_out" | sed 's/^/      /'
  else
    pass "tailscale funnel is off (the origin stays tailnet-only)"
  fi

  local cfg_mode state_mode env_mode
  cfg_mode="$(stat -f '%Lp' "$ROOT/config" 2>/dev/null || echo '???')"
  state_mode="$(stat -f '%Lp' "$STATE_DIR" 2>/dev/null || echo '???')"
  env_mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '???')"
  [ "$cfg_mode" = "700" ] && pass "config/ is mode 0700" || fail "config/ is mode $cfg_mode, expected 700"
  [ "$state_mode" = "700" ] && pass "state/ is mode 0700" || fail "state/ is mode $state_mode, expected 700"
  [ "$env_mode" = "600" ] && pass "config/server.env is mode 0600" || fail "config/server.env is mode $env_mode, expected 600"

  if grep -q '^DORMOUSE_BIND_HOST=127\.0\.0\.1$' "$ENV_FILE" 2>/dev/null; then
    pass "DORMOUSE_BIND_HOST=127.0.0.1"
  else
    fail "DORMOUSE_BIND_HOST is not pinned to 127.0.0.1"
  fi

  if [ -L "$ROOT/current" ] && [ -f "$ROOT/current/RELEASE" ]; then
    pass "current release: $(basename "$(readlink "$ROOT/current")")"
    [ "$(release_field git_dirty)" = "true" ] && warn "this release was built from a DIRTY worktree"
  else
    fail "current release symlink or RELEASE metadata missing"
  fi

  if [ -L "$ROOT/previous" ] && [ "$(readlink "$ROOT/previous")" = "$(readlink "$ROOT/current" 2>/dev/null)" ]; then
    fail "previous names the same release as current — there is no rollback target"
  elif [ -L "$ROOT/previous" ]; then
    pass "a previous release is retained for rollback"
  else
    warn "no previous release retained yet — rollback is unavailable until the next update"
  fi

  # The release must not depend on the source checkout.
  local src
  src="$(release_field source_checkout || echo '')"
  if [ -n "$src" ]; then
    if grep -q "$src" "$PLIST" 2>/dev/null || grep -q "$src" "$ROOT/bin/run-server" 2>/dev/null; then
      fail "the LaunchAgent or wrapper references the source checkout ($src)"
    else
      pass "the installed service does not reference the source checkout"
    fi
  fi

  printf '\n'
  if [ "$FAILURES" -eq 0 ]; then
    printf '%sAll checks passed.%s\n\n' "$C_GRN" "$C_OFF"
    return 0
  fi
  printf '%s%s check(s) failed.%s\n\n' "$C_RED" "$FAILURES" "$C_OFF"
  return 1
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_DIR/server.out.log" "$LOG_DIR/server.err.log"
  printf 'tailing %s/{server.out.log,server.err.log} — ctrl-c to stop\n\n' "$LOG_DIR"
  tail -n 50 -f "$LOG_DIR/server.out.log" "$LOG_DIR/server.err.log"
}

cmd_restart() {
  launchctl kickstart -k "gui/$UID/$LABEL"
  printf 'restarted; waiting for health...\n'
  if wait_for_health 30; then
    printf '%shealthy%s\n' "$C_GRN" "$C_OFF"
  else
    printf '%sdid not become healthy within 30s — check: manage logs%s\n' "$C_RED" "$C_OFF"
    return 1
  fi
}

cmd_show_password() {
  printf '\n%sWARNING%s the setup password gates account creation and Host enrollment.\n' "$C_YEL" "$C_OFF"
  printf 'It is about to be printed to this terminal. Make sure nobody is looking\n'
  printf 'over your shoulder and that this session is not being recorded or shared.\n\n'
  if [ ! -t 0 ]; then
    printf 'refusing to print the setup password with no terminal to confirm at\n' >&2
    return 1
  fi
  printf 'Print it? [y/N] '
  local reply=""
  read -r reply || true
  case "$reply" in y|Y|yes|YES) ;; *) printf 'aborted\n'; return 1 ;; esac
  printf '\n  %s\n\n' "$(env_value DORMOUSE_SETUP_PASSWORD)"
}

cmd_serve() {
  # Re-apply the Serve mapping — e.g. after a dev session repointed / at :3000.
  [ -n "$TS_BIN" ] || { printf 'tailscale CLI not found\n' >&2; return 1; }
  ts serve --bg "$PORT"
  ts serve status
}

cmd_rollback() {
  [ -L "$ROOT/previous" ] || { printf 'no previous release retained\n' >&2; return 1; }
  local prev cur
  prev="$(readlink "$ROOT/previous")"
  cur="$(readlink "$ROOT/current" 2>/dev/null || echo '')"
  [ -d "$ROOT/releases/$(basename "$prev")" ] || { printf 'previous release directory is gone: %s\n' "$prev" >&2; return 1; }
  # Swapping a release with itself would wait for health and print success while
  # changing nothing. Refuse instead — an install left in that state by an older
  # installer has no rollback target, whatever the `previous` link suggests.
  [ "$prev" != "$cur" ] || { printf 'previous and current name the same release (%s) — nothing to roll back to\n' "$(basename "$prev")" >&2; return 1; }
  printf 'rolling back: %s -> %s\n' "$(basename "$cur")" "$(basename "$prev")"
  local node_bin=""
  for candidate in "$prev/runtime/node" "$ROOT/current/runtime/node"; do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
  [ -n "$node_bin" ] || { printf 'no usable runtime found to swap the symlinks\n' >&2; return 1; }
  # `previous` first: node_bin can be "$ROOT/current/runtime/node", and moving
  # `current` to $prev would repoint it at the runtime that was just rejected.
  if [ -n "$cur" ]; then atomic_symlink "$cur" "$ROOT/previous" "$node_bin"; fi
  atomic_symlink "$prev" "$ROOT/current" "$node_bin"
  if [ "$(readlink "$ROOT/current")" != "$prev" ]; then
    printf 'current did not advance to %s\n' "$prev" >&2
    return 1
  fi
  launchctl kickstart -k "gui/$UID/$LABEL" || true
  if wait_for_health 30; then
    printf '%srolled back and healthy%s\n' "$C_GRN" "$C_OFF"
  else
    printf '%srolled back but not healthy — check: manage logs%s\n' "$C_RED" "$C_OFF"
    return 1
  fi
}

cmd_uninstall() {
  printf '\nThis removes the LaunchAgent and the installed code.\n'
  printf 'It PRESERVES your configuration and state:\n'
  printf '  config : %s\n' "$ROOT/config"
  printf '  state  : %s\n' "$STATE_DIR"
  printf '\nUse "manage purge" separately to delete those irreversibly.\n\n'
  if [ ! -t 0 ]; then
    printf 'refusing to uninstall with no terminal to confirm at\n' >&2
    return 1
  fi
  printf 'Uninstall? [y/N] '
  local reply=""
  read -r reply || true
  case "$reply" in y|Y|yes|YES) ;; *) printf 'aborted\n'; return 1 ;; esac
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  # Turn off only the mapping this installer owns.
  if ts serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
    if ts serve --bg off 2>/dev/null; then
      printf 'turned off the Serve mapping to 127.0.0.1:%s\n' "$PORT"
    else
      printf 'could not turn off the Serve mapping; check "tailscale serve status" and remove it by hand\n' >&2
    fi
  else
    printf 'left the Serve config alone (it does not point at 127.0.0.1:%s)\n' "$PORT"
  fi
  rm -rf "$ROOT/releases" "$ROOT/current" "$ROOT/previous" "$ROOT/bin"
  printf '\nuninstalled. config and state remain at:\n  %s\n  %s\n\n' "$ROOT/config" "$STATE_DIR"
}

cmd_purge() {
  printf '\n%sIRREVERSIBLE%s This deletes the account, enrolled Hosts, push\n' "$C_RED" "$C_OFF"
  printf 'subscriptions, and the VAPID key:\n  %s\n  %s\n\n' "$STATE_DIR" "$ROOT/config"
  printf 'Registered passkeys and enrolled Hosts will have to be set up again.\n\n'
  printf 'Type exactly: DELETE DORMOUSE STATE\n> '
  local reply=""
  read -r reply || true
  if [ "$reply" != "DELETE DORMOUSE STATE" ]; then printf 'aborted\n'; return 1; fi
  rm -rf "$STATE_DIR" "$ROOT/config"
  printf 'purged.\n'
}

case "${1:-status}" in
  status) cmd_status ;;
  verify) cmd_verify ;;
  logs) cmd_logs ;;
  restart) cmd_restart ;;
  show-password) cmd_show_password ;;
  serve) cmd_serve ;;
  rollback) cmd_rollback ;;
  uninstall) cmd_uninstall ;;
  purge) cmd_purge ;;
  *)
    cat <<USAGE
usage: manage <command>

  status          LaunchAgent, process, health, Serve origin, and release
  verify          run every acceptance check; exits nonzero on any failure
  logs            tail the local server logs
  restart         kickstart the LaunchAgent and wait for health
  show-password   warn, then display the setup password locally
  serve           re-apply the Tailscale Serve mapping for this server
  rollback        switch to the retained previous release, preserving state
  uninstall       remove LaunchAgent + code (keeps config and state)
  purge           irreversibly delete config and state
USAGE
    exit 64
    ;;
esac
MANAGE_EOF
chmod 0700 "$BIN_DIR/manage"
ok "bin/manage"

# --------------------------------------------------------- candidate check ---

step "Health-checking the candidate release"

# Disposable: a throwaway state dir, a throwaway password and an ephemeral port,
# so nothing touches the live service or the real state while we prove the new
# code boots and serves.
PROBE_PORT="$("$STAGE/runtime/node" -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))});')"
PROBE_STATE="$(mktemp -d -t dormouse-probe-state)"
PROBE_LOG="$(mktemp -t dormouse-probe-log)"
chmod 0700 "$PROBE_STATE"

env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  DORMOUSE_SETUP_PASSWORD="candidate-probe-$RELEASE_ID" \
  DORMOUSE_ORIGIN="$ORIGIN" \
  DORMOUSE_STATE_DIR="$PROBE_STATE" \
  DORMOUSE_BIND_HOST=127.0.0.1 \
  PORT="$PROBE_PORT" \
  NODE_ENV=production \
  "$STAGE/runtime/node" "$STAGE/server/dist/index.js" > "$PROBE_LOG" 2>&1 &
PROBE_PID=$!

probe_cleanup() {
  kill "$PROBE_PID" 2>/dev/null || true
  wait "$PROBE_PID" 2>/dev/null || true
  rm -rf "$PROBE_STATE"
  rm -f "$PROBE_LOG"
}

PROBE_OK=0
i=0
while [ $i -lt 60 ]; do
  if curl -sf -o /dev/null "http://127.0.0.1:$PROBE_PORT/api/hello"; then PROBE_OK=1; break; fi
  kill -0 "$PROBE_PID" 2>/dev/null || break
  sleep 0.25
  i=$((i + 1))
done

if [ "$PROBE_OK" != "1" ]; then
  echo "--- candidate output ---" >&2
  cat "$PROBE_LOG" >&2
  probe_cleanup
  rm -rf "$STAGE"
  die "the candidate release did not answer /api/hello. The live service was left untouched."
fi
ok "candidate answers /api/hello (scrubbed PATH, ephemeral port $PROBE_PORT)"

if curl -sf -o /dev/null "http://127.0.0.1:$PROBE_PORT/"; then
  ok "candidate serves the Pocket app"
else
  probe_cleanup
  rm -rf "$STAGE"
  die "the candidate release did not serve the Pocket index. The live service was left untouched."
fi
probe_cleanup

# ----------------------------------------------------------- switch release --

step "Switching to the new release"

OLD_RELEASE=""
if [ -L "$CURRENT_LINK" ]; then
  OLD_RELEASE="$(readlink "$CURRENT_LINK")"
fi

if [ -n "$OLD_RELEASE" ]; then
  atomic_symlink "$OLD_RELEASE" "$PREVIOUS_LINK" "$STAGE/runtime/node"
  detail "previous -> $(basename "$OLD_RELEASE")"
fi
atomic_symlink "$STAGE" "$CURRENT_LINK" "$STAGE/runtime/node"

# Prove the switch actually landed: a silently unmoved `current` is exactly the
# failure this step exists to prevent.
SWITCHED_TO="$(readlink "$CURRENT_LINK" 2>/dev/null || echo "")"
[ "$SWITCHED_TO" = "$STAGE" ] || die "current did not advance to $RELEASE_ID (points at '${SWITCHED_TO:-nothing}')."
ok "current -> $RELEASE_ID"

# ------------------------------------------------------------- launchagent --

write_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$BIN_DIR/run-server</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$INSTALL_ROOT</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>15</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/server.out.log</string>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/server.err.log</string>
</dict>
</plist>
PLIST_EOF
  chmod 0644 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "generated plist failed plutil -lint: $PLIST"
}

rollback_release() {
  warn "restoring the previous release"
  if [ -z "$OLD_RELEASE" ]; then
    warn "there is no previous release to restore (this was a first install)."
    return 1
  fi
  # $STAGE/runtime/node was verified executable and version/arch-matched earlier
  # in this run; $OLD_RELEASE/runtime/node has not been checked at all.
  atomic_symlink "$OLD_RELEASE" "$CURRENT_LINK" "$STAGE/runtime/node"
  # Prove the restore landed before touching `previous`, the way the forward
  # switch proves `current` advanced. Both callers invoke this as
  # `rollback_release || true`, which disables errexit for the entire function
  # body, so a failed atomic_symlink above falls through to here instead of
  # aborting — and deleting `previous` then would strip the only rollback
  # pointer off an install still sitting on the rejected release.
  local restored_to
  restored_to="$(readlink "$CURRENT_LINK" 2>/dev/null || echo "")"
  if [ "$restored_to" != "$OLD_RELEASE" ]; then
    warn "current was NOT restored to $(basename "$OLD_RELEASE") (points at '${restored_to:-nothing}'). Leaving the previous link in place so rollback stays possible."
    return 1
  fi
  # `previous` was pointed at $OLD_RELEASE before the switch, so leaving it would
  # make both links name the same release: `manage verify` would report a rollback
  # target that does not exist and `manage rollback` would swap a release with
  # itself and call it healthy. Once `current` is back on $OLD_RELEASE there is
  # genuinely no previous release, and the state must say so.
  rm -f "$PREVIOUS_LINK"
  if [ "$TEST_MODE" != "1" ]; then
    launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  fi
  # A 200 does not say who answered: the rejected release's own process holding
  # the port would otherwise read as the previous release being healthy again.
  # listening_release only runs once curl succeeds, so a still-starting server
  # costs nothing here.
  local old_id serving j=0
  old_id="$(basename "$OLD_RELEASE")"
  while [ $j -lt 60 ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:$LOOPBACK_PORT/api/hello" &&
      [ "$(listening_release "$LOOPBACK_PORT")" = "$old_id" ]; then
      warn "the previous release ($old_id) is healthy again."
      return 0
    fi
    sleep 0.5
    j=$((j + 1))
  done
  serving="$(listening_release "$LOOPBACK_PORT")"
  if [ -n "$serving" ] && [ "$serving" != "$old_id" ]; then
    warn "port $LOOPBACK_PORT is held by release '$serving', not by the restored $old_id."
  fi
  warn "the previous release did NOT become healthy. Inspect: $LOG_DIR"
  return 1
}

step "Installing the LaunchAgent"
write_plist
ok "wrote and linted $PLIST"

if [ "$TEST_MODE" = "1" ]; then
  warn "test mode: skipping launchctl bootout/bootstrap/kickstart"
else
  BOOTOUT_OUT="$(launchctl bootout "gui/$UID/$LABEL" 2>&1)" && BOOTOUT_RC=0 || BOOTOUT_RC=$?
  if [ "$BOOTOUT_RC" != "0" ]; then
    case "$BOOTOUT_OUT" in
      *"No such process"*|*"not find"*|*"not currently loaded"*) detail "no previously loaded agent (first install)" ;;
      *) die "launchctl bootout failed unexpectedly (rc=$BOOTOUT_RC): $BOOTOUT_OUT" ;;
    esac
  else
    detail "unloaded the previous agent"
  fi

  launchctl bootstrap "gui/$UID" "$PLIST" || die "launchctl bootstrap failed for $PLIST"
  launchctl kickstart -k "gui/$UID/$LABEL" || die "launchctl kickstart failed for $LABEL"
  ok "LaunchAgent bootstrapped into gui/$UID"
fi

# ------------------------------------------------------------ live health ----

step "Waiting for the installed service"

if [ "$TEST_MODE" = "1" ]; then
  warn "test mode: skipping the live health check (no LaunchAgent was loaded)"
else
  # Wait for THIS release to be the one answering, not merely for a 200: an
  # orphan of an older release holding the port answers identically, which would
  # read as a successful update while the old code keeps serving. Waiting on it
  # rather than asserting afterwards also covers the moments after `kickstart`
  # when the outgoing process has not finished letting go of the port.
  LIVE_OK=0
  i=0
  while [ $i -lt 80 ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:$LOOPBACK_PORT/api/hello" &&
      [ "$(listening_release "$LOOPBACK_PORT")" = "$RELEASE_ID" ]; then LIVE_OK=1; break; fi
    sleep 0.5
    i=$((i + 1))
  done

  if [ "$LIVE_OK" != "1" ]; then
    LISTENING="$(listening_release "$LOOPBACK_PORT")"
    if [ -n "$LISTENING" ] && [ "$LISTENING" != "$RELEASE_ID" ]; then
      warn "port $LOOPBACK_PORT is served by release '$LISTENING', not by $RELEASE_ID"
    else
      warn "the new release never answered http://127.0.0.1:$LOOPBACK_PORT/api/hello"
    fi
    [ -f "$LOG_DIR/server.err.log" ] && tail -30 "$LOG_DIR/server.err.log" >&2
    rollback_release || true
    die "update FAILED. Rollback was attempted — this is not a success, whatever the previous release now reports."
  fi
  ok "http://127.0.0.1:$LOOPBACK_PORT/api/hello responds, from $RELEASE_ID"

  if curl -sf -o /dev/null "http://127.0.0.1:$LOOPBACK_PORT/"; then
    ok "Pocket app is served"
  else
    warn "the Pocket index did not load"
    rollback_release || true
    die "update FAILED (Pocket index). Rollback was attempted."
  fi
fi

# -------------------------------------------------------------- serve ------

step "Configuring Tailscale Serve"

SERVE_BEFORE="$(ts serve status 2>&1 || true)"
if [ -n "$SERVE_BEFORE" ]; then
  detail "existing Serve configuration:"
  printf '%s\n' "$SERVE_BEFORE" | sed 's/^/      /'
fi

NEEDS_SERVE=1
if printf '%s' "$SERVE_BEFORE" | grep -q "127.0.0.1:$LOOPBACK_PORT"; then
  ok "Serve already proxies to 127.0.0.1:$LOOPBACK_PORT"
  NEEDS_SERVE=0
elif printf '%s' "$SERVE_BEFORE" | grep -qE '^\|-- / +proxy'; then
  EXISTING_TARGET="$(printf '%s' "$SERVE_BEFORE" | sed -n 's%^|-- / *proxy *%%p' | head -1)"
  warn "the root HTTPS path is already mapped to something else: ${EXISTING_TARGET:-<unknown>}"
  warn "Dormouse needs / on this node to serve the Pocket app at the passkey origin."
  confirm "Repoint / to 127.0.0.1:$LOOPBACK_PORT?" \
    || die "left the Serve config alone. Resolve the hostname/path conflict, then re-run."
fi

if [ "$TEST_MODE" = "1" ]; then
  warn "test mode: skipping the Serve mutation"
elif [ "$NEEDS_SERVE" = "1" ]; then
  info "tailscale serve --bg $LOOPBACK_PORT"
  detail "Tailscale may open a browser consent flow if HTTPS is not yet enabled."
  ts serve --bg "$LOOPBACK_PORT" || die "\`tailscale serve --bg $LOOPBACK_PORT\` failed."
  ok "Serve configured"
fi

if [ "$TEST_MODE" != "1" ]; then
  SERVE_AFTER="$(ts serve status 2>&1 || true)"
  printf '%s' "$SERVE_AFTER" | grep -q "127.0.0.1:$LOOPBACK_PORT" \
    || { printf '%s\n' "$SERVE_AFTER" >&2; die "Serve does not report a proxy to 127.0.0.1:$LOOPBACK_PORT."; }
  printf '%s' "$SERVE_AFTER" | grep -q "$TS_DNS" \
    || { printf '%s\n' "$SERVE_AFTER" >&2; die "Serve does not report the expected HTTPS origin $ORIGIN."; }
  ok "Serve reports $ORIGIN -> 127.0.0.1:$LOOPBACK_PORT"
fi

# ----------------------------------------------------------------- prune ----

step "Pruning old releases"

KEEP_CURRENT="$(basename "$(readlink "$CURRENT_LINK")")"
KEEP_PREVIOUS=""
[ -L "$PREVIOUS_LINK" ] && KEEP_PREVIOUS="$(basename "$(readlink "$PREVIOUS_LINK")")"

PRUNED=0
for dir in "$RELEASES_DIR"/*; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [ "$name" = "$KEEP_CURRENT" ] && continue
  [ -n "$KEEP_PREVIOUS" ] && [ "$name" = "$KEEP_PREVIOUS" ] && continue
  rm -rf "$dir"
  detail "removed release $name"
  PRUNED=$((PRUNED + 1))
done
if [ "$PRUNED" = "0" ]; then
  ok "nothing to prune (retaining current${KEEP_PREVIOUS:+ and previous})"
else
  ok "pruned $PRUNED old release(s); config and state untouched"
fi

# ---------------------------------------------------------------- summary ---

step "Installed"

printf '    origin        %s\n' "$ORIGIN"
printf '    release       %s\n' "$RELEASE_ID"
printf '    commit        %s (dirty=%s)\n' "$GIT_SHA" "$GIT_DIRTY"
printf '    install root  %s\n' "$INSTALL_ROOT"
printf '    config        %s\n' "$ENV_FILE"
printf '    state         %s\n' "$STATE_DIR"
printf '    logs          %s\n' "$LOG_DIR"
printf '\n'
printf '    manage:  "%s" <status|verify|logs|restart|show-password|serve|rollback|uninstall>\n' "$BIN_DIR/manage"
printf '\n'

if [ "$FIRST_INSTALL" = "1" ]; then
  printf '    First install. Retrieve the generated setup password when you are ready\n'
  printf '    to create the passkey and enroll a Host:\n\n'
  printf '        "%s" show-password\n\n' "$BIN_DIR/manage"
fi

exit 0
