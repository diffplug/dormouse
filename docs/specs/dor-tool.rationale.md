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

**Why the key is the upstream rather than the path.** Path-keyed trust asks once per checkout, and worktree-heavy work makes that constant: `dormouse` and `dormouse.phase-b` are the same code from the same place, and approving each separately teaches nothing. The upstream URL is the identity the user actually reasons about. The cost is that the answer comes from `.git/config`, which the directory itself controls and nothing can verify — so a directory shipping its own `.git` can claim a URL you have granted. That is accepted rather than mitigated: closing it would need either a network round-trip (which proves the URL exists, not that this checkout came from it) or a nominated-parent-directory setting, and the vector requires being handed a directory rather than cloning one, at which point running its build tooling is already the larger exposure.

**Why declining records nothing.** A remembered denial was there so a hostile repo could not re-ask on every invocation. Once the prompt lives in a pane the user closed deliberately, that pressure is gone — and a persisted denial keyed on an upstream would silently disable tools across every worktree of a repo, with nothing in the product able to list or revoke it. Re-asking is recoverable; a permanent invisible block is not.

**Why trust is not content-hashed.** Hash-pinning a `dormouse.yml` re-prompts on every edit and every `git pull` that touches the file. On a repo whose maintainer edits it regularly that is a dialog seen daily, and a dialog seen daily is answered reflexively — the control stops controlling anything. The residual, a trusted repo that later gains a hostile entry, is exposure already accepted from `package.json` scripts, `.vscode/tasks.json`, and git hooks in that same repo. The gate exists for first contact, which a key over the whole repo already covers.

## Serving

**Why two ports is a refusal rather than a tie-break.** Dormouse already declines to guess among several ports everywhere else: the Dev-Server Chip renders only when *exactly one* terminal owns a port, and `surface.resolveOpen` — behind `dor iframe surface:N` — fails and lists the candidates. The tool path was the outlier, silently taking the numerically lowest. A tie-break has no honest rule to apply: lowest-numbered is arbitrary, and first-bound is not even observable from scan snapshots. Refusing is the only answer that cannot be quietly wrong, and it costs the user one config line to resolve.

**Why the conflict is shown in the browser's place.** With no port framed there is nothing in the pane's second half, and the pane would otherwise sit on its terminal with no indication that Dormouse had decided anything. Putting the explanation exactly where the browser would have appeared makes the absence self-describing, and the header chip still flips back to the terminal.

**Why autobind waits a tick.** Ports appear one at a time during boot. The standalone harness binds its dev bridge (1422) before vite (1420), so a scan landing between the two sees only the bridge; framing on first sighting would keep it. Waiting for one unchanged tick costs ~1.5s and catches every boot-time case. After serving, only a changed OSC port triggers a scan; remembering the last applied announcement prevents the poll from undoing URL-bar navigation. Scanning every framed tool forever would pay a shell-out per tool per tick to catch a case that essentially only happens at startup.

**Why the scan outranks the announcement.** An announcement states intent; the scan states the result, and the two diverge exactly when it matters. Storybook launched with `-p 6006` in a second worktree auto-increments to 6007, so a hardcoded announcement would frame a port belonging to the *other* checkout. Vite under `strictPort: true` (`standalone/vite.config.ts`) does not start at all. The repo's existing answer to contention, `scripts/free-dev-port.mjs`, kills whatever holds the port. A trigger built on the announcement inherits all three problems; one built on the scan inherits none, and works on software nobody patched.

**What the announcement is still needed for.** Multi-port tools. `pnpm dev:standalone:ab` binds vite, the dev bridge, and the sidecar's control socket, and no scan can guess which one to frame. ssh is the other case: the control socket does not exist across it, and neither does the host's view of the remote process tree.

## Take-over

**Why the gate is conservative in the split direction.** Every condition can be read wrong in two directions, and the two costs are nowhere near equal. Declining a take-over that should have happened costs a pane the user closes — the tool still runs, in the placement `dor tool` has always used. Taking over a pane that should have split types a command into a shell that belongs to something else: an agent's session, a line with work queued behind `dor`, a directory the tool was not asked to run in. So each condition is written to fail closed, and quoting is not unpicked — a line carrying `&&` inside quotes splits rather than being parsed for whether that `&&` is real.

**Why the naked test is worth having at all, given `dor send`.** It answers "did a human ask for this *here*", not "is this trustworthy". The discrimination it actually makes is placement: an agent's `dor tool` runs under the agent's own command line, so the pane reports `claude` (or `bash script.sh`) and never matches — which is the whole point, since an agent's tool must not commandeer the pane the human is watching the agent in. Trust is a separate gate with a separate ceremony, and it is the one that carries the security weight.

## Security

**Why the content-driven announce risk is accepted.** The blast radius is the containment rule applied to ports: an announce reveals and frames, never transferring input authority, grants, or state. The iframe proxy dials upstream as a fresh client with no browser cookie authority, and the link-local/cloud-metadata SSRF guard stands regardless. Two properties of this design narrow it further than an announce-triggered one: the scan supplies the port, so an announced port that nothing bound frames nothing at all, and a runtime re-key cannot dedupe, so it cannot reach another pane.

## Persistence and hosts

**Why `dor tool` is not routed to the VS Code editor, despite native-first.** Every other `dor` verb returns a handle the caller can address afterwards. A verb that returns a handle on standalone and a "told the editor" note on VS Code is one command with two return types: `dor open x.md && dor read surface:N` would work on one host and silently no-op on the other, which is worse for an agent than the command not existing. Native-first governs chrome and theming; Dormouse already renders browser surfaces inside VS Code, as does the built-in Simple Browser.
