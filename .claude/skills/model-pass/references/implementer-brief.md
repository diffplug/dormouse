# Deep audit — implementer brief

You are implementing fixes for verified audit findings in **Dormouse**, a mouse-friendly multitasking terminal (React/TypeScript lib, Tauri standalone app, VS Code extension, `dor` CLI, Relay, Hosted Workers). This is a periodic deep audit, run whenever a new model is released. Reviewers found the problems and wrote each one up with its trace and a proposed repair; an orchestrator triaged them into your queue. Your job is to turn each queued finding into one small, tested commit, or to say plainly why you did not.

A wrong fix is worse than no fix. Every commit you make will be read by the orchestrator and then by the maintainer.

## Paths

- `SP` = `{{LEDGER}}` (the ledger: this pass's working directory, outside the repository)
- **Your worktree** is named in your assignment, under `{{WORKTREES}}`. It is a new git worktree on its own branch. Work only there. Every command you run must start with `cd <your worktree>`, and every file you edit must be under it. Before anything else, run `pnpm install --frozen-lockfile` at its root once (this is the one install you may run without a manifest change), then `pnpm --filter dormouse-lib run pretest`, which builds the workspace packages other suites import.
- **Findings**: `SP/findings/<unit>.md`. Print one finding with `node .claude/skills/model-pass/scripts/ledger.mjs show --ledger {{LEDGER}} <unit> <nn>` from your worktree root. Findings cite line numbers from a snapshot at commit `{{BASE}}` (`{{SNAPSHOT}}/`); the tree has moved since, so find the code by its content, never by line number alone.
- **Your queue**: `SP/queue/<lane>.md`. It lists the findings to implement, in order, with the orchestrator's notes. A note overrides the finding's own proposed fix.
- **Your log**: `SP/fixlog/<lane>.md`. Append one entry per finding as you finish it (format below).
- **Backups** for the mutation check: `SP/backup/<lane>/`.
- Conventions: `AGENTS.md` at the worktree root. Read its "Specs" section before you touch a spec.

## For each finding in the queue, in order

1. **Re-verify it.** Read the finding, then read the current code it names and trace the caller yourself. If the code no longer matches, or you cannot confirm that a shipping caller reaches it, do not fix it: log it as `disproved` or `skipped` with what you found.
2. **Make the smallest repair.** Prefer deleting code, or using a signal the code already trusts, over adding a guard, retry, fallback, or new state. Change nothing the finding does not require: no drive-by refactors, renames, reformatting, or comment rewrites. Write comments that state what the code needs and why, for a reader who never saw this audit; never mention the audit, the finding id, or "fix". Before you remove or rename an export, search tests, `lib/src/stories/`, `lib/.storybook/`, `standalone/`, `vscode-ext/`, `website/`, and `hosted/` for the name. No gate type-checks all of those yet.
3. **Pin it with a test** whenever behavior changes. Extend the existing test file for that module. The test must fail on the old code at its intended assertion. Prove it:
   - copy your fixed source file(s) to `SP/backup/<lane>/`;
   - put the old code back with `git show HEAD:<path> > <path>`;
   - run the one test file and see your new test fail for the right reason;
   - restore your fixed file(s) from the backup and run the test again to see it pass.

   Never use `git stash`, `git checkout`, `git restore`, or `git reset` for this.

   A pure deletion of dead code, a comment or doc correction, or a config cleanup needs no new test; say so in the log.
4. **Update the spec** when your change makes a sentence in `docs/specs/*.md` false, or when the finding is a spec-versus-code disagreement the queue says to settle in the spec. House rules: a rule leads with a bolded imperative; the why goes in the paired `.rationale.md` under the same heading; every paragraph and list item is one source line; never change a heading (code comments cite them by name). Then run `node scripts/spec-lint.mjs`. If it reports a word budget, cut your own additions until it passes. **Never run `--ratchet` and never edit `scripts/spec-word-budgets.json`.**
5. **Run the gates** for what you touched, from your worktree:
   - the package's own tests (see its `package.json`; for one file use `pnpm exec vitest run <file>` inside the package, or `node --test <file>`);
   - `cd lib && pnpm exec tsc -b` after any change under `lib/src` or `dor/src`;
   - `cd standalone && pnpm exec tsc --noEmit` after any change under `standalone/src`, `lib/src`, or `remote-lib-common/src`;
   - `cd vscode-ext && pnpm exec tsc --noEmit -p tsconfig.json` after any change under `vscode-ext/`;
   - Rust: `CARGO_TARGET_DIR={{CARGO_TARGET}} pnpm exec cargo test --manifest-path standalone/src-tauri/Cargo.toml` (always through `pnpm exec`, which puts the pinned Node on `PATH`; the target directory is shared with the other implementers);
   - `node scripts/spec-lint.mjs` and `node scripts/md-unwrap.mjs` after any `.md` change;
   - after changing any `dor` help text: `cd dor && pnpm build && UPDATE_SNAPSHOTS=1 node --test && node --test`, and commit `dor/test/snapshots/`;
   - after your last commit, `node --test scripts/security-audit.test.mjs scripts/security-audit-canary.test.mjs` from the worktree root. A canary patch under `.github/audit/canaries/` that no longer applies because you changed the lines it edits is yours to report: do not re-cut it, name it in your final reply and your log.

   A failing gate that also fails with your change removed is a baseline failure: log it and carry on. Otherwise fix it before you commit.
6. **Commit that one finding.** Stage only the files you changed for it (`git add <paths>`, never `git add -A` or `git add .`), then commit with a message written to a file and passed with `git commit -F`:
   - subject: imperative, at most 72 characters, naming the area and the behavior (`Sidecar: keep a ZDOTDIR the user's .zshenv sets`);
   - body: what a user or caller saw before, what changed, and how it was validated. Plain prose, wrapped at 76 columns. No finding ids, no mention of an audit.
   - end with the attribution trailer your own session instructions give for commits.

   Two findings that are one change (the same lines, or a fix and the comment it makes false) may share a commit. Unrelated findings never do.
7. **Log it** in `SP/fixlog/<lane>.md`:
   ```
   ## <finding-id> — fixed | skipped | disproved
   - commit: <short sha>  (fixed only)
   - changed: <files>
   - test: <test file and title>; failed on old code with: <the assertion or error line>   (or: none needed, because …)
   - note: <anything the orchestrator must know: a wider or narrower repair than proposed, a baseline failure, a doubt>
   ```

## Sharing the machine

Other implementers are running tests on this machine at the same time, and it is slow. Run the narrowest test that covers each change (one file) while you work, and your package's whole suite once, after your last finding. A test that fails in a file you did not touch is probably a timing flake under load: rerun that one file alone before you treat it as real, and log it as a baseline note if it passes.

**Bound every run of a test you just wrote.** A new test that drives a real editor or an event loop can feed its own updates back to itself, and an unbounded one took 122 GB of memory in seconds. Run a new or changed test file as `node --max-old-space-size=1024 --test --test-timeout=60000 <file>` (for Vitest, `NODE_OPTIONS=--max-old-space-size=1024 pnpm exec vitest run --testTimeout=60000 <file>`), never in a retry loop or the background, and check afterwards that no process of yours is left. A run that hits the cap is a loop to find by reading the code, not something to rerun.

## When to skip instead of fix

Skip, with a reason, when any of these holds. Skipping is a good outcome, not a failure.
- You cannot confirm a reachable trigger on a shipping path.
- The repair needs a product, security, or compatibility decision the queue does not make for you.
- The repair would change a persisted format, a wire message, or a public CLI flag or output, and the queue does not say to.
- The honest repair is larger than about 150 changed lines, or needs files outside your lane's directories (named in your assignment). Say which files.
- The finding's premise is native behavior (IME, touch, focus, a real PTY, Windows or Linux) that you cannot check and the reviewer marked as unverified.

## Hard rules

- Never push, open a pull request, or touch a remote. Never change another worktree or branch. Never run `git stash`, `git reset`, `git checkout`, `git restore`, `git clean`, `git rebase`, `git merge`, or `git cherry-pick`.
- Never start a dev server, a watcher, a browser, or any long-running process. Run finite test and build commands only.
- Apart from the first install in your worktree, never run `pnpm install` unless you changed a `package.json`; if you did, run it and commit `pnpm-lock.yaml` with that change, then run `pnpm exec node website/scripts/generate-deps.js` and commit any change under `website/src/data/` too.
- `pnpm` skips a `pre<name>` or `post<name>` script when the body of `<name>` contains that hook's name anywhere (a path such as `prebuilds/` counts). Never add such text to a script that has a hook.
- Do not spawn subagents. Do not use web search.
- Do not weaken a test to make it pass, delete a failing test, or add `skip`. If an existing test pinned the broken behavior, change its expectation and say so in the commit body.
- If you find a new problem that is not in your queue, do not fix it. Add a line under `## New findings` at the end of your log.

## Final reply

At most 200 words: how many fixed, skipped, and disproved, the commit range (`git log --oneline <base>..HEAD`), any baseline failures, and anything you are unsure of. The detail lives in the log.
