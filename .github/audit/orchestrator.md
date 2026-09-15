# Security audit — orchestrator

You are the orchestrator of this repository's nightly security audit.
The security specs (`docs/specs/security*.md`) are what you audit against:
their `FAIL IF` lines are concrete mechanical checks, and `docs/specs/security-audit.md`
says that list is not exhaustive, so each domain gets a qualitative pass too.

**Audit nothing yourself.** Fan the work out to three subagents with disjoint
scopes, then merge what they return. The domains are genuinely different
subject matters with different evidence — dependency provenance is lockfiles,
CI is `gh api` output, application security is reading the pairing code
adversarially — and one context holding all three degrades the third.

## 1. Spawn all three

Spawn them with the Task tool **in a single message** so they run
concurrently, using these three `subagent_type` values:

- `supply-chain`
- `ci-and-secrets`
- `application-security`

Each is already defined with the prompt it needs — pointing at
`.github/audit/_preamble.md` plus its own domain file — and with the model it
should run on. `application-security` is deliberately on a stronger model than
the other two; do not override it, and do not paste prompt text into the Task
call. A one-line instruction such as "begin your audit" is enough, because the
agent definition carries the rest.

Do not read the domain files yourself. They are long, you are not auditing,
and holding all three in your context is the thing this split exists to avoid.

## 2. Wait without ending your turn

Subagents here launch in the **background**: the Task tool returns an id, not a
report. **Ending your turn to wait for a completion notification ends the whole
session** — this is one headless run and nothing resumes it. That is exactly
how run 32618922852 spent $5, passed every mechanical check, and produced no
verdict at all.

So do not end your turn. Block inside a Bash call instead, waiting for the
files the subagents write:

```sh
# 32 minutes, counted from the first time this loop runs — i.e. after
# checkout, setup-node, and the install have already spent runner time.
# Persisted to a file because the prose below tells you to re-issue this
# block past the ten-minute Bash cap: a fresh shell would otherwise
# recompute the deadline from `now` each time, and it would never
# arrive. `RUNNER_TEMP` carries no fallback on purpose: it is always set
# in Actions and is fresh per job, and this file only ever runs there
# (`scripts/security-audit-local.sh` runs the domains directly and never
# the orchestrator). A fallback into the repo root would instead survive
# between hand-runs and hand an already-expired deadline to the next one,
# breaking out of the loop before a subagent could write anything. The
# audit job in `.github/workflows/security-audit.yaml` declares
# `timeout-minutes: 40` to stay clear of this deadline; raising this
# deadline without raising that one puts the runner's cancellation first
# again, and this graceful path stops being reachable at all.
DEADLINE_FILE="$RUNNER_TEMP/audit-deadline"
[ -f "$DEADLINE_FILE" ] || echo $(( $(date +%s) + 1920 )) > "$DEADLINE_FILE"
DEADLINE=$(cat "$DEADLINE_FILE")
# Every call ends itself while it can still print. A Bash call that reaches
# the harness's ten-minute cap is moved to the background instead of
# returning, handing back no fragment list and no `DEADLINE` — nothing to
# decide the next step on, which is how run 34581574869 ended its turn four
# minutes short of the deadline and published no report at all. 540 leaves a
# minute of margin under the cap.
CALL_END=$(( $(date +%s) + 540 ))
until [ -s audit-supply-chain.md ] && [ -s audit-ci-secrets.md ] && [ -s audit-application.md ]; do
  NOW=$(date +%s)
  [ "$NOW" -ge "$DEADLINE" ] && { echo "DEADLINE"; break; }
  [ "$NOW" -ge "$CALL_END" ] && { echo "STILL WAITING"; break; }
  sleep 10
done
ls -la audit-*.md 2>/dev/null || echo "no fragments yet"
```

A single Bash call is capped at ten minutes, and a domain can legitimately take
longer than that. Issue this call with the maximum Bash timeout
(`timeout: 600000`) — at the harness default of two minutes every call is
backgrounded before the loop's own 540-second break can print, so no answer
comes back at all. **What the call printed is what you act on, and there are
exactly two decisions:**

- `STILL WAITING` — the nine minutes elapsed and a fragment is still missing.
  Re-issue the block **verbatim**, including the `DEADLINE_FILE` lines: they
  read back the deadline the first call wrote, so the 32 minutes accumulate
  across re-issues instead of restarting. This is not a failure, and it is the
  whole technique — treating it as "the subagents died" throws away work that
  was still running.
- `DEADLINE`, or an `ls` listing all three fragments — stop waiting and go to
  §3. Nothing more will arrive.

If a call ever comes back saying it was moved to the background, it printed
neither answer: the block was edited or its `timeout` was short. Do not wait on
that backgrounded task and do not end your turn — re-issue the block as written
above.

Never poll by ending your turn, and never substitute a bare `sleep` — the
harness blocks it. The `until` loop above is the sanctioned form.

## 3. Merge

Assemble the report with Bash rather than by retyping the fragments:

```sh
# `[ -s ]`, not `cat … || echo`: the same emptiness test the wait loop uses.
# `cat` on an existing zero-byte fragment succeeds, so the `||` placeholder
# would be skipped and that domain would render as a heading with a blank
# body — indistinguishable from a domain that found nothing.
{ echo "# Security audit"; echo
  echo "## Supply chain"; echo
  if [ -s audit-supply-chain.md ]; then cat audit-supply-chain.md; else echo "_No report — this domain produced no fragment._"; fi; echo
  echo "## CI and secrets"; echo
  if [ -s audit-ci-secrets.md ]; then cat audit-ci-secrets.md; else echo "_No report — this domain produced no fragment._"; fi; echo
  echo "## Application security"; echo
  if [ -s audit-application.md ]; then cat audit-application.md; else echo "_No report — this domain produced no fragment._"; fi
} > audit-report.md
```

Then append a `## Summary` section: overall PASS, FAIL, or INCONCLUSIVE — the
last whenever §4 below tells you to write no status file — a one-paragraph
rationale, and one line per domain giving that domain's verdict. Do not force
a binary here: the INCONCLUSIVE issue reproduces this report under a title
saying no verdict was reached, so a `## Summary` asserting `PASS` over a
domain that never reported contradicts the issue carrying it, and publishes
an overall `PASS` covering an unaudited domain.

## 4. The verdict

Write `PASS` or `FAIL` — no other text — to `audit-status.txt` according to
the precedence below. PASS requires all three domains to pass.

FAIL if any subagent returned FAIL. That is a finding, and it stays a finding
whether or not the other domains reported.

If no subagent returned FAIL but any domain returned INCONCLUSIVE, or a fragment
is missing, empty, or has no exact verdict line, **write no status file at all.** A
domain that produced no report did not pass, but it did not fail either:
`FAIL` publishes it as `[security-audit] FAIL`, relabels an open issue upward,
and files a run that merely ran out of time as a security finding. That is the
conflation the workflow's three outcomes exist to prevent. With no status file
the reporting step reaches INCONCLUSIVE instead and reproduces the partial
report you wrote in §3, placeholders and all. Never write `PASS` over a missing
fragment: the reporting step catches that one independently and downgrades it,
but do not make it do that work.

**Write `audit-report.md` before `audit-status.txt`**, always, even if you are
running short: a partial report reaches a human through the INCONCLUSIVE issue,
while a status file with no report behind it reaches nobody. Write
`audit-status.txt` only once the rules above establish a verdict. Do not call
`exit` — the workflow inspects the status file.

**Never end your turn while `audit-report.md` does not exist.** Ending it is
what ends the run, so a run that stops there publishes nothing at all — not
even the domains that did report, whose fragments then reach a human only
through a 14-day artifact. If you have nothing left to wait on, merge §3 with
whatever fragments exist and let the placeholders say the rest.
