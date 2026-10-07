# Security Audit

> - Owns how the security specs are audited: the schedule and the release gate, the four domains and their prompts, the orchestration contract, the three outcomes, the reporting steps, the embargo on finding detail, and the environment that holds `AUDIT_PAT`.
> - Defers what is audited to `docs/specs/security.md` and the specs it names, and each agent's procedure to its prompt in `.github/audit/`.
> - Read `docs/specs/security.md` first.

## Schedule and gate

`.github/workflows/security-audit.yaml` audits `docs/specs/security.md` and the specs it names: nightly at `04:21 UTC`, on `workflow_dispatch`, and on the release tag, dispatched by `.github/workflows/release.yml` whose `publish-vscode` job `needs:` it — so no release ships without a passing audit. Dispatched, not `uses:`-called — see `docs/specs/security-ci.md` -> "GitHub Actions Policies".

`FAIL IF` lines are grouped by the operation that answers them, one bullet asserting several properties when a single call establishes all of them; a qualitative pass looks for holes the specs do not cover. **On any `FAIL IF` violation or BLOCKER-severity finding the audit fails** ([Outcomes and reporting](#outcomes-and-reporting)).

- **FAIL IF** `.github/audit/_preamble.md` stops requiring every `FAIL IF` to run as a mechanical check (`gh api`, grep, file read, or a script run) with evidence, each clause its own PASS/FAIL and never satisfied in bulk, or a domain prompt drops its qualitative pass.
- **FAIL IF** `.github/workflows/security-audit.yaml` is missing or disabled, or any of the three separate things that make it a release gate is gone: the `gh workflow run` dispatch, the `gh run watch --exit-status` that turns a failed audit into a failed job, and `publish-vscode`'s `needs:` edge on that job (rationale).

## Domains

The CI audit fans out to four subagents, each owning a disjoint share of the tree; a domain may read outside its share — `application-security` runs the repo's own lints — but owns nothing there (rationale).

**Ownership is by file: every `docs/specs/security*.md` spec, its `.rationale.md` aside, is in exactly one domain's scope**, declared as backticked repo paths in the bullet list under the `**Scope` line of its domain file in `.github/audit/`, and enforced by `scripts/spec-lint.mjs`; `docs/specs/security.md` -> "How the guarantees are checked" tabulates the assignment.

`AUDIT_PAT` is a step-level `env:` on the one job, so every subagent inherits it, and only the prompt tells `application-security` and `hosted` not to use it (`docs/specs/security.md` -> "Known gaps"); `## Future` -> Credential separation stages the fix.

CI and the local runner share the prompts and their scopes in `.github/audit/` (rationale). The local runner uses the operator's `gh` authentication when no `AUDIT_PAT` is supplied; inaccessible local checks are inconclusive.

**The qualitative scopes are stated by subtraction, so adding a directory cannot orphan it** (rationale). `application-security` takes the remainder, worked out from `ls -A` rather than from a list. **Dotfile directories are named explicitly wherever they land**, and **the subtraction is recursive**: where a domain claims a subdirectory rather than a whole tree, the rest of that tree belongs to `application-security`.

- **FAIL IF** a `docs/specs/security*.md` spec (not a `.rationale.md`) is in no domain's scope, or in two, or a scope names a file that does not exist (rationale).
- **FAIL IF** `.github/audit/orchestrator.md` lets the orchestrator audit anything itself (rationale).
- **FAIL IF** the audit stops fanning out to a dedicated `application-security` subagent scoped to `docs/specs/security-local.md` and `docs/specs/security-remote.md`, or to a dedicated `hosted` subagent scoped to `docs/specs/security-hosted.md`, or either scope is merged back into a context that also carries another domain (rationale).
- **FAIL IF** `application-security` or `hosted` does not run on Opus and the mechanical domains on Sonnet, the stronger model on the code-reading domains, in **both** `.github/workflows/security-audit.yaml`'s `claude_args` — its `--model` sets the floor and its `--agents` raises those two domains — and `scripts/security-audit-local.sh` (rationale).
- **FAIL IF** `.github/audit/` is missing a prompt file the workflow names, or `scripts/security-audit-local.sh` stops running the audit from those same files (rationale), or exits zero after a failed process, a missing or unfinished fragment, or any verdict other than exact `VERDICT: PASS`.
- **FAIL IF** the union of the subagents' qualitative scopes does not cover every top-level path in the repository (rationale).
- **FAIL IF** `.github/audit/` or `.vscode/` is outside **any** consumer of `.github/workflows/workflow-audit.yaml`'s diff window — the commit list, `own_changes`, `is_clean_merge`, and both content classifiers' refusals, whose half is *derived* from the single `WINDOW` array. The security specs are deliberately *not* watched there (rationale).

Source of truth: the `**Scope` and `## Qualitative pass` sections of each domain prompt in `.github/audit/`; `claude_args` in `.github/workflows/security-audit.yaml`; `run_domain` in `scripts/security-audit-local.sh`.

## Orchestration

**Subagents launch in the background**, so an agent that ends its turn to await a completion notification is finished: an orchestrator ends the whole run, a delegating domain ships what it has (rationale). `.github/audit/orchestrator.md` and `.github/audit/_preamble.md` own the procedure; these are the invariants the workflow depends on:

- The job's timeout stays above the orchestrator's wait deadline (rationale).
- **Each domain appends to its own fragment as it determines each result**, and the fragments upload with the transcript, so an orchestrator that dies mid-merge still ships what the domains found.
- **A fragment opens `VERDICT: INCONCLUSIVE` and closes with the literal `<!-- END OF REPORT -->`**, its verdict rewritten once at the end. **The sentinel, not existence, is what a reader treats as finished** (rationale).

- **FAIL IF** the orchestrator prompt stops requiring a non-turn-ending wait — a Bash `until` loop over the fragments' sentinels, **breaking on its own sub-cap under the Bash cap the workflow sets** so every call ends by printing its answer, re-issued under a bounded 32-minute deadline **persisted to a file** (`$RUNNER_TEMP/audit-deadline`) rather than recomputed from `now`. That cap is `BASH_DEFAULT_TIMEOUT_MS` in `.github/workflows/security-audit.yaml`, set above the loop's 540-second break (rationale).
- **FAIL IF** the audit job's `timeout-minutes` in `.github/workflows/security-audit.yaml` is not above the orchestrator's persisted wait deadline (rationale), or `AUDIT_FRAGMENTS` there stops naming every domain's fragment.
- **FAIL IF** the prompt permits ending the turn without `audit-report.md` (rationale).
- **FAIL IF** a domain prompt lets findings be held for a write-up at the end, lets a domain that delegates end its turn or background its wait loop, or the wait, the merge, or the verdict treats existence rather than the sentinel as a domain having reported (rationale).
- **FAIL IF** the orchestrator can report `PASS` while a subagent left no report fragment — nor `FAIL`, unless some domain actually returned one: the prompt writes no status file when a fragment is missing and no domain failed, routing an audit that ran out of time to INCONCLUSIVE. Both exit non-zero and hold the release gate shut (rationale).

Source of truth: `.github/audit/orchestrator.md`; the fragment contract in `.github/audit/_preamble.md`; the wait and merge blocks run as shipped in `scripts/security-audit.test.mjs`.

## Outcomes and reporting

**The reporting step distinguishes three outcomes, not two** (rationale):

| Outcome | Computed when | Result |
|---|---|---|
| `PASS` | every domain computes PASS and `audit-status.txt` is literally `PASS` | public failure issues closed, or commented while the ledger holds an earlier run's finding ([Findings ledger](#findings-ledger)); exit zero |
| `FAIL` | any domain computes FAIL | private issue filed; public issue filed or updated; exit non-zero |
| INCONCLUSIVE | anything else | filed as for `FAIL`, both saying no verdict was reached; exit non-zero |

**Verdicts are computed from the fragments' lines, never read from a conclusion** (rationale). `scripts/security-audit-report.mjs` parses each fragment in the grammar `.github/audit/_preamble.md` fixes:

- **FAIL**: any `FAIL` result or `BLOCKER` finding, malformed or not.
- **INCONCLUSIVE**: otherwise, an `UNVERIFIABLE` result, an owed rule with no result, a skipped clause letter, a malformed line, a result for a rule not owed, not exactly one `QUALITATIVE: done` line, no sentinel, or a first line other than exact `VERDICT: PASS`.
- **PASS**: none of these.

**A domain owes one result per `FAIL IF` rule in the specs its `**Scope` claims**, numbered by position under its heading, so a skipped section is a missing rule. A verdict line or `audit-status.txt` that disagrees with the computed verdict is reported as an anomaly; a pessimistic one holds at INCONCLUSIVE, never raising to `FAIL`.

- **A title moves upward only.** An append retitles an open issue for `FAIL` alone, so an inconclusive run cannot relabel one already carrying findings.
- **The private report is what did not pass**: computed verdicts, anomalies, non-`PASS` results, missing rules, malformed lines, and merged findings. `PASS` lines and the orchestrator's `audit-report.md` stay in the encrypted artifact.
- **The private report is split, never truncated**, by `scripts/clamp-issue-body.mjs` into the issue body and its comments, under a bounded part count; a helper failure files it as one part (rationale).
- **The `audit-transcript` artifact uploads during postprocessing**, 14-day retention; runner timeout or cancellation can prevent upload, and a missing artifact receives no download link (rationale).
- **A `FAIL IF` names only a condition an audit run can read**: the readable half is audited, and the rest is staged under `## Future` only while it is unbuilt, otherwise stated beside the rule. `AUDIT_PAT`-readable GitHub state stays audited (rationale).

- **FAIL IF** the `Redact secrets from agent output` step is removed, stops covering any sink later archived or filed (`audit-report.md`, the four per-domain fragments, and the transcript), or stops failing closed by deleting those files when the redactor itself throws (rationale).
- **FAIL IF** the reporting step takes a verdict from a `VERDICT:` line or `audit-status.txt` over the computed one, a fragment computes PASS under any INCONCLUSIVE condition above, the manifest is read from anywhere but the claimed specs' `FAIL IF` lines, or a builder that throws hands on anything but INCONCLUSIVE (rationale).
- **FAIL IF** the private report omits a note for a condition that holds — a failing, missing, unreadable, cut-off, or inconclusive domain, an anomaly, or no status — or any note asserts something about a condition other than its own, or the public issue's domain table omits one (rationale).
- **FAIL IF** the audit has been weakened in a way no bullet above names — e.g. the prompt no longer requires the qualitative pass, a `FAIL IF` can be ignored, the failure-reporting step that opens a `security-audit-failure` issue and exits non-zero has been removed, or the `AUDIT_PAT` pre-check is removed or bypassed. **This bullet is a judgement item, not a checklist.**

The reporting step's known gaps are `docs/specs/security.md` -> "Known gaps" (rationale).

Source of truth: `Compose the audit report` and `Surface result, file or close issue` in `.github/workflows/security-audit.yaml`; `scripts/security-audit-report.mjs`; reporting, redaction, and local-runner regressions in `scripts/security-audit.test.mjs`.

## Findings

**A BLOCKER fails the run like a failed `FAIL IF`**; the severity rubric and evidence rules are `.github/audit/_preamble.md`'s (rationale). **Findings naming the same file and root cause within five lines are one finding**, at the worst severity reported, across domains. **Delegation follows each domain prompt's `## Work streams`**, one `qualitative` stream among them, the domain's only qualitative pass.

- **FAIL IF** `.github/audit/_preamble.md` stops rating BLOCKER by attacker-controlled input reaching code execution, a credential, or an authorization grant, or stops requiring every BLOCKER and WARNING to quote its code, trace source to a named sink, and give a reproduction, or a BLOCKER or WARNING lacking those lines can reach PASS (rationale).
- **FAIL IF** the private report and the ledger stop merging findings by file, root cause, and a five-line window.
- **FAIL IF** a domain prompt's `## Work streams` omits or repeats a heading its manifest owes, or `.github/audit/_preamble.md` lets a domain delegate by any other partition or run more than one qualitative pass (rationale).

Source of truth: `.github/audit/_preamble.md`; `dedupFindings` in `scripts/security-audit-report.mjs`.

## Embargo

**Finding detail stays private until fixed** (rationale):

| Sink | Carries |
|---|---|
| Public `security-audit-failure` issue | the run link, the audited commit, each domain's computed verdict and its failed-check, missing-rule, malformed-line, BLOCKER, and WARNING counts, each failed check's spec and heading, how many verdict lines disagreed, how many ledger findings are open, and whether the private filing failed |
| Private issue in `diffplug/dormouse-embargo`, one per non-PASS run | the private report ([Outcomes and reporting](#outcomes-and-reporting)), titled with date and commit |
| Ledger issue in `diffplug/dormouse-embargo`, one per open finding key | one failed rule clause, or one merged BLOCKER or WARNING, with its evidence |
| `audit-transcript` artifact | age ciphertext of the transcript, `audit-report.md`, and the fragments |

- **FAIL IF** the public issue can carry finding text: it is posted from anything but the output of `scripts/security-audit-public-body.mjs` and the fixed private-filing notes, or that builder emits anything but fixed text, counts, validated run metadata, fragment names, and headings it found in the checked-out spec. A failed check naming no such heading, in the line form `.github/audit/_preamble.md` fixes, is counted, never quoted (rationale).
- **FAIL IF** `secrets.EMBARGO_TOKEN` is referenced anywhere but the `env:` of `File embargoed findings`, a workflow or job `env:` or a `$GITHUB_ENV` write could carry it to another step, or that step runs anything but `gh` and shell builtins (rationale).
- **FAIL IF** a non-PASS run whose private filing failed or was skipped can succeed, or its public issue omits that the filing failed; or a PASS run files anything but ledger issues, or `scripts/security-audit-local.sh` files anything.
- **FAIL IF** the `audit-transcript` artifact can upload anything but age ciphertext: its `path:` names a non-`.age` file, it uploads when `Encrypt the audit transcript` did not succeed, that step reads its recipient from anywhere but `.github/audit/transcript-recipient.txt`, or it stops running whatever the audit step's outcome (`if: always()`).
- **FAIL IF** `diffplug/dormouse-embargo` is publicly visible: an unauthenticated `curl -s -o /dev/null -w '%{http_code}' https://github.com/diffplug/dormouse-embargo` must print `404` (rationale).

That the agent shares its job with these steps is `docs/specs/security.md` -> "Known gaps".

Source of truth: `Encrypt the audit transcript`, `File embargoed findings`, and `Surface result, file or close issue` in `.github/workflows/security-audit.yaml`; `scripts/security-audit-public-body.mjs`; embargo regressions in `scripts/security-audit.test.mjs`.

### Findings ledger

**Every run reads the ledger, a PASS included, and only a human closes a ledger issue** (rationale). A ledger issue's title starts `[audit-finding <key>]`, the key hashing a failed rule's clause, or a finding's file and root cause without its line. A key with no open issue gets one, a PASS's WARNINGs included; one already open gets a `Seen again` comment.

- **FAIL IF** `File embargoed findings` can close, edit, or reopen an issue, or open a ledger issue for a key that already has one open (rationale).
- **FAIL IF** a PASS closes a public `security-audit-failure` issue while a ledger issue opened before that run is still open, or while the ledger could not be read; or a PASS whose ledger could not be read exits zero (rationale).

## Environment and `AUDIT_PAT`

The audit job declares `environment: security-audit`, **whose deployment-branch-policy admits only `main` and `v*` tags** — both admin-only by the rulesets in `docs/specs/security-ci.md` -> "Automated Maintainer (tend)" (rationale). A `workflow_dispatch` from any other ref is rejected before any step runs, so audit changes are iterated on `main`.

- **`AUDIT_PAT` is required.** A dedicated step verifies the secret is present before the audit step runs and refuses to continue otherwise (rationale).
- **The PAT is fine-grained and read-only**: `Administration` + `Secrets` + `Environments`, scoped to `diffplug/dormouse` only, minted on an admin's account, stored env-scoped.
- `gh api` responses never carry secret values (rationale).

- **FAIL IF** the step that verifies `AUDIT_PAT` is provisioned before the audit runs is removed or bypassed (rationale).
- **FAIL IF** a workflow step prints `$AUDIT_PAT` or `$CLAUDE_CODE_OAUTH_TOKEN`, or `.github/audit/_preamble.md` stops forbidding a domain to print a secret value or to pass the PAT any way but an unexpanded `GH_TOKEN=` prefix (rationale).

Source of truth: `Verify AUDIT_PAT is provisioned` in `.github/workflows/security-audit.yaml`; `Never print a secret value` in `.github/audit/_preamble.md`.

## Future

**Scope: audit-credential-separation** — [Credential separation](#credential-separation).

### Credential separation

A second job outside the `security-audit` environment, running the domains that need no PAT and passing their fragments back as artifacts, would leave `application-security` and `hosted` unable to hold `AUDIT_PAT` at all. The fragments would cross as ciphertext, and `File embargoed findings` would move to a job no agent ran on, holding the key to read them.
