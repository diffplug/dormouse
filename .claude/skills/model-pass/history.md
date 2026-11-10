# Model pass history

One section per pass, newest first, written at close-out from `ledger.mjs scorecard`. The next pass reads the newest section to choose its worker model and to judge whether its own yield is better or worse.

## 2026-11-09: Claude Fable 5.2 (pass 1)

**Verdict.** Worth doing once before launch; not worth the way it was run. The maintainer's judgment after the first fix PR was "not a great use of Fable tokens", and the pass could not answer whether Fable finds more than Opus, because no unit was reviewed by both. This skill was written from that pass.

| | Model under test: Fable 5.2 | Worker: Opus 5.5 |
|---|---|---|
| Review units | 32 in the first wave, then 2 (mobile, Pocket) | 16 in the second wave, plus one interrupted unit resumed |
| Tokens per review unit | About 750k in the first wave (not recorded per unit); 407k measured on the last two | 338k measured (267k to 441k) |
| Findings | 533 in the first wave; 28 on the last two units | 123 |
| `high` findings | 29, all in the first wave | 0 |
| Findings per unit | 16.7, then 14 | 7.7 over the 16 new units |

The two columns are **not comparable**: the first wave took the core library, both desktop hosts, and the remote stack, and the second took what was left (the website, installers, CI, scripts, docs). The lower yield on the right is as likely the units as the model.

| Outcome | Count |
|---|---|
| Findings | 684 across 50 units |
| Fixed and merged | 381 |
| Left for a maintainer decision | 267, 15 of them `high` |
| Skipped by an implementer, with a reason | 30 |
| Disproved | 6 |
| Pull requests | 20, all merged |

**Fix cost.** Six Opus fix lanes in the second wave used 1.63M tokens for 109 fixes, about 15k each. Of the 125 findings those lanes logged, implementers fixed 109, skipped 11, and disproved 5, all five because `main` already had the fix.

**Regressions the pass caused.**

- A dead-export cleanup removed a name `lib/.storybook/preview.ts` still imported, which blanked every Storybook story until Argos ran. Tests and Storybook config are type-checked since #1646.
- A build-script edit added a path containing `prebuilds`, and pnpm skips a `pre<name>` hook whenever the body of `<name>` contains that hook's name, so `prebuild` stopped running and `pnpm build` failed in a fresh clone. CI ran tests first, which hid it. Fixed and tested in #1643.
- Three audit canary patches stopped applying after fixes changed lines they quote.
- During the follow-up on open `high` findings, an implementer's new jsdom test of the Markdown editor failed an `assert.equal` on two DOM nodes, `node:assert` deep-inspected both documents to build the message, and one Node process reached 122 GB before the maintainer noticed. The implementer brief now bounds memory and time on every run of a new test.

**What went wrong in the process.**

- Thirty-two units went to the most expensive model before any finding had been fixed, so the first evidence of value arrived after two token resets.
- Early fixes were written in the main session on the model under test.
- The first PR was a small batch that undersold what the ledger held.
- Per-agent token counts for the first wave were never written down, so its cost is an estimate.
- Nothing was run on a phone, Windows, Linux, or a packaged build. Every such claim was traced in source.

**What worked and is kept.**

- The reviewer brief: a named trigger, a cited caller chain, an evidence level, and a 200-word reply kept findings checkable and the main session small.
- One finding per commit with a test proven to fail on the old code; implementers skipped freely and said why.
- A cross-unit synthesis by the model under test, which is where the process proposals came from.
- Opus as both bulk reviewer and implementer.

**Use next time.** Worker: Opus 5.5 or its successor. Priority areas last time: mobile UI and Pocket.
