# Surface Notepad — rationale

Evidence for `docs/specs/notepad.md`, keyed by its headings.

## The archive port

The port could have been "hand the host a mutation and let it apply it". It is a
compare-and-swap instead because the three hosts have nothing in common except
"store a string": the standalone store is a file behind a Rust command, VS Code's
is `globalState` behind a message round trip, and the demo's is a variable. Putting
validation and the mutation in one shared module means one implementation of the
schema, one of the merge, and hosts that cannot drift from each other — the VS Code
extension host imports the very same `applyArchiveMutation` for the teardown case
where no webview is left to ask.

That choice forces the revision token: without one, two webviews (a VS Code window
with the panel and an editor tab both open) each read, apply, and write, and the
later write silently drops the earlier one's batch. A token plus a retry costs one
extra read on the rare collision and loses nothing. The retry is only safe because
mutations are idempotent: the `'conflict'` loop re-applies the same mutation object,
so batch id alone covers it.

Note-id idempotence is for the case batch id cannot cover. A closure attempt that
reaches the host, lands, and *then* reports failure (the VS Code adapter's request
timeout does exactly this) leaves the user looking at a Surface that is still open,
so they keep typing into it. Remembering the batch id across that rejection made
the next attempt a no-op append — `applyArchiveMutation` skipped the id it already
had — and `removeSurface` then discarded everything added in between. A fresh id
per attempt plus dedupe by note id gets both halves right: the notes already stored
are dropped from the second batch, the new ones land, and nothing is duplicated. A
note id is a UUID, so "already stored" is an exact test rather than a heuristic.

`MAX_SAVE_ATTEMPTS` is 5. An unbounded retry against an archive somebody else is
rewriting in a loop would spin instead of telling the user, and the closure paths
need a decision — "keep this Surface open" — rather than a hang.

## Capture

Copy Rewrapped exists to make terminal output paste well into a chat window: it
drops frame-only lines, strips box-drawing runs, and joins paragraphs. That is the
wrong transform for a note. A captured excerpt is kept to be looked at again later,
often next to the terminal it came from, and often *because* of its shape — a table,
a tree, a diff. Rewrapping would destroy exactly what made it worth keeping. So the
capture joins soft-wrapped rows (undoing display wrapping, which is not content)
and does nothing else.

Trailing whitespace is trimmed only on rows that end hard for the same reason
`extractSelectionText` does it: a soft-wrapped row is full by definition, so its
trailing spaces are content that the next row continues from, while a hard-ended
row's trailing spaces are just the rest of the terminal grid.

Colors record what xterm *drew* rather than what the program *said*. The alternative
— record palette index 1 and re-resolve it at render time — sounds more faithful
but produces a note that does not match the screenshot in the user's memory: with
`drawBoldTextInBrightColors` on (xterm's default) bold red is drawn as bright red,
and a note showing plain red beside a terminal showing bright red reads as a bug.
The same argument settles inverse: the swap is baked in, with the defaulted side
made explicit, because a note that inverts at render time against a *different*
theme inverts to different colors.

Palette entries 0–15 are read from the live theme and 16–255 computed, because the
first sixteen are the user's and the rest are a fixed formula xterm itself applies.

## Source links

The pin could have stored a scrollback line number. It stores two xterm markers
because a marker is the only handle xterm keeps correct as the buffer scrolls, and
scrolling is the normal case — a capture is usually of something that has already
moved up the screen.

Markers alone are not enough, though: they track lines, not columns, and a resize
reflows the buffer under them. Rather than reimplement reflow tracking, the pin
carries the raw text it captured and refuses to navigate unless the rebuilt range
reads back byte for byte. That turns every failure mode — reflow, trimmed
scrollback, a program that overwrote the rows, an alternate buffer now active —
into one honest outcome instead of scrolling the user to plausible-looking wrong
output. It is why column restoration is allowed to be best effort at all.

Failure removes the pin rather than leaving it to fail again. A pin the user can
see is one that resolved the last time it was asked, which is a more useful promise
than a button that sometimes apologizes.

## Notepad UI

`beforeinput` is the whole mechanism behind "the first content mutation converts".
It is the one event that names *what* the edit is (`inputType`) for typing,
deletion, cut, and paste alike, and it fires before the DOM changes, so the handler
can cancel it, apply the same edit to the note's plain text, and hand that to the
store — one transition instead of a converted note plus a lost keystroke. React's
synthetic `onBeforeInput` cannot be used: it is built from composition and
`textInput` events, carries no `inputType`, and never fires for a deletion.

Caret movement and selection deliberately do not convert, because reading a rich
note is the common case and losing its colors to a stray arrow key would be a
surprise the user cannot undo.

### The chord on hosts that do not own their keyboard

Cmd/Ctrl+N in an ordinary browser tab opens a new window before any listener runs;
`preventDefault` does not stop it. A demo that showed `Cmd+N` next to "Add to
notepad" would therefore advertise a shortcut that spawns a window and (sometimes)
also adds a note. `browserReservesNotepadChord` lets the adapter say "this build
runs in a browser I do not own", in the style of `hostOwnsTheme`, so the button
stays and the shortcut label and binding both disappear. The shipped Tauri and VS
Code builds own their keyboards and leave it unset.

The chord is gated on a finalized selection for the same reason Ctrl+C is: with no
selection, Ctrl+N is readline's next-history and must reach the program.

## Archive

An unreadable archive is the one place the app could destroy user data by being
helpful. Starting fresh over a file that failed to parse is what most stores do,
and it is unrecoverable — the bytes may be a JSON syntax error one character wide
with a hundred notes behind it. So validation failure is a *state*, not a repair:
every append fails, closures take their failure path, and the Archive view says
plainly that nothing was replaced. Recovery is a single explicit button, and it
moves the data aside rather than deleting it, because only a human can judge
whether what is in there is worth salvaging.

Rejecting unknown fields rather than projecting them away is the same instinct
once more. A reader that keeps the fields it knows and drops the rest looks
forgiving, but every mutation loads, applies, and writes the *whole* archive
back, so the first save after a downgrade would quietly delete whatever a newer
build had stored — notes included, if the newer shape carried them in a field
this one does not have. `version` cannot cover it: it guards breaking changes,
and additive fields are exactly the ones a newer build ships without bumping it.
Refusing turns that into the unreadable state above — visible, and with the data
still on disk — instead of silent loss.

Staged deletion, rather than immediate, follows from the same instinct in the
opposite direction: the archive is where things go to be found weeks later, so a
misclick must be cheap. Holding the set in view state costs nothing, makes Undo
free, and means a failed write leaves the view exactly as it was — the retry is
pressing Back again.

## Closure

Refused closures queue rather than sharing one slot because a Surface with an
unanswered prompt is a Surface the user cannot close. With one slot, killing a
second Surface while the first prompt was up replaced it, and the first Surface was
left holding its notes with nothing on screen left to answer for it.

`dor kill` takes the error and raises no prompt because its caller is an agent or a
script, not someone looking at the Wall: a modal there blocks a window nobody is
watching, and the command already answers with the reason.

The freeze exists because the coordinator snapshots the notes, awaits the host, and
*then* forgets them, and the panel stayed interactive across that await. A note
added in between was deleted having never been archived. An edit was worse: the
batch already held the pre-edit text, so the archive kept a stale copy and the
forget step took the edit with it. Refusing the mutations is what makes the
snapshot and the forget describe the same notes; a counted freeze rather than a
flag is because two closures of one Surface can overlap (a kill retried while the
quit gate is closing everything), and the first to finish must not thaw notes the
second is still writing.

## Standalone quit

The gate sits before the first `quit_progress` rather than inside the teardown
because teardown has a standing rule that no failing step prevents exit — that rule
is what keeps a wedged flush from stranding the app. Archiving needs the opposite:
a failure has to be able to stop the quit and ask. Before `quit_progress` the flow
is still in the phase Rust's watchdog does not bound (a human may be looking at the
confirmation dialog), so the dialog can offer Cancel / Quit anyway. Once teardown
starts, nothing may ask a question again.

The failure path leaves the pending quit alone rather than cancelling it, because
`quit_cancel` bumps `seq` and retires the live watchdog: cancelling before the
dialog went up meant a later Quit anyway ran the whole teardown unwatched, with
nothing left to force the exit if the webview wedged. Phase 2's wait is unbounded
precisely so it can sit through a human's decision, so the quit stays pending and
only Cancel — the branch that really does abandon the quit — invokes it.

The deadline aborts the archive it stopped waiting for because `withDeadline` only
stops the *waiting*. The write keeps going, and a success arriving minutes later
called `removeSurface` on every Surface — emptying every notepad in front of a user
who had just been told the notes were not stored and had chosen Cancel.

3 s is the bound because the write is one small file and the user is waiting on a
quit they already asked for; a slower answer is a failure worth surfacing.

The file is a sibling of `sessions/` rather than a member of it because the two have
different lifetimes: session snapshots are per window and swept by `clear_session`,
while archived notes outlive the window that produced them and must survive that
sweep. They share `write_file_atomically` because both carry user text and both
must survive a crash mid-write; that is one implementation, not two.

## VS Code lifecycle

VS Code destroys a webview whenever it likes — an editor tab closed, a window gone,
a panel dragged between containers — and gives the extension no veto and no
reliable "about to be destroyed with these notes" hook. The close coordinator
therefore cannot be the only path. The mirror is the smallest thing that closes the
gap: the webview pushes what a close *would* archive after every change, and the
two endings the extension host *does* see (a `killOnDispose` router disposal, and
`deactivate()`) archive from it.

It is memory only, and that is the point rather than a limitation. A file-backed
draft store would be a second archive with its own staleness, its own recovery
story, and its own disclosure — captured terminal excerpts on disk that no closure
ever wrote. Module state cleared by an extension restart is exactly the lifetime
the mirror needs: one disposal wide.

The snapshot is round-tripped through `readNotepadArchive` on the way in because a
teardown writes it verbatim into `globalState` with no webview left to validate it,
and one malformed note would make the whole archive unreadable on the next load.

Staged archive deletions leave on *every* disposal, not only a killing one, because
the promise the Archive view makes when it stages them is "irreversible once this
window closes" — and for the user the webview *is* the window. A `WebviewView`
dragged between containers is disposed and re-resolved, and keeping the staged set
meant the new view showed a batch the user had already deleted, still offering
Undo, which `deactivate()` would then delete for real hours later. Committing at
the disposal makes the promise true and leaves nothing pending to hand a resume.

`globalState` and not `workspaceState`: an archive is machine-local, and a Surface
closed in one window belongs in the same list as every other. Settings Sync is the
hazard that follows from that choice — it would carry excerpts, CWDs, and titles to
every machine the user signs into — and VS Code syncs only keys an extension
registers, so the rule is kept by there being no `setKeysForSync` call anywhere in
the extension.

## Live resume

The mirror hydrates a live resume and nothing else because a live resume is the one
case where the notes and the Surfaces they belong to are both still real: the PTYs
never died, the pane ids are the same, and the webview that vanished was a
rendering detail. A cold restore is the opposite — the PTYs are gone, the Surfaces
are rebuilt from a saved snapshot, and any notes still in memory belong to a
previous life of the application. Hydrating there would resurrect notes for
Surfaces the user already ended, which is worse than losing them.

`loadVolatile()` is consumed exactly once for that reason: a second read could only
be a later, colder boot's.

The mirror is served non-destructively (the resuming webview re-reports the notes
under its own router, re-establishing ownership) so that a webview which boots and
then crashes before its first sync still has its notes archived by `deactivate()`.
