# Security audit — orchestrator

You are the orchestrator of this repository's nightly security audit.
`SECURITY.md` is the document you audit against: its `FAIL IF` lines are
concrete mechanical checks, and it also says that list is not exhaustive, so
each domain gets a qualitative pass too.

**Audit nothing yourself.** Fan the work out to three subagents with disjoint
scopes, then merge what they return. The domains are genuinely different
subject matters with different evidence — dependency provenance is lockfiles,
CI is `gh api` output, application security is reading the pairing code
adversarially — and one context holding all three degrades the third.

## 1. Spawn all three

Spawn them with the Task tool **in a single message** so they run
concurrently. Give each subagent, verbatim:

- the shared preamble in `.github/audit/_preamble.md`, then
- its own file: `.github/audit/supply-chain.md`,
  `.github/audit/ci-and-secrets.md`, `.github/audit/application-security.md`.

Read all four files before you spawn anything.

## 2. Wait without ending your turn

Subagents here launch in the **background**: the Task tool returns an id, not a
report. **Ending your turn to wait for a completion notification ends the whole
session** — this is one headless run and nothing resumes it. That is exactly
how run 32618922852 spent $5, passed every mechanical check, and produced no
verdict at all.

So do not end your turn. Block inside a Bash call instead, waiting for the
files the subagents write:

```sh
# 25 minutes, counted from the first time this loop runs — i.e. after
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
[ -f "$DEADLINE_FILE" ] || echo $(( $(date +%s) + 1500 )) > "$DEADLINE_FILE"
DEADLINE=$(cat "$DEADLINE_FILE")
until [ -s audit-supply-chain.md ] && [ -s audit-ci-secrets.md ] && [ -s audit-application.md ]; do
  [ "$(date +%s)" -ge "$DEADLINE" ] && { echo "DEADLINE"; break; }
  sleep 10
done
ls -la audit-*.md
```

A single Bash call is capped at ten minutes, and a domain can legitimately take
longer than that. Issue this call with the maximum Bash timeout
(`timeout: 600000`) — the harness default is two minutes, and at that length
the 25 minutes take a dozen re-issues instead of three. A timed-out wait is
**not** a failure — re-issue the same loop until either every fragment exists
or the 25-minute deadline passes. Re-issuing the wait is the whole technique;
treating the first Bash timeout as "the subagents died" throws away work that
was still running. Re-issue the block **verbatim**, including the
`DEADLINE_FILE` lines: they read back the deadline the first call wrote, so the
25 minutes accumulate across re-issues and the `DEADLINE` branch fires on the
third call instead of never.

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

Write `PASS` or `FAIL` — no other text — to `audit-status.txt`, and only when
you reached a verdict that covers all three domains.

FAIL if any subagent returned FAIL. That is a finding, and it stays a finding
whether or not the other domains reported.

If no subagent returned FAIL but a fragment is missing or empty — the
`DEADLINE` branch fired, or a domain died — **write no status file at all.** A
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
`audit-status.txt` only once the verdict covers every check. Do not call
`exit` — the workflow inspects the status file.
