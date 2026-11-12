---
name: model-pass
description: Run a staged, budgeted whole-repository audit when a new model is released, to learn whether that model finds real problems the previous one missed and whether the findings are worth the spend. Use whenever the maintainer asks to "let the new model take a pass", to read or audit the whole project with a new model, to compare models on this codebase, or to repeat the pre-launch audit. It pilots three units against a control model, reports a scorecard, and stops for a go/no-go before any fan-out. For a feature-by-feature bug hunt with no model comparison, use audit-features instead.
---

# Model pass

A model pass answers one question before it answers any other: **does the new model find problems on this codebase that the previous one did not, at a price worth paying?** The first pass (`history.md`) spent two full token resets before the maintainer saw a single pull request, and his verdict was "not a great use of Fable tokens". Everything below exists so the next pass shows evidence early, spends the expensive model only where it leads, and leaves a scorecard the pass after it can be compared against.

Three roles, named this way throughout:

- **Model under test** — the new model. It runs this session, reviews the pilot, and writes the synthesis.
- **Control** — the best previous model. It reviews the same pilot units, so the comparison is like for like.
- **Worker** — the cheapest model that passed the last pass's precision check (the control, unless `history.md` says otherwise). It does bulk reviews and every fix.

[audit-features](../audit-features/SKILL.md) owns the standards for a single finding (evidence table, necessity checks, the smallest repair, a regression that fails on the baseline) and for a PR. This skill owns the staging, the budget, and the comparison, and defers to it for the rest.

## The ledger

A pass lives in a **ledger**: a directory outside the repository, by default `~/projects/dormouse-audit-<model>-pass-<n>/`. It holds unfixed findings, some of them security-relevant, so it never enters this public tree; ask the maintainer whether it belongs in the private embargo repository instead. `scripts/ledger.mjs` creates and reads it. Run it from the repository root, with `MODEL_PASS_LEDGER` exported or `--ledger <dir>` on each call:

| Command | What it does |
|---|---|
| `init --ledger <dir> --worktrees <dir> --base origin/main [--previous <older ledger>]` | Snapshots the tree, renders both briefs, cuts the tree into review units from `references/units.json`, and fails if any tracked file is in no unit. |
| `units` | Re-cuts `units/` and `assign/` after an edit to `references/units.json`. |
| `show [--control] <unit> <nn>…` | Prints findings. Read findings this way; never read a findings file whole into the main session. |
| `list` | Regenerates `REVIEW-LIST.md`: every finding with what happened to it. |
| `run <name> <role> <model> <tokens> <duration-ms>` | Records one finished subagent. The numbers exist only in its completion notification, so record each as it arrives. |
| `scorecard` | Reviews by model, pilot overlap, fix-lane cost, reviewer precision. This is what the maintainer decides on. |
| `queues` | Turns `lanes.json` into one fix queue per lane. |
| `pr <lane> <branch> <base> <new\|number> <title> [--limits <text>] [--dry-run]` | Pushes a finished lane and opens its draft PR from the lane's fix log. |

`init` failing on unassigned files is the catalogue telling you the tree has moved since the last pass. Fix `references/units.json` in the same change that runs the pass; a file in no unit is a file nobody reads.

## Stage 0: agree the terms

Settle these with the maintainer before spending anything, and write them at the top of `<ledger>/notes.md`:

- **Budget**, in tokens of the model under test, and what share the pilot may use (a tenth is a good default).
- **Priority areas**: what he cares about most this time. Those units get the model under test whatever the pilot says.
- **The control and the worker**, by model name.
- **Backlog first.** Read the previous ledger's `REVIEW-LIST.md`. Findings still marked as needing a decision will be found again and paid for again, so ask him to sort them into `fix`, `defer`, `ignore`, or `declined` in `decisions.tsv` first, then run `list --ledger <previous>` so `REVIEW-LIST.md` carries the answers, or accept that the pass will re-find them. Reviewers read only that file, and the brief tells them never to re-report a recorded decision.

Then run `init`, create `<worktrees>/review-main` from `origin/main`, and run `pnpm install && pnpm build` there so reviewers have a built, read-only checkout.

## Stage 1: pilot

Pick **three units**:

1. One the previous pass reviewed heavily (its findings are in the previous ledger, a free second comparison).
2. One in the maintainer's priority area.
3. One of a different kind from both: an installer, the CI and lints, a wire contract.

Review each unit twice, once with the model under test and once with the control, all six at once. Each reviewer gets the same prompt apart from the output path: the model under test writes `findings/<unit>.md`, the control writes `control/<unit>.md`. The prompt is three sentences: read `<ledger>/assign/<unit>.md`, read the brief it points to, carry it out. The brief (`references/reviewer-brief.md`) already demands a traced caller, an evidence level, a root cause, and a 200-word reply; adding to it per reviewer makes the comparison unfair.

When they finish:

1. Record each with `run`.
2. **Match the findings.** For each unit, read both summary tables and write `pilot.tsv`: one tab-separated row per distinct problem, holding the unit, the model-under-test finding id or `-`, the control finding id or `-`, and the severity (the higher of the two sides'). Two write-ups of one defect are one row even when they propose different fixes.
3. **Verify a sample.** For every finding only one model reported at `med` or above, and five others per unit, confirm the cited caller chain in the code yourself. A model that reports more is not ahead if the extra findings are wrong. Note each disproved finding in `decisions.tsv` as `declined` with the reason.
4. **Fix a handful now.** Queue the pilot's five to ten clearest sure-fix findings to one worker implementer (Stage 4), and open that PR. The maintainer judges fix quality from a real diff, and the first pass's largest mistake was making him wait for one.

## Gate A: go, narrow, or stop

Stop and report. Lead with the answer, then the `scorecard` output, then the PR link. The report must state:

- Per model: tokens per unit, findings per unit by severity, how many survived verification, and tokens per verified `high` or `med` finding.
- **Found only by the model under test**, at `med` or above, each in one line. This list is the case for the new model; if it is empty or trivial, say so plainly.
- Found only by the control, the same way.
- What the full pass would cost at these rates, for each option below.

Then recommend one, and wait for his answer:

- **Go wide** — the model under test reviews everything. Justified only when its only-found list is clearly stronger on all three units.
- **Narrow** — the model under test reviews the priority areas and any kind of unit where it led; the worker reviews the rest. This was the right answer in the first pass, reached too late.
- **Stop** — the pilot's fixes are the deliverable. A new model that finds nothing new on three units is a result worth having, and cheap.

## Stage 2: fan out

Launch reviewers in waves of at most twenty, each on the model Gate A assigned its unit. Hold the cross-cutting units (`cross` in `units.json`: dead code, dependencies, wiring, performance, duplication) until the file-owning units are done, since they build on what those found. Record every completion with `run`, and run `list` after each wave.

- A reviewer that a safeguard stops mid-unit leaves a partial file, because the brief has it checkpoint as it goes. Rerun that unit on the worker with instructions to keep the existing findings and continue.
- Keep the main session out of the detail. Reviewers reply in 200 words; the findings stay on disk.
- Do not launch a second pass over the same units. When a wave of units returns no `high` finding, the remaining yield is polish, and the stop rule in Stage 6 applies.

## Stage 3: synthesis

This is where the model under test earns its cost, so do it in the main session or one subagent on that model. Read every findings file's summary table and the previous `history.md` row, and write `<ledger>/META.md`: the recurring root causes with counts, which existing test or lint should have caught each class, and at most eight proposals ranked by findings prevented per unit of work. The **Root cause** and **Should have been caught by** lines on each finding are there to make this a tally rather than a re-read.

## Stage 4: fix lanes

Never fix in the main session: a fix costs the worker about 15,000 tokens and costs the model under test several times that for the same diff.

1. Write `<ledger>/lanes.json`: one lane per area, each with its branch, its units, the directories it may touch, and **notes that override the findings**. The notes are where your judgment goes: which finding is most serious and goes first, which are product decisions to skip, what cannot be run on this machine. Run `queues`.
2. For each lane, create a worktree and branch from `origin/main` yourself, then launch one worker implementer pointed at `<ledger>/FIXBRIEF.md` and `<ledger>/queue/<lane>.md`. The brief has it re-verify each finding, make the smallest repair, prove the test fails on the old code, commit one finding at a time, log to `fixlog/<lane>.md`, and never push.
3. When a lane reports, do the integration in the main session, because a subagent is not allowed to merge: `git -C <worktree> merge origin/main`, resolve conflicts, then run `cd lib && pnpm exec tsc -b`, `cd standalone && pnpm exec tsc --noEmit`, `pnpm --filter dormouse typecheck`, `node scripts/spec-lint.mjs`, and `node --test scripts/security-audit.test.mjs scripts/security-audit-canary.test.mjs`. Then `pr`, and mark it ready.

CI is the full gate for a lane. Six lanes running whole suites at once push the machine's load past the point where timing tests pass, and a local green under that load proves little.

Traps that each cost a round in the first pass:

- **Spec word budgets collide.** Two lanes that each add ten words to one spec both pass alone and fail merged. Implementers never ratchet; re-baseline in the main session, in the PR that crosses the line.
- **Audit canaries go stale** when a fix changes a line a seed patch quotes. The implementer reports it; refresh only the context lines, and check the seed still applies and still plants its defect.
- **A removed export may still be imported** by a story or a test. `tsc -b` covers both now; before that gate existed, one removal blanked every Storybook story.
- **The session's working directory follows a `cd`** into another worktree. Use `git -C` and subshells.
- **Never `git stash`.** The stash is shared by every worktree and session on the machine.

## Stage 4b: build the nets

When the synthesis names a root-cause class with many findings and no test that catches it, build the net before fixing that class by hand. A net is a suite that runs the real code against a stated contract (every shell on every OS, every implementation of one interface, a spec's own state diagram) and keeps a `KNOWN` table: each thing it catches runs as an expected failure with its evidence. The net's PR fixes nothing; a fix lane then deletes entries, and is done when the table is empty. `history.md` lists the three the first pass built and what each caught.

**Use a real machine while the lanes run**, not only on the checklist afterwards: a temporary clone over SSH, the repo's own tests, deleted when done. The first pass's largest design change came from one probe on real Windows.

**Before merging anything large, give it to an agent that did not write it**: the diff and the spec, read-only, with no conclusions supplied. For a choice between designs, give the shapes and withhold the opinions.

## Stage 5: shepherd the PRs

Until each PR merges, it is yours. On every pass through the open PRs: merge `origin/main` into any that conflict (merge commits, never a rebase of a pushed branch), read the bot's review bodies as well as its inline comments, apply or answer each, and re-run the gates above before pushing. Hand a non-trivial review fix back to that lane's implementer, which still has the context. When a fix reshapes a PR, rewrite its description. Say in each PR body what was not verified and how to verify it.

## Stage 6: close out

1. Run `scorecard` and add a row to `history.md` in the same PR that updates `references/units.json`: models, units, tokens, findings by severity, fixed, regressions the pass itself caused, and the verdict in one sentence. An honest row includes the regressions.
2. Write `<ledger>/DEVICE-CHECKLIST.md`: every claim that rests on a phone, Windows, Linux, or a packaged build, merged from the findings files' own lists and the PR bodies, ordered so one sitting covers it. Lanes reach only the machines they can drive over SSH, never a phone or a real window, and the first pass's most valuable follow-up was the hour the maintainer spent with this list.
3. Write the open `high` findings as a decision brief: three lines each (what breaks, who hits it, the smallest fix), so he can answer `fix`, `defer`, or `ignore` quickly, and record the answers in `decisions.tsv`.
4. Hand over: PR queue with merge order, the ledger path, the worktrees you created (remove them only when he agrees).

**Stop rule.** Recommend against another pass with this model when the last wave found no `high` finding, and say what would change that: a large new subsystem, or the next model.

## What to tell the maintainer, and when

He should never have to ask how far along the pass is or what it has cost. Report at Gate A, after each fan-out wave (units done, tokens spent against the budget, findings by severity, anything `high`), and when each PR opens. State a regression the pass caused as soon as you know of it, with the fix.
