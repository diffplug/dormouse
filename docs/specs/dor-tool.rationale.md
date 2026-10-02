# Dor Tools — Rationale

> Informative evidence for `docs/specs/dor-tool.md`, keyed by its headings.

## The tool capability set

Before the Display modal read the Surface's own render modes (2026-09), it offered a Tool Playwright screencast and popout wherever the host wired Playwright. `onSwapRenderMode`'s Tool branch then wrote `toolRender: 'pw-*'`, cleared the session and launched only for `agent-browser-screencast`, so the pane sat on its placeholder until the next save coerced it to `iframe`; `playwright-popout` also popped out a Tool. The Wall refuses independently because the in-controller popout never reaches it.

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

Every preview-slot retarget of a serving Tool (the built-in file viewer, `builtin:folder`, a web viewer) otherwise waits up to one 1.5-second poll before its browser frames (2026-09). The `serve` announcement already names the port, so scanning when it arrives removes most of that wait without trusting it any further. Its first form ran a full tick per announcement (2026-09-28): every unbound Tool was scanned again milliseconds after the poll, which autobind counted as its unchanged tick, so a boot's first listener could frame before the next one bound.

## Lifecycle

### September 2026 innerdogfood QC record

The `dor-tool-qc` run (from `4c7f9012`, on the real standalone sidecar, staged
CLI, PTYs, and iframe proxy) exercised project approval, keyed reuse, serving,
open-rule dispatch, and the built-in viewer's formats and failures. Two findings
constrain later edits: at that baseline the Tools feature flag could reject
creation and standalone `dor open` split, both since superseded by
always-enabled Tools and eligible inline opening; and Chromium's native PDF
plugin failed inside the normal iframe sandbox (see
`docs/specs/dor-tools-builtin.rationale.md` → File viewer). The
run did not cover Tool transfer, native-window movement, native Tauri/VS Code
rendering, Windows shells, or cold restore. The reusable recipe is
`docs/testing/dor-tool-qc.md`.

The September 2026 integration reuses Terminal Context for the Tool's primary terminal. The auxiliary helper's automatic refresh, Reset, and Promote semantics do not describe a serving command, whose Session also owns the browser and remote terminal identity. Sharing the presentation avoids introducing a second navigation mechanism or a second shell.

## Naming

A name read from a browser or terminal passes through whatever those show mid-switch: the dev-server chip that named serving Tools went chip, bare address, chip on every preview retarget (`docs/specs/layout.rationale.md` → Pane header, 2026-09-29). The dedupe key is what tells two Surfaces of one Tool apart, so its elements beyond the name are what the name adds; an absolute path's last component is usually the checkout or file it scopes to.

## Opening local files

The supported VS Code host floor runs Node 20 (2026-10), which lacks native glob matching; `docs/specs/vscode.md` records the pinned runtime floor. Bundled picomatch keeps association behavior the same across hosts. Patterns with separators test both the CWD-relative and canonical absolute path: files above the CWD otherwise start with `../` and can miss patterns intended to cover an absolute directory. Canonicalization also gives symlink aliases one matching identity. Canonicalizing only the target mixed physical and logical paths under a symlinked CWD, so relative slash patterns missed files inside that directory. An absolute target can still be opened after its caller's CWD disappears; matching falls back to the supplied directory in that case.

## Folders

Directories match through a name suffix rather than a new rule field, so folder rules share the ordered `open` list and picomatch syntax. The suffix alone would let `*` or `**` file rules capture directories, and a regular file literally named `x.📁` capture a folder rule; making suffixed patterns and directories match only each other closes both.

## Preview slot

Customizable viewers are the point of `dor open`, so previews trade speed for flexibility. A design considered on 2026-09-28 previewed inside one long-lived built-in viewer with a folder-scoped grant: every selection was an in-page navigation, but user Tools never saw a preview. Retargeting the slot instead costs an interrupt, a process start, and a port scan for a serving Tool, which its `serve` announcement now starts at once ([Serving](#serving)); terminal-only viewers skip the scan. A rule's `preview` handler and the speed item in scope **open-folder** narrow that cost without bypassing the open rules.

Measured in the innerdogfood harness (Chromium, macOS, 2026-09-28), a built-in viewer retarget took 255–285 ms from issuing the click to the new document's `load`, about 100 ms of it the automation round trip. That left retarget without restart, the remaining speed item, unbuilt.

Most slot occupants are viewers scrolled with the keyboard (`less`, `glow`), so pinning on keyboard input would pin nearly every preview. Editors report `OSC 367 state`; one that does not loses unsaved work on the next selection.

Splitting the pinned pane keeps a double-clicked file visible, the intent of the gesture. Minimizing it to a Door, the closer analogue of a VS Code tab left behind the preview, was rejected for that reason. Without latest-wins supersession, the Tool launch queue would run one restart per click in order.

`less` without `-K`, vim, nvim, and hx ignore Ctrl+C. Waiting out the 15s prompt timeout for one held the serial Tool queue on every click after the first, then failed, and a terminal link then fell back to its dialog. Considered on 2026-09-28: signalling the foreground process group with SIGTERM needs new plumbing in every host's PTY owner and has no Windows equivalent; typing `q` risks inserting it into an editor's buffer; killing the Session could lose editor state. Keeping the slot as it stands costs a pane, and its occupant never agreed to exit.

At the 1s mark an ignored Ctrl+C looks the same as a slow exit: a serving Tool's shutdown work, or a prompt hook that reports late, such as a git-status prompt in a large repository (reasoned 2026-09-28). Watching for that late prompt off the queue gives a kept pane its content back, and a marked slot its viewer, without holding the queue past the 1s; 15s is the prompt timeout the interrupt waited before the grace existed. A Surface typed into since the interrupt is the user's again, and a retyped command would land in their line.

Supersession stops once a retarget has typed its command. A newer preview interrupting a line the shell has not yet reported could send its Ctrl+C before the shell reads that line, and its own command would then be typed into the old command's input (reasoned 2026-09-28, not reproduced). The wait it keeps is the command's startup report, normally milliseconds.

## Switching the slot

Observed live in the innerdogfood harness (2026-09-28), a retarget without a hold went: the old browser retired at once, the pane flipped to its terminal face (`^C`, a prompt, the typed command), the new frame appeared as a white blank, then the new document painted, while the header label passed through the terminal's derived titles and the dev-server chip came and went.

A screenshot of the old view is not the ghost for an iframe: a cross-origin frame's pixels cannot be read from the parent. None is needed either, since a loaded document stays painted after its server exits and CSS blurs a cross-origin frame. The blur is a `backdrop-filter` overlay, not the ghost's own `filter`: live in Chromium (2026-09-28), `filter: blur` sampled transparent pixels past the pane edge and rimmed a white page dark, while the backdrop's edges stayed clean. WebKit's edge handling is unobserved. A screencast's last frame is copied canvas to canvas, so nothing is encoded on the main thread as the preview arrives (a JPEG `toDataURL` of the device-resolution frame did that) and no pixels are read; keeping its live view would hold a session the retarget has closed.

Dimming was rejected (Ned, 2026-09-28): a dim reads differently on light and dark themes, and on a dark theme a dimmed page barely changes. Blur alone reads the same on both.

A built-in viewer prints only its `OSC 2` title and `OSC 367 serve`, so OSC-only output never ends a switch before its browser paints. The shell's echo of the typed command can arrive in the chunk that starts it, so the echo does not count as output either.

## Terminal links

xterm.js 6.1.0-beta.304 activates a link on every `mouseup` whose press began on that link, passing the `mouseup`. A two-press double-click sent to Chromium over CDP activated with `detail` 1, then 2 (2026-09-28). `agent-browser dblclick` sends a single press with click count 2, so it activates once and cannot probe this. A triple-click's third activation would be another `dor open`, starting an unkeyed Tool twice.

The display-text rule replaces the dialog's consent: the path the click opens is the text clicked. Output that can run `dor open` gains nothing from a link; output that cannot, such as a remote shell over ssh, names its own host in `ls --hyperlink`, which the host check refuses. OSC 7 locality (`isRemoteFileHost` in `lib/src/lib/terminal-state.ts`) differs: it treats every named host as remote, this machine's name included, while a link naming this machine opens, since `ls --hyperlink` names the local host too.

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

## OSC 367

JSON escaping can double the source length of a valid path, so a field within its own bound can still exceed the serialized payload cap of the host. C1 OSC and ST are literal JSON characters, unlike escaped C0 controls; allowing them in a serve path inserts terminal framing into the emitted sequence.

## Closing unsaved Tools

Host save request ids restart at 1 on a replacement connection. A completion that reads the current frame connection can therefore acknowledge a new request after reconnect, permitting closure before the new save finishes. The accepted host object distinguishes connection generations even when a reconnect repeats its nonce.
