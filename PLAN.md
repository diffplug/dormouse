# Surface Notepad and Archive

## Summary

Add an ephemeral per-Surface notepad to Standalone, VS Code, and the desktop website demo. Pocket remains out of scope.

A notepad can contain manually entered plain text and rich terminal selections preserving bold, italic, foreground color, and background color. Rich notes use an application-owned run model rendered as safe DOM—not another xterm instance—so they can be edited, archived, and copied as both `text/plain` and `text/html`.

Normal-buffer captures may retain runtime-only xterm markers that link back to their scrollback source. This works while the source remains in the live buffer; markers are never archived.

When a Surface closes, its notes are persisted as one archive batch containing the Surface title, kind, latest CWD, closure time, and notes. Standalone and VS Code use entirely separate machine-local archives. The desktop demo uses memory only.

The design is supported by xterm’s public [cell-style API](https://xtermjs.org/docs/api/terminal/interfaces/ibuffercell/) and [buffer markers](https://xtermjs.org/docs/api/terminal/interfaces/imarker/). VS Code’s archive belongs in extension-global storage, which is workspace-independent; do not opt its key into Settings Sync. See [VS Code data storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage).

## Data Model and Platform Interfaces

Introduce a shared notepad model:

```ts
interface RichTextRun {
  text: string;
  bold?: true;
  italic?: true;
  foreground?: string; // normalized #RRGGBB
  background?: string; // normalized #RRGGBB
}

type NoteContent =
  | { kind: 'plain'; text: string }
  | { kind: 'terminal'; runs: RichTextRun[] };

interface RuntimeTerminalSource {
  terminalId: string;
  startMarker: IMarker;
  endMarker: IMarker;
  startColumn: number;
  endColumn: number;
  expectedRawText: string;
}

interface LiveNote {
  id: string;
  createdAt: number;
  content: NoteContent;
  source?: RuntimeTerminalSource;
}

type ArchivedNote = Omit<LiveNote, 'source'>;

interface ArchiveBatch {
  id: string;
  closedAt: number;
  surfaceTitle: string;
  surfaceKind: SurfaceKind;
  cwd: CwdState | null;
  notes: ArchivedNote[];
}

interface NotepadArchiveV1 {
  version: 1;
  batches: ArchiveBatch[];
}
```

`ArchiveBatch.cwd` is required but nullable. For terminal-backed Surfaces, snapshot the complete canonical `CwdState` immediately before teardown, preserving the path, URI, host and remote identity, path kind, source, and observation time. Browser Surfaces and terminals without a known CWD store `null`. The Archive UI renders the full path and remote host through the existing CWD display utilities rather than persisting a preformatted label.

Add a host-backed archive port to `PlatformAdapter`:

```ts
interface NotepadArchiveMutation {
  append?: ArchiveBatch[];
  deleteBatchIds?: string[];
  deleteNotes?: Array<{ batchId: string; noteId: string }>;
}

interface NotepadArchivePort {
  load(): Promise<unknown>;
  mutate(change: NotepadArchiveMutation): Promise<void>;
  syncVolatile?(snapshot: VolatileNotepadSnapshot): void;
}
```

The shared layer validates `load()` as `NotepadArchiveV1`. A malformed archive is reported as unavailable and must never be silently replaced: the Archive view shows it as unreadable and offers one user-initiated recovery, which moves the unreadable data aside (Standalone renames the file to `notepad-archive-v1.unreadable-<timestamp>.json`; VS Code copies the value to a sibling `globalState` key) and starts an empty archive. Until then every append fails and closures take the failure path in Archive and Lifecycle. Mutations operate against the latest stored version and are idempotent by batch and note ID, preventing duplicated batches or lost concurrent appends.

`syncVolatile` supports VS Code’s unavoidable editor-disposal lifecycle. It mirrors live note content, Surface metadata including `cwd`, and staged archive deletions into extension-host memory. It excludes terminal markers, is never written to disk, and is cleared on extension restart. It hydrates exactly one path, a live resume: a webview re-resolved over PTYs the extension host still owns (the bottom-panel `WebviewView` is disposed by a move between containers, and its `onDidDispose` leaves PTYs alive) receives the mirrored notes for the Surface ids in its live PTY list, riding the boot payload beside the recovery commands. It never hydrates a cold restore.

Do not add live notes to session snapshots, Lath persistence, `localStorage`, VS Code webview state, workspace state, or any other restoration path. The volatile mirror above is the one exception, and only for live resume.

Platform archive implementations are:

- Standalone: a versioned, owner-only `notepad-archive-v1.json` under Tauri application data, separate from session files. Serialize mutations, lock against concurrent writers, and use atomic temporary-file, sync, and rename replacement.
- VS Code: a versioned entry in `ExtensionContext.globalState`, updated through a serialized extension-host queue. Never register the archive key for Settings Sync.
- Website desktop demo: an in-memory implementation cleared by page reload.
- Pocket: no notepad or archive implementation.

## Notepad UI, Capture, and Source Links

Add `<NotepadIcon />` to every desktop Surface header. It appears after the cursor/selection icon when that icon is present and before the split controls. It is present at the full and compact header tiers; at the minimal tier it appears only while the Surface has notes, so notes are never invisible but an empty notepad yields its 20px to the title. It uses:

```tsx
<NotepadIcon weight={noteCount > 0 ? 'fill' : 'regular'} />
```

For an attached Surface, clicking it opens a panel aligned to the top-right of the Surface body with 75% of the Surface width and height. Only one Surface notepad is open per Wall. The panel traps its editing interactions from terminal shortcuts and closes on its close control, Escape, or an outside click.

For a minimized Surface containing notes, place a distinct filled Notepad button in its Door. Restructure the current single-button Door into a wrapper carrying `data-door-id` (what the selection ring and baseboard fitting measure) with two buttons: the title button keeps click-to-reattach and the drag press, the Notepad button does neither. It opens a compact, edge-clamped popover above the Door, capped at approximately 30rem wide and 75% of the Wall height. Opening it does not reattach the Surface. Minimized Surfaces with no notes do not need a Notepad button.

Notes remain in creation order from top to bottom. Each live item offers Copy and Delete, plus a source-link pin when available. Add New creates an empty plain-text note at the bottom and focuses it; an untouched empty note disappears on blur or panel close.

Existing notes are directly focusable and editable at the clicked text position. Focusing or moving the caret through a rich note does not change its model. The first content mutation—typing, deletion, cut, or paste—atomically converts the entire note to plain text and then applies the edit. Pasted content is inserted as plain text. Pins do not affect ordering and are not user-controlled favorites.

Render rich runs as escaped DOM spans in a whitespace-preserving container. Copy writes:

- `text/plain` for every destination.
- Sanitized `text/html` generated only from escaped text and the four supported attributes.
- Plain-text fallback when rich clipboard writing is unavailable.

Extend the finalized Dormouse native-selection popup with “Add to notepad,” after Copy Raw and Copy Rewrapped. Show `Cmd+N` on macOS and `Ctrl+N` elsewhere. The shortcut is intercepted only while that terminal has a finalized Dormouse selection; otherwise the key continues to the terminal unchanged. Intercept with a capture-phase window listener that calls `preventDefault` and `stopPropagation`, as the popup's Escape handler does; that also keeps the chord from VS Code's keydown forwarding to the workbench, which the implementation verifies in the extension build. The Standalone menu claims no N chord. The website demo shows no chord and binds none, because browsers reserve Cmd/Ctrl+N; an adapter flag the website's adapter sets, in the style of `hostOwnsTheme`, gates it. Successful capture briefly shows an Added state and dismisses the selection popup without opening the notepad.

Capture text by joining soft-wrapped rows, detected by xterm's `isWrapped` on the following line, and keeping every hard line break; a block selection keeps every row. This is not Copy Rewrapped: no paragraph joining and no box-drawing stripping. Separately retain the raw selected text (`extractSelectionText`) for source validation. Colors record what xterm renders, so bold with palette 0-7 resolves to the bright entry while `drawBoldTextInBrightColors` is on. Walk xterm buffer cells over the normalized selection, skip width-zero continuation cells, include wide characters once, resolve explicit palette/RGB and inverse colors to normalized RGB, and merge adjacent runs with identical supported styling. Ignore underline, strike-through, dim, blink, hyperlinks, and other terminal attributes.

For normal-buffer captures, register start and end xterm markers and store the normalized endpoint columns and raw selected text. Alternate-buffer captures receive no source link.

Clicking a source pin:

1. Closes the notepad and reattaches the Surface if necessary.
2. Resolves both live markers and reconstructs the original range using their current lines and stored columns.
3. Reads the candidate range and compares its raw text exactly with `expectedRawText`.
4. On success, scrolls it into view and restores the xterm selection plus Dormouse outline and finalized-selection popup.
5. On disposed markers, missing rows, or a text mismatch, removes the pin, keeps or reopens the notepad, and reports that the source is no longer available.

Column restoration after terminal resizing is explicitly best effort; the raw-text equality check prevents navigation to incorrect output. Scrollback trimming is discovered only when a pin is used. Disposing or replacing the terminal instance removes its pins immediately while retaining the notes.

## Archive and Lifecycle

Add a Notepad Archive entry to Settings. It opens a dedicated, roomy Archive view with a Back to Settings action.

Show newest batches first while preserving note order within each batch. Each batch header displays its Surface title, kind, closure time, and CWD when present. Archived notes support Copy and Delete only—no editing or source pin. Copy uses the same plain/HTML clipboard exporter as live notes.

Archive deletions are staged in UI state while the Archive view remains open:

- Delete immediately hides the selected note without confirmation.
- Empty batches are hidden automatically.
- After the first deletion, show: “Deletion is irreversible once this window closes. Undo”.
- Undo restores every deletion staged since the Archive view was opened.
- Back, Escape, and the dialog close control commit the remaining deletion set in one mutation before leaving.
- If the mutation fails, keep the Archive view open, retain its staged state, and show the error.

Archived entries remain until explicitly deleted. Do not impose an age limit or count limit.

Route every user-visible permanent Surface closure through an asynchronous close coordinator. If notes exist, construct stable-ID batches and append them before teardown. This includes titlebar actions, keyboard kills (confirmed and the untouched fast path), `dor kill`, the door-restore kill path, and controlled application quit. Multi-Surface closure appends all batches in one mutation. Workspace/Window closure has no live code path (`closeWorkspace` has only test callers and the workspaces flag is dormant), so the spec states it as `Reserved:` against the workspaces-rollout scope and nothing is wired.

If archiving fails during a blockable closure:

- Keep the affected Surface open and show a pane-anchored error offering Keep open (default) and Close anyway, which discards that Surface's notes; without the escape an unwritable archive makes every Surface unclosable.
- Return an error from `dor kill`; the Surface stays.
- In Standalone the archive is a gate step before teardown: after the running-work confirmation (or immediately on an all-idle quit) and before `quit_progress`, bounded at 3 s. Failure or timeout calls `quit_cancel`, and the quit dialog shows the error with Cancel (default) and Quit anyway, discarding notes. Teardown keeps its existing rule that no failing step prevents exit.

Keep an internal immediate-teardown primitive only for rollback and throwaway Surfaces that cannot contain user notes.

Renderer changes, browser/terminal mode changes, and shell replacement performed in place retain the live notepad instead of archiving it. Every such replacement mints a new Surface id (`replaceSurface`, the untouched-shell replace branch, the door `replace-terminal` restore), so the notepad store migrates the notes to the new id wherever `transferSurfaceRef` runs. Any terminal source pins are discarded if their terminal instance is disposed.

For Standalone, intercept controlled window/application closure, archive every live batch in one transaction, then continue shutdown. Forced process termination or crashes may lose live notes.

For VS Code, continuously refresh the extension host’s volatile in-memory mirror. On editor-panel disposal (`killOnDispose: true`) or extension deactivation, append mirrored notes and commit mirrored staged deletions on a best-effort basis. The bottom-panel `WebviewView`'s disposal is not a closure: its PTYs stay alive, its notes stay in the mirror, and they hydrate the next resolve. External VS Code tab/window destruction cannot reliably be blocked; a final storage failure or forced termination may therefore lose those notes. Do not add a persistent draft mirror to address this limitation.

Standalone and VS Code archives must never discover, import, synchronize, or share each other’s data.

## Tests and Documentation

Add unit coverage for:

- Rich extraction across bold, italic, palette/RGB foreground and background, inverse colors, default colors, wide characters, reversed selections, hard breaks, and soft wraps.
- Run merging, HTML escaping, clipboard MIME output, and plain-text fallback.
- Rich-to-plain conversion only on actual content mutation.
- Archive schema validation, including required local, remote, and `null` CWD snapshots.
- Idempotent append/delete mutations, malformed archives, concurrent appends, and atomic-write failures.
- Marker restoration, resized buffers, trimmed markers, alternate buffers, text mismatch, and terminal disposal.
- VS Code volatile snapshots excluding markers, hydrating a live resume, and never hydrating a cold restore.

Add component and integration coverage for:

- Header icon ordering, filled state, and all density tiers.
- Attached 75% panel behavior and compact Door popover behavior.
- Door Notepad clicks not reattaching the Surface.
- Note creation, editing, copying, deletion, ordering, and keyboard isolation.
- Selection-popup action and platform shortcut behavior.
- Archive batch CWD display, staged deletion, Undo, commit-on-close, failed commit, and the unreadable-archive recovery.
- Explicit close, `dor kill`, replacement, controlled Standalone quit, VS Code panel disposal and view re-resolve, and their failure paths including Close anyway and Quit anyway.
- Strict separation of Standalone, VS Code, and demo archive stores.
- Confirmation that live notes are absent from every existing session-persistence format.

Add focused Storybook scenarios for empty/filled headers, rich and plain notes, unavailable pins, minimized Door popovers, local/remote CWD batch headers, and staged archive deletion.

Create `docs/specs/notepad.md` as the owning specification and add it to the AGENTS.md spec index and word-budget registry. Update the owning sections of the layout, mouse-and-clipboard, shortcuts, transport, Standalone, VS Code, local-security, and user-security specs. The security contract must disclose that explicitly captured terminal excerpts, style data, Surface metadata, and CWD can persist in the archive while ordinary scrollback remains unpersisted.

Before implementation, read the glossary, the touched specifications and rationales, `PRODUCT.md`, `DESIGN.md`, and the shared design-token source. Finish by running focused library/host tests, spec lint, and the root test/build suites.
