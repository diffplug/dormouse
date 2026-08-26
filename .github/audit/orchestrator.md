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
# arrive. The audit job in `.github/workflows/security-audit.yaml`
# declares `timeout-minutes: 40` to stay clear of it; raising this
# deadline without raising that one puts the runner's cancellation first
# again, and this graceful path stops being reachable at all.
DEADLINE_FILE="${RUNNER_TEMP:-.}/audit-deadline"
[ -f "$DEADLINE_FILE" ] || echo $(( $(date +%s) + 1500 )) > "$DEADLINE_FILE"
DEADLINE=$(cat "$DEADLINE_FILE")
until [ -s audit-supply-chain.md ] && [ -s audit-ci-secrets.md ] && [ -s audit-application.md ]; do
  [ "$(date +%s)" -ge "$DEADLINE" ] && { echo "DEADLINE"; break; }
  sleep 10
done
ls -la audit-*.md
```

A single Bash call is capped at ten minutes, and a domain can legitimately take
longer than that. A timed-out wait is **not** a failure — re-issue the same
loop until either every fragment exists or the 25-minute deadline passes.
Re-issuing the wait is the whole technique; treating the first Bash timeout as
"the subagents died" throws away work that was still running. Re-issue the
block **verbatim**, including the `DEADLINE_FILE` lines: they read back the
deadline the first call wrote, so the 25 minutes accumulate across re-issues
and the `DEADLINE` branch fires on the third one instead of never.

Never poll by ending your turn, and never substitute a bare `sleep` — the
harness blocks it. The `until` loop above is the sanctioned form.

## 3. Merge

Assemble the report with Bash rather than by retyping the fragments:

```sh
{ echo "# Security audit"; echo
  echo "## Supply chain"; echo; cat audit-supply-chain.md 2>/dev/null || echo "_No report — this domain produced no fragment._"; echo
  echo "## CI and secrets"; echo; cat audit-ci-secrets.md 2>/dev/null || echo "_No report — this domain produced no fragment._"; echo
  echo "## Application security"; echo; cat audit-application.md 2>/dev/null || echo "_No report — this domain produced no fragment._"
} > audit-report.md
```

Then append a `## Summary` section: overall PASS or FAIL, a one-paragraph
rationale, and one line per domain giving that domain's verdict.

## 4. The verdict

Write `PASS` or `FAIL` — no other text — to `audit-status.txt`.

FAIL if any subagent returned FAIL, **or** if any of the three fragments is
missing or empty. A domain that produced no report did not pass; it did not
finish. The reporting step checks this independently, so a `PASS` written over
a missing fragment is caught and downgraded — but do not make it do that work.

**Write `audit-report.md` before `audit-status.txt`**, always, even if you are
running short: a partial report reaches a human through the INCONCLUSIVE issue,
while a status file with no report behind it reaches nobody. Write
`audit-status.txt` only once the verdict covers every check. Do not call
`exit` — the workflow inspects the status file.
