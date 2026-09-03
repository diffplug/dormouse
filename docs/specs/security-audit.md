# Security Audit

> Owns how the security specs are audited: the schedule and the release gate, the three domains and their prompts, the orchestration, the three outcomes, the reporting step, and the environment that holds `AUDIT_PAT`. Defers what is audited to `docs/specs/security.md` and the specs it names.
> Read `docs/specs/security.md` first.

## Schedule and gate

`.github/workflows/security-audit.yaml` audits `docs/specs/security.md` and the specs it names: nightly at `04:21 UTC` (`schedule`), on `workflow_dispatch`, and on the release tag, dispatched by `.github/workflows/release.yml` whose `publish-vscode` job `needs:` it — so no release ships without a passing audit. Dispatched, not `uses:`-called — see `docs/specs/security-ci.md` -> "GitHub Actions Policies".

- **Must execute every `FAIL IF` as a mechanical check** (`gh api`, grep, file read, or a script run) **and add a qualitative pass** for security holes the specs do not cover.
- **`FAIL IF` lines are grouped by the operation that answers them**: one bullet may assert several properties when a single API call, file read, or script run establishes all of them. **Every clause stays an independent check**, with its own PASS/FAIL and its own evidence; never satisfied in bulk.
- **On any `FAIL IF` violation or BLOCKER-severity finding the workflow opens (or updates) a `security-audit-failure` issue** carrying the report, and exits non-zero; a subsequent passing audit auto-closes it.

- **FAIL IF** `.github/workflows/security-audit.yaml` is missing or disabled, or any of the three separate things that make it a release gate is gone: the `gh workflow run` dispatch, the `gh run watch --exit-status` that turns a failed audit into a failed job, and `publish-vscode`'s `needs:` edge on that job (rationale).

## Domains

**The audit fans out to three subagents with disjoint scopes**; the orchestrator audits nothing itself, spawning them concurrently and merging what they return (rationale).

**Ownership is by file: every `docs/specs/security*.md` spec is in exactly one domain's scope**, declared as backticked repo paths in the bullet list under the `**Scope` line of its domain file in `.github/audit/`, and enforced by `scripts/spec-lint.mjs`.

| Domain | Specs |
|---|---|
| `supply-chain` | `docs/specs/security-supply-chain.md` |
| `ci-and-secrets` | `docs/specs/security-ci.md`, `docs/specs/security-audit.md`, `docs/specs/security.md` |
| `application-security` | `docs/specs/security-application.md` |

**The separation is one of context, not of credential.** `AUDIT_PAT` is a step-level `env:` on the one job, so every subagent inherits it, and only the prompt tells `application-security` not to use it. **Known gap:** a prompt is not a control; a real separation needs a second job outside the `security-audit` environment, passing fragments as artifacts — worth doing, not done. Three contexts each *read* less; none *holds* less.

**The domains do not all run on the same model**: the mechanical two on the session default, `application-security` on Opus (rationale).

**The prompts live in `.github/audit/`, not inline in the workflow**, three times over: `scripts/security-audit-local.sh` runs the audit from those same files, so the local loop cannot drift from the nightly; changes review as markdown diffs, not YAML block-scalar churn; and the scope blocks are read as markdown, not as prose embedded in YAML (rationale).

**The qualitative scopes are stated by subtraction, so adding a directory cannot orphan it** (rationale).

- `ci-and-secrets` — `.github/` (including `.github/audit/`), `.config/`, `.claude/`, `.vscode/`, `scripts/`, and `website/public/`, plus any code anywhere that touches a secret (rationale).
- `supply-chain` — the dependency graph, the lockfile, and all of `website/` except `website/public/`, stated as a subtraction rather than as named subdirectories. `website/scripts/generate-deps.js` is in that set, so the generator behind the disclosed snapshot is audited whole, not just its `productDependencyFilters` array (rationale).
- `application-security` — **everything else**, worked out from `ls -A` rather than from a list, including `.impeccable/`. **Dotfile directories are named explicitly wherever they land**, here and in the prompt files. **The subtraction is recursive**: where another domain claims a subdirectory rather than a whole tree — as both do inside `website/` — the remainder of that tree belongs here.

- **FAIL IF** a `docs/specs/security*.md` spec is in no domain's scope, or in two, or a scope names a file that does not exist (rationale).
- **FAIL IF** the audit stops fanning out to a dedicated `application-security` subagent scoped to `docs/specs/security-application.md`, or that scope is merged back into a context that also carries the supply-chain or CI domains (rationale).
- **FAIL IF** `application-security` does not run on a stronger model than the mechanical domains, in **both** `.github/workflows/security-audit.yaml`'s `--agents` and `scripts/security-audit-local.sh` (rationale).
- **FAIL IF** `.github/audit/` is missing a prompt file the workflow names, or `scripts/security-audit-local.sh` stops running the audit from those same files (rationale).
- **FAIL IF** the union of the subagents' qualitative scopes does not cover every top-level path in the repository (rationale).
- **FAIL IF** `.github/audit/` or `.vscode/` is outside **every** consumer of `.github/workflows/workflow-audit.yaml`'s diff window — the commit list, `own_changes`, and both classifiers' refusals, whose half is *derived* from the single `WINDOW` array (`"${WINDOW[@]:1}"`). The security specs are deliberately *not* watched there (rationale).

Source of truth: `--agents` in `.github/workflows/security-audit.yaml`; `run_domain` in `scripts/security-audit-local.sh`.

## Orchestration

**Subagents launch in the background** — the Task tool returns an id, not a report — so an orchestrator that ends its turn to await a completion notification ends the whole run: one headless turn, nothing resumes it (rationale).

- **The job's `timeout-minutes: 40` stays above the orchestrator's 25-minute wait deadline** (rationale).
- **`--allowed-tools` enforces none of this**: it only auto-approves and removes nothing. `Task`/`Agent` are allowed on purpose; only `Workflow` is denied.
- **Each subagent writes its own report fragment before returning its verdict** — `audit-supply-chain.md`, `audit-ci-secrets.md`, `audit-application.md` — and the orchestrator concatenates them rather than retyping. Fragments upload with the transcript, so an orchestrator that dies mid-merge still ships what the domains found.

- **FAIL IF** the orchestrator prompt stops requiring a non-turn-ending wait — a Bash `until` loop over the fragment files, re-issued past the ten-minute Bash cap, under a bounded 25-minute deadline **persisted to a file** (`$RUNNER_TEMP/audit-deadline`) rather than recomputed from `now` (rationale).
- **FAIL IF** the orchestrator can report `PASS` while a subagent left no report fragment — nor `FAIL`, unless some domain actually returned one: the prompt writes no status file when a fragment is missing and no domain failed, routing an audit that ran out of time to INCONCLUSIVE. Both exit non-zero and hold the release gate shut (rationale).

Source of truth: `2. Wait without ending your turn` and `4. The verdict` in `.github/audit/orchestrator.md`.

## Outcomes and reporting

**The reporting step distinguishes three outcomes, not two.** Only the literal strings `PASS` and `FAIL` are honored (rationale).

| Outcome | `audit-status.txt` | Result |
|---|---|---|
| `PASS` | literally `PASS` | open failure issues auto-closed; exit zero |
| `FAIL` | literally `FAIL` | issue filed or updated; exit non-zero |
| INCONCLUSIVE | missing, empty, or anything else | filed under the same label, titled `INCONCLUSIVE`, body reproducing the partial report and saying it is not a security finding; exit non-zero |

- **`audit-report.md` is always written before `audit-status.txt`** — partial, if the agent runs short — and `audit-status.txt` only once the verdict covers every check.
- **Partial has two shapes**, both named in the INCONCLUSIVE issue: `UNVERIFIABLE` for a check the agent reached but could not determine, inside its domain's fragment; a `_No report …_` placeholder for a domain that never reported. The merged `## Summary` may likewise read `INCONCLUSIVE`.
- **`STATUS` is assigned in exactly two places**: where the status file is parsed, and in the single escalation block, **which orders `FAIL` > `MISSING` > `PASS`** — a dissent can raise `MISSING` to `FAIL` and never the reverse, and a `FAIL` alongside missing or unreadable fragments still reports them. Both fragment guards run unconditionally and only record.
- **The report is truncated to 32,000 characters before posting**, head kept, by `scripts/clamp-issue-body.mjs` (self-tested by `scripts/clamp-issue-body-selftest.mjs`). The call is non-fatal; the `audit-transcript` artifact holds the report in full; `.github/workflows/workflow-audit.yaml` truncates its commit list the same way (rationale).
- **Every run uploads the `audit-transcript` artifact, which is world-readable and not secret-masked** — 14-day retention, deep-linked from failure issues (rationale).

- **FAIL IF** the `Redact secrets from agent output` step is removed, stops covering any sink that is later published (`audit-report.md`, the three per-domain fragments, and the transcript), or stops failing closed by deleting those files when the redactor itself throws (rationale).
- **FAIL IF** the reporting step writes issue prose per *combination* of conditions rather than one note per condition that holds (rationale).
- **FAIL IF** either fragment guard is gated on the status at all (rationale).
- **FAIL IF** a fragment's first line is not literally `VERDICT: PASS` or `VERDICT: FAIL` and nothing else — the reporting step greps it — or the reporting step stops downgrading a merged `PASS` that contradicts one — **or** stops treating a fragment with no readable verdict as inconclusive. Three cases, not two (rationale).
- **FAIL IF** the audit has been weakened in any other way — e.g. the prompt no longer requires the qualitative pass, a `FAIL IF` can be ignored, the failure-reporting step that opens a `security-audit-failure` issue and exits non-zero has been removed, or the `AUDIT_PAT` pre-check is removed or bypassed. **This bullet is a judgement item, not a checklist**: the examples are the ones that have come up, not the ones that exist (rationale).

Source of truth: `clampIssueBody` in `scripts/clamp-issue-body.mjs`; `Surface result, file or close issue` in `.github/workflows/security-audit.yaml`.

## Environment and `AUDIT_PAT`

The audit job declares `environment: security-audit`, **whose deployment-branch-policy admits only `main` and `v*` tags** — both admin-only by the rulesets in `docs/specs/security-ci.md` -> "Automated Maintainer (tend)", so a write-scoped bot cannot reach its secrets from a feature branch.

- **Audit changes are iterated on `main` directly**: a `workflow_dispatch` from any other ref is rejected before any step runs. To experiment on a branch, widen the policy temporarily and revert after.
- **`AUDIT_PAT` is required.** A dedicated step verifies the secret is present before the audit step runs — after the checkout and install, not literally first — and refuses to continue otherwise (rationale).
- **The PAT is fine-grained and read-only**: `Administration` + `Secrets` + `Environments`, scoped to `diffplug/dormouse` only, minted on an admin's account, stored env-scoped.
- **No step may ever print `$AUDIT_PAT` or `$CLAUDE_CODE_OAUTH_TOKEN`.** The prompt passes the PAT only through an unexpanded `GH_TOKEN=` prefix, and `gh api` responses never carry secret values (rationale).

```bash
gh secret set AUDIT_PAT --env security-audit --repo diffplug/dormouse --body 'github_pat_…'
```

- **FAIL IF** the step that verifies `AUDIT_PAT` is provisioned before the audit runs is removed or bypassed (rationale).

Source of truth: `Verify AUDIT_PAT is provisioned` in `.github/workflows/security-audit.yaml`; `Never print a secret value` in `.github/audit/_preamble.md`.
