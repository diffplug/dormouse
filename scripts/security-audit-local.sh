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
# repo, or those checks come back UNVERIFIABLE and the domain INCONCLUSIVE.
#
# Usage:
#   scripts/security-audit-local.sh            # the deterministic checks, then every domain
#   scripts/security-audit-local.sh remote                  # one domain
#   scripts/security-audit-local.sh github-state            # the deterministic checks alone
#   scripts/security-audit-local.sh canary [count] [--key <key>] [--claude-scorecard <file>]
#                                                           # recall on seeded vulnerabilities
#   scripts/security-audit-local.sh --engine codex [any of the above]
#
# `canary` measures rather than audits (docs/specs/security-audit.md -> "Canary
# recall"): it copies the committed tree to a temporary directory, seeds it from
# `.github/audit/canaries/` as CI does, runs the code domains there, and
# scores their fragments. Your checkout is never touched, and nothing is filed.
# `--key` takes a CI canary run's seed key, its run ID, so the same commit seeds
# the same seeds that run did.
#
# `--engine codex` runs the same prompts on Codex instead of Claude: the red
# team (docs/specs/security-audit.md -> "Red team"), advisory, never the
# release gate. Its canary takes `--claude-scorecard`, the decrypted
# `scorecard.json` of the CI canary run its `--key` names, to count the seeds
# either engine caught. It ends by printing the `gh workflow run
# codex-audit-report.yaml` command that publishes its verdicts and counts;
# running that is yours to do, since this script files nothing.
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

ENGINE=claude
if [ "${1:-}" = --engine ]; then
  [ $# -ge 2 ] || { echo "error: --engine needs claude or codex" >&2; exit 64; }
  ENGINE="$2"
  shift 2
fi
case "$ENGINE" in
  claude|codex) ;;
  *) echo "error: unknown engine '$ENGINE' (claude|codex)" >&2; exit 64 ;;
esac
# The red team's model and Cyber access program. Pinned here alone: the
# Codex engine has no CI counterpart to agree with.
CODEX_MODEL=gpt-6-sol
CODEX_PROGRAM=daybreak_blue

if ! command -v "$ENGINE" >/dev/null 2>&1; then
  echo "error: the \`$ENGINE\` CLI is not on PATH." >&2
  exit 1
fi

for f in _preamble orchestrator supply-chain ci-and-secrets remote local hosted; do
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
    remote) out=audit-remote.md ;;
    local) out=audit-local.md ;;
    hosted) out=audit-hosted.md ;;
    *) echo "error: unknown domain '$domain' (supply-chain|ci-and-secrets|remote|local|hosted)" >&2; return 64 ;;
  esac
  # Same model split as CI (`.github/workflows/security-audit.yaml` ->
  # `--agents`): the two mechanical domains run on the default, and the
  # code-reading domains — remote, local, and hosted — run on Opus.
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
  case "$domain" in remote|local|hosted) model_args="--model opus" ;; esac

  if [ "$ENGINE" = codex ]; then
    # Sandboxed to the working tree, with the network `ci-and-secrets` needs
    # for live GitHub state; a check the sandbox keeps from the operator's `gh`
    # login comes back UNVERIFIABLE, never PASS. The leading line stands in
    # for the Claude run's denied `Task`: the domain runs every work stream
    # itself.
    echo "==> $domain -> $out (codex: $CODEX_MODEL, $CODEX_PROGRAM)"
    rm -f "$out"
    if ! codex exec -m "$CODEX_MODEL" --cyber-access-program "$CODEX_PROGRAM" \
      --sandbox workspace-write -c sandbox_workspace_write.network_access=true --ephemeral \
      "$(echo "Do not delegate: run every work stream yourself."; echo; cat "$AUDIT_DIR/_preamble.md"; echo; cat "$AUDIT_DIR/$domain.md")" </dev/null; then
      echo "==> $domain auditor process failed" >&2
      return 1
    fi
  else
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
  fi
  if [ ! -s "$out" ]; then
    echo "==> $domain produced no fragment — in CI that is an INCONCLUSIVE audit, not a FAIL" >&2
    return 1
  fi
  echo "==> wrote $out"
  # The verdict CI reports, computed from the fragment's lines: zero only on
  # PASS, which also needs its sentinel and a first line of exactly
  # `VERDICT: PASS`. It prints why anything else is not.
  local report status=0
  report=$(node scripts/security-audit-report.mjs check "$out") || status=$?
  printf '%s\n' "$report" >&2
  VERDICTS="$VERDICTS $domain=$(printf '%s\n' "$report" | sed -n '1s/^[^:]*: \([A-Z]*\).*/\1/p')"
  return "$status"
}

# Each domain's computed verdict, `domain=VERDICT`, for the red team's report;
# a domain that left no fragment is INCONCLUSIVE, as CI computes it.
VERDICTS=""
run_domain_recorded() {
  local domain="$1" before="$VERDICTS" status=0
  run_domain "$domain" || status=$?
  [ "$VERDICTS" != "$before" ] || VERDICTS="$VERDICTS $domain=INCONCLUSIVE"
  return "$status"
}

# The command that publishes the red team's report, printed, never run.
print_codex_report() {
  local commit
  commit=$(git rev-parse HEAD 2>/dev/null) || commit="<commit>"
  echo
  echo "==> advisory: a Codex verdict never gates a release (docs/specs/security-audit.md -> \"Red team\")."
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "==> the checkout has uncommitted changes; these results are of that tree, not of $commit." >&2
  fi
  echo "==> to publish them:"
  echo "gh workflow run codex-audit-report.yaml -R $GITHUB_REPOSITORY --ref main -f commit=$commit -f model=$CODEX_MODEL $*"
}

# The open ledger findings every domain re-verifies, as CI's `List open
# findings` step writes them, read on the operator's own login. Without the
# file each domain computes INCONCLUSIVE, as it does in CI. It reads the
# private tracker and files nothing there.
write_open_findings() {
  local open row
  rm -f audit-open-findings.txt
  # `--limit 1000`, not `gh`'s default of 30, which once left an older open
  # finding unreconciled.
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

# The canary, in a copy of the committed tree: seeded, audited by the code
# domains, then scored. `--key` (or `CANARY_KEY`) picks the seeds; the same
# key and pool seed the same way, so a CI canary run's ID over its commit
# seeds what it seeded (`seed --key "$GITHUB_RUN_ID"` in the workflow).
run_canary() {
  local count=8 key="${CANARY_KEY:-}" claude_card="" tree stash domain
  while [ $# -gt 0 ]; do
    case "$1" in
      --key) key="${2:-}"; shift 2 || { echo "error: --key needs a value" >&2; return 64; } ;;
      --claude-scorecard) claude_card="${2:-}"; shift 2 || { echo "error: --claude-scorecard needs a file" >&2; return 64; } ;;
      *[!0-9]*|'') echo "error: unexpected canary argument '$1'" >&2; return 64 ;;
      *) count="$1"; shift ;;
    esac
  done
  if [ -n "$claude_card" ]; then
    [ "$ENGINE" = codex ] || { echo "error: --claude-scorecard is the Codex engine's" >&2; return 64; }
    [ -n "$key" ] || { echo "error: --claude-scorecard needs the --key of the run it scored" >&2; return 64; }
    [ -f "$claude_card" ] || { echo "error: no scorecard at $claude_card" >&2; return 1; }
    claude_card=$(cd "$(dirname "$claude_card")" && pwd)/$(basename "$claude_card")
  fi
  key="${key:-$(date +%s)}"
  tree=$(mktemp -d)
  stash=$(mktemp -d)
  git archive HEAD | tar -x -C "$tree"
  echo "==> canary: seeding $count in $tree"
  (cd "$tree" && node scripts/security-audit-canary.mjs seed --key "$key" --count "$count" --stash "$stash" &&
    pnpm install --frozen-lockfile >/dev/null)
  # Run here rather than through the copy's runner, which would read the real
  # findings ledger: a canary hands its domains an empty list, as CI does.
  (cd "$tree" && : > audit-open-findings.txt &&
    for domain in $(node scripts/security-audit-canary.mjs domains); do run_domain "$domain" || true; done)
  (cd "$tree" && node scripts/security-audit-canary.mjs score --stash "$stash" \
    --scorecard "$stash/scorecard.json" --public "$stash/canary-recall.json" ${claude_card:+--union "$claude_card"})
  echo "==> scorecard: $stash/scorecard.json; seeded tree: $tree"
  [ "$ENGINE" = codex ] || return 0
  case "$key" in
    *[!0-9]*) echo "==> keyed by no CI run, so there is no canary run to publish against." ; return 0 ;;
  esac
  if [ -z "$claude_card" ]; then
    echo "==> to publish, re-run with --claude-scorecard: the scorecard.json in run $key's decrypted canary-transcript."
    return 0
  fi
  # shellcheck disable=SC2046,SC2016
  print_codex_report $(node -e '
    const card = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    console.log(`-f canary_run=${process.argv[2]} -f canary_seeded=${card.seeded} -f canary_caught=${card.caught} -f canary_either=${card.either} -f canary_unfinished=${card.unfinished.length}`);
  ' "$stash/scorecard.json" "$key")
}

if [ $# -gt 0 ]; then
  status=0
  case "$1" in
    canary) shift; run_canary "$@"; exit $? ;;
    github-state) run_github_state; exit $? ;;
    ci-and-secrets|supply-chain) run_github_state || status=1 ;;
  esac
  write_open_findings
  run_domain_recorded "$1" || status=$?
  [ "$ENGINE" = claude ] || print_codex_report "-f verdicts='${VERDICTS# }'"
  exit "$status"
fi

# Every domain, sequentially rather than fanned out. CI parallelises because it is
# paying wall-clock for a nightly; locally, serial output is readable and a
# each domain's failure is recorded while the remaining domains still run.
status=0
run_github_state || status=1
write_open_findings
for domain in supply-chain ci-and-secrets remote local hosted; do
  run_domain_recorded "$domain" || status=1
done

echo
echo "==> fragments:"
ls -la audit-*.md 2>/dev/null || echo "  (none)"
echo "==> each verdict above is the one CI computes; there is no merge here, so read the fragments directly."
[ "$ENGINE" = claude ] || print_codex_report "-f verdicts='${VERDICTS# }'"
exit "$status"
