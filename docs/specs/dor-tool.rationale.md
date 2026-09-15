# Dor Tools — Rationale

> Informative evidence for `docs/specs/dor-tool.md`, keyed by its headings.

## Declaring tools

YAML authors naturally collapse one-element lists to scalars. Overloading a scalar dedupe key as a command would make `prespawn_dedupe: storybook` execute instead of identify. Separate future fields avoid that ambiguity.

A misspelled substitution such as `$PROJECTROOT` retained as a literal silently makes distinct checkouts share a key. Rejecting unknown substitutions exposes the typo before reuse can target another checkout.

Argument-list commands let the renderer quote each value for the actual target shell. Keeping shell strings literal avoids needing a shell-template parser to distinguish an author-provided pipeline from punctuation in a filename. Canonical file targets make symlink aliases reuse the same document viewer.

## Identity and dedupe

`pnpm storybook`, `pnpm run storybook`, and `pnpm storybook --quiet` are different command strings for the same intended tool. `dor ensure` already supplies exact-command/CWD identity. An explicit Tool key allows authors to choose their own scope without making the declaration of a short command name implicitly enable dedupe.

A key list makes scope visible: `$PROJECT_ROOT` distinguishes worktrees without string-concatenation conventions. A runtime collision differs from a redundant spawn: both Surfaces may already hold edited documents, so merging or killing either can destroy work.

## Trust

A prompt rendered as terminal output is forgeable, and `dor send` can type bytes identical to a user's. The dedicated chrome action prevents terminal/control-socket input from granting approval through the normal command path. It does not establish a boundary against arbitrary programs running as the same OS user.

Upstream grants reduce repeated approval across clones and worktrees. They rely on the URL reported by Git, without authenticating the checkout's provenance. Folder grants provide narrower scope. A copied directory carrying `.git/config` can claim a previously trusted URL; cloning a chosen URL has a different provenance story.

Remembering a denial would disable tools across worktrees without a corresponding grant-management UI. Closing the pending pane is recoverable on another explicit invocation. Content-hashing approval would prompt after routine edits or pulls, making acceptance habitual.

## Serving

The standalone browser harness binds more than one HTTP port. Choosing the lowest port or the first observed listener cannot identify which service the user intended to see. A conflict in the browser area gives that refusal a visible explanation while keeping the terminal accessible.

Successive startup listeners can appear in different scan ticks. One unchanged tick catches changes within that window; it does not prove no later listener will appear. Remembering the last applied announced port keeps repeated announcements from undoing URL-bar navigation.

A hardcoded Storybook port can disagree with the port it obtains under contention, while Vite with strict-port behavior can fail entirely. Discovery therefore checks the Session process tree. An OSC can cross SSH, but the current host scan still requires a locally discoverable listener.

## Lifecycle

The September 2026 integration reuses Terminal Context for the Tool's primary terminal. The auxiliary helper's automatic refresh, Reset, and Promote semantics do not describe a serving command, whose Session also owns the browser and remote terminal identity. Sharing the presentation avoids introducing a second navigation mechanism or a second shell.

## Take-over

**Why the gate is conservative in the split direction.** Every condition can be read wrong in two directions, and the two costs are nowhere near equal. Declining a take-over that should have happened costs a pane the user closes — the tool still runs, in the placement `dor tool` has always used. Taking over a pane that should have split types a command into a shell that belongs to something else: an agent's session, a line with work queued behind `dor`, a directory the tool was not asked to run in. So each condition is written to fail closed, and quoting is not unpicked — a line carrying `&&` inside quotes splits rather than being parsed for whether that `&&` is real.

**Why the naked test is worth having at all, given `dor send`.** It answers "did a human ask for this *here*", not "is this trustworthy". The discrimination it actually makes is placement: an agent's `dor tool` runs under the agent's own command line, so the pane reports `claude` (or `bash script.sh`) and never matches — which is the whole point, since an agent's tool must not commandeer the pane the human is watching the agent in. Trust is a separate gate with a separate ceremony, and it is the one that carries the security weight.

## Security

Hostile text printed by the designated command can contain an announcement. The current process-tree check limits port selection to that Session's discovered listeners; browser content still executes under the existing renderer boundaries. Earlier text describing arbitrary local-port selection did not match the scan implementation.

## Persistence and hosts

A derived URL or browser daemon binding belongs to one execution. Reusing it after cold restore can connect a Tool to another process that obtained the old port. The saved command and declaration metadata are sufficient to start again and discover the new endpoint.

Routing `dor tool` to a native editor on one host would change its result from a Surface handle to a host-specific side effect. Native file opening remains a separate operation.

A Workspace transfer carries the live browser binding separately from its durable record. The arrival record can reach disk while the windows coordinate, whereas the content channel stays in memory; reusing the saved-record projection alone would reopen a Tool browser and lose its current page state. Pending approvals and unfinished browser startup still own asynchronous work in the source window, so the move waits for the user to resolve the approval or retry after startup.
