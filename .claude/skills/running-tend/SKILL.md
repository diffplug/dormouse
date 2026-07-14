---
name: running-tend
description: Project-specific guidance for tend workflows running on this repo.
---

No project-specific tend preferences yet beyond the notes below. Add guidance here as needed — this file is loaded by tend workflows alongside AGENTS.md.

## Filing issues in other repos

When asking permission to file an issue upstream (e.g. at `max-sixty/tend`), do **not** include the standing-exception offer ("I can treat this target as file-directly going forward"). nedtwigg wants to keep approving each cross-repo issue individually — keep asking each time, and skip the offer. ([diffplug/dormouse#168](https://github.com/diffplug/dormouse/issues/168#issuecomment-4836133002))

## Settled upstream rulings — don't re-file

Before a `review-runs`/`review-reviewers` sweep flags a tend behavior as waste or files it upstream, check this list — these were already raised and ruled on, so re-filing burns a session and spams upstream:

- **`tend-review` silently running a full review on the bot's own PRs is intended, not waste.** The diff read *is* the review — it catches lint failures and edge cases even though self-approval is impossible, so a silent exit means the review ran and found nothing to post. Ruled intended behavior by the upstream owner in [max-sixty/tend#607](https://github.com/max-sixty/tend/issues/607) (closed as intended, same ruling as tend#212/#154). Do not treat self-review-of-bot-PRs no-ops as cost waste and do not re-file. (The companion `tend-mention` no-op on undirected bot comments, [tend#606](https://github.com/max-sixty/tend/issues/606), was *fixed* upstream — that one is resolved, not rejected.)
