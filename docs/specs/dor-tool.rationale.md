# Dor Tools — Rationale

> Informative evidence for [dor-tool.md](dor-tool.md), keyed by its headings; nothing here is normative.

## Declaring tools

**Why `prespawn_*` spends a field name per addition instead of overloading one.** The tempting compaction is a single `prespawn_dedupe` that means a literal key when it is a list and a command to run when it is a string. YAML defeats it: authors habitually collapse a one-element sequence to a scalar, so `prespawn_dedupe: storybook` is exactly as natural a spelling of `["storybook"]` as it is of "run `storybook`". Guessing wrong in that direction *runs the tool* to answer a question about the tool — the same hazard that keeps a probe off any command not written to be probed. Distinct field names cost one word and remove the guess.

**Why an unknown `$NAME` is an error rather than a literal.** The two failure modes are not symmetric. Forgetting the field entirely is loud: two tools start, fight over a port, and one visibly fails. A `$PROJECTROOT` typo kept as a constant string is silent, and it makes every checkout on the machine share one key — so the second worktree's tool kills the first. Parse-time rejection converts the silent destructive case into a startup error.

## Identity and dedupe

**Why no key is derived from the command.** Three independent reasons, any one sufficient:

- Command strings are not stable keys. `pnpm storybook`, `pnpm run storybook`, and `pnpm storybook --quiet` are three strings for one tool, so a derived key would dedupe depending on spelling — and an agent generating the string will not spell it identically twice. Dedupe that fires unpredictably is worse than dedupe that never fires.
- `dor ensure` already *is* command+cwd idempotency. Absorbing it into `dor tool` would be a second spelling of a shipped command with fuzzier semantics. It would also inherit `ensure`'s hard dependency on OSC 633 shell integration, which fails outright on a shell without it; keeping it off the base path lets `dor tool` work there.
- Declaring a tool to get a short name is a different intention from wanting one instance of it. Coupling them means editing the config silently changes runtime behavior, and a hand-written key documents its own scope to the next reader where an implicit one cannot.

**Why keys are lists rather than strings.** Parallel worktree development is the case that decides it. A tool-declared identity *string* — the obvious design, and what an earlier draft of this spec specified — has every checkout announcing `storybook`, so Dormouse treats the second worktree's server as a redundant spawn and kills it. A list makes scope a slot that `$PROJECT_ROOT` fills, rather than something an author must remember to concatenate into a string.

**Why a runtime re-key cannot dedupe.** Spawn-time dedupe is safe because the loser is redundant by construction: it has done nothing yet. That stops being true once a key can change. A scratch document edited for ten minutes and then saved over a path another pane already holds is a genuine collision between two Surfaces that both hold work, and killing either destroys it. Re-labelling is the only resolution that cannot lose data.

## Trust

**Why the approval gesture must live in Dormouse's chrome.** The naked-prompt test reads the pane's own OSC 633 command line, which is a good signal of human intent and a poor security boundary: an agent holding the control token can `dor send` keystrokes that are byte-identical to typing. A dialog rendered as terminal output is forgeable the same way. A click in Dormouse's own UI is not reachable from inside a PTY, which is why the remote pairing ceremony uses the same shape.

**Why trust is path-level rather than content-hashed.** Hash-pinning a `dormouse.yml` re-prompts on every edit and every `git pull` that touches the file. On a repo whose maintainer edits it regularly that is a dialog seen daily, and a dialog seen daily is answered reflexively — the control stops controlling anything. The residual, a trusted repo that later gains a hostile entry, is exposure already accepted from `package.json` scripts, `.vscode/tasks.json`, and git hooks in that same repo. The gate exists for first contact, and path-level trust covers first contact.

## Serving

**Why the scan outranks the announcement.** An announcement states intent; the scan states the result, and the two diverge exactly when it matters. Storybook launched with `-p 6006` in a second worktree auto-increments to 6007, so a hardcoded announcement would frame a port belonging to the *other* checkout. Vite under `strictPort: true` (`standalone/vite.config.ts`) does not start at all. The repo's existing answer to contention, `scripts/free-dev-port.mjs`, kills whatever holds the port. A trigger built on the announcement inherits all three problems; one built on the scan inherits none, and works on software nobody patched.

**What the announcement is still needed for.** Multi-port tools. `pnpm dev:standalone:ab` binds vite, the dev bridge, and the sidecar's control socket, and no scan can guess which one to frame. ssh is the other case: the control socket does not exist across it, and neither does the host's view of the remote process tree.

## Security

**Why the content-driven announce risk is accepted.** The blast radius is the containment rule applied to ports: an announce reveals and frames, never transferring input authority, grants, or state. The iframe proxy dials upstream as a fresh client with no browser cookie authority, and the link-local/cloud-metadata SSRF guard stands regardless. Two properties of this design narrow it further than an announce-triggered one: the scan supplies the port, so an announced port that nothing bound frames nothing at all, and a runtime re-key cannot dedupe, so it cannot reach another pane.

## Persistence and hosts

**Why `dor tool` is not routed to the VS Code editor, despite native-first.** Every other `dor` verb returns a handle the caller can address afterwards. A verb that returns a handle on standalone and a "told the editor" note on VS Code is one command with two return types: `dor open x.md && dor read surface:N` would work on one host and silently no-op on the other, which is worse for an agent than the command not existing. Native-first governs chrome and theming; Dormouse already renders browser surfaces inside VS Code, as does the built-in Simple Browser.
