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

Write your findings to the file named in your own prompt. **Its very first
line must be literally `VERDICT: PASS` or `VERDICT: FAIL`** — nothing else on
that line. The reporting step greps for it, so it is the one part of your
report a machine reads: a `FAIL` there cannot be lost in a merge, and it is
what stops an optimistic summary from overriding you. Then two sections:
`### FAIL IF results` (one line per check) and `### Qualitative findings`
(severity-tagged). **Write that file before you return** — your caller reads
the file, not your reply, and a fragment that does not exist fails the whole
audit. Then return a single line: `PASS` or `FAIL`, followed by a one-sentence
rationale. FAIL if any `FAIL IF` in your scope is violated or any of your
qualitative findings is BLOCKER.

Never print a secret value. `$AUDIT_PAT` is passed only as an unexpanded
`GH_TOKEN=` prefix; do not echo it, do not run `printenv` or `set -x`, and do
not paste the contents of any credential file into your report — report its
mode and location instead. This repository is public and both your report and
the SDK transcript are world-readable.
