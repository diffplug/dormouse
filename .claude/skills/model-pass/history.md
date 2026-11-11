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

### Follow-up, 2026-11-10: the findings left for a decision

The 16 `high` findings went to the maintainer one at a time, each as its own PR; all 16 merged. The other 280 open findings were sorted by the model under test into 13 classes, each with one default, so the maintainer accepted a table rather than answering 280 questions, and gave about ten product answers, asked one at a time.

| Class | Count | Default |
|---|---|---|
| Fix | 108 | Fix, one finding per commit |
| Text only (spec, comment, message) | 21 | Fix |
| Dead or legacy code | 26 | Delete |
| Needs a device to confirm | 21 | Check on the device before any code |
| Performance | 14 | Measure first |
| Security hardening | 9 | Fix |
| Needs a design | 12 | Four built; the rest deferred past launch |
| Needs the maintainer | 18 | One recommendation each |
| Release pipeline | 5 | Hold for the next tag dry run |
| Stale or duplicate | 30 | Close |
| Accepted as is | 16 | Close |

| Fix wave | Lanes | Fixed | Skipped | Already fixed | Opus tokens | Per fix |
|---|---|---|---|---|---|---|
| First (by area) | 9 | 163 | 8 | 5 | 3.57M | About 22k |
| Second (Windows-confirmed, a wire change, cross-cutting deletions) | 4 | 18 | 0 | 3 | 0.93M | About 52k |

All 13 lane PRs merged within a day of opening. Still open at close: 12 performance findings, the 5 release-pipeline items, 8 design items, the 8 skips that carry a real question, and the phone and Linux checks.

**Device checks.** Eleven Windows claims were run on a real machine, seven over SSH and four on screen by the maintainer. Six were confirmed and fixed, two did not reproduce and were dropped, one was harmless, one was measured and deferred, and one could not be exercised and was fixed on a best guess with a backstop: six real out of the ten exercised.

**Regressions and collisions the follow-up caused.**

- Nine lane PRs merging in one evening pushed a spec over its word budget five times; once the collision landed and left `main` red until the next lane re-baselined it. Several specs sat exactly at their budgets, so any two lanes that each added a sentence collided.
- Four canary patches went stale, and one lane was pushed with a stale canary because the push command did not gate on the canary test.
- One lane turned a silent failure into a rejected promise that four fire-and-forget callers did not handle. It was caught and fixed before merge.
- Two Windows-only tests ran in CI for the first time and failed on facts no macOS run shows (8.3 short paths, CRLF checkouts).
- The extra CI load exposed a timing flake in a test of the graceful stop, fixed in #1705.

**What worked and is kept.**

- The digest: classes with a default each, then questions one at a time.
- One implementer per lane, kept alive, so a review finding went back to the agent that wrote the fix.
- Running the device checks before writing the device fixes.

**Use next time.** Worker: Opus 5.5 or its successor. Priority areas last time: mobile UI and Pocket. Digest the undecided findings into classes as soon as the reviews end, leave slack in every spec budget a lane will touch before the lanes start, merge lane PRs one at a time with the canary test in the push gate, and book the device time while the reviews run.
