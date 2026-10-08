# Security Audit

> - Owns how the security specs are audited: the schedule and the release gate, the deterministic checks and the skip they allow, the four domains and their prompts, the orchestration contract, the three outcomes, the reporting steps, the embargo on finding detail, and the environment that holds `AUDIT_PAT`.
> - Defers what is audited to `docs/specs/security.md` and the specs it names, and each agent's procedure to its prompt in `.github/audit/`.
> - Read `docs/specs/security.md` first.

## Schedule and gate

`.github/workflows/security-audit.yaml` audits `docs/specs/security.md` and the specs it names: nightly at `04:21 UTC`, on `workflow_dispatch`, and on the release tag, dispatched by `.github/workflows/release.yml` whose `publish-vscode` job `needs:` it — so no release ships without a passing audit. Dispatched, not `uses:`-called — see `docs/specs/security-ci.md` -> "GitHub Actions Policies".

`FAIL IF` lines are grouped by the operation that answers them, one bullet asserting several properties when a single call establishes all of them; a qualitative pass looks for holes the specs do not cover. **On any `FAIL IF` violation or BLOCKER-severity finding the audit fails** ([Outcomes and reporting](#outcomes-and-reporting)).

- **FAIL IF** `.github/audit/_preamble.md` stops requiring every `FAIL IF` to run as a mechanical check (`gh api`, grep, file read, or a script run) with evidence, each clause its own PASS/FAIL and never satisfied in bulk, or a domain prompt drops its qualitative pass.
- **FAIL IF** `.github/workflows/security-audit.yaml` is missing or disabled, or any of the three separate things that make it a release gate is gone: the `gh workflow run` dispatch, the `gh run watch --exit-status` that turns a failed audit into a failed job, and `publish-vscode`'s `needs:` edge on that job (rationale). Pinned by `scripts/github-state-check.mjs` (disabled) and `scripts/security-audit.test.mjs`.

## Deterministic checks

**Every `FAIL IF` that GitHub state answers is judged by `scripts/github-state-check.mjs`, not a model** (rationale). The `Check GitHub state` step runs it on `AUDIT_PAT` before the domains start; it enumerates rulesets, environments, and secrets from the API, compares them with `.github/audit/expected-github-state.json`, and writes `audit-github-state.md` in the fragment form `.github/audit/_preamble.md` fixes, one line per clause. That fragment rides `AUDIT_FRAGMENTS`, so its verdict reaches the release gate through [Outcomes and reporting](#outcomes-and-reporting) and its detail follows [Embargo](#embargo) like any domain's.

- **A domain never re-derives a clause the fragment answers**; it reads the fragment as evidence and keeps the judgement bullets, the qualitative pass, and whether the expected-state file still encodes its spec.
- **A `FAIL IF` marked `Pinned by` a script or test in `pnpm test` is answered by running it**, not by reading the code it checks.
- **The check reads a 403 under `AUDIT_PAT` as scope drift, a `FAIL`**, any other failed call as `UNVERIFIABLE`, and never passes a clause it could not read; `--local` makes a 403 `UNVERIFIABLE` for an operator's own login.

- **FAIL IF** `Check GitHub state` is removed, runs after the agent, or its fragment leaves `AUDIT_FRAGMENTS`, or `scripts/github-state-check.mjs` stops failing a planted violation of any clause it judges. Pinned by `scripts/security-audit.test.mjs` and `scripts/github-state-check.test.mjs`.

Source of truth: `judge` in `scripts/github-state-check.mjs`; `Check GitHub state` in `.github/workflows/security-audit.yaml`.

## Skipping an unchanged audit

**A `schedule` run skips the four domains when nothing they read changed**: the last completed run on `main` succeeded, its `audit-state` artifact records this commit and this GitHub-state hash, and the full audit it descends from is under seven days old (rationale). The skipped run still runs the deterministic checks, writes an `audit-report.md` saying it skipped, and reports only `audit-github-state.md`.

- **FAIL IF** a `workflow_dispatch` run — the release gate's included — can skip, a run skips after a run that did not succeed or with a changed commit or hash, or a skipped run reports `PASS` over a GitHub-state fragment that did not pass. Pinned by `scripts/security-audit.test.mjs`.

Source of truth: `decide` in `scripts/security-audit-plan.mjs`.

## Domains

The CI audit fans out to four subagents, each owning a disjoint share of the tree; a domain may read outside its share — `application-security` runs the repo's own lints — but owns nothing there (rationale).

**Ownership is by file: every `docs/specs/security*.md` spec, its `.rationale.md` aside, is in exactly one domain's scope**, declared as backticked repo paths in the bullet list under the `**Scope` line of its domain file in `.github/audit/`, and enforced by `scripts/spec-lint.mjs`; `docs/specs/security.md` -> "How the guarantees are checked" tabulates the assignment.

`AUDIT_PAT` is a step-level `env:` on the one job, so every subagent inherits it, and only the prompt tells `application-security` and `hosted` not to use it (`docs/specs/security.md` -> "Known gaps"); `## Future` -> Credential separation stages the fix.

CI and the local runner share the prompts and their scopes in `.github/audit/` (rationale). The local runner uses the operator's `gh` authentication when no `AUDIT_PAT` is supplied; inaccessible local checks are inconclusive.

**The qualitative scopes are stated by subtraction, so adding a directory cannot orphan it** (rationale). `application-security` takes the remainder, worked out from `ls -A` rather than from a list. **Dotfile directories are named explicitly wherever they land**, and **the subtraction is recursive**: where a domain claims a subdirectory rather than a whole tree, the rest of that tree belongs to `application-security`.

- **FAIL IF** a `docs/specs/security*.md` spec (not a `.rationale.md`) is in no domain's scope, or in two, or a scope names a file that does not exist (rationale).
- **FAIL IF** `.github/audit/orchestrator.md` lets the orchestrator audit anything itself (rationale).
- **FAIL IF** the audit stops fanning out to a dedicated `application-security` subagent scoped to `docs/specs/security-local.md` and `docs/specs/security-remote.md`, or to a dedicated `hosted` subagent scoped to `docs/specs/security-hosted.md`, or either scope is merged back into a context that also carries another domain (rationale).
- **FAIL IF** `application-security` or `hosted` does not run on Opus and the mechanical domains on Sonnet, the stronger model on the code-reading domains, in **both** `.github/workflows/security-audit.yaml`'s `claude_args` — its `--model` sets the floor and its `--agents` raises those two domains — and `scripts/security-audit-local.sh` (rationale). Pinned by `scripts/security-audit.test.mjs`.
- **FAIL IF** `.github/audit/` is missing a prompt file the workflow names, or `scripts/security-audit-local.sh` stops running the audit from those same files (rationale), or exits zero after a failed process, a missing or unfinished fragment, or any verdict other than exact `VERDICT: PASS`. Pinned by `scripts/security-audit.test.mjs`.
- **FAIL IF** the union of the subagents' qualitative scopes does not cover every top-level path in the repository (rationale).
- **FAIL IF** `.github/audit/` or `.vscode/` is outside **any** consumer of `.github/workflows/workflow-audit.yaml`'s diff window — the commit list, `own_changes`, `is_clean_merge`, and both content classifiers' refusals, whose half is *derived* from the single `WINDOW` array. The security specs are deliberately *not* watched there (rationale).

Source of truth: the `**Scope` and `## Qualitative pass` sections of each domain prompt in `.github/audit/`; `claude_args` in `.github/workflows/security-audit.yaml`; `run_domain` in `scripts/security-audit-local.sh`.

## Orchestration

**Subagents launch in the background**, so an agent that ends its turn to await a completion notification is finished: an orchestrator ends the whole run, a delegating domain ships what it has (rationale). `.github/audit/orchestrator.md` and `.github/audit/_preamble.md` own the procedure; these are the invariants the workflow depends on:

- The job's timeout stays above the orchestrator's wait deadline (rationale).
- **Each domain appends to its own fragment as it determines each result**, and the fragments upload with the transcript, so an orchestrator that dies mid-merge still ships what the domains found.
- **A fragment opens `VERDICT: INCONCLUSIVE` and closes with the literal `<!-- END OF REPORT -->`**, its verdict rewritten once at the end. **The sentinel, not existence, is what a reader treats as finished** (rationale).

- **FAIL IF** the orchestrator prompt stops requiring a non-turn-ending wait — a Bash `until` loop over the fragments' sentinels, **breaking on its own sub-cap under the Bash cap the workflow sets** so every call ends by printing its answer, re-issued under a bounded 32-minute deadline **persisted to a file** (`$RUNNER_TEMP/audit-deadline`) rather than recomputed from `now`. That cap is `BASH_DEFAULT_TIMEOUT_MS` in `.github/workflows/security-audit.yaml`, set above the loop's 540-second break (rationale).
- **FAIL IF** the audit job's `timeout-minutes` in `.github/workflows/security-audit.yaml` is not above the orchestrator's persisted wait deadline (rationale), or `AUDIT_FRAGMENTS` there stops naming every domain's fragment. Pinned by `scripts/security-audit.test.mjs`.
- **FAIL IF** the prompt permits ending the turn without `audit-report.md` (rationale).
- **FAIL IF** a domain prompt lets findings be held for a write-up at the end, lets a domain that delegates end its turn or background its wait loop, or the wait, the merge, or the verdict treats existence rather than the sentinel as a domain having reported (rationale).
- **FAIL IF** the orchestrator can report `PASS` while a subagent left no report fragment — nor `FAIL`, unless some domain actually returned one: the prompt writes no status file when a fragment is missing and no domain failed, routing an audit that ran out of time to INCONCLUSIVE. Both exit non-zero and hold the release gate shut (rationale).

Source of truth: `.github/audit/orchestrator.md`; the fragment contract in `.github/audit/_preamble.md`; the wait and merge blocks run as shipped in `scripts/security-audit.test.mjs`.

## Outcomes and reporting

**The reporting step distinguishes three outcomes, not two.** Only the literal strings `PASS` and `FAIL` are honored (rationale).

| Outcome | `audit-status.txt` | Result |
|---|---|---|
| `PASS` | literally `PASS` | open failure issues auto-closed; nothing filed; exit zero |
| `FAIL` | literally `FAIL` | private issue filed; public issue filed or updated; exit non-zero |
| INCONCLUSIVE | missing, empty, or anything else | filed as for `FAIL`, the private issue reproducing the partial report and both saying it is not a security finding; exit non-zero |

- **A partial report can support `FAIL`; `PASS` requires every domain's completed checks.** A domain with any undetermined check returns `VERDICT: INCONCLUSIVE` unless it found a failure, and that prevents a merged pass.
- **Precedence is `FAIL` > INCONCLUSIVE > `PASS`**: a domain's dissent raises an inconclusive run to `FAIL` and never the reverse, and a `FAIL` alongside missing or unreadable fragments still reports them.
- **A title moves upward only.** An append retitles an open issue for `FAIL` alone, so an inconclusive run cannot relabel one already carrying findings; a PASS closes it.
- **With no `audit-report.md` the private report carries each fragment verbatim under its own heading**, unmerged (rationale).
- **Every fragment's verdict line, and its `UNVERIFIABLE`, `FAIL:`, `BLOCKER` and `WARNING` lines, are lifted into the private report's head**, the issue's own body; a cap on the findings never displaces a verdict line, and a fragment that matches nothing never fails the step (rationale).
- **The private report is split, never truncated**, by `scripts/clamp-issue-body.mjs` into the issue body and its comments, under a bounded part count; a helper failure files it as one part (rationale).
- **The `audit-transcript` artifact uploads during postprocessing**, 14-day retention; runner timeout or cancellation can prevent upload, and a missing artifact receives no download link (rationale).
- **A `FAIL IF` names only a condition an audit run can read**: the readable half is audited, and the rest is staged under `## Future` only while it is unbuilt, otherwise stated beside the rule. `AUDIT_PAT`-readable GitHub state stays audited (rationale).

- **FAIL IF** the `Redact secrets from agent output` step is removed, stops covering any sink later archived or filed (`audit-report.md`, every `AUDIT_FRAGMENTS` fragment, and the transcript), or stops failing closed by deleting those files when the redactor itself throws (rationale). Pinned by `scripts/security-audit.test.mjs`.
- **FAIL IF** the private report omits a note for a condition that holds — a dissenting, missing, unreadable, cut-off, or inconclusive domain, or no status — or any note asserts something about a condition other than its own, or the public issue's domain table omits one (rationale).
- **FAIL IF** either fragment guard is gated on the status at all (rationale).
- **FAIL IF** the reporting step accepts any domain verdict other than exact `VERDICT: PASS` as passing, fails to recognize a `VERDICT: FAIL` prefix as dissent, ignores an inconclusive domain, accepts a fragment with no completion sentinel as finished, or accepts status text other than literal `PASS`/`FAIL` (rationale).
- **FAIL IF** the audit has been weakened in a way no bullet above names — e.g. the prompt no longer requires the qualitative pass, a `FAIL IF` can be ignored, the failure-reporting step that opens a `security-audit-failure` issue and exits non-zero has been removed, or the `AUDIT_PAT` pre-check is removed or bypassed. **This bullet is a judgement item, not a checklist.**

The reporting step's known gaps are `docs/specs/security.md` -> "Known gaps" (rationale).

Source of truth: `Compose the audit report` and `Surface result, file or close issue` in `.github/workflows/security-audit.yaml`; reporting, redaction, and local-runner regressions in `scripts/security-audit.test.mjs`.

## Embargo

**Finding detail stays private until fixed** (rationale):

| Sink | Carries |
|---|---|
| Public `security-audit-failure` issue | the run link, the audited commit, each domain's verdict and its failed-check, BLOCKER, and WARNING counts, each failed check's spec and heading, and whether the private filing failed |
| Private issue in `diffplug/dormouse-embargo`, one per failing run | the whole report, titled with date and commit |
| `audit-transcript` artifact | age ciphertext of the transcript, `audit-report.md`, and the fragments |
| `audit-state` artifact | the audited commit, the GitHub-state hash, whether the domains ran, and when they last did |
| `Check GitHub state` job log | the GitHub-state verdict, its clause counts, and the hash |

- **FAIL IF** the public issue can carry finding text: it is posted from anything but the output of `scripts/security-audit-public-body.mjs` and the fixed private-filing notes, or that builder emits anything but fixed text, counts, validated run metadata, fragment names, and headings it found in the checked-out spec. A failed check naming no such heading, in the line form `.github/audit/_preamble.md` fixes, is counted, never quoted (rationale).
- **FAIL IF** `secrets.EMBARGO_TOKEN` is referenced anywhere but the `env:` of `File embargoed findings`, a workflow or job `env:` or a `$GITHUB_ENV` write could carry it to another step, or that step runs anything but `gh` and shell builtins (rationale).
- **FAIL IF** a non-PASS run whose private filing failed or was skipped can succeed, or its public issue omits that the filing failed; or a PASS run or `scripts/security-audit-local.sh` files anything.
- **FAIL IF** the `audit-transcript` artifact can upload anything but age ciphertext: its `path:` names a non-`.age` file, it uploads when `Encrypt the audit transcript` did not succeed, that step reads its recipient from anywhere but `.github/audit/transcript-recipient.txt`, or it stops running whatever the audit step's outcome (`if: always()`).
- **FAIL IF** `diffplug/dormouse-embargo` is publicly visible: an unauthenticated `curl -s -o /dev/null -w '%{http_code}' https://github.com/diffplug/dormouse-embargo` must print `404` (rationale). Pinned by `scripts/github-state-check.mjs`.

That the agent shares its job with these steps is `docs/specs/security.md` -> "Known gaps".

Source of truth: `Encrypt the audit transcript`, `File embargoed findings`, and `Surface result, file or close issue` in `.github/workflows/security-audit.yaml`; `scripts/security-audit-public-body.mjs`; embargo regressions in `scripts/security-audit.test.mjs`.

## Environment and `AUDIT_PAT`

The audit job declares `environment: security-audit`, **whose deployment-branch-policy admits only `main` and `v*` tags** — both admin-only by the rulesets in `docs/specs/security-ci.md` -> "Automated Maintainer (tend)" (rationale). A `workflow_dispatch` from any other ref is rejected before any step runs, so audit changes are iterated on `main`.

- **`AUDIT_PAT` is required.** A dedicated step verifies the secret is present before the audit step runs and refuses to continue otherwise (rationale).
- **The PAT is fine-grained and read-only**: `Administration` + `Secrets` + `Environments`, scoped to `diffplug/dormouse` only, minted on an admin's account, stored env-scoped.
- `gh api` responses never carry secret values (rationale).

- **FAIL IF** the step that verifies `AUDIT_PAT` is provisioned before the audit runs is removed or bypassed (rationale). Pinned by `scripts/security-audit.test.mjs`.
- **FAIL IF** a workflow step prints `$AUDIT_PAT` or `$CLAUDE_CODE_OAUTH_TOKEN`, or `.github/audit/_preamble.md` stops forbidding a domain to print a secret value or to pass the PAT any way but an unexpanded `GH_TOKEN=` prefix (rationale).

Source of truth: `Verify AUDIT_PAT is provisioned` in `.github/workflows/security-audit.yaml`; `Never print a secret value` in `.github/audit/_preamble.md`.

## Future

**Scope: audit-credential-separation** — [Credential separation](#credential-separation).

### Credential separation

A second job outside the `security-audit` environment, running the domains that need no PAT and passing their fragments back as artifacts, would leave `application-security` and `hosted` unable to hold `AUDIT_PAT` at all. The fragments would cross as ciphertext, and `File embargoed findings` would move to a job no agent ran on, holding the key to read them.
