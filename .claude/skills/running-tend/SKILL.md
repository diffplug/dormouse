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

## `tend check`'s org-level `repo-secret-allowlist` FAIL is a known false positive

`tend check` reports all ten `diffplug` org-level secrets (`BUILDCACHE_*`, `CHOCO_*`, `GPG_*`, `GRADLE_*`, `NEXUS_*`) as available to this repo's workflows. They are not. Every one has `visibility: selected`, and none of their selected-repositories lists includes `diffplug/dormouse` — verify with (org-admin only; the workflow token 403s on this endpoint, so take the ruling as given from CI):

```
gh api orgs/diffplug/actions/secrets/NEXUS_USER/repositories --jq '.repositories[].full_name'
```

The sweep enumerates org secrets without consulting visibility, so no repo-side configuration can clear it — the secrets are already at the tightest scoping GitHub offers. Do **not** add them to `secrets.allowed` in `.config/tend.yaml`: that entry means "any workflow here can read this token," which is false, and it would suppress the warning if one of them were ever genuinely shared with this repo. Filed upstream as [max-sixty/tend#993](https://github.com/max-sixty/tend/issues/993); leave the FAIL standing until it's fixed, and don't report it as new drift on [#339](https://github.com/diffplug/dormouse/issues/339).

## Settled upstream rulings — don't re-file

Before a `review-runs`/`review-reviewers` sweep flags a tend behavior as waste or files it upstream, check this list — these were already raised and ruled on, so re-filing burns a session and spams upstream:

- **`tend-review` silently running a full review on the bot's own PRs is intended, not waste.** The diff read *is* the review — it catches lint failures and edge cases even though self-approval is impossible, so a silent exit means the review ran and found nothing to post. Ruled intended behavior by the upstream owner in [max-sixty/tend#607](https://github.com/max-sixty/tend/issues/607) (closed as intended, same ruling as tend#212/#154). Do not treat self-review-of-bot-PRs no-ops as cost waste and do not re-file. (The companion `tend-mention` no-op on undirected bot comments, [tend#606](https://github.com/max-sixty/tend/issues/606), was *fixed* upstream — that one is resolved, not rejected.)
