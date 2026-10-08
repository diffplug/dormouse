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
#   scripts/security-audit-local.sh            # the deterministic checks, then all four domains
#   scripts/security-audit-local.sh application-security   # one domain
#   scripts/security-audit-local.sh github-state            # the deterministic checks alone
#   scripts/security-audit-local.sh canary [count]          # recall on seeded vulnerabilities
#
# `canary` measures rather than audits (docs/specs/security-audit.md -> "Canary
# recall"): it copies the committed tree to a temporary directory, seeds it from
# `.github/audit/canaries/` as CI does, runs the three code domains there, and
# scores their fragments. Your checkout is never touched, and nothing is filed.
#
# The deterministic GitHub-state check (`scripts/github-state-check.mjs`) runs
# first whenever a domain that reads its fragment does — `ci-and-secrets` and
# `supply-chain` — on the same `gh` login, with `--local` so a 403 reads as
# unverifiable rather than as drift in the CI PAT's scope.
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
  if [ ! -s "$out" ]; then
    echo "==> $domain produced no fragment — in CI that is an INCONCLUSIVE audit, not a FAIL" >&2
    return 1
  fi
  echo "==> wrote $out"
  # The verdict CI reports, computed from the fragment's lines: zero only on
  # PASS, which also needs its sentinel and a first line of exactly
  # `VERDICT: PASS`. It prints why anything else is not.
  node scripts/security-audit-report.mjs check "$out" >&2
}

# The open ledger findings every domain re-verifies, as CI's `List open
# findings` step writes them, read on the operator's own login. Without the
# file each domain computes INCONCLUSIVE, as it does in CI. It reads the
# private tracker and files nothing there.
write_open_findings() {
  local open row
  rm -f audit-open-findings.txt
  if ! open=$(gh issue list --repo diffplug/dormouse-embargo --state open --limit 1000 --json number,title \
      --jq '.[] | select(.title | startswith("[audit-finding ")) | "\(.number) \(.title)"'); then
    echo "==> could not read the findings ledger; every domain will compute INCONCLUSIVE" >&2
    return 0
  fi
  while read -r row; do
    [ -n "$row" ] || continue
    printf '%s\n' "${row#* }"
  done <<< "$open" > audit-open-findings.txt
}

# The deterministic checks, writing the fragment CI's reporting step reads
# beside the domains'.
run_github_state() {
  echo "==> github-state -> audit-github-state.md (deterministic)"
  rm -f audit-github-state.md
  if ! node scripts/github-state-check.mjs --local --out audit-github-state.md >/dev/null; then
    echo "==> the GitHub-state check failed to run" >&2
    return 1
  fi
  node scripts/security-audit-report.mjs check audit-github-state.md >&2
}

# The canary, in a copy of the committed tree: seeded, audited by the three code
# domains, then scored. `CANARY_KEY` picks the seeds;
# the same key and pool seed the same way.
run_canary() {
  local count="${1:-6}" tree stash domain
  tree=$(mktemp -d)
  stash=$(mktemp -d)
  git archive HEAD | tar -x -C "$tree"
  echo "==> canary: seeding $count in $tree"
  (cd "$tree" && pnpm install --frozen-lockfile >/dev/null &&
    node scripts/security-audit-canary.mjs seed --key "${CANARY_KEY:-$(date +%s)}" --count "$count" --stash "$stash")
  # Run here rather than through the copy's runner, which would read the real
  # findings ledger: a canary hands its domains an empty list, as CI does.
  (cd "$tree" && : > audit-open-findings.txt &&
    for domain in supply-chain application-security hosted; do run_domain "$domain" || true; done)
  (cd "$tree" && node scripts/security-audit-canary.mjs score --stash "$stash" \
    --scorecard "$stash/scorecard.json" --public "$stash/canary-recall.json")
  echo "==> scorecard: $stash/scorecard.json; seeded tree: $tree"
}

if [ $# -gt 0 ]; then
  status=0
  case "$1" in
    canary) shift; run_canary "$@"; exit $? ;;
    github-state) run_github_state; exit $? ;;
    ci-and-secrets|supply-chain) run_github_state || status=1 ;;
  esac
  write_open_findings
  run_domain "$1" || status=$?
  exit "$status"
fi

# All four, sequentially rather than fanned out. CI parallelises because it is
# paying wall-clock for a nightly; locally, serial output is readable and a
# each domain's failure is recorded while the remaining domains still run.
status=0
run_github_state || status=1
write_open_findings
for domain in supply-chain ci-and-secrets application-security hosted; do
  run_domain "$domain" || status=1
done

echo
echo "==> fragments:"
ls -la audit-*.md 2>/dev/null || echo "  (none)"
echo "==> each verdict above is the one CI computes; there is no merge here, so read the fragments directly."
exit "$status"
