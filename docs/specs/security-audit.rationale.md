# Security Audit — rationale

## Schedule and gate

The three release-gate pieces are named separately because they break independently: dropping `--exit-status` alone un-gates the release while leaving a green grep for "invoked".

## Domains

One context holding all three subject matters degrades application security — the newest domain, with the most code behind it, and the easiest to crowd out with API responses.

Folding the application-security scope back into a shared context is how that spec stops being audited without anyone deciding to stop auditing it.

The model split is where the findings that needed real reasoning came from: tracing a relay-minted `clientId` to a keystroke-injection path, and working out that an eight-character device fingerprint carried ~40 bits rather than ~48 because a P-256 point's leading byte is constant. The other two domains run a generator, read an API response, and compare a pin.

Both sides of the local split are pinned, not only the strong one. Unpinned, the mechanical domains inherit whatever the operator's default is — not necessarily weaker: on a machine defaulting to `opus[1m]` it is *stronger*, inverting the relation and turning the local loop into something other than a rehearsal of the nightly. CI gets this free, its session default being Sonnet with one override.

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

At `timeout-minutes: 20` the runner cancelled the job before the 25-minute deadline could fire, so the graceful "give up and report what the domains found" path was unreachable and every overrun landed as INCONCLUSIVE. The 40-minute slack also covers the merge, verdict, redact, upload, and reporting steps after the wait.

A missing fragment is indistinguishable, in the merged report, from a domain that found nothing, and only one of those is safe to publish a release on.

## Outcomes and reporting

Collapsing the inconclusive case into `FAIL`, as the step originally did, filed an identical issue for "the repo is insecure" and "the auditor stopped early".

GitHub rejects an over-long issue body outright; that rejection lands on a `set -e` step *after* the verdict is decided, and the finding then reaches no issue and no comment — only a red run and an artifact that expires. Truncation keeps the head because that is where the verdict and the links are, and the clamp call is non-fatal so a failure of the helper cannot reopen the window it closes.

Issue prose per combination of conditions cannot be kept correct by fixing combinations. Four consecutive review rounds found the same defect in different clothes — an arm whose text was true only of the states that could reach it, made false by the next gate that widened. A note claiming nothing about the other conditions cannot be invalidated by a new one.

Gating a fragment guard on the status produced the same defect three times: gated on `PASS`, one empty fragment silenced the dissent check; widened to `!= FAIL`, an orchestrator that wrote `FAIL` itself silenced both, so a domain that left no report beside a real finding appeared nowhere at all. Recording what is true of a run and deciding its verdict are separate jobs.

Existence is not agreement. The missing-fragment guard catches a domain that produced nothing; the verdict-line guard catches one whose `FAIL` the merge lost, which is worse, because `PASS` closes the open failure issue and opens the release gate. A fragment the check cannot read must not fall through to an unchallenged `PASS` either — that puts the verdict back on a prompt having been followed, the thing the guard exists to stop being the control.

The redaction step is the only thing between an accidental `printenv` and a world-readable artifact, and until its `FAIL IF` existed nothing would have tripped on its deletion. Its sinks are deleted rather than truncated on error because `: >` has to open the file and so fails on exactly the unreadable file that made the redactor throw, whereas `rm` needs only the directory.

Without the transcript a run that produces no verdict is undiagnosable: `claude-code-action` keeps tool output out of the step log on purpose and the runner is ephemeral. World-readable is consistent with the audit reports already posted to public issues; `***` masking applies to step logs, not to artifact contents.

Two weakenings found by the audit's own first run were covered by no example in the judgement bullet, and both became their own bullets.

## Environment and `AUDIT_PAT`

A bot-pushed feature branch cannot reach the audit job at all — GitHub rejects the run before any step starts — so `AUDIT_PAT` cannot be exfiltrated through a hand-authored workflow on a non-admin-gated ref.

Without the PAT the audit cannot read the administration endpoints behind ruleset bypass actors, repo-level secret listing, and environment policies, so the specs it enforces would be unenforceable in their key sections.

Passing the PAT only as an unexpanded `GH_TOKEN=` prefix is a convention, not a control: the agent holds unrestricted Bash and audits code that touches secrets, so one `printenv` or one `set -x` would publish an admin-read PAT for the artifact's whole retention.
