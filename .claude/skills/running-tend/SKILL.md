---
name: running-tend
description: Project-specific guidance for tend workflows running on this repo.
---

No project-specific tend preferences yet beyond the notes below. Add guidance here as needed — this file is loaded by tend workflows alongside AGENTS.md.

## Filing issues in other repos

When asking permission to file an issue upstream (e.g. at `max-sixty/tend`), do **not** include the standing-exception offer ("I can treat this target as file-directly going forward"). nedtwigg wants to keep approving each cross-repo issue individually — keep asking each time, and skip the offer. ([diffplug/dormouse#168](https://github.com/diffplug/dormouse/issues/168#issuecomment-4836133002))

## The Chromatic `UI Tests` check is human-gated — don't wait it out in a gated-approval poll

After approving a visually-changing PR the approval is gated, so the CI Monitoring poll runs to dismiss-on-red. One status context — **`UI Tests`** (Chromatic, `target_url` → `chromatic.com/build...`) — stays `PENDING` for the entire poll because Chromatic holds it open until a maintainer accepts or rejects the visual diffs in the Chromatic UI; it does **not** auto-terminalize in-session. Its sibling **`Storybook Publish`** (also Chromatic) *does* terminalize normally, so this applies only to `UI Tests`.

When `UI Tests` is the only non-terminal check and every automated check is green (Build & Test, Visual Regression Tests, verify, Standalone Smoketest, Cloudflare Pages, Storybook Publish), treat it as human-gated: stop polling, confirm nothing flipped to FAILURE, and keep the approval standing — don't wait out the poll cap. Polling it to the cap wastes ~9–17 job-minutes per visually-changing PR with no added signal. (Observed on #203, #289, #317.)

## The maintainer's GitHub handle is `nedtwigg` — never `ntwigg`

`ntwigg` is the maintainer's local shell username (it shows up in prompt fixtures like `ntwigg@ntwigg-mac-2025` in [`terminal-prompt-shape.test.ts`](../../../lib/src/lib/terminal-prompt-shape.test.ts)) and also, on GitHub, an unrelated person's account. Writing `@ntwigg` in a comment, PR body, or commit message pings a stranger and subscribes them to the thread, which only they can undo. Use `@nedtwigg`, and don't copy the shorter handle forward from a thread that already contains the typo. ([diffplug/dormouse#389](https://github.com/diffplug/dormouse/pull/389#issuecomment-5319456021))

## Reviewing a PR that supersedes another — carry the prior PR's findings forward

Long-running work here gets rewritten and reopened rather than pushed onto one branch, so a PR body saying **"Supersedes #N"** (or "replaces", "redo of") is common. The successor's review reads only the successor: `bot-review-state.sh <n>` and the review skill's prior-review machinery are scoped to the PR under review, so findings the bot published on #N — including a review it was forced to post as a plain comment because #N closed mid-session — are not in context, and nothing else will re-raise them.

When the PR body names a predecessor, fetch the bot's own comments and reviews on it before reading the diff, and treat any finding that is still true of this diff as a finding of this review:

```bash
gh api "repos/$GITHUB_REPOSITORY/issues/<N>/comments" --paginate \
  --jq '.[] | select(.user.login == "dormouse-bot") | .body'
gh api "repos/$GITHUB_REPOSITORY/pulls/<N>/reviews" --paginate \
  --jq '.[] | select(.user.login == "dormouse-bot") | .body'
# Inline comments are a separate endpoint — the two above return bodies only,
# and inline is where the review skill puts every concrete fix. No login filter
# here: a maintainer reply on a thread means that finding was answered on #N,
# not missed, so it should not be carried forward.
gh api "repos/$GITHUB_REPOSITORY/pulls/<N>/comments" --paginate \
  --jq '.[] | {user: .user.login, path, line, body}'
```

All three, not a subset — on #398 the two body endpoints return 1 comment and 0 reviews between them, while 7 findings sit inline. Check each one against the current code rather than assuming it carried over — the maintainer often takes some and not others. Say which ones you re-checked, so "nothing else surfaced" means the predecessor was read, not that it was skipped. (Observed on #398 → #416: three findings written up as #398 closed mid-review, one adopted by the maintainer, one silently merged to `main` (#420), one re-derived from scratch by nightly ten hours later (#418).)

## Settled upstream rulings — don't re-file

Before a `review-runs`/`review-reviewers` sweep flags a tend behavior as waste or files it upstream, check this list — these were already raised and ruled on, so re-filing burns a session and spams upstream:

- **`tend-review` silently running a full review on the bot's own PRs is intended, not waste.** The diff read *is* the review — it catches lint failures and edge cases even though self-approval is impossible, so a silent exit means the review ran and found nothing to post. Ruled intended behavior by the upstream owner in [max-sixty/tend#607](https://github.com/max-sixty/tend/issues/607) (closed as intended, same ruling as tend#212/#154). Do not treat self-review-of-bot-PRs no-ops as cost waste and do not re-file. (The companion `tend-mention` no-op on undirected bot comments, [tend#606](https://github.com/max-sixty/tend/issues/606), was *fixed* upstream — that one is resolved, not rejected.)
