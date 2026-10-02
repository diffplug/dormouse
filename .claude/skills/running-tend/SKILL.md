---
name: running-tend
description: Project-specific guidance for tend workflows running on this repo.
---

Project-specific guidance for tend workflows. Add to it as needed; tend workflows load this file alongside AGENTS.md.

## Reviewing PRs: judge necessity before correctness

Ask whether a change carries its weight before asking whether it is correct. Apply these checks in **Review**, and fold what they find into the same review:

- **Must name the trigger for every new guard, retry, fallback, or state.** Name the actor (user action, peer, Relay, local same-user process) and the shipping configuration that reaches it, and cite the caller. If nothing reachable triggers it, that is the finding: drop it, or file an issue. Do not review the robustness of a mechanism that should not exist. Code no CI job runs (Windows-only paths, PowerShell) needs a proportionally stronger trigger.
- **Never answer a gap in a hardening mechanism by asking for more of it.** When a fix needs a fix (an unbounded retry, a missed owner case, a stuck state), first ask whether a smaller design avoids the problem, and propose that instead. For example, write the journal before ownership moves and refuse the move on failure, rather than adding phases, retries, and parking.

When these checks are the only findings, submit `COMMENT`, not `APPROVE`.

## Filing issues in other repos

When asking permission to file an issue upstream (e.g. at `max-sixty/tend`), do **not** include the standing-exception offer ("I can treat this target as file-directly going forward"). nedtwigg wants to keep approving each cross-repo issue individually — keep asking each time, and skip the offer. ([diffplug/dormouse#168](https://github.com/diffplug/dormouse/issues/168#issuecomment-4836133002))

## CI polls skip the `Hosted PR preview` deploy jobs

Append `--skip deploy --skip cleanup` after the PR number and SHA in every `poll_pr_checks.py` call (`poll` and `approval`). Those are the `Hosted PR preview` jobs bound to the `hosted-preview` environment, which requires a maintainer's approval. They sit in `waiting` until someone approves them, and `cleanup` starts on the PR's head when it merges. A poll that waits for either never finishes, and the session runs until the job timeout kills it. Neither job gates a merge. `verify`, which builds and tests Hosted, runs ungated and stays in the poll.

## A restart starts clean — don't carry a superseded PR's findings forward

Long-running work here is often closed and reopened as a fresh PR ("Supersedes #N"), and that restart is deliberate — nedtwigg: *"When I start over, I usually **want** to start over. The original conversation grew too unfocused and out of hand."* So review the successor on its own terms: don't fetch the predecessor's bot comments and reviews in order to re-raise findings from them, and don't treat a finding dropped that way as a gap in the review machinery. Carrying the closed thread's context forward is the thing the restart was for.

Proposed as an overlay note and rejected in [#421](https://github.com/diffplug/dormouse/pull/421#issuecomment-5361239323). The underlying incident (#398 → #416, where three findings written up as #398 closed mid-review went unre-raised) is easy to re-derive from session logs — a `review-runs`/`review-reviewers` sweep that rediscovers it should not re-file it here or upstream at `max-sixty/tend`.

## Settled upstream rulings — don't re-file

Before a `review-runs`/`review-reviewers` sweep flags a tend behavior as waste or files it upstream, check this list — these were already raised and ruled on, so re-filing burns a session and spams upstream:

- **`tend-review` silently running a full review on the bot's own PRs is intended, not waste.** The diff read *is* the review — it catches lint failures and edge cases even though self-approval is impossible, so a silent exit means the review ran and found nothing to post. Ruled intended behavior by the upstream owner in [max-sixty/tend#607](https://github.com/max-sixty/tend/issues/607) (closed as intended, same ruling as tend#212/#154). Do not treat self-review-of-bot-PRs no-ops as cost waste and do not re-file. (The companion `tend-mention` no-op on undirected bot comments, [tend#606](https://github.com/max-sixty/tend/issues/606), was *fixed* upstream — that one is resolved, not rejected.)
