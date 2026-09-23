#!/bin/bash
#
# Run the nightly security audit locally, against the same prompt files CI
# uses (`.github/audit/`). Nothing is duplicated here: if this and the workflow
# ever disagree, it is a bug in one of them, not a drift in the prompts.
#
# The audit reads administration endpoints (ruleset bypass actors, secret
# listings, environment policies, `actions/permissions/workflow`). In CI those
# go through the read-only `AUDIT_PAT`; locally they go through whatever `gh`
# is already authenticated as, so run this as someone with admin read on the
# repo or the ci-and-secrets domain will report FAILs that are really 403s.
#
# Usage:
#   scripts/security-audit-local.sh            # all four domains
#   scripts/security-audit-local.sh application-security   # one domain
#
# Reports land in ./audit-*.md, which .gitignore covers.

set -euo pipefail

cd "$(dirname "$0")/.."
AUDIT_DIR=.github/audit
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-diffplug/dormouse}"
# `_preamble.md`'s delegate wait persists its deadline under `$RUNNER_TEMP`,
# which only Actions sets. No domain reaches that block here — `run_domain`
# denies `Task`/`Agent`, so a local domain cannot delegate, and the
# orchestrator never runs locally — but a fresh directory per run keeps the
# wait bounded if that ever changes, where a repo-root fallback would hand the
# next run an expired deadline.
export RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"

if ! command -v claude >/dev/null 2>&1; then
  echo "error: the \`claude\` CLI is not on PATH." >&2
  exit 1
fi

for f in _preamble orchestrator supply-chain ci-and-secrets application-security hosted; do
  [ -f "$AUDIT_DIR/$f.md" ] || { echo "error: missing $AUDIT_DIR/$f.md" >&2; exit 1; }
done

# One domain, in the foreground. This is the loop you actually iterate in while
# editing a security spec: no orchestrator, no waiting, no merge — just the domain
# under test, writing its own fragment.
run_domain() {
  local domain="$1" out
  case "$domain" in
    supply-chain) out=audit-supply-chain.md ;;
    ci-and-secrets) out=audit-ci-secrets.md ;;
    application-security) out=audit-application.md ;;
    hosted) out=audit-hosted.md ;;
    *) echo "error: unknown domain '$domain' (supply-chain|ci-and-secrets|application-security|hosted)" >&2; return 64 ;;
  esac
  # Same model split as CI (`.github/workflows/security-audit.yaml` ->
  # `--agents`): the two mechanical domains run on the default, and the two
  # code-reading domains — application-security and hosted — run on Opus.
  # Local and CI must agree here, or the domains where the model matters most
  # are the ones they disagree about.
  # BOTH sides are pinned, not just the strong one. Leaving the mechanical
  # domains unpinned inherits whatever the operator's `~/.claude/settings.json`
  # names, which is not necessarily weaker than Opus — on a machine defaulting
  # to `opus[1m]` it is *stronger* (same family, larger context), inverting the
  # relation docs/specs/security-audit.md requires and making a local run no longer a rehearsal
  # of the nightly. CI gets this for free: its session default is Sonnet and
  # only the code-reading domains carry an override.
  #
  # A plain string, not an array: macOS ships bash 3.2, where `"${arr[@]}"` on
  # an EMPTY array is an unbound-variable error under `set -u`. These are fixed
  # literals with no whitespace, so the unquoted expansion below is safe.
  local model_args="--model sonnet"
  case "$domain" in application-security|hosted) model_args="--model opus" ;; esac

  echo "==> $domain -> $out${model_args:+ ($model_args)}"
  rm -f "$out"
  # shellcheck disable=SC2086
  if ! claude -p "$(cat "$AUDIT_DIR/_preamble.md"; echo; cat "$AUDIT_DIR/$domain.md")" \
    $model_args \
    --allowed-tools "Read,Write,Edit,Bash,Grep,Glob" \
    --disallowed-tools "Task,Agent,Workflow"; then
    echo "==> $domain auditor process failed" >&2
    return 1
  fi
  if [ -s "$out" ]; then
    echo "==> wrote $out"
    # Same sentinel CI reads, for the same reason: the domain appends findings
    # as it determines them, so a fragment without its last line is one whose
    # domain stopped early — and its first line may already say PASS.
    # Last non-blank line, not `tail -n1`: a trailing blank line after the
    # sentinel still ends a finished report.
    if [ "$(sed -e '/^[[:space:]]*$/d' "$out" | tail -n1)" != "<!-- END OF REPORT -->" ]; then
      echo "==> $domain was cut off before finishing $out — findings kept, its verdict line covers less than it appears to" >&2
      case "$(head -n1 "$out")" in 'VERDICT: FAIL'*) echo "==> $domain reports FAIL" >&2 ;; esac
      return 1
    fi
    # The same grammar CI applies in .github/workflows/security-audit.yaml, and
    # for the same reason: a failure with an appended explanation is still a
    # finding, so only the PASS arm matches exactly. Drifting from CI here would
    # report a dissenting fragment as unreadable.
    case "$(head -n1 "$out")" in
      'VERDICT: PASS') return 0 ;;
      'VERDICT: FAIL'*) echo "==> $domain reports FAIL" >&2; return 1 ;;
      'VERDICT: INCONCLUSIVE') return 1 ;;
      *) echo "==> $domain produced no readable verdict" >&2; return 1 ;;
    esac
  else
    echo "==> $domain produced no fragment — in CI that is an INCONCLUSIVE audit, not a FAIL" >&2
    return 1
  fi
}

if [ $# -gt 0 ]; then
  run_domain "$1"
  exit $?
fi

# All four, sequentially rather than fanned out. CI parallelises because it is
# paying wall-clock for a nightly; locally, serial output is readable and a
# each domain's failure is recorded while the remaining domains still run.
status=0
for domain in supply-chain ci-and-secrets application-security hosted; do
  run_domain "$domain" || status=1
done

echo
echo "==> fragments:"
ls -la audit-*.md 2>/dev/null || echo "  (none)"
echo "==> merge and verdict are the orchestrator's job in CI; read the fragments directly here."
exit "$status"
