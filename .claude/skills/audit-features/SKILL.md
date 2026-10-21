---
name: audit-features
description: Audit Dormouse feature by feature against its specs for reachable bugs and unnecessary complexity, validate focused fixes, and deliver reviewable PRs when authorized. Use for requested broad or time-boxed quality passes, not routine single-feature implementation or PR review.
---

# Audit features

Aim for fewer user-visible failures and less code to maintain. PR count, test count, and hours spent are evidence of activity, not success criteria.

## Set the scope and map the system

Use the user's requested scope, exclusions, delivery permissions, and time budget. A timed pass needs a dated stopping time and timezone; do not inherit a previous run's deadline. Reuse existing authorization rather than asking again. This skill does not authorize merging, deploying, messaging others, or starting additional agents.

Read `AGENTS.md` and `docs/specs/glossary.md`, then derive a feature checklist from the current spec index. Follow the repository's worktree and Dormouse tooling instructions. Consult `TESTING_AND_MODIFICATION_GUIDE.md` for relevant test entrypoints, checking that any branch-specific advice still applies.

Before proposing fixes, inspect the baseline commit, working-tree state, open PRs, and representative entrypoints across the affected hosts. Read each feature's spec and relevant rationale before changing it. Treat design below `## Future` as unbuilt scope, not missing implementation to fill during an audit.

Track coverage separately from findings: distinguish reviewed with no finding, candidate needing evidence, reproduced defect, fixed, and not reviewed. A passing package suite alone does not establish feature coverage.

## Establish necessity before adding code

Apply [running-tend's necessity checks](../running-tend/SKILL.md#reviewing-prs-judge-necessity-before-correctness) before designing a fix. For each candidate, record:

- The actor, shipping configuration, reachable caller, and sequence that violates an owning contract.
- The actual consequence, likely frequency, and affected users.
- The evidence obtained: source analysis, synthetic events, real browser interaction, native host behavior, or physical-device reproduction.
- The smallest repair, including deletion or reuse of existing authoritative state.

Prioritize lost edits, wrong-target input or process termination, broken lifecycle/persistence, and demonstrated platform failures. An async result arriving after its owner changes is a useful hypothesis to investigate, not a reason to add generation counters everywhere. Check whether disposal, identity, or an existing cancellation path already guarantees the behavior.

A mock that permits an impossible callback or an unmount with no shipping caller proves little. Trace the real lifecycle before adding guards. For IME, touch, clipboard, focus, and process behavior, explicitly separate simulated ordering from native behavior; seek the latter when it changes the severity or justifies the mechanism.

Do not label every rare race a release blocker. Record uncertain candidates without implementing speculative defenses. Respect rejected scope; do not reintroduce a rejected parent change through a child PR.

## Make a small batch reviewable

Choose coherent changes with independently explainable outcomes. Group tightly related fixes or test maintenance when that reduces review cost; separate unrelated product behavior. Keep the active batch small enough to read its feedback and finish its validation before opening more. Avoid a PR per assertion or a broad rewrite justified only by tidiness.

Prefer an existing authoritative signal over a second parser or observer. If a proposed fix needs retries, fallback states, or additional bookkeeping, reconsider whether the ownership boundary can be made simpler first.

Use independent PRs when changes do not depend on one another; stack only real dependencies and record the GitHub base explicitly. Worktree ancestry alone does not set a PR's review base. Update owning specs with behavior changes under `AGENTS.md`'s conventions; keep test mechanics beside tests.

Describe the reachable before/after behavior, relevant validation, and material limitations in each PR. If review disproves necessity, withdraw the change and remove it from the combined validation tree.

## Validate the failure, then the combination

Use a focused regression when it meaningfully pins the contract. Check that the original fails at the intended assertion, not because a fixture cannot create a symlink, load a dependency, or start a process. Validate the smallest affected suite and types, then the relevant package or host boundary.

Reproduce suspicious pre-existing failures on the unchanged baseline with the same runtime and command. Separate product defects, fixture portability, environmental prerequisites, and flaky timing. Preserve assertions when repairing fixtures: real Windows junctions can exercise directory resolution without replacing it with a mock. A failure matching an old baseline remains a limitation, not a passing check.

For UI or cross-process fixes, exercise the shipping path where feasible. Use [the standalone browser harness skill](../debug-standalone-agent-browser/SKILL.md) when appropriate, subject to current `AGENTS.md` tooling rules. Drive commands through the terminal under test rather than injecting its credentials into an external CLI. Use fixtures for destructive lifecycle tests and keep clear ownership of browsers, processes, and surfaces.

Periodically combine the retained changes in an isolated validation worktree. Run the relevant full suites, build, and repository checks there to catch interactions and combined spec budgets that individual PRs miss. Associate results with commits; if later changes are only tests, verify that production source is unchanged rather than claiming an unrun build. Broaden or repeat checks only for changed code, failures, or unresolved concerns.

Inspect visual baselines, current images, and diffs in each affected browser. Distinguish an expected change awaiting approval from a rendering defect or missing snapshot readiness. Fix timing from observed lifecycle evidence; do not retry until green or approve unexplained differences.

## Close the loop

Keep a concise current ledger outside tracked product files: baseline and validated commits, feature coverage, findings and dispositions, branch/worktree/PR/base, reproduction and test logs, owned runtime resources, and remaining limitations. Separate historical observations from current results so stale failures or unfinished notes cannot become the handoff.

For a timed run, reserve time for feedback, integration checks, and delivery. Do not start a new wide change near the deadline just to stay busy. If the user asked to remain active until a time, use the remaining window for unresolved review, CI monitoring, and handoff verification; otherwise finish when the agreed scope is complete.

Before handoff, verify pushed commits, clean task worktrees, current CI and review status, and each stack's merge order. Leave active worktrees and unrelated processes intact. Report coverage gaps, baseline failures, expected visual approvals, and unproven candidates separately from completed fixes.

When asked whether the work landed, fetch the intended target branch and inspect its actual code. GitHub's "merged" may mean merged into another feature branch. Check stack parents as well as children; fetch missing merge commits before checking ancestry, and inspect the resulting patch when squash or rebase makes ancestry inconclusive. A closed parent can strand a merged child.

Summarize user impact, important simplifications, validation and its limits, and outstanding decisions. Link the PR queue and ledger. State whether fixes are merely proposed, merged into a stack, or present on the intended target. Do not equate review approval, a timeout diagnostic, or a passing rerun with proof that the underlying problem is solved.
