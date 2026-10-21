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
# `--key` takes a CI canary run's seed key, its run ID: the canary then seeds
# that run's commit, read on your `gh` login, with the seeds that run dealt.
#
# `--engine codex` runs the same prompts on Codex instead of Claude: the
# second-opinion audit (docs/specs/security-audit.md -> "Second-opinion audit"), never
# the release gate. Its canary takes `--claude-scorecard`, the decrypted
# `scorecard.json` of the CI canary run its `--key` names, to count the seeds
# either engine caught; without it that count is left empty. It ends by
# printing the `gh workflow run codex-audit-report.yaml` command that
# publishes its verdicts and counts; running that is yours to do, since this
# script files nothing.
#
# `AUDIT_OPEN_FINDINGS=<file>` hands every domain the open findings from that
# file, one ledger title per line as CI's `List open findings` writes them,
# copied to `audit-open-findings.txt` in place of listing the ledger with
# `gh`. A Codex run's sandbox reaches this run's `gh` login, so on its machine
# that login must not read the ledger: write the list on another. Under
# `--engine codex` a run that audits a domain refuses to start without it.
#
# The deterministic GitHub-state check (`scripts/github-state-check.mjs`) runs
# first whenever a domain that reads its fragment does — `ci-and-secrets` and
# `supply-chain` — on the same `gh` login, with `--local` so a 403 reads as
# unverifiable rather than as drift in the CI PAT's scope.
#
# Reports land in ./audit-*.md, which .gitignore covers.

set -euo pipefail

# Resolved before the `cd` below, so a relative path is the operator's.
if [ -n "${AUDIT_OPEN_FINDINGS:-}" ]; then
  [ -f "$AUDIT_OPEN_FINDINGS" ] || { echo "error: AUDIT_OPEN_FINDINGS names no file: $AUDIT_OPEN_FINDINGS" >&2; exit 64; }
  AUDIT_OPEN_FINDINGS="$(cd "$(dirname "$AUDIT_OPEN_FINDINGS")" && pwd)/$(basename "$AUDIT_OPEN_FINDINGS")"
fi

cd "$(dirname "$0")/.."
AUDIT_DIR=.github/audit
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-diffplug/dormouse}"
# `_preamble.md`'s delegate wait persists its deadline under `$RUNNER_TEMP`,
# which only Actions sets. No domain reaches that block here — `run_domain`
# denies `Task`/`Agent`, so a local domain cannot delegate, and the
# orchestrator never runs locally — but a fresh directory per run keeps the
# wait bounded if that ever changes, where a repo-root fallback would hand the
# next run an expired deadline. The Codex engine keeps each fragment's copy
# there while a session runs.
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
# The second-opinion audit's model and Cyber access program. Pinned here alone:
# the Codex engine has no CI counterpart to agree with.
CODEX_MODEL=gpt-6-sol
CODEX_PROGRAM=daybreak_blue

# Never the ledger fallback under Codex: its sandbox reaches this login.
if [ "$ENGINE" = codex ] && [ -z "${AUDIT_OPEN_FINDINGS:-}" ]; then
  case "${1:-}" in
    canary|github-state) ;;
    *) echo "error: --engine codex reads the open findings from AUDIT_OPEN_FINDINGS=<file>, written on another login; it never lists them with gh" >&2; exit 64 ;;
  esac
fi

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
    # Codex has no subagents, so this runs the domain as a delegating domain
    # would (`scripts/security-audit-codex.mjs`): one session per work stream,
    # each appending to the fragment opened here, which is closed with the
    # verdict its lines compute only when every session finished and only
    # appended. Sandboxed to the working tree, with the network
    # `ci-and-secrets` needs for live GitHub state; a check the sandbox keeps
    # from the operator's `gh` login comes back UNVERIFIABLE, never PASS.
    local streams stream prompt failed=0
    streams=$(node scripts/security-audit-codex.mjs streams "$domain") || return 1
    rm -f "$out"
    node scripts/security-audit-codex.mjs open "$out"
    for stream in $streams; do
      echo "==> $domain/$stream -> $out (codex: $CODEX_MODEL, $CODEX_PROGRAM)"
      prompt=$(node scripts/security-audit-codex.mjs prompt "$domain" "$stream") || { failed=1; continue; }
      cp "$out" "$RUNNER_TEMP/$out.before"
      if ! codex exec -m "$CODEX_MODEL" --cyber-access-program "$CODEX_PROGRAM" \
        --sandbox workspace-write -c sandbox_workspace_write.network_access=true --ephemeral "$prompt" </dev/null; then
        echo "==> $domain/$stream auditor process failed" >&2
        failed=1
      fi
      node scripts/security-audit-codex.mjs settle "$out" "$RUNNER_TEMP/$out.before" "$stream" || failed=1
    done
    [ "$failed" = 1 ] || node scripts/security-audit-codex.mjs close "$out"
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

# Each domain's computed verdict, `domain=VERDICT`, for the second-opinion report;
# a domain that left no fragment is INCONCLUSIVE, as CI computes it.
VERDICTS=""
run_domain_recorded() {
  local domain="$1" before="$VERDICTS" status=0
  run_domain "$domain" || status=$?
  [ "$VERDICTS" != "$before" ] || VERDICTS="$VERDICTS $domain=INCONCLUSIVE"
  return "$status"
}

# The command that publishes the second-opinion audit's report on the commit it
# audited, printed, never run.
print_codex_report() {
  local commit="$1"
  shift
  echo
  echo "==> second opinion: a Codex verdict never gates a release (docs/specs/security-audit.md -> \"Second-opinion audit\")."
  echo "==> to publish them:"
  echo "gh workflow run codex-audit-report.yaml -R $GITHUB_REPOSITORY --ref main -f commit=$commit -f model=$CODEX_MODEL $*"
}

# The second-opinion audit's report on the domains just run in the working tree.
print_codex_verdicts() {
  local commit
  commit=$(git rev-parse HEAD 2>/dev/null) || commit="<commit>"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "==> the checkout has uncommitted changes; these results are of that tree, not of $commit." >&2
  fi
  print_codex_report "$commit" "-f verdicts='${VERDICTS# }'"
}

# The open ledger findings every domain re-verifies, as CI's `List open
# findings` step writes them, read on the operator's own login, or copied from
# `AUDIT_OPEN_FINDINGS` with the ledger left unread. Without the file each
# domain computes INCONCLUSIVE, as it does in CI. It reads the private tracker
# and files nothing there.
write_open_findings() {
  local open row
  if [ -n "${AUDIT_OPEN_FINDINGS:-}" ]; then
    # Through a temporary name, so a variable naming this very file keeps it.
    cp "$AUDIT_OPEN_FINDINGS" audit-open-findings.txt.new
    mv audit-open-findings.txt.new audit-open-findings.txt
    echo "==> open findings: copied from $AUDIT_OPEN_FINDINGS; the ledger is not read"
    return 0
  fi
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

# The canary, in a copy of a committed tree: seeded, audited by the code
# domains, then scored. `--key` (or `CANARY_KEY`) picks the seeds; the same
# key and pool seed the same way. A `--key` that is a CI canary run's ID
# (`seed --key "$GITHUB_RUN_ID"` in the workflow) seeds that run's commit,
# read from the API, so it seeds what that run seeded whatever is checked out.
run_canary() {
  local count=8 key="${CANARY_KEY:-}" run_key="" commit="HEAD" claude_card="" tree stash domain
  while [ $# -gt 0 ]; do
    case "$1" in
      --key) key="${2:-}"; shift 2 || { echo "error: --key needs a value" >&2; return 64; }
        case "$key" in ''|*[!0-9]*) run_key="" ;; *) run_key="$key" ;; esac ;;
      --claude-scorecard) claude_card="${2:-}"; shift 2 || { echo "error: --claude-scorecard needs a file" >&2; return 64; } ;;
      *[!0-9]*|'') echo "error: unexpected canary argument '$1'" >&2; return 64 ;;
      *) count="$1"; shift ;;
    esac
  done
  if [ -n "$claude_card" ]; then
    [ "$ENGINE" = codex ] || { echo "error: --claude-scorecard is the Codex engine's" >&2; return 64; }
    [ -n "$run_key" ] || { echo "error: --claude-scorecard needs the --key of the run it scored" >&2; return 64; }
    [ -f "$claude_card" ] || { echo "error: no scorecard at $claude_card" >&2; return 1; }
    claude_card=$(cd "$(dirname "$claude_card")" && pwd)/$(basename "$claude_card")
  fi
  key="${key:-$(date +%s)}"
  if [ -n "$run_key" ]; then
    commit=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_key" --jq .head_sha) && [ -n "$commit" ] ||
      { echo "error: could not read run $run_key's commit, which its seeds were dealt over" >&2; return 1; }
    git cat-file -e "$commit^{commit}" 2>/dev/null ||
      { echo "error: run $run_key audited $commit, which this clone does not have; fetch it first" >&2; return 1; }
  fi
  tree=$(mktemp -d)
  stash=$(mktemp -d)
  git archive "$commit" | tar -x -C "$tree"
  echo "==> canary: seeding $count in $tree ($commit)"
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
  if [ -z "$run_key" ]; then
    echo "==> keyed by no CI run, so there is no canary run to publish against."
    return 0
  fi
  # Without Claude's scorecard the "caught by either" count is left empty,
  # which the published recall reads as not computed for that run.
  if [ -z "$claude_card" ]; then
    echo "==> no --claude-scorecard (the scorecard.json in run $run_key's decrypted canary-transcript): \"caught by either\" is left empty."
  fi
  # shellcheck disable=SC2046,SC2016
  print_codex_report "$commit" $(node -e '
    const card = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const either = "either" in card ? ` -f canary_either=${card.either}` : "";
    console.log(`-f canary_run=${process.argv[2]} -f canary_seeded=${card.seeded} -f canary_caught=${card.caught}${either} -f canary_unfinished=${card.unfinished.length}`);
  ' "$stash/scorecard.json" "$run_key")
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
  [ "$ENGINE" = claude ] || print_codex_verdicts
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
[ "$ENGINE" = claude ] || print_codex_verdicts
exit "$status"
