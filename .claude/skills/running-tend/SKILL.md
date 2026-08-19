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

## `tend check`'s `credential-environments` FAIL is known and maintainer-owned — don't re-file it as drift

`tend check` reports one standing FAIL on this repo: **`credential-environments`**, for the two release jobs that mint `id-token: write` outside any environment (`release.yml:build-standalone`, `release.yml:build-vscode`, for `actions/attest-build-provenance`). Clearing it needs a **new** environment whose deployment policy names only `v*` tags — repo-admin work the bot cannot do, and which must exist *before* any `environment:` key references it, or the next `v*` push auto-creates an unprotected one.

nedtwigg closed the drift issue ([#339](https://github.com/diffplug/dormouse/issues/339)) on 2026-08-18 with this FAIL outstanding and after discussing it in the thread, so the close is a decision, not an oversight. The nightly's step-2 dedup only searches **open** bot-authored issues, so a literal reading files a fresh drift issue every night. Don't: while `credential-environments` is the *only* FAIL, note it in the run summary and move on. File a new drift issue only when a **different** check starts failing — then scope the issue to that check and reference #339 for this one.

The standing offer in #339 still holds: once the environment exists, the workflow half is two `environment:` blocks on the release jobs, and the bot opens that PR on request.

## Settled upstream rulings — don't re-file

Before a `review-runs`/`review-reviewers` sweep flags a tend behavior as waste or files it upstream, check this list — these were already raised and ruled on, so re-filing burns a session and spams upstream:

- **`tend-review` silently running a full review on the bot's own PRs is intended, not waste.** The diff read *is* the review — it catches lint failures and edge cases even though self-approval is impossible, so a silent exit means the review ran and found nothing to post. Ruled intended behavior by the upstream owner in [max-sixty/tend#607](https://github.com/max-sixty/tend/issues/607) (closed as intended, same ruling as tend#212/#154). Do not treat self-review-of-bot-PRs no-ops as cost waste and do not re-file. (The companion `tend-mention` no-op on undirected bot comments, [tend#606](https://github.com/max-sixty/tend/issues/606), was *fixed* upstream — that one is resolved, not rejected.)
