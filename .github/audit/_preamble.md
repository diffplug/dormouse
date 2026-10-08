# Shared preamble — every audit subagent

Read `docs/specs/security.md` first: it states the guarantees, what is not defended, and the known gaps, and names the spec each domain audits. Your scope is exactly the spec files listed under **Scope** in your own file — ignore every other spec's `FAIL IF` lines; another agent owns them. `docs/specs/security-audit.md` is the contract this run executes.

For each `FAIL IF` in your scope, run the mechanical check (`gh api`, grep, file read, or a script) and record PASS or FAIL with concrete evidence: file path and line number, API response excerpt, or command output. A `FAIL IF` bullet may assert several properties in one sentence; **each clause gets its own verdict and its own evidence**. Never satisfy a bullet in bulk. A `FAIL IF` that ends `(rationale)` has its evidence in the paired `<spec>.rationale.md` under the same heading; read it when the rule alone is not enough to judge.

Report what you can prove. Use `UNVERIFIABLE` only for a check you could not determine — a transient network error, or an area you ran out of room to reach — and say which it was. It is never a substitute for a check you could have run.

A condition no audit run can read — a provisioning step, a setting in an external service's console — is not a check, so the each-clause rule above does not reach it. Record it as INFO, never as `UNVERIFIABLE`: nothing a later run can read would settle it, so every later run would be inconclusive too.

- Written into a `FAIL IF`: verdict only that rule's readable condition.
- Stated beside a rule, or staged under `## Future`: there is no rule to verdict.
- Promoted above the fold: audit it as the promoted rule is written — a readable condition as a `FAIL IF`, an unreadable one by the bullets above.

GitHub state `AUDIT_PAT` reaches — rulesets, environments, secret placement, workflow permissions — is readable, so it is always a check, and `UNVERIFIABLE` stays right for a call that fails.

Where `docs/specs/security.md` says a risk is accepted ("What is not defended") or a gap is known ("Known gaps"), do not re-report it as a finding — report only if the situation has changed or is worse than described.

Write your findings to the file named in your own prompt, and write them **as you determine them — never buffered in your context for one write-up at the end.** Open the file before your first check:

```sh
printf 'VERDICT: INCONCLUSIVE\n\n' > <your fragment>
```

**The reporting step computes your verdict from your lines, not from what you conclude.** It reads only the line shapes below, wherever they sit in the file; a line that starts like one of them (`PASS`, `FAIL`, `UNVERIFIABLE`, `BLOCKER`, `WARNING`, `INFO`, `QUALITATIVE`, bold or not) but is not written exactly to its grammar is malformed, and one malformed line makes your domain INCONCLUSIVE. Prose that starts any other way is kept in the encrypted transcript and read by no machine.

### Result lines

Print the rules you owe before your first check:

```sh
node scripts/security-audit-report.mjs manifest <your fragment>
```

It prints one template line per `FAIL IF` in your scope, numbered by its position under its heading (`#1`, `#2`, …), from the specs as checked out. **Every rule it prints gets at least one result line**; a rule with none counts as undetermined, so skipping a section is never silent. Copy the spec, heading, and number from that output verbatim:

```
- FAIL: `docs/specs/security-ci.md` -> "GitHub Actions Policies" #2.b — <clause>: <evidence>
```

- The status is `PASS`, `FAIL`, or `UNVERIFIABLE`, then a colon; the separator before the clause is ` — ` (an em dash between spaces).
- **A rule asserting several properties gets one line per clause**, lettered `.a`, `.b`, … in the order the rule states them, with no letter skipped; a single-clause rule is the bare number. A lettered gap counts as an undetermined clause.
- A line naming a rule your manifest does not print is malformed.

### Severity

Then do the qualitative pass described for your domain. Rate each finding by this rubric, against the attacker `docs/specs/security.md` and the spec you are in describe:

| Severity | When |
|---|---|
| `BLOCKER` | Attacker-controlled input reaches code execution, a credential, or an authorization grant, with no entry under "What is not defended" or "Known gaps". A command injection from a file name is a BLOCKER. |
| `WARNING` | The same reach, but only after a precondition you state; or a missing defense in depth. |
| `INFO` | Hardening, spec drift, an unreadable condition, or anything you could not confirm. |

**A BLOCKER fails the audit like a failed `FAIL IF`.** Rate by impact, not by how mechanical the finding was: a loose file mode is not a BLOCKER beside a command injection rated WARNING.

**Every BLOCKER and WARNING carries its evidence or is capped at INFO**, marked `(unconfirmed)`:

- `Code:` the vulnerable line or lines, quoted from the file.
- `Path:` the source → sink path, file and line at each hop. A claim that something is "not validated" or "not checked" names the sink and shows that no control sits between source and sink — read the sink as well as the reader before you claim it.
- `Reproduction:` a concrete input and the effect it has.

### Findings

```
- WARNING: `deploy/local/install-windows.ps1:88` `Install-Service` — <one-line summary>
  - Code: `<quoted line>`
  - Path: <source> → <sink>
  - Reproduction: <input> → <effect>
```

The location is the sink's `path:line` (for spec drift or a condition no code holds, the spec line that states it); the second backticked field is its root cause, the function or rule it lives in. Indented lines below the header belong to the finding, so append the header and its evidence in one write. The reporting step merges findings naming the same file and root cause within five lines, so name the root cause the same way each time and report each finding once. An `INFO` needs no evidence lines.

When your qualitative pass has finished, append exactly one line saying so:

```
- QUALITATIVE: done — <the areas it covered>
```

A fragment with no such line, or with two, is INCONCLUSIVE: the pass is part of the audit, not an extra.

### Closing the fragment

The public issue names a failed check only by its spec and heading, and only when the heading exists in the spec, and counts findings by their tags; everything else you write is filed privately until fixed. **Append; never rewrite the file whole.** What is in that file is the whole of what the audit publishes from you: run 35205193090's `application-security` domain had every one of its work streams reported and lost all of them, because it was holding them for a final write-up it never reached.

**Its very first line must be literally `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: INCONCLUSIVE`** — nothing else on that line. It opens as `INCONCLUSIVE` so a fragment you never finish fails closed on its own. The reporting step compares it with the verdict your lines compute and reports any disagreement: FAIL if any result is `FAIL` or any finding is `BLOCKER`; otherwise INCONCLUSIVE if any result is `UNVERIFIABLE`, a rule has no result line, a line is malformed, or the qualitative line is missing; PASS only when every rule was determined. Rewrite that one line at the end, with Edit rather than `sed -i` (whose in-place flag differs between GNU and BSD), then close the file:

```sh
printf '\n<!-- END OF REPORT -->\n' >> <your fragment>
```

**That sentinel is what tells your caller the fragment is finished**, so write it last, once, and only when the verdict line above it is the one you reached. Your caller blocks on it rather than on the file existing, because a fragment that exists is a fragment still being filled in. Then return a single line: `PASS`, `FAIL`, or `INCONCLUSIVE`, followed by a one-sentence rationale.

### Work streams

**Delegate only by the `## Work streams` your domain file names, never by a partition of your own**: one delegate per stream, holding that stream's rules and nothing else. A rule stream runs no qualitative pass; the `qualitative` stream is the domain's one pass, run by you or by one delegate. A delegate appends its lines straight to your fragment, one `printf … >>` per result line and one per finding, its evidence lines in the same call so another stream's line cannot land inside it, and writes no verdict line and no sentinel; when it finishes it touches `$RUNNER_TEMP/<your fragment>.<stream>.done`, and that file is what your wait loop below tests.

**If you delegate, block for your delegates — never end your turn to wait.** Subagents launch in the **background**: the Task tool returns an id, not a report. Ending your turn ends *you*, and your caller reads that as your report being finished — it merges the fragment as it stands and everything your delegates write afterwards is lost. Block inside a Bash call instead, and never with `run_in_background`, which returns an id immediately and blocks nothing. A single Bash call is capped at ten minutes, so break the loop yourself under the cap, issue it with `timeout: 600000`, and re-issue it under a bound of your own:

```sh
# Persisted, because you re-issue this block in a fresh shell each time — and
# named after your own fragment, because every domain shares one $RUNNER_TEMP.
DEADLINE_FILE="$RUNNER_TEMP/delegate-deadline-<your fragment>"
if [ ! -f "$DEADLINE_FILE" ]; then
  # Your caller's own deadline, less three minutes to close your fragment. It
  # writes that file before it starts waiting; the 25 minutes here is only the
  # fallback for the case where it has not.
  CALLER=$(cat "$RUNNER_TEMP/audit-deadline" 2>/dev/null || true)
  [ -n "$CALLER" ] || CALLER=$(( $(date +%s) + 1680 ))
  echo $(( CALLER - 180 )) > "$DEADLINE_FILE"
fi
DEADLINE=$(cat "$DEADLINE_FILE")
CALL_END=$(( $(date +%s) + 540 ))
ANSWER="ALL FINISHED"
until <every delegated stream's .done file exists>; do
  NOW=$(date +%s)
  [ "$NOW" -ge "$DEADLINE" ] && { ANSWER="DEADLINE"; break; }
  [ "$NOW" -ge "$CALL_END" ] && { ANSWER="STILL WAITING"; break; }
  sleep 10
done
echo "$ANSWER"
```

**The call's last line is its answer.** Re-issue the block verbatim on `STILL WAITING`; on `DEADLINE` or `ALL FINISHED` stop waiting and write up what you have. Your deadline is your caller's own, three minutes early, so you still have room to rewrite your verdict line and close the fragment; the 25 minutes is only the fallback for a caller that has not started waiting yet. An empty answer means the call was moved to the background, so re-issue it rather than waiting on that task.

Never substitute a bare `sleep` — the harness blocks it; the `until` loop above is the sanctioned form. Run 35327271988's `application-security` domain backgrounded its own wait loop, said it was holding for four outstanding work streams, and ended its turn at 09:11:56. All four finished by 09:19:29, fourteen minutes inside the deadline, and none of their results reached the report.

Never print a secret value. `$AUDIT_PAT` is passed only as an unexpanded `GH_TOKEN=` prefix; do not echo it, do not run `printenv` or `set -x`, and do not paste the contents of any credential file into your report — report its mode and location instead. Your report is filed in a private tracker and the SDK transcript is archived encrypted, but a secret in either is still a leaked secret.

Never create, edit, or comment on an issue or pull request, in any repository. The workflow files your report, privately, after you finish; anything you post yourself lands in public.
