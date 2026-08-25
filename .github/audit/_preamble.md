# Shared preamble — every audit subagent

Read `SECURITY.md` first. Your scope is exactly the sections named in your own
file — ignore every other section, including its `FAIL IF` lines; another agent
owns them.

For each `FAIL IF` in your scope, run the mechanical check (`gh api`, grep,
file read, or a script) and record PASS or FAIL with concrete evidence: file
path and line number, API response excerpt, or command output. A `FAIL IF`
bullet may assert several properties in one sentence; **each clause gets its
own verdict and its own evidence**. Never satisfy a bullet in bulk.

Then do the qualitative pass described for your domain, rating findings
BLOCKER / WARNING / INFO. Report what you can prove. Use `UNVERIFIABLE` only
for a check you could not determine — a transient network error, or an area you
ran out of room to reach — and say which it was. It is never a substitute for a
check you could have run.

Write your findings to the file named in your own prompt, with two sections:
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
