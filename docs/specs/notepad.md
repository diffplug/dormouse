# Surface Notepad

> See `docs/specs/glossary.md` for Surface / Session / Pane / Door / Wall vocabulary. This spec uses it throughout.
>
> Owns the per-Surface notepad: its model, the host archive port, capture, source pins, the notepad UI, the Archive view, and every path that turns live notes into archived ones.
> **Defers:** header element order and density tiers to `docs/specs/layout.md`; the selection popup and its chords to `docs/specs/mouse-and-clipboard.md`; CWD semantics to `docs/specs/terminal-state.md`.
> Read [Closure](#closure) first for anything about a Surface ending.

## Model

A notepad is one ordered list of notes per Surface, held in renderer memory for that Surface's life and opened from its header or its Door.

- **A note is plain text or a captured terminal excerpt** (`NoteContent`), and nothing else.
- **A run keeps bold, italic, foreground, and background, and nothing else.** Colors are normalized lowercase `#rrggbb`; a missing color means the theme default, so an excerpt stays theme-adaptive. **Underline, dim, blink, strike-through, and hyperlinks are dropped at capture**, never later.
- **A note's source pin is runtime-only.** `RuntimeTerminalSource` holds live xterm markers, so `ArchivedNote` is `LiveNote` minus that field and no marker ever reaches a store.
- **A closure appends one `ArchiveBatch` per Surface** — `id`, `closedAt`, `surfaceTitle`, `surfaceKind`, `cwd`, and the notes in creation order.
- **`ArchiveBatch.cwd` is required and nullable.** It is the whole canonical `CwdState` snapshotted before teardown — path, URI, host, path kind, source, observation time — or `null` for a browser Surface and a terminal that never reported one. **Never persist a preformatted CWD label beside it**; the Archive renders path and remote host through `cwdDisplay`.
- **A batch id is remembered per Surface across its closure attempts and forgotten once one lands**, and **every attempt deletes and re-appends that id in one mutation**, so an attempt that landed and *then* reported failure is replaced by the next, carrying the edits, additions, and deletions made in between. **`closedAt` is minted per attempt.**
- **A mutation applies its deletes before its appends**, which is what makes that pair a replacement. Appends stay idempotent by batch and note id — an already-stored note is dropped from an appended batch and a batch left empty is skipped — and deleting something already gone is a no-op.

Source of truth: `lib/src/lib/notepad/types.ts`; `applyArchiveMutation`, `buildArchiveBatch`, `readNotepadArchive` and `toArchivedNote` in `lib/src/lib/notepad/archive-model.ts`; `pendingBatchId` in `lib/src/lib/notepad/notepad-store.ts`.

## The archive port

`PlatformAdapter.notepadArchive` is the whole host surface of the archive.

- **A host stores bytes and names their version; the shared layer owns the shape.** `load()` returns `{ raw, revision }` or `null` (nothing ever archived); `save(archive, baseRevision)` replaces the stored archive only while it is still at that revision, answering `'conflict'` otherwise.
- **Every mutation is a compare-and-swap, retried on conflict** — load, validate, apply, save against the revision just read — bounded at `MAX_SAVE_ATTEMPTS` before it reports the archive busy (rationale).
- **One mutation queue per webview.** Two Surfaces closing together would otherwise read one revision and lose a batch to the other's conflict.
- **A host with no notepad omits the port.** Pocket does, and the header icon, Door button, selection-popup action, and Settings entry are hidden with it.
- **One store per host, never shared.** The standalone and VS Code archives must never discover, import, or synchronize each other's data.
- **A failed archive rejects; it never resolves as if the write landed.** Closure paths turn that rejection into their failure UI rather than dropping notes.

Standalone stores a file ([Standalone quit](#standalone-quit)), VS Code a `globalState` entry ([VS Code lifecycle](#vs-code-lifecycle)), the demo hosts plain memory cleared by a page reload.

Source of truth: `NotepadArchivePort` in `lib/src/lib/notepad/types.ts`; `mutateArchive` and `resetUnreadableArchive` in `lib/src/lib/notepad/archive-service.ts`; `createMemoryNotepadArchivePort` in `lib/src/lib/notepad/memory-archive-port.ts`.

## Capture

"Add to notepad" captures a finalized Dormouse selection as a rich note on the Surface holding it.

- **Join soft-wrapped rows and keep every hard break.** A row is soft-wrapped when the row *following* it reports xterm's `isWrapped`; a block selection is a rectangular slab, so every one of its rows ends hard. **Trailing whitespace is trimmed only on a row that ends hard** — a soft-wrapped row is full by definition.
- **Capture is not Copy Rewrapped**: no paragraph joining and no box-drawing stripping (`docs/specs/mouse-and-clipboard.md` §4.1.2; rationale).
- **Retain the raw selected text separately.** `extractSelectionText` over the same selection is the pin's validation key, read from the buffer rather than rebuilt from the runs.
- **Colors record what xterm drew.** Walk buffer cells over the normalized selection, skip width-zero continuation cells, emit a wide character once, resolve palette and RGB colors, swap inverse ones to explicit values, and merge adjacent runs of identical styling. **Bold text on palette entries 0–7 resolves to the bright entry while `drawBoldTextInBrightColors` is on.** Entries 0–15 come from the live theme, 16–255 from xterm's computed table.
- **An alternate-buffer capture gets no pin.** A full-screen program rewrites its grid in place, so there is nothing stable to point at.
- **A capture flashes in place and dismisses the selection; it never opens the notepad.**

Source of truth: `extractRichRuns` and `captureRichSelection` in `lib/src/lib/notepad/rich-extract.ts`; `addSelectionToNotepad` in `lib/src/lib/notepad/capture.ts`.

## Source links

A pin is the runtime link from a captured note back to the scrollback it came from.

- **Pin a normal-buffer capture with two xterm markers plus the normalized endpoint columns and the raw text.** Markers ride the buffer as it scrolls; the columns and text rebuild and prove the range.
- Clicking a pin runs five steps: close the notepad; reattach a minimized Surface; resolve both markers and rebuild the range from their current lines and the stored columns; read it back and compare **exactly** with the captured raw text; on success scroll it into view and restore the Dormouse selection, outline and finalized popup included.
- **Column restoration after a resize is best effort**; the raw-text equality is what prevents navigating to the wrong output. Trimmed scrollback is discovered only when a pin is used.
- **Every pin failure removes the pin and keeps the note.** Disposed markers, rows out of range, and a text mismatch all report that the source is no longer available, the notepad kept or reopened to say so.
- **Disposing or replacing a terminal instance drops its pins immediately**, notes untouched — a marker belongs to one xterm instance.
- **Pins never affect ordering and are not user-controlled favorites.**

Source of truth: `registerTerminalSource`, `resolveTerminalSource` and `revealResolvedSource` in `lib/src/lib/notepad/source-link.ts`; `revealNoteSource` in `lib/src/lib/notepad/pin.ts`; `dropSourcesForTerminal` in `lib/src/lib/notepad/notepad-store.ts`, called from `disposeSession` in `lib/src/lib/terminal-lifecycle.ts`.

## Notepad UI

**The header notepad icon sits after the mouse-override icon and before the split controls** (`docs/specs/layout.md` → "Pane header"), filled while the Surface has notes and regular otherwise. **At the minimal tier an empty notepad yields its space to the title; one with notes stays**, so notes are never invisible.

- **The attached notepad is a panel in the top-right of the Surface body, three quarters of it wide and tall.** It closes on its close control, Escape, or an outside click.
- **Only one Surface notepad is open per Wall.** The store holds a single open id, and opening a Door's popover closes the attached panel.
- **An open notepad owns the keyboard.** It is a `role="dialog"` with a focus trap, marks the Wall's dialog-keyboard context active so command-mode dispatch stands down, and stops key and mouse events from reaching the Surface under it — a live browser pane's key forwarder included.
- **A Door is a wrapper carrying `data-door-id` with one or two buttons.** The wrapper is what the selection ring and the baseboard fitting measure; the title button keeps click-to-reattach and the drag press, the notepad button does neither. **A minimized Surface with no notes gets no notepad button.**
- **The Door popover opens above its Door, edge-clamped, capped at 30rem wide and 75% of the Wall height. Opening it never reattaches the Surface** — only following a pin from it does.

Editing and copying:

- **Notes stay in creation order, never re-sorted.** Add New appends an empty plain note at the bottom and focuses it; **an untouched empty note is pruned on blur or on panel close**.
- **Moving the caret through a rich note never converts it.** Conversion hangs off the one event that names the edit: **the first content mutation — typing, deletion, cut, or paste — converts the whole note to plain text and applies the edit atomically.** **Paste inserts the plain flavor only.**
- **An IME composition converts on `compositionend`, with the composed text** — `insertCompositionText` is not cancelable, so it is the one edit the browser writes into the rich DOM first.
- **Rich runs render as escaped spans in a whitespace-preserving container**, never as injected HTML.
- **Copy always writes `text/plain`.** A terminal note adds a `text/html` flavor built only from escaped text and the four supported attributes — never by serializing rendered DOM. **Anything the rich clipboard refuses falls back to the plain-text write**, best effort by contract.

Source of truth: `NotepadBody` in `lib/src/components/NotepadBody.tsx`, placed by `lib/src/components/NotepadPanel.tsx` and `lib/src/components/DoorNotepadPopover.tsx`; `applyPlainEdit` in `lib/src/components/NoteList.tsx`; `lib/src/components/Door.tsx`; `noteToHtml` and `copyNoteToClipboard` in `lib/src/lib/notepad/rich-clipboard.ts`.

The popup's third action and the `⌘N` / `Ctrl+N` chord belong to `docs/specs/mouse-and-clipboard.md` §4.1 and §4.2. Two rules are the notepad's own: **intercept the chord only while that terminal has a finalized Dormouse selection**, so with none it reaches the program unchanged; and **a host whose browser reserves the chord shows no shortcut and binds none**, gated by `browserReservesNotepadChord`, which the website demo and the standalone browser-dev harness set (rationale). Source of truth: `isNotepadChordBound` in `lib/src/lib/notepad/capture.ts`, `lib/src/components/SelectionPopup.tsx`.

## Archive

A **Notepad archive** entry in Settings replaces that dialog's content with a roomier Archive view carrying a Back to Settings action. **The entry is hidden where the host has no archive port.**

- **Batches show newest first, notes in their original order within each batch.** A batch header carries its Surface title, kind, closure time, and CWD when present.
- **An archived note offers Copy and Delete only** — no editing and no pin, through the same clipboard exporter live notes use.
- **Deletions are staged while the view is open.** A delete hides its target with no confirmation, a batch left with nothing visible goes with it, and the first deletion raises "Deletion is irreversible once this window closes." with an **Undo** restoring everything staged since the view opened.
- **Back, Escape, and the close control commit the staged set as one mutation before leaving. A failed commit keeps the view open with its staged set intact and shows the error**; pressing the same control again is the retry.
- **Stored data that fails validation is reported as unreadable and never silently replaced.** Every append fails meanwhile, and closures take the failure path in [Closure](#closure). **Exactly one user-initiated recovery moves the stored data aside — never deletes it — and starts an empty archive** (rationale).
- **An unknown field anywhere in stored data fails validation**, because every mutation rewrites the whole archive, so a field this build does not know would be erased on the next save (rationale).
- **Archived entries stay until explicitly deleted.** No age limit and no count limit.

Source of truth: `lib/src/components/NotepadArchiveView.tsx`; the Settings entry in `lib/src/components/SettingsDialog.tsx`.

## Closure

**Every user-visible permanent Surface closure routes through the close coordinator**, which builds stable-id batches from whatever notes exist and appends them in one mutation *before* teardown. Routed: the header kill button, keyboard kills both confirmed and on the untouched fast path, `dor kill`, the Door-restore kill path, and controlled application quit. **A multi-Surface closure appends every batch in one mutation**, and a closure with no notes writes nothing.

**A Surface's notes are frozen from the moment its closure snapshots them until the write settles** — adds, edits, and deletes are refused, a refused capture releases its own markers, and the panel renders read-only behind an "Archiving notes…" line — so nothing taken during the write can be archived stale or dropped unarchived by the forget step (rationale). The freeze is counted, so overlapping closures of one Surface thaw it once. **Empty plain notes are never archived**: an untouched Add New still on screen when the kill lands is not a note, and a Surface holding only those closes as if it held none.

**The immediate-teardown primitive is reachable only once the archive question is settled, or from a Surface that cannot have taken a note**: `closeSurface` after its append lands, its own Close anyway branch, and `dor ensure`'s integration-timeout teardown of the throwaway split it just created.

On a failed archive:

- **A blockable closure keeps the Surface open** behind a pane-anchored error offering **Keep open** (default) and **Close anyway**, which discards that Surface's notes; without the escape an unwritable archive would make every Surface unclosable.
- **Refused closures queue, oldest first, one prompt on screen**, so a second refusal cannot orphan the Surface waiting on the first; a Surface already queued has its message replaced.
- **`dor kill` returns an error, raises no prompt, and the Surface stays** — the caller is a command, not someone looking at the Wall.
- **An aborted `AbortSignal` suppresses the forget step.** The mutation still finishes, but the live notes stay, so a caller that stopped waiting cannot empty a notepad behind the user; a later close re-archives them once.

**An in-place replacement keeps the notepad instead of archiving it.** Renderer swaps, browser/terminal mode changes, and shell replacement each mint a new Surface id, so the notes migrate with the ref wherever `transferSurfaceRef` runs; pins into the disposed terminal are dropped on the way.

Reserved: Workspace and Window closure has no live code path today (`closeWorkspace` has only test callers and the workspaces flag is dormant), so nothing is wired to it; routing it through the coordinator belongs to the **workspaces-rollout** scope.

Source of truth: `archiveSurfaceNotes` in `lib/src/lib/notepad/close-coordinator.ts`; `closeSurface` and `killPaneImmediately` in `lib/src/components/Wall.tsx`; `NotepadArchiveFailureModal` in `lib/src/components/NotepadArchiveFailure.tsx`; `beginClosing` and `transferNotepad` in `lib/src/lib/notepad/notepad-store.ts`; `useSurfaceClosing` in `lib/src/components/use-notepad.ts`.

## Standalone quit

**Archiving is a gate step before teardown**: after the running-work confirmation, or immediately on an all-idle quit, and **before the first `quit_progress`** (`docs/specs/standalone.md` → "Quit flow"; rationale). **It is bounded at 3 s.**

- **A failure or timeout leaves the quit pending in Rust**, whose phase-2 wait is unbounded for exactly this (`docs/specs/standalone.md` → "Quit flow"), and the dialog shows the error with **Cancel** (default) and **Quit anyway**, which discards the notes. **Only Cancel calls `quit_cancel`**: Quit anyway must reach teardown with the watchdog still armed.
- **A timeout aborts the archive it stopped waiting for** ([Closure](#closure)).
- **Teardown's own rule is untouched**: once teardown begins, no failing step prevents exit.

The store is `<app_data_dir>/notepad-archive-v1.json`, **a sibling of `sessions/`, never inside it** — a Surface's notes outlive the window whose closure archived them, so they must not ride the per-window session blob or be swept by `clear_session`. **It is written owner-only and atomically through the same `write_file_atomically` the session snapshot uses** (`docs/specs/security-local.md` → "Persisted state"). **Recovery renames it to `notepad-archive-v1.unreadable-<unix-millis>.json` beside the original**, disambiguating rather than overwriting an earlier quarantine; only a temp file a crash left behind is dropped.

Source of truth: `archiveNotesBeforeQuit` in `standalone/src/quit.ts`, the `'archive-failed'` phase in `standalone/src/quit-confirm-store.ts`; `write_notepad_archive_to` and `reset_notepad_archive_at` in `standalone/src-tauri/src/lib.rs`; the port in `standalone/src/tauri-adapter.ts`.

## VS Code lifecycle

The archive is one `globalState` key, `dormouse.notepadArchive.v1`. **Never register it for Settings Sync** — it would carry captured terminal excerpts, their CWDs, and their Surface titles to every machine the user signs into, and the archive is machine-local. **Every read-modify-write goes through one extension-host queue**, so two webviews, or a webview and a teardown, cannot interleave.

VS Code can destroy a webview without asking, so the close coordinator may never run. **Every webview therefore mirrors its live notes into extension-host memory**, and a teardown archives from that mirror instead.

- **The mirror holds what a close would archive minus the markers** — notes, Surface title, kind and CWD, plus any archive deletions an open Archive view has staged.
- **The mirror is memory only, never written to disk, and cleared by an extension restart.** It is a bridge across one disposal, not a draft store.
- **The mirror is sanitized on the way in**, round-tripped through the archive validator, because a teardown writes it verbatim with no webview left to ask.
- **Editor-panel disposal (`killOnDispose: true`) and `deactivate()` archive their mirrored notes, best effort**, draining what they take so `deactivate()` cannot write a panel's notes again under a fresh batch id. In `deactivate()` the step sits between the recovery capture and the session flush, bounded (`docs/specs/vscode.md` → "Serialization and restore").
- **Every router disposal commits and drains that router's staged archive deletions, best effort** — they were promised irreversible once this window closed, and the webview *is* the window. **A live resume is therefore never handed a pending deletion**; `hydrateNotepadFromVolatile` ignores the field.
- **A `WebviewView` disposal is not a closure.** Its PTYs stay alive, so only its *notes* stay in the mirror for the next resolve.
- **External tab or window destruction cannot reliably be blocked**, so a storage failure or a forced termination may lose those notes. **Never add a persistent draft mirror to address it.**

Source of truth: `vscode-ext/src/notepad-archive-store.ts` and `vscode-ext/src/notepad-volatile.ts`; the `notepad:*` handlers and the `killOnDispose` archive in `vscode-ext/src/message-router.ts`; the archive step in `deactivate` in `vscode-ext/src/extension.ts`.

## Live resume

**The mirror hydrates exactly one path, a live resume** — a webview re-resolved over PTYs the extension host still owns, which is what a move between panel containers produces. It rides the boot payload beside the recovery commands, claimed by the same pane ids, and **is consumed exactly once**: a second read would be a cold restore's, and **a cold restore must never hydrate live notes** (rationale). An editor panel is always handed `null`.

**Hydration fills only live Surfaces holding no notes yet**, and restores no pins — the markers died with the previous webview's xterm instances.

**Live notes must never enter a restoration path**: not a session snapshot, not Lath persistence, not `localStorage`, not VS Code webview or workspace state. The volatile mirror is the single exception, and only here.

Source of truth: `hydrateNotepadFromVolatile` in `lib/src/lib/notepad/notepad-store.ts`, called from the live-resume branch of `lib/src/lib/reconnect.ts`; `snapshotForLiveResume` in `vscode-ext/src/notepad-volatile.ts`; `readInjectedVolatileNotepad` in `lib/src/lib/vscode-notepad-global.ts`.

## Security

**Captured terminal excerpts, their style data, the Surface title and kind, and the CWD persist in the archive; ordinary scrollback still persists nowhere** (`docs/specs/security-local.md` → "Persisted state"). An excerpt reaches disk only because the user added it to a notepad and then closed that Surface.
