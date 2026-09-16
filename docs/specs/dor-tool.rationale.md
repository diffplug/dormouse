# Dor Tools — Rationale

> Informative evidence for `docs/specs/dor-tool.md`, keyed by its headings.

## Declaring tools

YAML authors naturally collapse one-element lists to scalars. Overloading a scalar dedupe key as a command would make `prespawn_dedupe: storybook` execute instead of identify. Separate future fields avoid that ambiguity.

A misspelled substitution such as `$PROJECTROOT` retained as a literal silently makes distinct checkouts share a key. Rejecting unknown substitutions exposes the typo before reuse can target another checkout.

Argument-list commands let the renderer quote each value for the actual target shell. Keeping shell strings literal avoids needing a shell-template parser to distinguish an author-provided pipeline from punctuation in a filename. Canonical file targets make symlink aliases reuse the same document viewer.

A Session can keep running PowerShell after its user's default changes to Bash. Takeover therefore cannot use the default's quotation rules: apostrophes and quoted executable paths differ between those shells. Pending invocations also depend on their CWD, since identical relative filenames in two subdirectories identify different documents.

## Identity and dedupe

`pnpm storybook`, `pnpm run storybook`, and `pnpm storybook --quiet` are different command strings for the same intended tool. `dor ensure` already supplies exact-command/CWD identity. An explicit Tool key allows authors to choose their own scope without making the declaration of a short command name implicitly enable dedupe.

A key list makes scope visible: `$PROJECT_ROOT` distinguishes worktrees without string-concatenation conventions. A runtime collision differs from a redundant spawn: both Surfaces may already hold edited documents, so merging or killing either can destroy work.

## Trust

A prompt rendered as terminal output is forgeable, and `dor send` can type bytes identical to a user's. The dedicated chrome action prevents terminal/control-socket input from granting approval through the normal command path. It does not establish a boundary against arbitrary programs running as the same OS user.

Upstream grants reduce repeated approval across clones and worktrees. They rely on the URL reported by Git, without authenticating the checkout's provenance. Folder grants provide narrower scope. A copied directory carrying `.git/config` can claim a previously trusted URL; cloning a chosen URL has a different provenance story.

Remembering a denial would disable tools across worktrees without a corresponding grant-management UI. Closing the pending pane is recoverable on another explicit invocation. Content-hashing approval would prompt after routine edits or pulls, making acceptance habitual.

## Serving

An exit and rerun can both occur inside the 1.5-second polling interval. Command text alone then leaves the previous browser and settle state attached to a new process. Run ids expose that transition; observing a transferred Workspace for the first time does not imply a restart. Clearing hints at the command-start event, in stream order, also avoids deleting a new serve emitted before the next poll.

Renderer swaps and Workspace transfers can give a Tool a browser session name other than the serving hook's default. Reopening that existing session preserves its browser state and avoids orphaning it behind a second daemon.

The standalone browser harness binds more than one HTTP port. Choosing the lowest port or the first observed listener cannot identify which service the user intended to see. A conflict in the browser area gives that refusal a visible explanation while keeping the terminal accessible.

Successive startup listeners can appear in different scan ticks. One unchanged tick catches changes within that window; it does not prove no later listener will appear. Remembering the last applied announced port keeps repeated announcements from undoing URL-bar navigation.

A hardcoded Storybook port can disagree with the port it obtains under contention, while Vite with strict-port behavior can fail entirely. Discovery therefore checks the Session process tree. An OSC can cross SSH, but the current host scan still requires a locally discoverable listener.

## Lifecycle

The September 2026 integration reuses Terminal Context for the Tool's primary terminal. The auxiliary helper's automatic refresh, Reset, and Promote semantics do not describe a serving command, whose Session also owns the browser and remote terminal identity. Sharing the presentation avoids introducing a second navigation mechanism or a second shell.

## Take-over

User input queued before injection can complete ahead of the Tool. A changed completion id alone releases the queue too early; matching the command and its start directory distinguishes the requested launch while accepting a Tool that finishes between polls.

An accepted takeover has already answered the CLI and promised its placement. Switching Workspaces while the shell returns to its prompt changes presentation without changing ownership of that shell; abandoning the launch then silently loses a successful request. Initial visibility still distinguishes a human's invocation from background placement, while the post-prompt checks protect the live Session and Workspace.

**Why the gate is conservative in the split direction.** Every condition can be read wrong in two directions, and the two costs are nowhere near equal. Declining a take-over that should have happened costs a pane the user closes — the tool still runs, in the placement `dor tool` has always used. Taking over a pane that should have split types a command into a shell that belongs to something else: an agent's session, a line with work queued behind `dor`, a directory the tool was not asked to run in. So each condition is written to fail closed, and quoting is not unpicked — a line carrying `&&` inside quotes splits rather than being parsed for whether that `&&` is real.

**Why the naked test is worth having at all, given `dor send`.** It answers "did a human ask for this *here*", not "is this trustworthy". The discrimination it actually makes is placement: an agent's `dor tool` runs under the agent's own command line, so the pane reports `claude` (or `bash script.sh`) and never matches — which is the whole point, since an agent's tool must not commandeer the pane the human is watching the agent in. Trust is a separate gate with a separate ceremony, and it is the one that carries the security weight.

## Security

Hostile text printed by the designated command can contain an announcement. The current process-tree check limits port selection to that Session's discovered listeners; browser content still executes under the existing renderer boundaries. Earlier text describing arbitrary local-port selection did not match the scan implementation.

## Persistence and hosts

A Tool may take over a PowerShell Session even while the selected default is Bash, and the selected default may change before restart. Its already-quoted command string cannot safely move between those shells. Retaining resolved argv preserves literal filenames and lets cold restore quote for its actual shell without retaining an obsolete shell executable.

A derived URL or browser daemon binding belongs to one execution. Reusing it after cold restore can connect a Tool to another process that obtained the old port. The saved command and declaration metadata are sufficient to start again and discover the new endpoint.

Routing `dor tool` to a native editor on one host would change its result from a Surface handle to a host-specific side effect. Native file opening remains a separate operation.

A Workspace transfer carries the live browser binding separately from its durable record. The arrival record can reach disk while the windows coordinate, whereas the content channel stays in memory; reusing the saved-record projection alone would reopen a Tool browser and lose its current page state. Pending approvals and unfinished browser startup still own asynchronous work in the source window, so the move waits for the user to resolve the approval or retry after startup.

## Opening local files

The VS Code host supports Node 18, which lacks native glob matching. Bundled picomatch keeps association behavior the same across hosts. Patterns with separators test both the CWD-relative and canonical absolute path: files above the CWD otherwise start with `../` and can miss patterns intended to cover an absolute directory. Canonicalization also gives symlink aliases one matching identity. Canonicalizing only the target mixed physical and logical paths under a symlinked CWD, so relative slash patterns missed files inside that directory. An absolute target can still be opened after its caller's CWD disappears; matching falls back to the supplied directory in that case.
