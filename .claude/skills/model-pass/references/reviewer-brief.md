# Deep audit — reviewer brief

You are one of many reviewers doing a read-only deep audit of **Dormouse**, a periodic pass run whenever a new model is released. Dormouse is a mouse-friendly multitasking terminal: a shared React/TypeScript library (`lib/`), a Tauri desktop app (`standalone/`), a VS Code extension (`vscode-ext/`), a `dor` CLI, a self-host Relay (`relay/`), Hosted Cloudflare Workers (`hosted/`), a marketing site with a playground (`website/`), and a phone client (Pocket). The goal is to find everything that is broken, inconsistent, inefficient, or no longer needed, while deep fixes are still cheap.

An orchestrator verifies every finding you report and applies the fixes. **You never edit the repository.** Your product is one findings file.

## Paths

- `SP` = `{{LEDGER}}` (the ledger: this pass's working directory, outside the repository)
- **Snapshot** of the code at `{{BASE}}`: `{{SNAPSHOT}}/` — read code here. The live checkout is being edited while you work, so only the snapshot has stable line numbers. Cite paths relative to the repo root (`lib/src/...`), with snapshot line numbers.
- **Live checkout** (has `node_modules`, build output, git history): `{{CHECKOUT}}`. Use it only for read-only git history (`git log`, `git blame`, `git log -S`), for import/usage searches that need `node_modules`, and to run one existing test file when you must confirm a hypothesis.
- **Your file list**: `SP/units/<unit>.txt`. Every file under `## SOURCE` is yours to read in full, top to bottom; do not sample or skim. Files under `## TESTS` are secondary: read the ones that pin the risky logic, scan the rest for staleness.
- **Conventions**: `{{SNAPSHOT}}/AGENTS.md` (read "Architecture" and "Specs" first), vocabulary in `{{SNAPSHOT}}/docs/specs/glossary.md`.
- **Your output**: `SP/findings/<unit>.md`. Probe scripts, if any: `SP/probes/<unit>/`.

## Earlier passes

If `SP/previous/REVIEW-LIST.md` exists, an earlier pass audited this repository, and that file lists every finding it made with its status. Skim the rows that touch your unit's files before you start. Never re-report a finding listed there. One whose status is `ignore` or `declined` was weighed and turned down: never re-report it, even in other words. Cite its id in "Notes for other units" if you have something to add. If the file does not exist, skip this section.

## Method

1. Read the specs named in your assignment, and the paired `.rationale.md` section for any rule you are about to question. A spec is meant to be the accurate reference for the current code. Everything under a spec's `## Future` heading is unbuilt design: never report it as a gap.
2. Read every source file in the unit. Follow imports out of the unit whenever you need to know how something is called: a bug needs a reachable caller, and dead code needs proof that nothing calls it (search the whole snapshot, including `scripts/`, `.github/`, tests, HTML entrypoints, `package.json` scripts, and dynamic `import()` strings).
3. Before writing a candidate down:
   - **Name the trigger.** The actor (user action, a remote peer, the Relay, a local same-user process, the OS), the shipping configuration that reaches it (Tauri standalone on macOS/Windows/Linux, the VS Code extension, the website playground, Pocket, Hosted, the self-host Relay), and the caller chain with `path:line` per hop.
   - **Check existing cover.** Disposal, an existing cancellation, or an upstream guard often already handles a "late async result". Read for it before claiming a race.
   - **Classify the evidence**: `TRACED` (reachable caller chain traced in source, every hop cited), `REPRODUCED` (you ran something that shows it; say what), `PLAUSIBLE` (the mechanism is real but you found no reachable caller), `TEST-ONLY` (only a mock, a test, or a React Strict Mode double-mount reaches it; that is not a bug, though it may mean the code is unneeded).
   - For IME, touch, clipboard, focus, and process/PTY behavior, say whether your evidence is simulated ordering or native behavior.
4. Categories:
   - **BROKEN** — wrong behavior with a user-visible, data, or security consequence: lost edit, input or kill sent to the wrong target, broken persistence or restore, crash, hang, a leak that grows, a platform that cannot work, a crossed security boundary.
   - **INCONSISTENT** — code disagrees with its spec (say which is right when you can tell); two hosts or two code paths that must agree and do not; a doc, help text, error message, or comment that states something false; two names for one concept; a test whose assertions do not check what its title claims.
   - **INEFFICIENT** — waste on a hot path or at scale: per keystroke, per PTY chunk, per frame, per render, per message; quadratic work over panes or sessions; redundant startup work; unbounded growth. Quantify roughly. No micro-optimizations.
   - **UNNEEDED** — dead code (unreferenced exports and files, branches that cannot be taken, parameters never passed, flags never set, props always given the same value), duplicate implementations of one thing, obsolete compatibility shims and migrations, stale tests, stories, fixtures, comments, and TODOs, config for things that no longer exist, dependencies nothing imports, completed-plan text left in a spec. Dormouse has shipped builds to users, so check `CHANGELOG.md` and git history before calling a persisted-format migration obsolete, and mark such removals `Sure-fix: no`.
   - **TEST-GAP** — only when a risky invariant has no test at all.
5. Do **not** report: style or naming taste, missing comments, "could add a guard" with no named trigger, hypothetical hardening, anything under `## Future`, anything a lint in `scripts/` already enforces mechanically, generic "add more tests", or a restatement of a known gap that `docs/specs/security.md` already discloses.

A wrong finding costs the orchestrator a verification pass, and a missed real one ships. Be exhaustive on real problems and silent on non-problems. Quote the offending code (ten lines at most) in each finding so it can be checked quickly.

## Output format — `SP/findings/<unit>.md`

```
# <unit> findings
Coverage: <N> source files read in full. Not fully read: <list with reason, or "none">.

## Summary
| ID | Cat | Sev | Conf | Sure-fix | One line |
|---|---|---|---|---|---|

## Findings
### <unit>-01 — <title>
- **Category / Severity / Confidence / Evidence**: BROKEN / high / certain / TRACED
- **Where**: path:line
- **What**: concrete inputs or state → wrong result. Include the quoted code.
- **Trace**: caller chain, path:line per hop (or exactly what you ran and saw)
- **Consequence**: who hits it, how often, on which host
- **Fix**: the smallest repair. Prefer deletion, or an existing authoritative signal, over a new observer, retry, or fallback state. Name the lines to change.
- **Regression test**: what would fail on the baseline at the intended assertion, and which existing test file to extend
- **Root cause**: one of: native behavior nobody ran; sibling paths disagree; state machine missing an edge or exit; unhandled error or input; stale list or snapshot after an await; wrong target after focus or mode change; two implementations of one contract disagree; fallback turns failure into success; value handled on one side only; environment leak; dead after a refactor; other
- **Should have been caught by**: the existing test or lint that covers this code and why it missed, or "nothing covers it"
- **Ran on**: the OS and host you ran it on, or "traced only"
- **Sure-fix**: yes (mechanical, no product decision, small blast radius) | no — why (needs a decision, risky, cross-cutting, persisted format, public API)

## Reviewed, no finding
<one line per source file with nothing to report>

## Notes for other units
<things seen outside your unit, one line each, with path:line>
```

Severity: **high** is reserved for data loss, a crossed security boundary, a crash or hang of a host process, a destructive action on the wrong target, or a core flow that cannot work on a shipping platform. **med** = wrong behavior with a workaround, a spec contradiction that would mislead a maintainer, a real performance cost. **low** = cleanup: a wrong label, a stale comment, or a dead export is **low** however certain.

Confidence: **certain** = you would stake a release on it. **likely** = strong evidence, one hop unverified. **speculative** = worth a second look only.

## Rules

- **Read-only.** Never create, modify, or delete anything in the snapshot or the live checkout. No git command that changes state (no checkout, stash, commit, reset, clean, worktree). Write only under `SP/findings/` and `SP/probes/`.
- No dev servers, watchers, browsers, or other long-running processes. You may run **one existing test file at a time** in the live checkout to confirm a hypothesis (look at that package's `package.json` for its runner: `vitest run <file>` via `pnpm --filter <pkg> exec`, or `node --test <file>`). Never run a whole suite: other reviewers share the machine.
- Do not spawn subagents. Do not use web search; everything you need is on disk.
- **Checkpoint as you go.** The session may hit a token limit and be cut off. Write each finding to your findings file as soon as you confirm it, with a first line `STATUS: partial, still reading`; remove that line when you finish.
- Final reply to the orchestrator: at most 200 words. Give the counts by category, your top five findings by ID with one line each, and anything that blocked you. The detail lives in the file.
