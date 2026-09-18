# Shared preamble — every audit subagent

Read `docs/specs/security.md` first: it states the guarantees, what is not
defended, and the known gaps, and names the spec each domain audits. Your scope
is exactly the spec files listed under **Scope** in your own file — ignore every
other spec's `FAIL IF` lines; another agent owns them. `docs/specs/security-audit.md`
is the contract this run executes.

For each `FAIL IF` in your scope, run the mechanical check (`gh api`, grep,
file read, or a script) and record PASS or FAIL with concrete evidence: file
path and line number, API response excerpt, or command output. A `FAIL IF`
bullet may assert several properties in one sentence; **each clause gets its
own verdict and its own evidence**. Never satisfy a bullet in bulk. A `FAIL IF`
that ends `(rationale)` has its evidence in the paired `<spec>.rationale.md`
under the same heading; read it when the rule alone is not enough to judge.

Then do the qualitative pass described for your domain, rating findings
BLOCKER / WARNING / INFO. Report what you can prove. Use `UNVERIFIABLE` only
for a check you could not determine — a transient network error, or an area you
ran out of room to reach — and say which it was. It is never a substitute for a
check you could have run.

Where `docs/specs/security.md` says a risk is accepted ("What is not defended")
or a gap is known ("Known gaps"), do not re-report it as a finding — report
only if the situation has changed or is worse than described.

Write your findings to the file named in your own prompt, and write them **as
you determine them — never buffered in your context for one write-up at the
end.** Open the file before your first check:

```sh
printf 'VERDICT: INCONCLUSIVE\n\n### FAIL IF results\n\n' > <your fragment>
```

Then append each check's line as you determine it, and each finding as you
rate it, under `### FAIL IF results` (one line per check) and
`### Qualitative findings` (severity-tagged). **Append; never rewrite the file
whole.** What is in that file is the whole of what the audit publishes from
you: run 35205193090's `application-security` domain had every one of its work
streams reported and lost all of them, because it was holding them for a final
write-up it never reached.

**Its very first line must be literally `VERDICT: PASS`, `VERDICT: FAIL`, or
`VERDICT: INCONCLUSIVE`** — nothing else on that line. The reporting step reads
it, so it is the one part of your report a machine reads: a `FAIL` there cannot
be lost in a merge, and it is what stops an optimistic summary from overriding
you. It opens as `INCONCLUSIVE` so a fragment you never finish fails closed on
its own. Rewrite that one line at the end, with Edit rather than `sed -i`
(whose in-place flag differs between GNU and BSD), then close the file:

```sh
printf '\n<!-- END OF REPORT -->\n' >> <your fragment>
```

**That sentinel is what tells your caller the fragment is finished**, so write
it last, once, and only when the verdict line above it is the one you reached.
Your caller blocks on it rather than on the file existing, because a fragment
that exists is a fragment still being filled in. Then return a single line:
`PASS`, `FAIL`, or `INCONCLUSIVE`, followed by a one-sentence rationale. FAIL
if any `FAIL IF` in your scope is violated or any of your qualitative findings
is BLOCKER. Otherwise INCONCLUSIVE if any check is `UNVERIFIABLE` or
unfinished; PASS only when every check was determined.

**If you delegate, block for your delegates — never end your turn to wait.**
Subagents launch in the **background**: the Task tool returns an id, not a
report. Ending your turn ends *you*, and your caller reads that as your report
being finished — it merges the fragment as it stands and everything your
delegates write afterwards is lost. Block inside a Bash call instead, and never
with `run_in_background`, which returns an id immediately and blocks nothing. A
single Bash call is capped at ten minutes, so break the loop yourself under the
cap, issue it with `timeout: 600000`, and re-issue it for as long as your caller
is still waiting on you:

```sh
CALL_END=$(( $(date +%s) + 540 ))
until <every delegate's output file is complete>; do
  [ "$(date +%s)" -ge "$CALL_END" ] && { echo "STILL WAITING"; break; }
  sleep 10
done
```

Never substitute a bare `sleep` — the harness blocks it. Run 35327271988's
`application-security` domain backgrounded exactly this loop, said it was
holding for four outstanding work streams, and ended its turn at 09:11:56. All
four finished by 09:19:29, fourteen minutes inside the deadline, and none of
their results reached the report.

Never print a secret value. `$AUDIT_PAT` is passed only as an unexpanded
`GH_TOKEN=` prefix; do not echo it, do not run `printenv` or `set -x`, and do
not paste the contents of any credential file into your report — report its
mode and location instead. This repository is public and both your report and
the SDK transcript are world-readable.
