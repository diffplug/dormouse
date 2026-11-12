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

Sixteen `high` findings went to the maintainer one at a time, each as its own PR, and all 16 merged: the 15 the table above counts as left for a decision, and one an implementer had skipped. The table also counts 252 other findings left for a decision; by the time the rest were digested, one of them had been fixed, so the digest took the remaining 251 and 29 of the 30 implementer skips (the table counts skips on their own row): 280 findings, sorted by the model under test into 13 classes, each with one default, so the maintainer accepted a table rather than answering 280 questions, and gave about ten product answers, asked one at a time.

| Class | Count | Default |
|---|---|---|
| Fix | 108 | Fix, one finding per commit |
| Text only (spec, comment, message) | 21 | Fix |
| Dead code | 18 | Delete |
| Pre-launch compatibility code | 8 | Delete |
| Needs a device to confirm | 21 | Check on the device before any code |
| Performance | 14 | Measure first |
| Security hardening | 9 | Fix |
| Needs a design | 12 | Four built; the rest deferred past launch |
| Needs the maintainer | 18 | One recommendation each |
| Release pipeline | 5 | Hold for the next tag dry run |
| Already fixed on `main` | 12 | Close |
| Duplicate of another open finding | 18 | Close |
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

### Follow-up, 2026-11-11: the tail, three nets, and what a real machine changed

After the two fix waves the maintainer answered the remaining questions one at a time (19 in all), then approved deeper work. Sixteen more PRs merged in two days and three were open when this was written. Opus did all of it for about 7.7M tokens; the figure for one long-lived implementer is approximate, because its counter restarted when its context was compacted.

**Three nets, each built to record what it found, not fix it.** Each suite keeps a `KNOWN` table: a finding runs as an expected failure with its evidence, and the fix lane's job is to delete the entry.

| Net | The class it covers | Caught on its first runs |
|---|---|---|
| Real-shell conformance suite, on Linux, macOS and Windows in CI | Native behavior nobody ran (55 of 144 broken) | 6 product bugs, and 3 faults in the suite itself |
| Adapter contract suite, one set of cases for all five `PlatformAdapter` implementations, and the fake PTY held to the real one | Two implementations of one contract disagree (18), a fake doing what the real system cannot (30) | 4: one adapter, three in the fake |
| Model test of the alert layer, with the spec's own state diagrams as the oracle | A state machine missing an edge (22) | 7 from 4 causes, in a module the pass had already reviewed |

All 17 are fixed, the last seven in a PR still open when this was written. The model test needs a spec that draws its machine, and only `alert.md` does.

**What a real machine changed.** A Windows laptop reachable over SSH was used throughout: a temporary clone, the repo's own tests, deleted afterwards.

- Output flow control passed every test and a headless Chrome measurement, and was wrong on Windows: Ctrl+C cannot reach a program whose PTY is paused, because the console host takes no input while it is blocked on output. A 150-line probe on the real machine separated that from the two other explanations in one run. The design gained a rule for it.
- The same work found that macOS discards a dead process's unread output past 1 KB, and that a hidden page parses about 540 chars a second on timers. Each changed the design; none was visible from a test on one OS.
- The first Windows run of the shell suite took 14 minutes and found the suite did not exit there. CI would have shown a timeout and nothing else.

**What a second agent changed.** Three times an agent with no stake in the work overturned the main session.

- An independent reviewer of flow control found its admitted data loss was wider than stated and that deleting one line left every test green.
- Asked to choose between three designs with no opinions supplied, an evaluator rejected the small one the main session had offered, with measurements, and proposed the fail-open watchdog that made the large one acceptable.
- A researcher established that `inert` does not reach a framed document by the standard's own design, which the main session had doubted, and measured a fix the main session had recommended deferring.

The repository's review bot did the same at smaller scale: it found an accounting bug in that watchdog, a known-failure mark wide enough to hide a second bug, and two wrong counts in this file.

**Mistakes the main session made.**

- It asked the maintainer a question from memory of a finding and described it wrongly; his answer rebuilt a bug, which was built and then dropped. Re-read the finding before asking.
- It said nothing in CI ran PowerShell, when a parse step did.
- It promised 27 GB from deleting worktrees and freed 6, having counted hard-linked packages once per worktree.
- It resolved two review threads before its replies had posted.
- It recommended against merging flow control, then offered a rate cap, before either had been evaluated by anyone but itself.

**What worked and is kept.**

- A net first, then the fix lane: the finding arrives as a failing test with a reproduction, and "done" is an empty table.
- Findings, not fixes, inside a net's own PR, so the maintainer sees what it caught before anything changes.
- Design briefs with a written assessment first and a rule for stopping there.
- The real machine in the loop during the work, not only on a checklist afterwards.
- Stacked work held as a branch until its base merges.

**Still open when this was written.** The next pass should not rediscover these.

- Tracked as issues: the escape-sequence parser and xterm.js disagreeing about where a string control ends (#1715), and three native checks of Workspaces never run in a real build (#1750).
- Never run on a device: the phone findings (`mobile-04`, `mobile-05`, `hosted-server-a-09`, `browser-web-21`), two Linux ones (`rust-lib-20`, `rust-other-03`), and flow control in a real minimized window on Windows or Linux. The ledger's `DEVICE-CHECKLIST.md` is the list.
- Waiting on a decision: a kitty-keyboard depth counter that never resets on Windows (`termstate-11`), where the obvious fix breaks shells that set those flags themselves.
- Deliberately left: five release-pipeline findings, eight design items deferred past launch, and the performance findings measured as small (the ledger's `perf/RESULTS.md`).
- No net exists for the second-largest class, sibling paths in one module that drifted apart (33 broken). The model test covers one state machine; the terminal lifecycle, the browser pane lifecycle and Workspace transfer have no drawn model to test against.

**Use next time.** Worker: Opus 5.5 or its successor. Priority areas last time: mobile UI and Pocket. Digest the undecided findings into classes as soon as the reviews end, leave slack in every spec budget a lane will touch before the lanes start, merge lane PRs one at a time with the canary test in the push gate, and book the device time while the reviews run. After the fix waves, build a net for each large root-cause class before fixing its findings by hand. Put a real machine for each OS within reach of the lanes. Before merging anything large, give it to an agent that did not write it, with the code and no conclusions.
