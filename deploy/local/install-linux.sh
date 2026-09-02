#!/bin/bash
#
# Install the Dormouse coordinating server on this Linux machine as a per-login
# systemd *user* service, fronted by `tailscale serve` on the node's own HTTPS
# name.
#
# Running this a second time updates the installed release from the current
# checkout. It never pulls, fetches, switches branches, or installs an updater:
# the checkout you are standing in is the release source.
#
# See SELF_HOST.md for the runbook and docs/specs/server.md for the runtime
# contract this installs.
#
# Usage:
#   ./deploy/local/install-linux.sh [--yes] [--linger]
#
#   --linger   Also enable lingering, so the service survives logout and starts
#              at boot without a login. Off by default: the shipped contract is
#              a per-login agent, and lingering changes that availability
#              property. Required for a headless box you reach over SSH.
#
# Environment:
#   DORMOUSE_INSTALL_TEST=1   Build, stage, health-check and switch releases,
#                             but do not touch systemd or the Serve config.
#   DORMOUSE_INSTALL_ROOT     A throwaway install root (requires the above), so
#                             path quoting and release switching can be tested.
#   DORMOUSE_INSTALL_ORIGIN   An origin to use instead of asking Tailscale
#                             (requires the above). Lets CI, which has no
#                             tailnet, run everything up to the Serve step.

set -euo pipefail

LABEL="dormouse-server"
UNIT="$LABEL.service"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/dormouse-server"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dormouse-server/logs"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT"
LOOPBACK_PORT=3100

ASSUME_YES=0
[ "${DORMOUSE_INSTALL_ASSUME_YES:-0}" = "1" ] && ASSUME_YES=1
TEST_MODE=0
[ "${DORMOUSE_INSTALL_TEST:-0}" = "1" ] && TEST_MODE=1
WANT_LINGER=0

# A throwaway install root, for exercising path quoting, unit generation,
# release switching and cleanup without touching the real installation. Gated to
# test mode on purpose: a real install belongs in the documented location, and
# an overridden root would leave `manage` and systemd disagreeing about where
# the service lives. Overriding HOME instead would break pnpm, whose store and
# downloaded runtime live under the real home.
if [ -n "${DORMOUSE_INSTALL_ORIGIN:-}" ] && [ "$TEST_MODE" != "1" ]; then
  echo "DORMOUSE_INSTALL_ORIGIN is only honored with DORMOUSE_INSTALL_TEST=1" >&2
  exit 64
fi

if [ -n "${DORMOUSE_INSTALL_ROOT:-}" ]; then
  if [ "$TEST_MODE" != "1" ]; then
    echo "DORMOUSE_INSTALL_ROOT is only honored with DORMOUSE_INSTALL_TEST=1" >&2
    exit 64
  fi
  INSTALL_ROOT="$DORMOUSE_INSTALL_ROOT"
  LOG_DIR="$INSTALL_ROOT/logs"
  UNIT_DIR="$INSTALL_ROOT/systemd"
  UNIT_FILE="$UNIT_DIR/$UNIT"
fi

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --linger) WANT_LINGER=1 ;;
    --help|-h) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

mktemp_file() { mktemp "${TMPDIR:-/tmp}/dormouse-$1.XXXXXX"; }

# ------------------------------------------------------------- preflight ----

[ "$(uname -s)" = "Linux" ] || die "this installer is Linux-only (found $(uname -s)). Use deploy/local/install-macos.sh on macOS or deploy/local/install-windows.ps1 on Windows."

[ "$(id -u)" != "0" ] || die "do not run this as root. It installs only into \$HOME and needs no sudo. The whole credential posture is that one user account owns config/ and state/; a root install would write them owned by another principal and register the service for it."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$REPO_ROOT/pnpm-workspace.yaml" ] || die "cannot locate the repository root from $SCRIPT_DIR"
cd "$REPO_ROOT"

JSON_RUNNER=""
if command -v node >/dev/null 2>&1; then
  JSON_RUNNER="node"
elif command -v python3 >/dev/null 2>&1; then
  JSON_RUNNER="python3"
else
  die "need either node or python3 to read package.json and the Tailscale status."
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
      python3 -c '
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

# HTTP health check without assuming curl is installed. Ubuntu Server images
# ship it, but a minimal container or Debian netinst does not, and the release
# already carries a Node binary that can do this.
#
# HTTP_NODE names the Node to fall back on; it advances from the build's runtime
# to the staged one as soon as a release exists, so no call site has to pass it.
# $1 = url, $2 = timeout seconds, $3 = node binary (optional override)
HTTP_NODE=""
http_ok() {
  local url="$1" timeout="${2:-5}" node_bin="${3:-$HTTP_NODE}"
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null --max-time "$timeout" "$url"
    return $?
  fi
  [ -n "$node_bin" ] && [ -x "$node_bin" ] || return 2
  "$node_bin" -e '
const http = require("http");
const req = http.get(process.argv[1], { timeout: Number(process.argv[2]) * 1000 }, (res) => {
  res.resume();
  process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
});
req.on("timeout", () => { req.destroy(); process.exit(1); });
req.on("error", () => process.exit(1));
' "$url" "$timeout"
}

# --- who answered? -----------------------------------------------------------
#
# `/api/hello` carries no identity, so a 200 on the loopback port proves only
# that *something* got there first. Every live check waits on the identity
# instead — never on `http_ok` alone — which also absorbs the window where an
# outgoing process answers one last time. `manage` carries the same helpers.

unit_active() { [ "$(systemctl --user is-active "$UNIT" 2>/dev/null || true)" = "active" ]; }

# Echoes the release id serving port $1, or nothing when that cannot be
# established. The server writes {pid, releaseId, port} at successful bind
# (server/src/runtime-file.ts), so this is a file read and a liveness check
# rather than three platforms' worth of process forensics.
#
# Empty means "unknown", never "nobody": a stale file whose pid is dead, a
# server started outside the installer, and a foreign process that got the port
# first are all indistinguishable from here, and all of them must fail the
# comparison rather than pass it.
listening_release() {
  local port="$1" file pid release rport
  file="$INSTALL_ROOT/run/server.json"
  [ -r "$file" ] || return 0
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -1)"
  release="$(sed -n 's/.*"releaseId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1)"
  rport="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -1)"
  [ -n "$pid" ] && [ -n "$release" ] || return 0
  # The file is about one socket; a record for a different port says nothing
  # about this one.
  [ "$rport" = "$port" ] || return 0
  # A crash leaves the file behind on purpose, so liveness is what separates a
  # serving process from a corpse.
  kill -0 "$pid" 2>/dev/null || return 0
  printf '%s\n' "$release"
}

# $1 = the release id that must be answering. Three legs, all required:
# systemd's own view, a 200, and the identity of whoever holds the port.
service_healthy() {
  unit_active \
    && http_ok "http://127.0.0.1:$LOOPBACK_PORT/api/hello" 2 \
    && [ -n "$1" ] && [ "$(listening_release "$LOOPBACK_PORT")" = "$1" ]
}

# ---------------------------------------------------------------- systemd ---

command -v systemctl >/dev/null 2>&1 \
  || die "systemctl not found. This installer targets a systemd user service; on a non-systemd init, stop and design the native service manager with the user rather than translating unit files blindly."

SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | head -1 | awk '{print $2}')"
case "$SYSTEMD_VERSION" in
  ''|*[!0-9]*) warn "could not parse the systemd version from \`systemctl --version\`." ;;
  *)
    # StandardOutput=append: landed in systemd 240. Below that the unit would
    # silently truncate the log on every restart, so `manage logs` would lie.
    if [ "$SYSTEMD_VERSION" -lt 240 ]; then
      die "systemd $SYSTEMD_VERSION is too old: the unit uses StandardOutput=append:, which needs systemd 240 or newer."
    fi
    ;;
esac

# `ss` used to be load-bearing here: identity came from resolving the port
# holder, so without iproute2 the post-switch wait could never succeed and a
# good install rolled itself back. The server now records its own identity
# (`DORMOUSE_RUNTIME_FILE`), so the only thing left that needs `ss` is
# `manage verify`'s bind check — worth a warning, not a refusal.
command -v ss >/dev/null 2>&1 \
  || warn "ss not found (iproute2). The install works without it, but \`manage verify\` cannot confirm that port $LOOPBACK_PORT is bound only to 127.0.0.1."

if [ "$TEST_MODE" != "1" ]; then
  # A user manager is what runs the service. Without one — a bare `su`, a
  # container with no logind, a distro where the session never registered —
  # `systemctl --user` fails with a message about DBUS_SESSION_BUS_ADDRESS that
  # does not say what to do about it.
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    die "no systemd user manager is reachable for uid $(id -u). \`systemctl --user\` needs a running user instance and XDG_RUNTIME_DIR (currently '${XDG_RUNTIME_DIR:-<unset>}'). If you got here with \`su\`, log in as this user properly — \`machinectl shell $USER@\` or a fresh SSH session — and re-run."
  fi
fi

# --------------------------------------------------------------- tailscale --

# A test-mode run with an injected origin never consults Tailscale at all, which
# is what lets CI — which has no tailnet — exercise the build, the staging, the
# candidate probe and the release switch.
SKIP_TAILSCALE=0
[ "$TEST_MODE" = "1" ] && [ -n "${DORMOUSE_INSTALL_ORIGIN:-}" ] && SKIP_TAILSCALE=1

if [ "$SKIP_TAILSCALE" != "1" ]; then
  command -v tailscale >/dev/null 2>&1 \
    || die "tailscale CLI not found on PATH. Install Tailscale and sign in first — this installer will not install or reauthenticate it for you. https://tailscale.com/docs/install/linux"
fi

ts() { tailscale "$@"; }

# On Linux the CLI talks to tailscaled over a root-owned socket, so an
# unprivileged `tailscale serve` is refused unless the daemon has been told this
# user may operate it. That refusal arrives late — after the build, at the Serve
# step — unless it is checked here, and its fix is a one-line sudo the user has
# to run themselves.
ts_denied() {
  case "$1" in
    *"Access denied"*|*"access denied"*|*"permission denied"*|*"Permission denied"*|*"operator"*) return 0 ;;
    *) return 1 ;;
  esac
}

# One remediation, four call sites. The `sudo` line is the single most
# important operator-facing instruction in this script, so it is written once.
# The lead clause is the caller's, because one of the four has not run anything
# yet: preflight predicts the refusal rather than reporting one.
# $1 = lead clause, phrased for what actually happened
# $2 = supporting detail (the CLI's own output, or what the role check found)
# $3 = optional trailing paragraph, for context only some call sites have
die_needs_operator() {
  die "$1: $2
    On Linux the tailscaled control socket is root-owned. Grant this account the
    operator role once, then re-run:

        sudo tailscale set --operator=\$USER

    This installer will not run sudo for you.${3:-}"
}

# ------------------------------------------------------------------ start ----

printf '%sDormouse selfhost server — Linux installer%s\n' "$C_BLD" "$C_OFF"
[ "$TEST_MODE" = "1" ] && warn "DORMOUSE_INSTALL_TEST=1 — systemd and Serve will not be touched."

# One EXIT trap for every temporary this script creates. `pnpm deploy --prod
# --legacy` poisons the root node_modules/.pnpm-workspace-state-v1.json
# (production:true / dev:false), which would make every later pnpm command in
# this checkout try `pnpm install --production` and strip the developer's
# devDependencies — so the snapshot is restored unconditionally, even on a
# failed install. The probe temporaries are here too so that a `die` anywhere
# between staging and the switch cannot leak them.
TS_STATUS_JSON=""
TS_PREFS_JSON=""
WS_STATE="$REPO_ROOT/node_modules/.pnpm-workspace-state-v1.json"
WS_STATE_BACKUP=""
PROBE_STATE=""
PROBE_LOG=""
restore_workspace_state() {
  if [ -n "$WS_STATE_BACKUP" ] && [ -f "$WS_STATE_BACKUP" ]; then
    cp -p "$WS_STATE_BACKUP" "$WS_STATE" 2>/dev/null || true
    rm -f "$WS_STATE_BACKUP"
    WS_STATE_BACKUP=""
  fi
}
cleanup() {
  restore_workspace_state
  rm -f "$TS_STATUS_JSON" "$TS_PREFS_JSON" "$PROBE_LOG"
  [ -n "$PROBE_STATE" ] && rm -rf "$PROBE_STATE"
  return 0
}
trap cleanup EXIT

step "Checking Tailscale"

if [ "$SKIP_TAILSCALE" = "1" ]; then
  ORIGIN="$DORMOUSE_INSTALL_ORIGIN"
  case "$ORIGIN" in
    https://*) TS_DNS="${ORIGIN#https://}" ;;
    *) die "DORMOUSE_INSTALL_ORIGIN must be an https:// origin, got '$ORIGIN'." ;;
  esac
  warn "test mode: using the injected origin $ORIGIN; Tailscale is not consulted."
else

  TS_STATUS_JSON="$(mktemp_file ts-status)"
  # `2>&1 > file`, not `> file 2>&1`: the latter points stderr at the file too,
  # so the capture is always empty and the operator-role remediation below
  # becomes dead code with a blank error body.
  TS_STATUS_ERR="$(ts status --json 2>&1 > "$TS_STATUS_JSON")" || {
    ts_denied "$TS_STATUS_ERR" && die_needs_operator "\`tailscale status\` was refused for this user" "$TS_STATUS_ERR"
    die "\`tailscale status --json\` failed. Is tailscaled running and signed in? (systemctl status tailscaled)
      ${TS_STATUS_ERR}"
  }

  TS_BACKEND="$(json_query "$TS_STATUS_JSON" "BackendState" || echo "")"
  [ "$TS_BACKEND" = "Running" ] || die "Tailscale backend state is '${TS_BACKEND:-unknown}', expected 'Running'. Sign in and connect (\`tailscale up\`), then re-run."

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
      ;;
  esac

  # Prove the operator role now rather than at the Serve step, which happens after
  # the build and after `current` has already moved.
  #
  # `tailscale serve status` cannot answer this on its own: it is a *read*, and
  # tailscaled serves reads to everyone. Only writes are gated on the operator
  # role, so on exactly the machine whose Serve write is about to be denied the
  # read probe prints "No serve config" and exits 0. The role itself is the thing
  # to check, and `debug prefs` is where tailscaled exposes it. The read still
  # runs first: a denial *there* means something broader than the operator role
  # is wrong. A node with no Serve configuration exits nonzero too, so only a
  # refusal is fatal.
  if [ "$TEST_MODE" != "1" ]; then
    if ! SERVE_PROBE="$(ts serve status 2>&1)"; then
      ts_denied "$SERVE_PROBE" && die_needs_operator "\`tailscale serve status\` was refused for this user" "$SERVE_PROBE"
    fi

    # Only a definitive mismatch is fatal. `debug` is an explicitly unstable CLI
    # surface, so an unreadable or unparseable answer must not block an install
    # that would otherwise succeed; it degrades to the late refusal this check
    # exists to pull earlier, which is no worse than having no check.
    #
    # Readability is decided by a *different* field than the answer, because
    # `ipn.Prefs.OperatorUser` carries `json:",omitempty"`: with no operator set
    # the key is absent, which is indistinguishable from an unparseable blob if
    # the answer field is also the liveness probe. Reading it that way would send
    # the commonest case of this bug — nobody ever ran `tailscale set --operator`
    # — into the lenient branch, i.e. exactly the miss this whole check exists to
    # close. `ControlURL` has no `omitempty` and is always marshalled, so it
    # answers "did prefs parse?" on its own; absent-or-empty `OperatorUser` on a
    # blob that parsed is then a definitive unset, not an unknown.
    #
    # json_query's stderr is dropped here and only here: every other call site
    # reads JSON already known to be well-formed, whereas on this path a parse
    # failure is an expected outcome and its runner's stack trace would bury the
    # two warnings below.
    TS_PREFS_JSON="$(mktemp_file ts-prefs)"
    if ts debug prefs 2>/dev/null > "$TS_PREFS_JSON" \
      && json_query "$TS_PREFS_JSON" "ControlURL" >/dev/null 2>&1; then
      TS_OPERATOR="$(json_query "$TS_PREFS_JSON" "OperatorUser" 2>/dev/null || true)"
      if [ -n "$TS_OPERATOR" ] && [ "$TS_OPERATOR" = "$(id -un)" ]; then
        ok "this account may operate tailscaled"
      else
        die_needs_operator "\`tailscale serve\` will be refused for this user" \
          "tailscaled's operator is ${TS_OPERATOR:-unset}, not this account ($(id -un))."
      fi
    else
      warn "could not read tailscaled's operator role from \`tailscale debug prefs\`."
      warn "If it is unset, the Serve step below will be refused."
    fi
  fi
fi

# --------------------------------------------------------- origin identity ---

CONFIG_DIR="$INSTALL_ROOT/config"
ENV_FILE="$CONFIG_DIR/server.env"
RUN_DIR="$INSTALL_ROOT/run"
ENROLL_OFFER_FILE="$RUN_DIR/enroll-offer.json"
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
EXECPATH_FILE="$(mktemp_file execpath)"
pnpm exec node -e 'require("fs").writeFileSync(process.argv[1], process.execPath)' "$EXECPATH_FILE" >/dev/null 2>&1 \
  || die "could not resolve the pinned Node runtime via pnpm exec."
NODE_BIN="$(cat "$EXECPATH_FILE")"
rm -f "$EXECPATH_FILE"
[ -x "$NODE_BIN" ] || die "resolved Node runtime is not executable: $NODE_BIN"
HTTP_NODE="$NODE_BIN"

NODE_BUILD_VERSION="$("$NODE_BIN" -e 'process.stdout.write(process.version)')"
NODE_BUILD_ARCH="$("$NODE_BIN" -e 'process.stdout.write(process.arch)')"
[ "$NODE_BUILD_VERSION" = "v$NODE_PIN" ] || die "the build ran under Node $NODE_BUILD_VERSION but the repository pins v$NODE_PIN."
ok "pinned runtime: $NODE_BUILD_VERSION ($NODE_BUILD_ARCH)"

# ------------------------------------------------------------- stage build ---

step "Staging the new release"

umask 077
mkdir -p "$RELEASES_DIR" "$BIN_DIR"
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$RUN_DIR"
# Explicit rather than left to the umask above, so a directory an earlier run
# created looser is tightened rather than kept.
chmod 0700 "$CONFIG_DIR" "$STATE_DIR" "$RUN_DIR"
mkdir -p "$LOG_DIR"

BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$GIT_SHORT"
[ "$GIT_DIRTY" = "true" ] && RELEASE_ID="$RELEASE_ID-dirty"
STAGE="$RELEASES_DIR/$RELEASE_ID"

rm -rf "$STAGE"
mkdir -p "$STAGE/lib" "$STAGE/runtime"

info "pnpm deploy --prod --legacy"
if [ -f "$WS_STATE" ]; then
  WS_STATE_BACKUP="$(mktemp_file wsstate)"
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
  x86_64:x64|aarch64:arm64|armv7l:arm) : ;;
  *) die "the copied runtime is $STAGED_NODE_ARCH but this machine is $ARCH." ;;
esac
HTTP_NODE="$STAGE/runtime/node"
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

# One named CSPRNG, not a fallback chain: the release's own Node was staged a
# few lines ago and is the binary this service will run under, so it is always
# present and needs no probing. `crypto.randomBytes` is OpenSSL's RAND_bytes.
# Never substitute $RANDOM, a timestamp, or any non-CSPRNG source. Both secrets
# this installer mints — the setup password and the enrollment offer's token —
# come from here, so there is one generator to audit rather than one per secret.
random_hex32() {
  "$STAGE/runtime/node" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'
}

if [ ! -f "$ENV_FILE" ]; then
  SETUP_PASSWORD="$(random_hex32)"
  # 32 random bytes is 64 hex characters. The guard counts characters, so it
  # must be 64 — checking for 32 would pass a regression to 16 bytes, which is
  # half the entropy SECURITY.md claims.
  [ ${#SETUP_PASSWORD} -ge 64 ] || die "generated setup password is implausibly short; refusing to install it."

  # Create the file and lock it down BEFORE the secret is written, so the
  # password never sits under the directory's default permissions, even briefly.
  # `cat >` truncates without touching the mode, so no second chmod is needed.
  : > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
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
# Installed by deploy/local/install-linux.sh. Stable across releases.
#
# The systemd user manager does not read interactive shell startup files, so
# this must not depend on the user's PATH, on nvm/fnm/Volta, on pnpm's store, or
# on the source checkout. It loads only the installer-owned env file and execs
# the runtime copied into the current release.
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

# Tell the server who it is. It records {pid, releaseId, port} here once it has
# actually bound, which is how `manage` and the installer answer "which release
# is answering?" without reconstructing it from the process table. Set here
# rather than in server.env because it is derived from `current`, which moves.
export DORMOUSE_RUNTIME_FILE="$ROOT/run/server.json"
# The installer mints this only until hosts.json records the first enrollment.
export DORMOUSE_ENROLL_TOKEN_FILE="$ROOT/run/enroll-offer.json"
RELEASE_TARGET="$(readlink "$ROOT/current" 2>/dev/null || true)"
[ -n "$RELEASE_TARGET" ] && export DORMOUSE_RELEASE_ID="${RELEASE_TARGET##*/}"

exec "$NODE_BIN" "$ENTRY"
RUNSERVER_EOF
chmod 0700 "$BIN_DIR/run-server"
ok "bin/run-server"

cat > "$BIN_DIR/manage" <<'MANAGE_EOF'
#!/bin/bash
# Installed by deploy/local/install-linux.sh.
set -euo pipefail

LABEL="dormouse-server"
UNIT="$LABEL.service"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/config/server.env"
OFFER_FILE="$ROOT/run/enroll-offer.json"
STATE_DIR="$ROOT/state"
# LOG_ROOT is the dormouse-owned directory the logs sit in — outside ROOT on a
# real install, and what "purge" names so it does not leave an empty one behind.
LOG_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/dormouse-server"
LOG_DIR="$LOG_ROOT/logs"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
# A test install (DORMOUSE_INSTALL_ROOT) keeps its logs and unit inside its own
# root, so `manage` must follow them there rather than at the real HOME paths.
[ -d "$ROOT/logs" ] && { LOG_DIR="$ROOT/logs"; LOG_ROOT="$ROOT"; }
[ -f "$ROOT/systemd/$UNIT" ] && UNIT_FILE="$ROOT/systemd/$UNIT"

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
NODE_FOR_HTTP="$ROOT/current/runtime/node"

TS_BIN=""
command -v tailscale >/dev/null 2>&1 && TS_BIN="$(command -v tailscale)"
ts() {
  [ -n "$TS_BIN" ] || return 127
  "$TS_BIN" "$@"
}

http_ok() {
  local url="$1" timeout="${2:-5}"
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null --max-time "$timeout" "$url"
    return $?
  fi
  [ -x "$NODE_FOR_HTTP" ] || return 2
  "$NODE_FOR_HTTP" -e '
const http = require("http");
const req = http.get(process.argv[1], { timeout: Number(process.argv[2]) * 1000 }, (res) => {
  res.resume();
  process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
});
req.on("timeout", () => { req.destroy(); process.exit(1); });
req.on("error", () => process.exit(1));
' "$url" "$timeout"
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

# $1 = path, $2 = expected octal mode, $3 = label. Asserts both legs of
# "reachable only by the installing user" from a single stat.
owner_only() {
  local out mode owner me
  me="$(id -un)"
  out="$(stat -c '%a %U' "$1" 2>/dev/null || true)"
  if [ -z "$out" ]; then
    fail "$3 is missing: $1"
    return
  fi
  mode="${out%% *}"
  owner="${out#* }"
  if [ "$mode" = "$2" ] && [ "$owner" = "$me" ]; then
    pass "$3 is mode 0$2, owned by $me"
  else
    fail "$3 is mode 0$mode owned by $owner — expected mode 0$2 owned by $me"
  fi
}

# Which release is serving the loopback port?
#
# The server writes {pid, releaseId, port} at successful bind
# (server/src/runtime-file.ts), so this is a file read and a liveness check.
# Empty means "unknown", never "nobody": a stale file whose pid is dead, a
# server started outside the installer, and a foreign process that got the port
# first are all indistinguishable from here, and all must fail the comparison
# rather than pass it.
listening_release() {
  local port="$1" file pid release rport
  file="$ROOT/run/server.json"
  [ -r "$file" ] || return 0
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -1)"
  release="$(sed -n 's/.*"releaseId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1)"
  rport="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -1)"
  [ -n "$pid" ] && [ -n "$release" ] || return 0
  [ "$rport" = "$port" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  printf '%s\n' "$release"
}

unit_active() { [ "$(systemctl --user is-active "$UNIT" 2>/dev/null || true)" = "active" ]; }

current_release() { basename "$(readlink "$ROOT/current" 2>/dev/null || true)"; }

# $1 = the release id that must be answering. Three legs, all required: systemd's
# own view, a 200, and the identity of whoever holds the port.
service_healthy() {
  unit_active \
    && http_ok "http://127.0.0.1:$PORT/api/hello" 2 \
    && [ -n "$1" ] && [ "$(listening_release "$PORT")" = "$1" ]
}

# The identity lives in the wait, not at its callers, so `restart` and
# `rollback` are both covered from one place — and waiting on it rather than
# asserting it after the first 200 absorbs the window in which an outgoing
# process answers one last time.
wait_for_health() {
  local deadline=$((SECONDS + ${1:-30})) want serving
  want="$(current_release)"
  while [ $SECONDS -lt $deadline ]; do
    if service_healthy "$want"; then return 0; fi
    sleep 0.5
  done
  serving="$(listening_release "$PORT")"
  if [ -n "$serving" ] && [ "$serving" != "$want" ]; then
    printf '%sport %s is held by release %s, not by %s — a stale process is answering%s\n' \
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
  printf '\nsystemd user service\n'
  if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
    systemctl --user show "$UNIT" \
      -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStatus \
      2>/dev/null | sed 's/^/  /'
    printf '  UnitFileState = %s\n' "$(systemctl --user is-enabled "$UNIT" 2>&1 || true)"
    printf '  Linger        = %s\n' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo '?')"
  else
    printf '  %snot loaded%s\n' "$C_RED" "$C_OFF"
  fi
  printf '\nHealth\n'
  if http_ok "http://127.0.0.1:$PORT/api/hello" 3; then
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

  if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
    pass "systemd user unit $UNIT is known to the user manager"
  else
    fail "systemd user unit $UNIT is not loaded"
  fi

  if [ -f "$UNIT_FILE" ]; then
    if systemd-analyze --user verify "$UNIT_FILE" >/dev/null 2>&1; then
      pass "unit file passes systemd-analyze verify"
    else
      # systemd-analyze is absent on some minimal images; only fail when it ran
      # and objected.
      if command -v systemd-analyze >/dev/null 2>&1; then
        fail "unit file fails systemd-analyze verify: $UNIT_FILE"
      else
        note "skipped systemd-analyze verify (not installed)"
      fi
    fi
    if grep -q '^Restart=always$' "$UNIT_FILE" && grep -q '^WantedBy=default.target$' "$UNIT_FILE"; then
      pass "unit declares Restart=always and WantedBy=default.target"
    else
      fail "unit is missing Restart=always or WantedBy=default.target"
    fi
    if grep -q "DORMOUSE_SETUP_PASSWORD" "$UNIT_FILE"; then
      fail "the unit file contains the setup password — it must live only in config/server.env"
    else
      pass "unit file carries no credential"
    fi
  else
    fail "unit file missing: $UNIT_FILE"
  fi

  if [ "$(systemctl --user is-enabled "$UNIT" 2>/dev/null || echo no)" = "enabled" ]; then
    pass "unit is enabled (starts at login)"
  else
    fail "unit is not enabled — it will not start at the next login"
  fi

  # systemd's own view is the only thing that distinguishes *our* server from
  # anything else answering on the port, so it is checked before health is.
  local active
  active="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
  if [ "$active" = "active" ]; then
    pass "unit is active"
  else
    fail "unit is '${active:-unknown}' — any healthy /api/hello below is another process answering"
  fi

  local linger
  linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo "unknown")"
  if [ "$linger" = "yes" ]; then
    note "lingering is ON — the service also runs while you are logged out"
  else
    note "lingering is off — the service runs only while this user is logged in"
  fi

  # Health is never reported on its own. A ✓ next to "/api/hello responds" that
  # a stranger's server earned is worse than no line at all, so all three legs
  # decide which of the outcomes below is printed.
  local want serving
  want="$(current_release)"
  serving="$(listening_release "$PORT")"
  if service_healthy "$want"; then
    pass "http://127.0.0.1:$PORT/api/hello responds, from release $want"
  elif ! http_ok "http://127.0.0.1:$PORT/api/hello" 5; then
    fail "loopback /api/hello is unreachable"
  elif [ -n "$serving" ] && [ "$serving" != "$want" ]; then
    fail "port $PORT is held by release $serving, not by ${want:-the current release} — a stale process is answering"
  else
    fail "port $PORT answers /api/hello, but not from this service"
  fi

  if unit_active && http_ok "http://127.0.0.1:$PORT/" 5; then
    pass "Pocket app is served on loopback"
  else
    fail "Pocket index is not served — is lib/dist-pocket in the release?"
  fi

  # Identity is settled by the health block above, which already names a stale
  # release; this only asks what the socket is bound to.
  local listeners
  if ! command -v ss >/dev/null 2>&1; then
    note "skipped the bind check (ss from iproute2 is not installed)"
  else
    listeners="$(ss -lntH "sport = :$PORT" 2>/dev/null || true)"
    if [ -z "$listeners" ]; then
      fail "nothing this system can see is listening on port $PORT"
      note "if /api/hello answered above, the responder is outside this kernel's view"
    elif printf '%s\n' "$listeners" | awk '{print $4}' | grep -qv '^127\.0\.0\.1:'; then
      fail "port $PORT is bound off-loopback — fix DORMOUSE_BIND_HOST=127.0.0.1"
      printf '%s\n' "$listeners" | sed 's/^/      /'
    else
      pass "port $PORT is bound only to 127.0.0.1"
    fi
  fi

  local tsip
  tsip="$(ts ip -4 2>/dev/null | head -1 || true)"
  if [ -n "$tsip" ]; then
    if http_ok "http://$tsip:$PORT/api/hello" 3; then
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

  # The property is "reachable only by the installing user", and on unix that
  # is mode AND owner: a 0700 directory owned by someone else satisfies the mode
  # and inverts the property. Both legs, every path below, one stat each.
  owner_only "$ROOT/config" 700 "config/"
  owner_only "$STATE_DIR" 700 "state/"
  # run/ is checked as a directory in its own right, not merely as the offer's
  # parent: the directory governs who may replace or delete the one credential
  # the server honors from disk.
  owner_only "$ROOT/run" 700 "run/"
  owner_only "$ENV_FILE" 600 "config/server.env"
  # The enrollment offer is single-use: absent means it was spent (or never
  # minted by an older installer), which is healthy. Only its permissions are
  # this command's business, and only while it is there.
  if [ -f "$OFFER_FILE" ]; then
    owner_only "$OFFER_FILE" 600 "run/enroll-offer.json"
  else
    note "no enrollment offer on disk (spent, or minted by an older installer)"
  fi

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
  elif [ -L "$ROOT/previous" ] && [ ! -d "$ROOT/previous" ]; then
    fail "the previous symlink points at a release that no longer exists"
  elif [ -L "$ROOT/previous" ]; then
    pass "a previous release is retained for rollback"
  else
    warn "no previous release retained yet — rollback is unavailable until the next update"
  fi

  # The release must not depend on the source checkout.
  local src
  src="$(release_field source_checkout || echo '')"
  if [ -n "$src" ]; then
    if grep -q "$src" "$UNIT_FILE" 2>/dev/null || grep -q "$src" "$ROOT/bin/run-server" 2>/dev/null; then
      fail "the unit or wrapper references the source checkout ($src)"
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
  printf 'tailing %s/{server.out.log,server.err.log} — ctrl-c to stop\n' "$LOG_DIR"
  printf 'systemd also records unit events: journalctl --user -u %s\n\n' "$UNIT"
  tail -n 50 -f "$LOG_DIR/server.out.log" "$LOG_DIR/server.err.log"
}

cmd_restart() {
  systemctl --user restart "$UNIT"
  printf 'restarted; waiting for health...\n'
  if wait_for_health 30; then
    printf '%shealthy%s\n' "$C_GRN" "$C_OFF"
  else
    printf '%sdid not become healthy within 30s — check: manage logs%s\n' "$C_RED" "$C_OFF"
    return 1
  fi
}

cmd_show_password() {
  printf '\n%sWARNING%s the setup password gates Host enrollment.\n' "$C_YEL" "$C_OFF"
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
  # Swap with the target release's own runtime. Falling back to the one under
  # `current` would mean reaching through the very symlink being moved, and a
  # rollback target with no usable runtime cannot be started anyway.
  local node_bin="$prev/runtime/node"
  [ -x "$node_bin" ] || { printf 'previous release has no usable runtime: %s\n' "$node_bin" >&2; return 1; }
  if [ -n "$cur" ]; then atomic_symlink "$cur" "$ROOT/previous" "$node_bin"; fi
  atomic_symlink "$prev" "$ROOT/current" "$node_bin"
  if [ "$(readlink "$ROOT/current")" != "$prev" ]; then
    printf 'current did not advance to %s\n' "$prev" >&2
    return 1
  fi
  if ! systemctl --user restart "$UNIT"; then
    printf '%sthe symlinks were rolled back, but restarting %s failed%s\n' "$C_RED" "$UNIT" "$C_OFF" >&2
    printf 'inspect: systemctl --user status %s\n' "$UNIT" >&2
    return 1
  fi
  if wait_for_health 30; then
    printf '%srolled back and healthy%s\n' "$C_GRN" "$C_OFF"
  else
    printf '%srolled back but not healthy — check: manage logs%s\n' "$C_RED" "$C_OFF"
    return 1
  fi
}

cmd_uninstall() {
  printf '\nThis removes the systemd user unit and the installed code.\n'
  printf 'It PRESERVES your configuration and state:\n'
  printf '  config : %s\n' "$ROOT/config"
  printf '  state  : %s\n' "$STATE_DIR"
  printf '\nThis script is left in place so "purge" can still delete them\n'
  printf 'irreversibly afterwards:\n\n  "%s" purge\n\n' "$ROOT/bin/manage"
  if [ ! -t 0 ]; then
    printf 'refusing to uninstall with no terminal to confirm at\n' >&2
    return 1
  fi
  printf 'Uninstall? [y/N] '
  local reply=""
  read -r reply || true
  case "$reply" in y|Y|yes|YES) ;; *) printf 'aborted\n'; return 1 ;; esac
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
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
  # bin/run-server, not bin: this script lives there too, and "purge" — the
  # command the message above points at — is unreachable once it is deleted.
  rm -rf "$ROOT/releases" "$ROOT/current" "$ROOT/previous" "$ROOT/run"
  rm -f "$ROOT/bin/run-server"
  printf '\nuninstalled. config and state remain at:\n  %s\n  %s\n\n' "$ROOT/config" "$STATE_DIR"
  printf 'delete them irreversibly with:\n\n  "%s" purge\n\n' "$ROOT/bin/manage"
  printf 'lingering, if you enabled it, is left as it is: loginctl disable-linger %s\n\n' "$USER"
}

cmd_purge() {
  printf '\n%sIRREVERSIBLE%s This deletes the account, enrolled Hosts, push\n' "$C_RED" "$C_OFF"
  printf 'subscriptions, the VAPID key, and any unspent enrollment offer:\n  %s\n  %s\n  %s\n\n' \
    "$STATE_DIR" "$ROOT/config" "$ROOT/run"
  printf 'Registered passkeys and enrolled Hosts will have to be set up again.\n\n'
  printf 'Type exactly: DELETE DORMOUSE STATE\n> '
  local reply=""
  read -r reply || true
  if [ "$reply" != "DELETE DORMOUSE STATE" ]; then printf 'aborted\n'; return 1; fi
  # run/ too: an unspent enroll-offer.json redeems for a Host enrollment without
  # any existing account, and redemption mkdir-recreates the state this command
  # just deleted. Leaving it behind would make "IRREVERSIBLE" false for a day.
  rm -rf "$STATE_DIR" "$ROOT/config" "$ROOT/run"
  printf 'purged.\n'
  # bin/run-server is what "uninstall" removes, so its absence means the service
  # and the code are already gone and this script is the last thing standing. It
  # cannot delete itself out from under the shell running it, so say how. The
  # logs live outside ROOT on a real install, so LOG_ROOT has to be named too or
  # the printed command leaves them behind.
  if [ ! -e "$ROOT/bin/run-server" ]; then
    printf '\nthe service and code were already uninstalled; what remains is\n'
    printf 'this script and the logs:\n\n  rm -rf "%s" "%s"\n\n' "$ROOT" "$LOG_ROOT"
  fi
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

  status          unit state, process, health, Serve origin, and release
  verify          run every acceptance check; exits nonzero on any failure
  logs            tail the local server logs
  restart         restart the user service and wait for health
  show-password   warn, then display the setup password locally
  serve           re-apply the Tailscale Serve mapping for this server
  rollback        switch to the retained previous release, preserving state
  uninstall       remove the unit + code (keeps config, state, and this script)
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
PROBE_STATE="$(mktemp -d "${TMPDIR:-/tmp}/dormouse-probe-state.XXXXXX")"
PROBE_LOG="$(mktemp_file probe-log)"
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

# Only the process needs stopping here; PROBE_STATE and PROBE_LOG are globals
# the EXIT trap owns, so a `die` anywhere in this block cannot leak them.
probe_cleanup() {
  kill "$PROBE_PID" 2>/dev/null || true
  wait "$PROBE_PID" 2>/dev/null || true
}

# One exit for both candidate failures: tear the probe down, discard the
# half-staged release, and say the live service was never touched.
die_candidate() {
  echo "--- candidate output ---" >&2
  cat "$PROBE_LOG" >&2
  probe_cleanup
  rm -rf "$STAGE"
  die "$1 The live service was left untouched."
}

PROBE_OK=0
i=0
while [ $i -lt 60 ]; do
  if http_ok "http://127.0.0.1:$PROBE_PORT/api/hello" 2; then PROBE_OK=1; break; fi
  # Stop early if the candidate has already died — no point burning the timeout.
  kill -0 "$PROBE_PID" 2>/dev/null || break
  sleep 0.25
  i=$((i + 1))
done

[ "$PROBE_OK" = "1" ] || die_candidate "the candidate release did not answer /api/hello."
ok "candidate answers /api/hello (scrubbed PATH, ephemeral port $PROBE_PORT)"

http_ok "http://127.0.0.1:$PROBE_PORT/" 5 || die_candidate "the candidate release did not serve the Pocket index."
ok "candidate serves the Pocket app"
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

# ------------------------------------------------------------ systemd unit --

write_unit() {
  mkdir -p "$UNIT_DIR"
  # Paths are double-quoted in ExecStart so a root containing spaces (which the
  # test root may) survives systemd's own word splitting.
  cat > "$UNIT_FILE" <<UNIT_EOF
[Unit]
Description=Dormouse coordinating server (selfhost)
Documentation=https://github.com/diffplug/dormouse/blob/main/SELF_HOST.md

[Service]
Type=simple
ExecStart=/bin/bash "$BIN_DIR/run-server"
WorkingDirectory=$INSTALL_ROOT
# launchd's KeepAlive equivalent, with the same 10-second throttle the macOS
# plist declares as ThrottleInterval.
Restart=always
RestartSec=10
TimeoutStopSec=15
NoNewPrivileges=yes
StandardOutput=append:$LOG_DIR/server.out.log
StandardError=append:$LOG_DIR/server.err.log

[Install]
WantedBy=default.target
UNIT_EOF
  chmod 0644 "$UNIT_FILE"
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze --user verify "$UNIT_FILE" >/dev/null 2>&1 \
      || die "the generated unit failed systemd-analyze verify: $UNIT_FILE"
  fi
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

  # Only clear `previous` once the restore has actually landed. Both call sites
  # are `rollback_release || true`, which disables errexit for this whole body,
  # so an unguarded clear would strip the rollback pointer off an install still
  # sitting on the rejected release.
  local restored_to
  restored_to="$(readlink "$CURRENT_LINK" 2>/dev/null || echo "")"
  if [ "$restored_to" != "$OLD_RELEASE" ]; then
    warn "current was NOT restored to $(basename "$OLD_RELEASE") (points at '${restored_to:-nothing}'). Leaving the previous link in place so rollback stays possible."
    return 1
  fi
  # The switch had already aimed `previous` at the release we just restored to.
  # Leaving both pointers naming one release would make `verify` report a
  # rollback target that does not exist and `rollback` swap a release with
  # itself and call it success; once `current` is back there, there genuinely is
  # no previous release and the state must say so.
  rm -f "$PREVIOUS_LINK"

  if ! systemctl --user restart "$UNIT" >/dev/null 2>&1; then
    warn "restarting $UNIT after the restore failed. Inspect: systemctl --user status $UNIT"
    return 1
  fi
  # Wait on the identity of the restored release, not on a bare 200. This is the
  # path where a false "healthy again" is most expensive: the install has just
  # failed *because* something else may hold the port, and reporting that
  # stranger as the restored release is exactly the wrong thing to say here.
  local want j=0
  want="$(basename "$OLD_RELEASE")"
  while [ $j -lt 60 ]; do
    if service_healthy "$want"; then
      warn "the previous release ($want) is healthy again."
      return 0
    fi
    sleep 0.5
    j=$((j + 1))
  done
  warn "the previous release did NOT become healthy. Inspect: $LOG_DIR"
  return 1
}

step "Installing the systemd user service"
write_unit
ok "wrote $UNIT_FILE"

if [ "$TEST_MODE" = "1" ]; then
  warn "test mode: skipping systemctl daemon-reload/enable/restart"
else
  systemctl --user daemon-reload || die "systemctl --user daemon-reload failed."
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || die "systemctl --user enable $UNIT failed."
  systemctl --user restart "$UNIT" || die "systemctl --user restart $UNIT failed. Inspect: journalctl --user -u $UNIT -n 50"
  ok "unit enabled and started"

  if [ "$WANT_LINGER" = "1" ] && ! loginctl enable-linger "$USER" 2>/dev/null; then
    warn "could not enable lingering as this user. Run it yourself if you want it:"
    warn "    sudo loginctl enable-linger $USER"
  fi
  # Report what lingering actually IS, not what was asked for: re-running
  # without --linger does not turn off lingering a previous run enabled, and
  # saying "runs only while you are logged in" there would be false.
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)" = "yes" ]; then
    ok "lingering is on — the service survives logout and starts at boot"
  else
    detail "lingering is off; the service runs only while you are logged in."
    detail "For a headless box, re-run with --linger (or: loginctl enable-linger $USER)."
  fi
fi

# ------------------------------------------------------------ live health ----

step "Waiting for the installed service"

if [ "$TEST_MODE" = "1" ]; then
  warn "test mode: skipping the live health check (no unit was started)"
else
  LIVE_OK=0
  i=0
  while [ $i -lt 80 ]; do
    if service_healthy "$RELEASE_ID"; then
      LIVE_OK=1
      break
    fi
    sleep 0.5
    i=$((i + 1))
  done

  if [ "$LIVE_OK" != "1" ]; then
    # Say which of the three legs failed, because the remedies are different.
    SERVING="$(listening_release "$LOOPBACK_PORT")"
    if [ -n "$SERVING" ] && [ "$SERVING" != "$RELEASE_ID" ]; then
      warn "port $LOOPBACK_PORT is held by release '$SERVING', not by $RELEASE_ID — a stale process is answering"
    elif http_ok "http://127.0.0.1:$LOOPBACK_PORT/api/hello" 2; then
      warn "http://127.0.0.1:$LOOPBACK_PORT/api/hello answers, but NOT from this service."
      warn "  systemctl --user is-active $UNIT => $(systemctl --user is-active "$UNIT" 2>&1 || true)"
      warn "  release identity          => ${SERVING:-<none recorded>} (expected $RELEASE_ID)"
      warn "Either something else holds port $LOOPBACK_PORT, or this release never"
      warn "recorded itself in $INSTALL_ROOT/run/server.json — check the log below for"
      warn "a warning about writing that file. If this is WSL with networkingMode=mirrored,"
      warn "loopback is shared with Windows and the holder may be a Windows process."
    else
      warn "the new release never answered http://127.0.0.1:$LOOPBACK_PORT/api/hello"
    fi
    [ -f "$LOG_DIR/server.err.log" ] && tail -30 "$LOG_DIR/server.err.log" >&2
    journalctl --user -u "$UNIT" -n 20 --no-pager >&2 2>/dev/null || true
    rollback_release || true
    die "update FAILED. Rollback was attempted — this is not a success, whatever the previous release now reports."
  fi
  ok "release $RELEASE_ID is active and answering on 127.0.0.1:$LOOPBACK_PORT"

  if http_ok "http://127.0.0.1:$LOOPBACK_PORT/" 5; then
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
  SERVE_ERR="$(ts serve --bg "$LOOPBACK_PORT" 2>&1)" || {
    ts_denied "$SERVE_ERR" && die_needs_operator "\`tailscale serve\` was refused for this user" "$SERVE_ERR" "

    The release is installed and the service is running on 127.0.0.1:$LOOPBACK_PORT;
    only the HTTPS front door is missing. After granting the role you can finish
    without a reinstall:

        \"$BIN_DIR/manage\" serve"
    die "\`tailscale serve --bg $LOOPBACK_PORT\` failed: ${SERVE_ERR}"
  }
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

# ------------------------------------------------------------ enroll offer ---

# run/enroll-offer.json, the one-time offer redeemed at POST /api/host/enroll in
# place of the setup password (SECURITY.md → "Credentials at rest").
#
# Last state mutation: minting burns the previous unspent offer, so the release,
# HTTPS Serve mapping, and pruning must all have succeeded first. The server
# reads this file fresh; nothing needs it at service start.
#
# hosts.json is the durable "first Host happened" marker. Emptying its rows
# revokes Hosts but does not silently reopen this bootstrap credential.
if [ -e "$STATE_DIR/hosts.json" ]; then
  rm -f "$ENROLL_OFFER_FILE"
  ok "a Host has already enrolled — no one-click enrollment offer minted"
else
  ENROLL_TOKEN="$(random_hex32)"
  [ ${#ENROLL_TOKEN} -ge 64 ] || die "generated enroll token is implausibly short; refusing to write the enrollment offer."
  # Build an owner-only file beside the destination, then rename it into place.
  # Redemption may claim the live path at any instant; it must see one complete
  # generation or the other, never the truncate/chmod/write steps of a mint.
  ENROLL_OFFER_TMP="$(mktemp "$RUN_DIR/.enroll-offer.XXXXXX")" \
    || die "could not create a temporary enrollment offer."
  chmod 0600 "$ENROLL_OFFER_TMP"
  # mintedAt is read here, at write time, and never from BUILT_AT: the 24-hour
  # expiry runs from the mint, and the build that precedes it is not free.
  if ! printf '{"origin":"%s","token":"%s","mintedAt":"%s"}\n' \
    "$ORIGIN" "$ENROLL_TOKEN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ENROLL_OFFER_TMP"; then
    rm -f "$ENROLL_OFFER_TMP"
    unset ENROLL_TOKEN ENROLL_OFFER_TMP
    die "could not write the temporary enrollment offer."
  fi
  if ! mv -f "$ENROLL_OFFER_TMP" "$ENROLL_OFFER_FILE"; then
    rm -f "$ENROLL_OFFER_TMP"
    unset ENROLL_TOKEN ENROLL_OFFER_TMP
    die "could not publish the enrollment offer."
  fi
  unset ENROLL_OFFER_TMP
  unset ENROLL_TOKEN
  ok "minted run/enroll-offer.json (mode 0600) — a one-time enrollment offer for a Host on this machine"
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
printf '    unit          %s\n' "$UNIT_FILE"
printf '\n'
printf '    manage:  "%s" <status|verify|logs|restart|show-password|serve|rollback|uninstall>\n' "$BIN_DIR/manage"
printf '\n'

if [ "$FIRST_INSTALL" = "1" ]; then
  printf '    First install. Retrieve the generated setup password when you are ready\n'
  printf '    to enroll a Host by hand (the one-time offer card in the Host'"'"'s\n'
  printf '    Remote control settings needs no password):\n\n'
  printf '        "%s" show-password\n\n' "$BIN_DIR/manage"
fi

exit 0
