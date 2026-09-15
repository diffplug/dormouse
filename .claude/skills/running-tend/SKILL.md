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

## A restart starts clean — don't carry a superseded PR's findings forward

Long-running work here is often closed and reopened as a fresh PR ("Supersedes #N"), and that restart is deliberate — nedtwigg: *"When I start over, I usually **want** to start over. The original conversation grew too unfocused and out of hand."* So review the successor on its own terms: don't fetch the predecessor's bot comments and reviews in order to re-raise findings from them, and don't treat a finding dropped that way as a gap in the review machinery. Carrying the closed thread's context forward is the thing the restart was for.

Proposed as an overlay note and rejected in [#421](https://github.com/diffplug/dormouse/pull/421#issuecomment-5361239323). The underlying incident (#398 → #416, where three findings written up as #398 closed mid-review went unre-raised) is easy to re-derive from session logs — a `review-runs`/`review-reviewers` sweep that rediscovers it should not re-file it here or upstream at `max-sixty/tend`.

## Settled upstream rulings — don't re-file

Before a `review-runs`/`review-reviewers` sweep flags a tend behavior as waste or files it upstream, check this list — these were already raised and ruled on, so re-filing burns a session and spams upstream:

- **`tend-review` silently running a full review on the bot's own PRs is intended, not waste.** The diff read *is* the review — it catches lint failures and edge cases even though self-approval is impossible, so a silent exit means the review ran and found nothing to post. Ruled intended behavior by the upstream owner in [max-sixty/tend#607](https://github.com/max-sixty/tend/issues/607) (closed as intended, same ruling as tend#212/#154). Do not treat self-review-of-bot-PRs no-ops as cost waste and do not re-file. (The companion `tend-mention` no-op on undirected bot comments, [tend#606](https://github.com/max-sixty/tend/issues/606), was *fixed* upstream — that one is resolved, not rejected.)

## Nightly's tend workflow regeneration proposes a *downgrade* of Renovate-bumped pins — don't ship it

`.github/renovate.json` enables the `github-actions` manager, so Renovate bumps the `astral-sh/setup-uv` action pin and its `version:` input inside the generated `.github/workflows/tend-*.yaml` files ([#636](https://github.com/diffplug/dormouse/pull/636) took them to `v10.1.0` / uv `0.12.13`). The tend generator emits whatever its own release pins, which trails Renovate — at tend 0.2.7 that is `v10.0.1` / uv `0.12.10`. The uv pins are only the first instance: `actions/checkout` sits in all eight `tend-*.yaml` files under the same manager, and the only `enabled: false` entries for it are `max-sixty/tend` and `node`, so every Renovate-managed pin in a generated workflow collides this way once Renovate gets ahead of tend.

So `nightly_workflow_update.py prepare` reports `changed: true` on a regeneration whose diff carries that downgrade — today a same-version one touching only `tend-mention.yaml` and `tend-notifications.yaml`. **Never ship a pin downgrade.** Restore the repo's higher pins in the prepared worktree, then re-read the staged diff: if it is empty, skip the PR; if a real tend upgrade remains, ship that with the pins restored. Shipping the downgrade would revert a Renovate bump that Renovate re-applies on its Monday schedule, so the two would trade the pin back and forth every week. Abandoning a preparation needs no cleanup — `prepare` unlinks `$TMPDIR/tend-workflow-update.json` and force-removes the worktree before it does anything else, on every run.

This recurs on every nightly for as long as tend's pins trail the repo's. A real fix is either a Renovate rule that leaves the tend-generated workflows alone — making the files' `Regenerate with: uvx tend@latest init` header true — or an upstream change so tend preserves a pin already ahead of its own. Both are maintainer calls; raise them rather than assuming one.
