# Security Audit

> Owns how the security specs are audited: the schedule and the release gate, the three domains and their prompts, the orchestration, the three outcomes, the reporting step, and the environment that holds `AUDIT_PAT`. Defers what is audited to `docs/specs/security.md` and the specs it names.
> Read `docs/specs/security.md` first.

## Schedule and gate

`.github/workflows/security-audit.yaml` audits `docs/specs/security.md` and the specs it names: nightly at `04:21 UTC` (`schedule`), on `workflow_dispatch`, and on the release tag, dispatched by `.github/workflows/release.yml` whose `publish-vscode` job `needs:` it — so no release ships without a passing audit. Dispatched, not `uses:`-called — see `docs/specs/security-ci.md` -> "GitHub Actions Policies".

- **Must execute every `FAIL IF` as a mechanical check** (`gh api`, grep, file read, or a script run) **and add a qualitative pass** for security holes the specs do not cover.
- **`FAIL IF` lines are grouped by the operation that answers them**, one bullet asserting several properties when a single call establishes all of them. **Every clause stays an independent check**, with its own PASS/FAIL and evidence; never satisfied in bulk.
- **On any `FAIL IF` violation or BLOCKER-severity finding the audit fails**; [Outcomes and reporting](#outcomes-and-reporting) says what that files.

- **FAIL IF** `.github/workflows/security-audit.yaml` is missing or disabled, or any of the three separate things that make it a release gate is gone: the `gh workflow run` dispatch, the `gh run watch --exit-status` that turns a failed audit into a failed job, and `publish-vscode`'s `needs:` edge on that job (rationale).

## Domains

**Must fan the CI audit out to three subagents, each owning a disjoint share of the tree**; a domain reads outside its share — `application-security` runs the repo's own lints — but owns nothing there. The orchestrator audits nothing itself, spawning them concurrently and merging what they return (rationale).

**Ownership is by file: every `docs/specs/security*.md` spec is in exactly one domain's scope**, declared as backticked repo paths in the bullet list under the `**Scope` line of its domain file in `.github/audit/`, and enforced by `scripts/spec-lint.mjs`.

| Domain | Specs |
|---|---|
| `supply-chain` | `docs/specs/security-supply-chain.md` |
| `ci-and-secrets` | `docs/specs/security-ci.md`, `docs/specs/security-audit.md`, `docs/specs/security.md` |
| `application-security` | `docs/specs/security-local.md`, `docs/specs/security-remote.md`, `docs/specs/security-hosted.md` |

**The separation is one of context, not of credential.** `AUDIT_PAT` is a step-level `env:` on the one job, so every subagent inherits it, and only the prompt tells `application-security` not to use it. A prompt is not a control: three contexts each *read* less, none *holds* less. A known gap, staged as `## Future` -> Credential separation.

**Must pin the mechanical domains to Sonnet and `application-security` to Opus in CI and locally** (rationale).

**Must keep shared CI/local prompts and their scopes in `.github/audit/`** (rationale).

**Must make the sequential local runner exit nonzero for a failed process, a missing or unfinished fragment, or any verdict other than exact `VERDICT: PASS`.** It uses the operator's `gh` authentication when no `AUDIT_PAT` is supplied; inaccessible local checks are inconclusive.

**The qualitative scopes are stated by subtraction, so adding a directory cannot orphan it** (rationale). `application-security` takes the remainder, worked out from `ls -A` rather than from a list.

- **Dotfile directories are named explicitly wherever they land**, in the prompt files as here.
- **The subtraction is recursive**: where a domain claims a subdirectory rather than a whole tree — as `supply-chain` does inside `website/` — the remainder of that tree belongs to `application-security`.

- **FAIL IF** a `docs/specs/security*.md` spec is in no domain's scope, or in two, or a scope names a file that does not exist (rationale).
- **FAIL IF** the audit stops fanning out to a dedicated `application-security` subagent scoped to the application specs in the Domains table, or that scope is merged back into a context that also carries the supply-chain or CI domains (rationale).
- **FAIL IF** `application-security` does not run on a stronger model than the mechanical domains, in **both** `.github/workflows/security-audit.yaml`'s `claude_args` — its `--model` sets the floor and its `--agents` raises that one domain — and `scripts/security-audit-local.sh` (rationale).
- **FAIL IF** `.github/audit/` is missing a prompt file the workflow names, or `scripts/security-audit-local.sh` stops running the audit from those same files (rationale).
- **FAIL IF** the union of the subagents' qualitative scopes does not cover every top-level path in the repository (rationale).
- **FAIL IF** `.github/audit/` or `.vscode/` is outside **any** consumer of `.github/workflows/workflow-audit.yaml`'s diff window — the commit list, `own_changes`, and both classifiers' refusals, whose half is *derived* from the single `WINDOW` array (`"${WINDOW[@]:1}"`). Widening one consumer without the others is the failure. The security specs are deliberately *not* watched there (rationale).

Source of truth: the `**Scope` and `## Qualitative pass` sections of each domain prompt in `.github/audit/`; `claude_args` in `.github/workflows/security-audit.yaml`; `run_domain` in `scripts/security-audit-local.sh`.

## Orchestration

**Subagents launch in the background**, so an agent that ends its turn to await a completion notification is finished: an orchestrator ends the whole run, a delegating domain ships what it has (rationale).

- **The job's `timeout-minutes: 40` stays above the orchestrator's 32-minute wait deadline** (rationale).
- **`--allowed-tools` enforces none of this**, only auto-approving; `Task`/`Agent` are allowed on purpose and only `Workflow` is denied (rationale).
- **Each subagent appends to its own fragment as it determines each result**, never holding findings for a write-up at the end, and the orchestrator concatenates them rather than retyping; `AUDIT_FRAGMENTS` in `.github/workflows/security-audit.yaml` names the three. Fragments upload with the transcript, so an orchestrator that dies mid-merge still ships what the domains found.
- **A fragment opens `VERDICT: INCONCLUSIVE` and closes with the literal `<!-- END OF REPORT -->`**, its verdict rewritten once at the end. **The sentinel, not existence, is what a reader treats as finished** (rationale).

- **FAIL IF** the orchestrator prompt stops requiring a non-turn-ending wait — a Bash `until` loop over the fragments' sentinels, **breaking on its own sub-cap under the Bash cap the workflow sets** so every call ends by printing its answer, re-issued under a bounded 32-minute deadline **persisted to a file** (`$RUNNER_TEMP/audit-deadline`) rather than recomputed from `now`. That cap is `BASH_DEFAULT_TIMEOUT_MS` in `.github/workflows/security-audit.yaml`, set above the loop's 540-second break; the harness default is two minutes, under it (rationale).
- **FAIL IF** the prompt permits ending the turn without `audit-report.md` (rationale).
- **FAIL IF** a domain prompt lets findings be held for a write-up at the end, lets a domain that delegates end its turn or background its wait loop, or the wait, the merge, or the verdict treats existence rather than the sentinel as a domain having reported (rationale).
- **FAIL IF** the orchestrator can report `PASS` while a subagent left no report fragment — nor `FAIL`, unless some domain actually returned one: the prompt writes no status file when a fragment is missing and no domain failed, routing an audit that ran out of time to INCONCLUSIVE. Both exit non-zero and hold the release gate shut (rationale).

Source of truth: `2. Wait without ending your turn`, `3. Merge`, and `4. The verdict` in `.github/audit/orchestrator.md`; the fragment contract in `.github/audit/_preamble.md`; the wait and merge blocks run as shipped in `scripts/security-audit.test.mjs`.

## Outcomes and reporting

**The reporting step distinguishes three outcomes, not two.** Only the literal strings `PASS` and `FAIL` are honored (rationale).

| Outcome | `audit-status.txt` | Result |
|---|---|---|
| `PASS` | literally `PASS` | open failure issues auto-closed; exit zero |
| `FAIL` | literally `FAIL` | issue filed or updated; exit non-zero |
| INCONCLUSIVE | missing, empty, or anything else | filed under the same label, body reproducing the partial report and saying it is not a security finding; exit non-zero |

- **A title moves upward only.** A new issue is titled for its outcome; an append retitles an open issue for `FAIL` alone, so an inconclusive run cannot relabel one already carrying findings, and a PASS closes it rather than walking it back.
- **Must write `audit-report.md` before `audit-status.txt`.** A partial report can support FAIL; PASS requires every domain's completed checks.
- **Partial has three shapes**, each named in the INCONCLUSIVE issue: `UNVERIFIABLE` for a check reached but not determined; `_Incomplete …_` above a fragment cut off mid-report; `_No report …_` for a domain that never wrote one. The merged `## Summary` may likewise read `INCONCLUSIVE`, and **gives no coverage count for a cut-off domain** (rationale).
- **With no `audit-report.md` the reporting step publishes each fragment verbatim under its own heading**, unmerged (rationale).
- **Must return `VERDICT: INCONCLUSIVE` from a domain with any undetermined check unless it found a failure.** Only all-determined passing checks permit `VERDICT: PASS`; a domain's inconclusive verdict prevents a merged pass.
- **Never write a `FAIL IF` condition on state outside the repository**: state the in-repo half, the obligation beside it (rationale).
- **`STATUS` is assigned in exactly two places**: where the status file is parsed, and in the single escalation block, **which orders `FAIL` > `MISSING` > `PASS`** — a dissent can raise `MISSING` to `FAIL` and never the reverse, and a `FAIL` alongside missing or unreadable fragments still reports them.
- **The report is truncated to 32,000 characters before posting**, head kept, by `scripts/clamp-issue-body.mjs` (self-tested by `scripts/clamp-issue-body-selftest.mjs`). The call is non-fatal; the `audit-transcript` artifact holds the report in full; `.github/workflows/workflow-audit.yaml` truncates its commit list the same way (rationale).
- **Every run uploads the `audit-transcript` artifact, which is world-readable and not secret-masked** — 14-day retention, deep-linked from failure issues (rationale).

- **FAIL IF** the `Redact secrets from agent output` step is removed, stops covering any sink that is later published (`audit-report.md`, the three per-domain fragments, and the transcript), or stops failing closed by deleting those files when the redactor itself throws (rationale).
- **FAIL IF** the reporting step writes issue prose per *combination* of conditions rather than one note per condition that holds (rationale).
- **FAIL IF** either fragment guard is gated on the status at all (rationale).
- **FAIL IF** the reporting step accepts any domain verdict other than exact `VERDICT: PASS` as passing, fails to recognize a `VERDICT: FAIL` prefix as dissent, ignores an inconclusive domain, accepts a fragment with no completion sentinel as finished, or accepts status text other than literal `PASS`/`FAIL` (rationale).
- **FAIL IF** the audit has been weakened in any other way — e.g. the prompt no longer requires the qualitative pass, a `FAIL IF` can be ignored, the failure-reporting step that opens a `security-audit-failure` issue and exits non-zero has been removed, or the `AUDIT_PAT` pre-check is removed or bypassed. **This bullet is a judgement item, not a checklist**: the examples are the ones that have come up, not the ones that exist (rationale).

Source of truth: `clampIssueBody` in `scripts/clamp-issue-body.mjs`; `Surface result, file or close issue` in `.github/workflows/security-audit.yaml`; reporting, redaction, and local-runner regressions in `scripts/security-audit.test.mjs`.

## Environment and `AUDIT_PAT`

The audit job declares `environment: security-audit`, **whose deployment-branch-policy admits only `main` and `v*` tags** — both admin-only by the rulesets in `docs/specs/security-ci.md` -> "Automated Maintainer (tend)" (rationale).

- **Audit changes are iterated on `main` directly**: a `workflow_dispatch` from any other ref is rejected before any step runs; experimenting on a branch means widening the policy temporarily.
- **`AUDIT_PAT` is required.** A dedicated step verifies the secret is present before the audit step runs — after the checkout and install, not literally first — and refuses to continue otherwise (rationale).
- **The PAT is fine-grained and read-only**: `Administration` + `Secrets` + `Environments`, scoped to `diffplug/dormouse` only, minted on an admin's account, stored env-scoped.
- **No step may ever print `$AUDIT_PAT` or `$CLAUDE_CODE_OAUTH_TOKEN`.** The prompt passes the PAT only through an unexpanded `GH_TOKEN=` prefix, and `gh api` responses never carry secret values (rationale).

- **FAIL IF** the step that verifies `AUDIT_PAT` is provisioned before the audit runs is removed or bypassed (rationale).

Source of truth: `Verify AUDIT_PAT is provisioned` in `.github/workflows/security-audit.yaml`; `Never print a secret value` in `.github/audit/_preamble.md`.

## Future

### Credential separation

A second job outside the `security-audit` environment, running the domains that
need no PAT and passing their fragments back as artifacts, would leave
`application-security` unable to hold `AUDIT_PAT` at all.
