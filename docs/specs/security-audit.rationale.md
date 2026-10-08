# Security Audit — rationale

## Schedule and gate

The three release-gate pieces are named separately because they break independently: dropping `--exit-status` alone un-gates the release while leaving a green grep for "invoked".

## Deterministic checks

**Why GitHub state left the model (review of 160 runs, 2026-10).** About 60% of the roughly 223 `FAIL IF` bullets then in the corpus asked mechanical questions — GitHub API state, workflow-file properties, configuration values — and a model re-read them nightly. They flip-flopped on unchanged state: the `tend-mention` permission check read PASS on 2026-08-21 and FAIL on 2026-08-22 with nothing changed. On 2026-09-15 `ci-and-secrets` enumerated four of the seven environments, passed, and the PASS closed an open failure issue. A script that enumerates from the API and fails a planted violation of every clause it judges cannot do either. The model keeps the judgement bullets, where a reading of code or of a spec is the check.

**Why the expected values live in a file.** The script needs the spec's values as data; `.github/audit/` sits in `.github/workflows/workflow-audit.yaml`'s window, so an edit to them is surfaced like an edit to a prompt, and `ci-and-secrets` reads the file against its spec on every full run.

## Skipping an unchanged audit

**Why a skip is safe.** A model pass over the same commit and the same GitHub state reads the same inputs; repeating it nightly bought variance, not coverage, at about $28 a run (2026-10). The deterministic checks still run every night, so live drift in a setting is caught whether or not the domains run. **Why seven days.** The domains also read what neither input records — a mutable upstream tag's content, npm attestations, models improving — so a skip never outlives a week. The tend tag's commit is hashed, so moving it forces a full run. **Why a dispatch never skips.** The release gate dispatches one and must audit the tag it ships, and a maintainer dispatching by hand wants a full run.

## Domains

One context holding every subject matter degrades application security — the domain with the most code behind it, and the easiest to crowd out with API responses.

Hosted accounts were split out of `application-security` on 2026-09-21. That domain already carried remote control (where the depth goes), the local boundaries, Hosted, and the catch-all sweep, and it had overrun the 32-minute deadline more than once, so a remote-control pass that ran out of time took the Hosted results down with it. Hosted is a disjoint tree — `hosted/`, its installed pgstencil dependencies, and the two `hosted-*.yml` workflows it reads for the Deployment boundary — with its own spec, so it splits cleanly and now writes its own fragment. It also gives the pgstencil provenance checks a prompt that is about them rather than a paragraph inside one about pairing code. It runs on Opus for the same reason `application-security` does: the Worker's origin gate and the deployment path are read, not enumerated.

Folding the application-security scope back into a shared context is how that spec stops being audited without anyone deciding to stop auditing it.

The model split is where the findings that needed real reasoning came from: tracing a relay-minted `clientId` to a keystroke-injection path, and working out that an eight-character device fingerprint carried ~40 bits rather than ~48 because a P-256 point's leading byte is constant. The other two domains run a generator, read an API response, and compare a pin.

Both sides of the model split are pinned. An unpinned mechanical domain inherits the operator or action default, which may be Opus and invert the intended relation. An explicit Sonnet baseline keeps the local and CI runs aligned.

A local runner with its own copy of the prompts drifts, invisibly, until a nightly disagrees with a local pass.

Ownership used to be by `## ` section of a single `SECURITY.md`, checked by a grep over the prompt files. That worked only because the headings sat in markdown: inline in the workflow, YAML block-scalar wrapping split `## Automated Maintainer (tend)` across two lines and the check matched nothing. Ownership is now by file, checked by `scripts/spec-lint.mjs`. A spec owned by none is unaudited; one owned by two produces contradictory verdicts.

The per-domain scopes replaced a single roving "flag any other security hole you find", so anything no domain names is nobody's job. The first version silently orphaned `canopy/`, `.claude/` (itself named as a prompt-injection surface), `docs/`, the root files, and all of `website/` outside `src/data/` — which includes the Tauri updater manifest that shipped apps fetch. Naming `website/src/` and `website/scripts/` left `website/`'s build config owned by nobody, the same shape one level down; hence the subtraction, and hence `website/scripts/generate-deps.js` called out, so the generator behind the disclosed snapshot is audited and not just its `productDependencyFilters` array.

`website/public/` sits with `ci-and-secrets` because the updater manifest is a release artifact rather than marketing, and `.vscode/` because `.vscode/tasks.json` can carry `"runOn": "folderOpen"`, which executes on checkout. No such task exists today; adding one should be a finding.

Dotfile directories are named explicitly because a catch-all has twice been read as not covering them: `.vscode/` and `.impeccable/` (the design-token snapshot behind `DESIGN.md`) came to be owned by nobody after the first split named paths explicitly. An enumeration goes stale the moment a path is added, so the remainder clause is recursive.

On the `workflow-audit.yaml` diff window: widening one consumer without the others is worse than not widening at all — `git log` matches the commit, `own_changes` returns nothing, the empty-list `continue` swallows it, and the bullet claims a coverage that does not exist. The prompts decide what gets audited and by whom, and `.vscode/tasks.json` can execute on folder open; both are changes to the security automation, which is also why `.config/tend.yaml` is in that window. The security specs are left out on purpose: that job catches code executing from a branch nobody reviewed, and a `FAIL IF` is inert until merged to `main`, which is admin-gated — the watch would add no coverage over PR review while reporting a commit on nearly every security PR.

## Orchestration

Run 32618922852 passed all 21 mechanical checks, handed the qualitative pass to two background subagents, then ended its turn to "wait for the completion notification" — which in a headless SDK run terminates everything, discarding the subagents and leaving both output files unwritten. A clean audit blocked the release gate for $5 and no verdict. Runs 31927560706 and 32100728239 are the same shape: SDK success reported, `Write` never called.

The fix is not to stop delegating. `--allowed-tools` only auto-approves and removes nothing, which is why the tools were available in the first place; no allowlist stops an agent ending its turn.

The deadline is persisted because one longer than the ten-minute Bash cap cannot fire inside a single call: a re-issued loop that recomputes it from `now` never reaches it, so the bound is written down but never binds, and only the runner's cancellation ends the wait. `RUNNER_TEMP` carries no fallback on purpose — a repo-root fallback would survive between hand-runs and hand an already-expired deadline to the next one.

A call that reaches the cap is *moved to the background*, not returned: it prints nothing back, so re-issuing becomes a judgement call rather than a step. Run 34457954349 happened to re-issue a third time and its deadline fell inside that call, so it merged and published two PASS domains; run 34581574869 spent one extra call checking the fragments, which shifted the phase enough that a third wait would have been needed, ended its turn instead, and published no report at all — the same two domains' PASS fragments survived only in the artifact. A loop that ends itself under the cap turns both nights into the same printed answer.

The answer is the call's last line, below a per-domain status, rather than an `ls` listing: once domains append as they go, every fragment exists within minutes, so a listing of them no longer means that many reports.

The 25-minute deadline was raised to 32 after `application-security` failed to report inside it two nights running — the deadline expired on it on 2026-09-10, and on 2026-09-11 it was still sweeping when the run ended at 21 minutes — while roughly 13 of the job's 40 minutes went unused on both nights. On 2026-09-15 every domain reported in an agent step that ran 25.5 minutes, so the old deadline had little slack even on a night that finished.

At `timeout-minutes: 20` the runner cancelled the job before the 25-minute deadline could fire, so the graceful "give up and report what the domains found" path was unreachable and every overrun landed as INCONCLUSIVE. The 40-minute slack also covers the merge, verdict, redact, upload, and reporting steps after the wait.

A missing fragment is indistinguishable, in the merged report, from a domain that found nothing, and only one of those is safe to publish a release on.

A domain that writes its fragment once, at the end, publishes nothing at all if it does not reach the end. Run 35205193090 is the case: `application-security` fanned out to fourteen nested subagents, every one of them returned (the last at 09:45:12), and the domain then produced no further output before the wait deadline at 09:53:15 — no completion notification for it ever arrived, unlike the sixteen other agents in the run. Seven work streams of finished audit were in its context and none of it was in its file, so the night's report carried `Qualitative findings: Pending.` and the ninth consecutive run held the release gate shut. Appending as findings are determined makes the same death cost only the synthesis.

A domain that delegates hits the orchestrator's own §2 failure one level down, and never reads the file that warns about it. Run 35327271988's `application-security` fanned out to eight nested agents, issued its wait loop with `run_in_background: true` — which returns an id and blocks nothing — reported "I'm holding for them before assembling the final fragment", and ended its turn at 09:11:56. Ending the turn is how a subagent completes, so the orchestrator saw the task finish with no sentinel written; the four outstanding work streams returned at 09:13:00, 09:13:04, 09:13:45 and 09:19:29, all inside a deadline that did not expire until 09:33:24, and every one of their results was discarded. The orchestrator then published the failure as "cut off ... at the 32-minute deadline" — a cause it could not have observed, twenty-one minutes wrong.

The sentinel exists because the same run showed that existence is the wrong predicate. The domain wrote a placeholder into its real fragment path at 09:40 to satisfy "write that file before you return"; `[ -s audit-application.md ]` went true, and the orchestrator — correctly unwilling to merge a placeholder — improvised `grep -q "Audit in progress"`, a predicate that worked only because it guessed wording no contract defined. With findings appended continuously the file is nonempty for most of the run, so the predicate has to be something the domain writes deliberately and last.

The sentinel is checked in the reporting step too, not only in the orchestrator's wait. A domain rewrites its verdict line and then writes the sentinel, so a death between those two writes leaves `VERDICT: PASS` on line 1 of a report that stopped early — the one state where every other guard is satisfied and `PASS` closes the failure issue and opens the release gate.

Every reader compares the last *non-blank* line rather than `tail -n1`: a fragment ending `-->\n\n` is finished, and reading it as cut off would report the lost-report bug the sentinel exists to catch.

Run 35205193090's `## Summary` also inverted the placeholder it was reading: "two of seven work streams ... had not reported" was published as "completed only two of seven planned work streams", describing five audited streams as unaudited. A summary that repeats a cut-off fragment's account of its own progress is reporting a moment, not the run.

## Outcomes and reporting

A review of 160 runs (2026-05 to 2026-10) found the reported verdict trusted as the agent wrote it. On 2026-10-07 the `hosted` fragment opened `VERDICT: PASS` over its own `[Origin boundary #6.b] UNVERIFIABLE`; the issue for #797 missed a `FAIL —` line because the lift expected `FAIL:`; `ci-and-secrets` folded multi-clause rules into one PASS each; and a whole section could go unreported with nothing noticing. Each was a prompt being followed or not. Computing the verdict from lines in a fixed grammar, against a manifest the specs determine, turns each into a mechanical INCONCLUSIVE: the skipped section is a missing rule, the folded clauses are a lettered gap or a bare number the domain chose, and the misspelled `FAIL` is a malformed line.

A malformed line is INCONCLUSIVE rather than lifted by a more tolerant pattern because every tolerant pattern so far matched some passing evidence too: `### FAIL IF results` heads a passing list, and `- PASS: **FAIL IF** …` quotes the clause it passed. A malformed `BLOCKER` still counts as one, since a claimed blocker filed as "no verdict" would be the inversion this change exists to stop.

A pessimistic verdict line that its lines do not support is held at INCONCLUSIVE rather than taken as `FAIL`: taken at its word it files a security finding nobody can locate, and overruled it passes a domain that doubted itself. The same rule covers `audit-status.txt`, which is an agent's conclusion like any other.

The private report carries only what did not pass. Run 36119432126's fragments were 335,600 characters, nearly all of it `PASS` evidence, and its merged report repeated them: eleven parts once split, with the deciding lines in the head only because a lift put them there. With the computed verdicts and non-`PASS` lines leading, the head is the decision, and the `PASS` record stays in the encrypted transcript for whoever needs it.

Collapsing the inconclusive case into `FAIL`, as the step originally did, filed an identical issue for "the repo is insecure" and "the auditor stopped early".

A `FAIL IF` condition no audit run can read makes the verdict a coin flip, because no run can ever determine it. `AUDIT_PAT`-readable GitHub state is not in that class: a failed call there is a real `UNVERIFIABLE`. `## Future` holds such an obligation only while its subject is unbuilt, since a staged item must eventually be promoted; a standing obligation on existing infrastructure is present-tense fact and stays beside its rule. `security-hosted.md` carried two: the Cloudflare script-injection exclusion, which is a zone setting, and a closing activation sentence that stated its own answer. Run 35586089654 (2026-09-21) reached both as `UNVERIFIABLE` in its sub-auditors and its domain lead resolved both to PASS, on the ground that the audited condition was the in-repo half; run 35709640946 (2026-09-22) left both `UNVERIFIABLE`, so a pass with 375 PASS and 0 FAIL returned INCONCLUSIVE and held the release gate shut (issue #747). Nothing in the tree had changed between them. #757 staged both under `security-hosted.md`'s `## Future` and kept the in-repo half — the deploy's `preflight` gate — as a `FAIL IF`.

GitHub rejects an over-long issue body outright; that rejection lands on a `set -e` step *after* the verdict is decided, and the finding then reaches no issue and no comment — only a red run and an artifact that expires. The 2026-08-29 and 08-30 runs lost a `FAIL` that way, over 65,536 characters. The public body truncated with its head kept until the embargo; the private report now splits instead, because a reader of the private tracker has no reason to lose any of it, and the split stops at a bounded part count only so a runaway fragment cannot flood the tracker with comments. Both helper calls are non-fatal so a failure of the helper cannot reopen the window it closes.

Issue prose per combination of conditions cannot be kept correct by fixing combinations. Four consecutive review rounds found the same defect in different clothes — an arm whose text was true only of the states that could reach it, made false by the next gate that widened. A note claiming nothing about the other conditions cannot be invalidated by a new one.

Existence is not agreement. The missing-fragment guard catches a domain that produced nothing; the verdict-line guard catches one whose `FAIL` the merge lost, which is worse, because `PASS` closes the open failure issue and opens the release gate. A fragment the check cannot read must not fall through to an unchallenged `PASS` either — that puts the verdict back on a prompt having been followed, the thing the guard exists to stop being the control.

The September 2026 spec audit found that prefix matching accepted `VERDICT: PASS but unfinished`, whitespace deletion accepted `P A S S`, and the local runner returned success for a failed domain or a process that wrote a fragment before failing. The shared preamble also permitted `UNVERIFIABLE` checks without giving the domain an inconclusive verdict. Exact passing verdicts and the third domain outcome keep incomplete evidence from becoming a passing audit. A failure prefix stayed dissent until the verdict was computed from lines; an October 2026 audit INFO noted it still accepted any `VERDICT: FAIL…` line, and since an actual finding now fails from its own lines, all three verdicts are exact.

The redaction step was once the only thing between an accidental `printenv` and a world-readable artifact, and until its `FAIL IF` existed nothing would have tripped on its deletion. With the artifact encrypted and the report filed privately it still keeps a secret out of both, since a secret in a private tracker is still leaked. Its sinks are deleted rather than truncated on error because `: >` has to open the file and so fails on exactly the unreadable file that made the redactor throw, whereas `rm` needs only the directory.

Without the transcript a run that produces no verdict is undiagnosable: `claude-code-action` keeps tool output out of the step log on purpose and the runner is ephemeral. `***` masking applies to step logs, not to artifact contents.

The October 2026 audit checked the upload's `if: always()` and the reporter's absent-artifact branch. They attempt postprocessing after ordinary failures, but cannot establish an upload after the runner itself times out or is cancelled; the issue links a download only when the artifact lookup returns an id.

## Findings

Severity was never defined, and the ratings showed it. On #1027 a low-impact umask was the run's one FAIL while a file name reaching a PowerShell command line and a paste submitting a command were WARNINGs; the order was the order of mechanical certainty, not of impact. The rubric names the reach — execution, credential, authorization — so a domain rates what an attacker gets.

A qualitative BLOCKER fails the run, as the preamble already told domains to report; until the verdict was computed only the domain's own line enforced it, so a BLOCKER under `VERDICT: PASS` passed.

The evidence fields exist for false positives. A `recovery.json` finding claimed its contents were "not revalidated" after reading only the reader; the sink, `normalizeResumeCommand`, revalidates. Requiring the sink by name, and a reproduction or a cap at INFO, makes that claim either checked or visibly unconfirmed. Missing evidence makes the line malformed rather than demoting it, because a mechanical demotion of a real BLOCKER is the dangerous direction.

Run 37710148950 (2026-10-08) reported two `FAIL`s and two WARNINGs; run 37713086378, on a later commit with that code unchanged, passed and reported none of them. Comparing the fragments, the second run had passed each of those rules on the presence of the control it names, skipping a step the PASS evidence rules now require. The open findings are handed back as a checklist so a finding one run reached is not left to the next run's luck.

Duplicates came from delegation: each delegate a domain improvised ran its own qualitative pass over overlapping ground, and the merge concatenated them, so one PowerShell finding reached #1027 three times and a log finding twice. Named streams make the partition the prompt's rather than the run's, with one qualitative stream so no ground is swept twice; the five-line merge catches what still overlaps, including across domains.

## Embargo

Issue #1027 (2026-10) carried a BLOCKER with a working `calc` command-injection payload in the public `security-audit-failure` body, and every run's `audit-transcript` artifact — the merged report, the four fragments, and the Claude transcript — was downloadable by anyone for 14 days. Both contradicted `docs/specs/security.md` telling a reporter never to open a public issue. The security-audit sweep review of 2026-10-07 moved the detail to a private tracker and the artifact to ciphertext.

The public body is built from what a domain cannot phrase. A domain writes its own check lines, so a heading-shaped string in one is still agent text; only a heading the checked-out spec already publishes is safe to repeat, and the builder looks each one up rather than trusting the line's shape. Verdicts publish as an enum, never as the verdict line, because the verdict line is agent text, which once carried an explanation after `VERDICT: FAIL`.

`EMBARGO_TOKEN` stays out of the agent's step so an accidental print, or an agent talked into filing, cannot reach the private tracker or its history. The domains still need the open findings, so `List open findings` reads them with the token before the agent starts and hands over a file, never the token. The titles are private-tracker data, and the transcript the agent reads them into is already ciphertext; the step logs only the count, because a step's log is public and its `env:` is printed there, which rules out handing the titles on as step outputs. Running no repository code in the token's step stops a modified checkout swapping the script that handles it. Neither stops an agent that subverts the runner: a hosted runner grants passwordless `sudo`, and the agent's processes and files outlive its step; that is the known gap in `docs/specs/security.md`.

The token's step also writes `gh` a fresh config directory, so no leftover configuration decides where the token goes.

`age` comes from the Ubuntu archive the runner image already trusts, as in `.github/workflows/hosted-production.yml`'s backup step; no new trust root and no pinned binary to bump. The recipient lives in a checked-in file so a key rotation is a one-line diff under `.github/audit/`, which `workflow-audit.yaml` watches.

The tracker's visibility is checked against `github.com` rather than the REST API: anonymous API calls share a 60-an-hour limit per runner address, and a rate-limited 403 would read as `UNVERIFIABLE` and hold the release gate.


Provisioning `EMBARGO_TOKEN`: a fine-grained PAT with Issues: write on `diffplug/dormouse-embargo` only, minted on an admin's account.

```bash
gh secret set EMBARGO_TOKEN --env security-audit --repo diffplug/dormouse --body 'github_pat_…'
```

## Findings ledger

A later PASS closed issues whose findings were never fixed: the pass of 2026-07-10 closed a tend-permissions failure that was back by 07-14, and `hangs/` passed on 10-05 and 10-06 and failed on 10-07. A nondeterministic reader misses a finding on some nights, so one quiet night is not a fix. WARNINGs, which never failed a run, were not tracked anywhere once their run's issue closed.

The key leaves out the line number so an edit above a finding does not open a second issue for it; the five-line window applies within one run, where lines are comparable. It leaves out the clause letter too: domains letter a rule's clauses as they read it, so the same failure lettered `.b` one night and `.c` the next opened a second issue. A finding's root cause is free text the domain writes, and its wording drifts between runs (`parseConfig()`, `parseConfig fallback`); keying on the code symbol in it, with the whole cause lowercased only where it names none, holds one finding to one key. PascalCase is not read as a symbol, and a cause written as its rule is read whole: prose spells `GitHub` and `PowerShell`, and two rules under one heading would otherwise share its first proper noun. The failure key keeps an empty part where the clause letter was, so an unlettered failure keeps the key it was minted under.

Hand-filed issues carry `manual-…` keys that no run mints, and their titles cite a spec and heading rather than a rule number. They still count as open and still hold a PASS to re-verification, at the heading they cite, because they were filed for exactly the findings a run had missed.

A PASS that names the finding with a `path:line` is a mechanical stand-in for having looked: it cannot prove the reasoning, but a domain that never read the checklist cannot produce it. Only failures that cite a rule are checked this way; a finding citing no rule is re-verified in the qualitative pass, which no line can hold to a particular finding.

A PASS still exits zero while ledger findings are open: the gate holds a release on what the current tree fails, and the ledger holds what a human has not yet triaged. Only predecessors' issues hold the public issue open, so a PASS's own new WARNINGs do not keep a failure issue alive by themselves.

The step lists the tracker with `--limit 1000`, and the public step does the same: the default of 30 left an older open failure issue unreconciled.

## Environment and `AUDIT_PAT`

A bot-pushed feature branch cannot reach the audit job at all — GitHub rejects the run before any step starts — so `AUDIT_PAT` cannot be exfiltrated through a hand-authored workflow on a non-admin-gated ref.

Without the PAT the audit cannot read the administration endpoints behind ruleset bypass actors, repo-level secret listing, and environment policies, so the specs it enforces would be unenforceable in their key sections.

Passing the PAT only as an unexpanded `GH_TOKEN=` prefix is a convention, not a control: the agent holds unrestricted Bash and audits code that touches secrets, so one `printenv` or one `set -x` lands an admin-read PAT in the transcript.

Provisioning the secret, for whoever has to rotate it:

```bash
gh secret set AUDIT_PAT --env security-audit --repo diffplug/dormouse --body 'github_pat_…'
```
