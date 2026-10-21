---
name: audit-features
description: Audit Dormouse feature by feature against its specs for reachable bugs and unnecessary complexity, then deliver small validated PRs. Use for a requested audit, bug hunt, quality pass, or time-boxed (e.g. overnight) sweep across features — not for implementing or reviewing a single change.
---

# Audit features

Success is fewer user-visible failures and less code to maintain, not PR or test count.

## Scope

Take scope, exclusions, delivery permissions, and time budget from the user. A timed run needs a dated stop time with timezone; never inherit a previous run's. This skill grants no merge, deploy, or messaging authority. Sub-agents may do read-only per-feature review; fixes and PRs stay with you.

Derive the feature checklist from the spec index in `AGENTS.md`. Design under `## Future` is unbuilt scope, never a gap to fill.

## Per feature

1. Read the spec and the rationale for the sections in play, then the entrypoints on each host that ships the feature.
2. For each candidate, apply [running-tend's necessity checks](../running-tend/SKILL.md#reviewing-prs-judge-necessity-before-correctness), then record the consequence (lost edit, wrong-target input or kill, broken persistence, platform failure), who hits it, how often, and the strongest evidence obtained.
3. Act on the evidence:

   | Evidence | Action |
   |---|---|
   | Reproduced on the shipping path, or a reachable caller traced in source | Fix, PR |
   | Plausible, but no reachable caller found yet | Ledger, as a candidate; no code |
   | Only a mock, test, or Strict Mode unmount reaches it | Ledger, as not a bug; no code |

   A mock that permits an impossible callback proves nothing: [#1313](https://github.com/diffplug/dormouse/pull/1313) guarded a page teardown that no shipping build performs, and closed. A late async result is a hypothesis; check whether disposal or an existing cancellation already covers it before adding a generation counter.
4. Make the smallest repair, preferring deletion or an existing authoritative signal over a new observer, retry, or fallback state.
5. Pin it with a regression that fails on the baseline at the intended assertion, not on a fixture that cannot start. Repair broken fixtures without weakening them: [#1320](https://github.com/diffplug/dormouse/pull/1320) uses real Windows junctions rather than mocking directory resolution.
6. Mark the feature's coverage in the ledger.

For IME, touch, clipboard, focus, and process behavior, say whether the evidence is simulated ordering or native behavior. The [browser harness](../debug-standalone-agent-browser/SKILL.md) simulates one window, and real-Tauri stdio, ConPTY, and sidecar bugs do not reproduce in it (`TESTING_AND_MODIFICATION_GUIDE.md` §8); a feature checked only there is covered "harness only".

## PRs

Keep the open batch small enough to read its review before opening more. One PR per independently explainable outcome; group tightly coupled fixes, never unrelated behavior. Stack only real dependencies, and set the GitHub base explicitly. Each description states the reachable before/after, its validation, and its limits. When review disproves necessity, close the PR and drop it from the combined tree. Never carry a rejected parent's change in through a child.

## Combined validation

Periodically merge every retained branch into one throwaway worktree and run the full gate:

```
wt switch --create audit-combined --base origin/main
git merge <branch>...
pnpm install && pnpm test && pnpm build
```

This catches interactions and combined spec word budgets that no single PR trips. Reproduce any unexpected failure on the unchanged baseline with the same command before blaming a change; a failure the baseline shares is a limitation, not a pass. For visual changes, read the Argos diffs (Chromium and WebKit) and tell an expected change awaiting approval from a rendering defect or a story that captured before it was ready.

## Ledger

Keep it in the session scratchpad, never in the tree, and keep only current state; move superseded results to a dated history section.

```
Baseline: <sha>   Combined: <sha> (pnpm test ✓ / build ✓)   Stop: <date time tz>

| Feature | Coverage | Finding | Evidence | Disposition | Branch / PR → base |
```

Coverage is one of: not reviewed, reviewed – no finding, candidate, reproduced, fixed, harness only. Also list runtime resources you own (harnesses, browser sessions, worktrees) so handoff can release exactly those.

## Handoff

Near the stop time, take no new wide change; spend what remains on open review, CI, and verification. Before reporting, confirm every branch is pushed, CI and review are current, and each stack's merge order is stated.

"Merged" on GitHub can mean merged into another feature branch. Check the target itself:

```
m=$(gh pr view <n> --json mergeCommit --jq .mergeCommit.oid)
git fetch origin main $m
git merge-base --is-ancestor $m origin/main && echo landed
```

Check stack parents too: [#1309](https://github.com/diffplug/dormouse/pull/1309) merged into [#1283](https://github.com/diffplug/dormouse/pull/1283)'s branch, which closed unmerged, so #1309 never reached `main`. When a parent was itself squashed into `main`, its child's commit is not an ancestor even though the code landed; inspect the code on `origin/main` instead.

Report fixes as proposed, merged into a stack, or on the target; then coverage gaps, baseline failures, pending visual approvals, and unproven candidates, each separately. Link the PR queue and the ledger.
