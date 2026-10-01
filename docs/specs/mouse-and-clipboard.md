# Terminal Mouse and Clipboard Behavior Specification

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it for the pane-level scoping of mouse regime, override state, and selection.

> Sections are numbered for cross-spec reference (`§8.6` etc.); the numbers are stable, so append rather than renumber.

## Overview

Owns terminal selection, copy, paste, mouse override, and their chrome across platforms. Header placement: `docs/specs/layout.md`; sequence registry: `docs/specs/terminal-escapes.md`.

For tools, these rules apply while the terminal is forward; the browser or conflict view owns the keys otherwise.

## Background: The Two Mouse Regimes

Mouse events belong to one of two consumers:

1. **The terminal** — the default. Drags paint a selection; clicks shift focus or hit terminal chrome.
2. **The inside program** (`tmux`, `vim`, `less`, `htop`), once it emits a mouse-reporting escape sequence (`\e[?1000h`, `\e[?1002h`, `\e[?1003h`, optionally `\e[?1006h` SGR encoding). Events reach it as input, and the terminal's own selection is unreachable meanwhile.

## Terminology

- **Live region:** the terminal area showing the active screen buffer.
- **Scrollback:** history of previously-drawn content above the live region.
- **Mouse reporting:** the inside program has requested and is receiving mouse events.
- **Override:** the terminal takes mouse events for selection despite mouse reporting.

---

## 1. The Mouse Icon (Header Indicator)

**Visibility.** The **Mouse icon** (Phosphor `CursorClickIcon`) marks an inside program requesting mouse reporting; the **No-Mouse icon** (`CursorTextIcon`) takes the same slot while an override is active (full matrix: §6.2). Both drop below the compact tier (`docs/specs/layout.md`).

**Click.** The Mouse icon starts a **temporary override** (§2); the No-Mouse icon ends any override immediately and restores mouse reporting.

Source of truth: `lib/src/components/wall/TerminalPaneHeader.tsx` (icons), `lib/src/components/wall/MouseOverrideBanner.tsx` (banner and its actions).

---

## 2. Override State

**Temporary override.** Clicking the Mouse icon starts one. While active:

- Mouse events go to the terminal, not the inside program; belt and braces, any report xterm still emits is stripped from its `onData` stream before the write reaches the PTY (`stripMouseReportsFromInput`, `docs/specs/terminal-escapes.md`).
- **Wheel events are suppressed too**, so xterm cannot turn scroll into mouse reports or alternate-screen arrow keys.
- The No-Mouse icon replaces the Mouse icon, and a banner at the top-right of the pane content area reads `Temporary mouse override until mouse-up.` plus **Make sticky** and **Cancel**.

It ends on the **next mouse-up inside the terminal content area** paired with a prior mouse-down there:

- **Counts:** a plain primary click (down/up that never crossed the drag threshold) or a completed drag.
- **Does not count:** a non-primary click, whose context menu the override swallows anyway; clicks on the No-Mouse icon or the banner buttons; and an orphan mouse-up from a drag that started outside the terminal. Pinned by `lib/src/lib/terminal-mouse-router.test.ts`.
- **On end** — or on **Cancel**, after that button's 260 ms confirmation flash — reporting is restored, banner dismissed, Mouse icon back. **No timeout:** absent any mouse action the override stays indefinitely.

**Sticky override.** **Make sticky** converts it after the same flash (the store calls this state `permanent`): banner dismissed, No-Mouse icon kept with its "click to restore" hover text, mouse and wheel still going to the terminal. It persists until the user clicks the No-Mouse icon.

**Auto-clear on reporting off.** **Either override clears when the inside program stops requesting mouse reporting** (it exits, or DECRSTs `?1000l`/`?1002l`/`?1003l`); icon and banner go with it. A **dead** session's replay ends in the `REPLAY_MODE_RESET` tail that DECRSTs mouse tracking (`docs/specs/terminal-escapes.md`), so a mode latched by a dead TUI cannot block selection in the restored pane.

**No keyboard path is designed** for the icons or banner buttons, and focus-based activation is not actively prevented.

---

## 3. Selection Behavior

Selection is available whenever the terminal handles the mouse (§3.5, §6.1).

### 3.1 Initiating a Selection

- **Must begin selection after a click-and-drag crosses ~4px**; plain clicks shift pane focus or activate hyperlinks. **Must capture mouse presses on xterm’s screen immediately** (rationale); that capture, and the plain click it must not break, are pinned by `lib/src/lib/terminal-mouse-router.test.ts`.
- On touch or pen, a primary pointer tap-and-drag takes the same path; non-primary touch pointers are ignored.
- The selection draws as a single perimeter outline tracing the union of selected cells (§7 owns rendering). Color is `--color-focus-ring` (`docs/specs/theme.md`), with a hardcoded cornflower-blue final fallback in `SelectionOverlay.tsx`.
- **A drag whose button comes up outside the webview iframe must still finalize**, by captured `pointerup` or the window-`mousemove` backstop (rationale).

Source of truth: `lib/src/lib/terminal-mouse-router.ts`.

### 3.2 Selection Shapes

- **Linewise (default):** reading order, wrapping end-of-line to start-of-next-line.
- **Block (rectangular):** hold **Alt** (Option on macOS) during the drag.
- **The shape updates live as Alt is pressed and released mid-drag**, including while the mouse is stationary.
- Touch has no Alt key, so block mode is armed by **starting the drag with a double-tap** — a press within 300 ms and 24 px of a previous touch that *ended as a tap*. **Must retain that block shape for the whole drag**, including hardware-keyboard events. Pinned by `lib/src/lib/terminal-mouse-router.test.ts`.

### 3.3 Selection Hint Text

A small hint sits adjacent to an in-progress selection — below when dragging downward, above when dragging upward, always above in the touch UI so the thumb does not cover it. It shows for the whole drag whenever the drag's current end row is on screen, and never fades. §5.2 adds the extension line. Exact strings — mouse, touch, block, extension — in `lib/src/components/SelectionOverlay.tsx`.

### 3.4 Selection Follows Content

A selection is anchored to the characters under it, not to screen coordinates: stored in absolute buffer rows (scrollback + viewport).

- **Pure scroll** — vertical translation with no character changes — carries the selection along; coordinate math only, no matching.
- **Content change:** any change to a cell the finalized selection overlaps cancels it immediately; repaints elsewhere on screen are irrelevant. A text snapshot, retaken whenever the selection is finalized or moved (§4.3), is compared on each xterm render; **never add a partial-match or content-tracking heuristic** — cancel-on-change is the rule (§9.1).
- **Terminal resize** counts as a content change and cancels any active selection.

### 3.5 Selection in the Live Region vs. Scrollback

- **Scrollback selection is always available**, whatever the reporting or override state; live-region availability follows §6.1's matrix.
- **Crossing the boundary:** a drag beginning in scrollback and continuing into the live region is a single continuous selection. A drag beginning in the live region under mouse reporting, with no override, goes to the inside program instead, shadowed (§3.8).

### 3.6 During a Drag

**A terminal-handled drag claims the keyboard.** **e** extends to a detected token (§5), **Esc** cancels the drag and any in-progress selection, and every other keystroke is swallowed, not forwarded. **Alt** alone is left un-swallowed, so the OS still sees the modifier that drives block shape (§3.2). Normal routing resumes on mouse-up; the handler yields entirely when the selected Surface is not a terminal.

Source of truth: `lib/src/components/wall/keyboard/handle-mouse-selection-keys.ts`.

### 3.7 Ending a Selection

- Releasing the button ends the drag and fixes the selection; the copy editor (§4) opens.
- It persists until something ends it: a completed copy, a content change (§3.4), **Esc**, or a click outside (§4.3).
- **A new mouse-down in the terminal content area replaces any existing selection immediately** and dismisses its editor.

### 3.8 Drags the Inside Program Owns

A primary mouse drag that reaches the inside program (§6.1) is **shadowed**: its events reach the program untouched, and on release the cells it crossed become a linewise selection the program owns.

- **Must never consume, delay, or reorder a shadowed drag's events**; only a press that crosses the drag threshold counts, so a program click shadows nothing.
- It draws no outline, only a `Press Cmd+C to copy` hint (Ctrl+C on non-macOS): the program paints its own highlight.
- **The copy chord opens the copy editor over it** (§4), outline included. Any other key goes to the program and drops the shadow, as do a new mouse-down, a content change (§3.4), and the program ending mouse reporting.
- Touch never shadows; a touch drag over a reporting program takes §6.1's rows.

Source of truth: `finishProgramDrag` in `lib/src/lib/terminal-mouse-router.ts`, pinned by `lib/src/lib/terminal-mouse-router.test.ts`; the chord in `handleMouseSelectionKeys` in `lib/src/components/wall/keyboard/handle-mouse-selection-keys.ts`.

---

## 4. Copy Editor

Mouse-up over a terminal-handled drag opens the **copy editor**, as does the copy chord over a shadowed one (§3.8): the text a copy would produce, at full pane width, every line break the selection crossed marked (rationale).

### 4.1 Formats

| Format | Clipboard text |
|---|---|
| **Auto** (opens here) | Decoration stripped, each break judged on its own (§4.1.1). |
| **Exact** | As displayed: selected rows joined by `\n`, each trimmed of trailing whitespace — soft-wrapped rows included. |
| **Spaces** | Decoration stripped, blank lines dropped, every break one space, continuation indents removed. |
| **No breaks** | As Spaces, every break deleted. |

**Decoration** is a frame-only line (dropped), a leading or trailing run of box drawing (`U+2500–U+259F`, Box Drawing and Block Elements), and a TUI's leading bullet (`⏺`, `⎿`, `●`). **Must read cells through xterm's wide-character continuation cells.** **Never rewrap a block-shape selection**: it is a rectangular slab, so Auto reads it as Exact, and it has no wider scope (§4.2) and no edge keys (§4.3).

Source of truth: `render` in `lib/src/lib/copy-text.ts`, pinned by `lib/src/lib/copy-text.test.ts`.

#### 4.1.1 Auto

Each break between two consecutive rows is, in this order:

1. **Kept** if either row is blank, the next starts a list item, the row ends in `;` `{` `}` or the next starts with `)` `}` `]`, or the next row's indent is not this row's hanging indent.
2. **Deleted** if the next row is a true soft wrap (xterm's `isWrapped`).
3. **Kept** if the paragraph's longest row is under 40 columns (60% of a narrower terminal), or the next row's first word would have fit on this row within that longest row (rationale).
4. **Deleted** if this row fills that width and its last word is token-shaped (a URL or path character, or 16+ token characters) — a token split at the margin.
5. Otherwise **one space**.

Leading and trailing blank lines are trimmed, a run of blank lines collapses to one, and the indent every line shares is removed, keeping relative indent.

Source of truth: `autoBreak` in `lib/src/lib/copy-text.ts`.

### 4.2 Scopes

Narrowest first, each containing the dragged selection, one that adds nothing dropped:

| Scope | Covers |
|---|---|
| **As selected** | The drag (opens here). |
| **Whole words** | Each edge grown over the token under it, following a token Auto would rejoin across rows; an edge resting on a blank grows nothing. Named **Full URL** or **Full path** when the smart-token detector (§5.1) classifies a grown edge token so. |
| **Paragraph** | The rows between blank rows, frame-only rows, and box sides (`│ ┃ ║`). |

The selection overlay draws a wider scope dashed around the outline; the preview marks every cell outside the drag. Source of truth: `computeScopes` in `lib/src/lib/copy-text.ts`.

### 4.3 Keys

| Key | Effect |
|---|---|
| `e` / `Shift+E` | Next wider / narrower scope, stopping at either end. |
| `f` / `Shift+F` | Next / previous format, wrapping, in table order (§4.1), then the program's own copy (§4.6). |
| `←` `→` / `Shift+←` `→` | Move the end / start one word; a row boundary ends a word. Returns to As selected, keeping the format. |
| `Enter`, `Cmd+C` (Ctrl+C on non-macOS), either with Shift | Copy what the editor shows. |
| `Esc` | Close and cancel the selection. |

**Any other key closes the editor and reaches the terminal**, so typing after a selection still types; a bare modifier and the paste chord leave it open. **Intercept Ctrl+C only while the editor is open or a shadowed drag waits for it** (§3.8); otherwise it reaches the inside program (SIGINT for shells, app-defined for TUIs). A selection a TUI makes from the keyboard (vim visual mode, less search highlight) is neither, and does not change that routing. The editor's hints write Shift and the arrows as the mobile compass rose does (`⬆︎` `◀` `▶`), and touch shows none.

Source of truth: `handleCopyEditorKey` in `lib/src/components/wall/keyboard/handle-mouse-selection-keys.ts`, pinned by its test; the transitions in `lib/src/lib/copy-editor.ts`, pinned by `lib/src/lib/copy-editor.test.ts`.

### 4.4 Preview and Marks

- One gutter-numbered row per clipboard line; leading whitespace shows as `·`.
- Every break is a mark — `⏎` kept, `␣` one space, `⌁` deleted. **A click cycles it keep → space → none**, and the format then reads `Auto*`. A scope or format change, or a nudge, discards those edits.
- A format whose text an earlier one already gives is dimmed.

### 4.5 Placement and Dismissal

- Full pane width, on the side of the selection with more room; touch prefers above, clear of the thumb that ended the drag. **When neither side has 120px it docks at the bottom over the selection.** Remeasured on every render tick (§7).
- **Esc**, a click outside the editor, or a content change (§3.4) dismisses it and cancels the selection; a new mouse-down replaces both (§3.7).
- **Must flash only after a successful clipboard write, and only for the selection copied**: the Copy button shows a checkmark for ~700 ms, then the selection clears. Failed writes retain it for retry; canceling clears the flash immediately.

Source of truth: `CopyEditor` in `lib/src/components/CopyEditor.tsx`, pinned by `lib/src/components/CopyEditor.test.tsx`; `copySelection` in `lib/src/lib/copy-selection.ts`, pinned by `lib/src/lib/copy-editor.test.ts`.

### 4.6 The Program's Own Copy (OSC 52)

An `OSC 52` clipboard write from the inside program is never the clipboard. It becomes an **offer** the editor can show (rationale):

1. The owner's parser decodes the base64 as UTF-8, turns `\r\n` and `\r` into `\n`, and removes every other control character but tab. **Must drop, never truncate, a payload over `CLIPBOARD_OFFER_LIMIT` base64 characters**, kept under the incomplete-OSC bound so read splitting never changes the answer; a `?` read is never answered, and an empty or malformed write offers nothing. The sequence is consumed either way.
2. The host sends it to the owning renderer as `terminal:clipboardOffer` (`docs/specs/transport.md`); replay re-parses output without offers.
3. **Must accept an offer only into a pane holding a shadowed drag** (§3.8), the latest replacing any earlier; it goes with that selection.
4. The editor then offers a fifth format, **From <program>** (the running command as WATCHING keys it, `docs/specs/alert.md`, else `program`), last in `f` order. **It has no scope**: choosing it returns to As selected, and `e` does nothing while it shows. Its marks still flip, and a nudge returns to Auto. **Never write an offer to the clipboard except as that format, chosen and copied by the user.**

Source of truth: `parseOsc52` and `CLIPBOARD_OFFER_LIMIT` in `lib/src/lib/terminal-protocol.ts`, pinned by `lib/src/lib/terminal-protocol.test.ts`; `offerProgramCopy` in `lib/src/lib/mouse-selection.ts`, pinned by `lib/src/lib/mouse-selection.test.ts`; `editorFormats` in `lib/src/lib/copy-editor.ts`.

---

## 5. Smart Extension (URL / Path Detection)

Offered **mid-drag**, alongside the Alt block modifier (§3.2–§3.3): each drag update re-examines the cell under the cursor for a URL- or path-shaped token, and offers **e** to extend the selection over the whole token.

### 5.1 Detection

A token is whitespace-delimited. Trailing characters unlikely to be part of it — `.`, `,`, `;`, `:`, `!`, `?`, single quotes, double quotes — are stripped from its end, along with unmatched closing brackets (`)`, `]`, `}`, `>`); matched pairs are preserved. **Strip before pattern matching, never after** (rationale).

**Must map detection offsets through xterm cells**, preserving wide characters, combining marks, and multi-codepoint emoji. Source of truth: `detectTokenInBufferLine` in `lib/src/lib/smart-token.ts`, pinned by `lib/src/lib/smart-token.test.ts`.

Source of truth: `PATTERNS` in `lib/src/lib/smart-token.ts` — the detected shapes in priority order, error locations (`<path>:line[:col]`) ahead of the generic path patterns. The generic patterns require an anchor (`~/`, `/`, `./`, `../`, or a drive letter), so a bare relative path like `src/foo.ts` qualifies only in its error-location form.

### 5.2 Mid-Drag Hint

A second line on the block-selection hint names the detected kind — URL or path (exact strings in `lib/src/components/SelectionOverlay.tsx`). It appears and disappears live as the drag moves into and out of qualifying tokens; no qualifying token, no extension hint.

### 5.3 Extension Action

- **e** during a drag, while the hint is visible, extends the selection over the full detected token: the anchor is preserved, the far end moves to the token boundary away from it. The drag then continues normally — movement updates the selection from the new boundary, Alt still toggles block shape.
- **e** with no qualifying token is consumed (per §3.6) but extends nothing; once the drag has ended, `e` is the editor's expand instead (§4.3). On release the selection is finalized at whatever boundaries the drag, `e`-extensions included, produced.
- **Only this single extension step is offered mid-drag**, and no "open URL" action (§9.1); the editor's scopes are the wider steps (§4.2).

---

## 6. Interaction Summary

### 6.1 State Matrix

Where a drag goes; **Terminal** means the terminal's own selection.

| Program requests mouse | Override | Live-region drag | Scrollback drag |
|---|---|---|---|
| No | — | Terminal | Terminal |
| Yes | No | Inside program, shadowed (§3.8) | Terminal |
| Yes | Temporary | Terminal, ends on mouse-up | Terminal |
| Yes | Sticky | Terminal | Terminal |

**Ownership is decided at mouse-down and latched for the whole drag**, so §3.5's scrollback→live-region crossing is a single continuous selection. Wheel events follow the override rows only: swallowed while an override is active (§2); in the "Yes / No override" row they reach the inside program in both regions.

Source of truth: `terminalOwnsEvent` in `lib/src/lib/terminal-mouse-router.ts`, `stateRequiresNativeMouseSuppression` in `lib/src/lib/mouse-selection.ts` (the in-flight drag).

### 6.2 Header Icon States

| Condition | Icon | Banner |
|---|---|---|
| No mouse reporting | None | None |
| Mouse reporting, no override | Mouse | None |
| Temporary override | No-Mouse | `Temporary mouse override until mouse-up.` + `[Make sticky]` `[Cancel]` |
| Sticky override | No-Mouse | None |

---

## 7. Rendering Notes

**Must keep selection and hint updates from rerendering pane headers or override banners** (rationale).

- **Must render outlines, hints, and the copy editor above the cell grid**, isolated from inside-program output and redraws; header icons and banners remain persistent chrome.
- **Geometry comes from the *measured* xterm cell grid** (`cellWidth`/`cellHeight`/`gridLeft`/`gridTop`), never element-width ÷ cols, so the outline stays aligned across xterm's internal padding.
- **Must remeasure both overlay and editor on every shared render tick** (scroll, resize, output), even when the selection is unchanged; the editor dismisses if the selection is canceled. Pinned for the editor by `lib/src/components/CopyEditor.test.tsx`.

Source of truth: `lib/src/lib/selection-text.ts` (extraction and normalization), `lib/src/lib/selection-geometry.ts` (perimeter construction), `TerminalPaneHeader` in `lib/src/components/wall/TerminalPaneHeader.tsx` and `MouseOverrideBanner` in `lib/src/components/wall/MouseOverrideBanner.tsx` — tested in `lib/src/components/wall/mouse-chrome.test.tsx`.

---

## 8. Paste Behavior

### 8.1 Overview

**Paste keystrokes are intercepted by the terminal**, never forwarded: the inside program receives only the clipboard bytes, optionally bracket-wrapped (§8.5). **A non-empty clipboard or file-path paste marks the Session touched** before the direct PTY write (`docs/specs/layout.md`).

### 8.2 Paste Keybindings

**`Cmd/Ctrl (+Shift) + V` — all four combinations, on every platform — are intercepted and paste** (`hasPasteModifier`); copy keeps the macOS separation instead (§4.2). The price: the raw control byte `0x16` (readline `quoted-insert`, vim literal-next) never reaches the program by this key — §8.3 is the escape hatch. (rationale)

Source of truth: `lib/src/components/wall/keyboard/chords.ts`.

### 8.3 Sending `0x16` (Ctrl+Q)

Because Ctrl+V is intercepted everywhere, a literal control character goes in through **Ctrl+Q, then the desired key** — readline's own `quoted-insert` (bash/zsh/fish), which the terminal does nothing to enable. No equivalent exists for programs without it (vim insert mode) — §9.2.

### 8.4 Platform Detection

**`IS_MAC` (`lib/src/lib/platform/index.ts`) is computed once at startup** from `navigator.userAgentData.platform`, else `navigator.platform`, matched against `/Mac|iPhone|iPad/i`. It gates the copy chord (§4.2), every platform-dependent label, and the app's own macOS chrome (the AppBar's traffic-light inset, the VS Code workbench chord map) — **the paste chord alone is platform-independent** (§8.2).

### 8.5 Bracketed Paste

When the inside program has opted in via `\e[?2004h`, the PTY gets `\e[200~`, the clipboard content, then `\e[201~`; otherwise the content is written unwrapped.

**Must defang every bracketed payload:** replace each `\e` with visible U+241B before wrapping, or an embedded `\e[201~` closes the boundary and later newlines submit. This covers file-path pastes (§8.6 tiers 1 and 3), which share the writer. **Never filter the unbracketed branch:** with no paste boundary, filtering only corrupts deliberate escape sequences. Both branches are pinned by `lib/src/lib/clipboard.test.ts`.

The mode is read at paste time from the per-terminal `bracketedPaste` field, which `lib/src/lib/mouse-mode-observer.ts` syncs from xterm's public `terminal.modes.bracketedPasteMode` (the same `CSI ? ... h`/`l` parser hook that tracks mouse reporting).

Source of truth: `defangPasteEscapes` in `lib/src/lib/clipboard.ts`.

### 8.6 Paste Content

Paste reads the clipboard in three tiers, preferred in order:

1. **File references** (a Finder/Explorer Copy of a file). Each path is shell-escaped; the space-joined list is written to the PTY with a trailing space, so the next token starts cleanly.
2. **Plain text.** The adapter's native `readClipboardText` where it has one, else `navigator.clipboard.readText()`. **Never reverse that order** (rationale). A non-empty string goes to the PTY (bracket-wrapped, §8.5).
3. **Raw image data.** Only when both of the above come back empty and the clipboard holds image bytes (e.g. a `Cmd+Shift+4` screenshot): the bytes are written to a newly-created private temp directory as `<uuid>-clipboard.png`, and that path is pasted as in tier 1. **On Unix-like systems the temp directory is owner-only and the image file owner-read/write**, so clipboard screenshots are not exposed to other local users. File and directory are unlinked ~5 minutes later (rationale).

**Tiers 1 and 2 are read in parallel** (independent IPC roundtrips) and the file reference wins; tier 3 is sequential because it allocates a temp file. Every tier empty ⇒ silent no-op.

One shared Node module, `standalone/sidecar/clipboard-ops.js`, serves both hosts: the sidecar (Tauri on macOS/Linux) and the extension host (VSCode on all platforms, via the `lib/clipboard-ops.cjs` shim — tiers 1 and 3 only, so VSCode's tier 2 falls through to `navigator.clipboard.readText()`). It shells out:

| Platform | Tools |
|---|---|
| macOS | `osascript` (file URLs, image bytes), `pbpaste` (text) |
| Windows | `powershell` — `Get-Clipboard -Format FileDropList` / `-Raw`, `System.Windows.Forms.Clipboard` |
| Linux | `wl-paste` and `xclip`, in whichever order `WAYLAND_DISPLAY` suggests, each falling through to the other |

**Every spawn must pass `windowsHide`** (CREATE_NO_WINDOW; rationale).

**The standalone/Tauri build on Windows reads the Win32 clipboard directly in Rust**, dropping the subprocess: `CF_HDROP` for file paths, `CF_UNICODETEXT` for text, `CF_DIB` for an image saved as a `.bmp` temp file — the extension differs from the sidecar path's `.png`, and the same ~5-minute cleanup applies. Non-Windows Tauri stays on the sidecar path.

**Path escaping (tiers 1 and 3, and §8.7). Quote a pasted path for the Session's launch shell** — never for the host platform, never for the app-global shell selected for future terminals (rationale). Each terminal registry entry captures its `shellKind` at spawn and keeps it across a live reconnect (the `pty:list` row carries the launch-shell path) and a cold restore. **Only a missing registry entry falls back** — to the app-global selected shell, then the platform (`cmd` on Windows, posix elsewhere). Classification uses the same `shellCommandKind` `dor` uses to quote commands (`docs/specs/dor-cli.md`). Three rules:

- **posix** — backslash-escape each metacharacter, matching macOS Terminal's drag-and-drop format (rationale). Newline/CR paths are single-quote-wrapped instead, since bash swallows `\<newline>` as a line continuation.
- **cmd** — double-quote-wrap, doubling embedded `"`. cmd's own `%NAME%` (and `!NAME!` under delayed expansion) remains a parser limitation of this legacy path.
- **powershell** — bare when every character is inert in argument mode, else single-quote-wrapped with embedded `'` doubled, reusing `dor`'s `quotePowerShellArg`. **Never reuse the cmd rule here** (rationale). The bare set excludes `,` (array operator in argument mode) and `@` (splatting, or another expression form at a token's start).

Source of truth: `lib/src/lib/clipboard.ts` (Session-kind selection), `lib/src/lib/shell-escape.ts` (dispatch + posix/cmd rules, pinned by `lib/src/lib/shell-escape.test.ts`) over `POSIX_ESCAPABLE` in `lib/src/lib/posix-escape.ts` (the escapable set, shared with the command tokenizer), `lib/src/lib/terminal-lifecycle.ts` (captured `shellKind`), `dor/src/commands/shell-quote.ts` (`shellCommandKind`, `quotePowerShellArg`), `standalone/src-tauri/src/clipboard_win.rs` (Win32 read), and the live-PTY list contract in `docs/specs/transport.md`.

### 8.7 Drag-to-Paste

Dropping files on a terminal pane types their escaped paths at the current prompt, exactly as tier 1 does (§8.6). Tauri takes the drop natively via `WindowEvent::DragDrop` and routes the paths to the selected pane (dropped if the selection is a Door or has left the layout) — but **the wiring is inert today**: `tauri.conf.json` sets `dragDropEnabled: false` (tauri-apps/tauri#14373, dormouse#38), so the native handler never fires. **Nothing in the layout stack needs the flag off any more** — Lath's pane drag is pointer-based — so flipping it is a live option, and a deliberate, separate change (rationale).

**Drag-to-paste is not supported in the VSCode build**: the workbench excludes `WebviewView` (sidebar/panel) from external-file drop routing, so the iframe never receives `dragover`/`drop` for OS files (§9.2). VSCode users paste instead (§8.1/§8.5).

### 8.8 Right-Click and Menu Paste

Right-click and OS Edit-menu paste are not implemented; users paste via §8.2's shortcuts.

### 8.9 Clipboard Chords Inside Dormouse's Own Text Fields

Dormouse's own `<input>`s — pane rename, the browser URL editor, dialog fields — have no *native* clipboard chords in the menu-less standalone build (`docs/specs/standalone.md` → "Application menu"). `handleEditableClipboard` (`lib/src/components/wall/keyboard/handle-editable-clipboard.ts`) supplies them in JS, **ahead of the wall's mode and rename gates** so a focused field wins whatever the wall is doing:

- **Paste** reads through `readTextFromClipboard` (the §8.6 tier-2 preference, so no "Paste from <App>" popup) and replaces the field's selection. **Copy** and **cut** write the selected substring through `writeTextToClipboard`, whose false return is what stops a cut deleting; a collapsed selection copies nothing. **Text only** — the file-reference and image tiers stay terminal-only.
- The edit goes through `document.execCommand('insertText')` where the webview allows it (native undo), else **the prototype `value` setter plus a synthetic `input` event** — a plain `value` assignment desyncs a React-controlled field.
- Chords are §8.2's: paste takes either modifier on every platform, copy/cut take `⌘` on macOS and `Ctrl` elsewhere.
- **Scope is narrow.** Excluded: xterm's `.xterm-helper-textarea` (the terminal owns its chords), read-only and disabled fields. The handler runs only where the adapter implements the optional `readClipboardText` — today the two standalone adapters, slightly over-reaching the menu-less macOS build it is written for (rationale). Elsewhere — VS Code, the website, Pocket — it never fires and the webview's own chords are untouched.
- **Must skip an asynchronous edit if the field unmounts, loses focus, becomes read-only/disabled, or changes value or selection**; a cut deletes only after clipboard-write success. Pinned by `lib/src/components/wall/keyboard/handle-editable-clipboard.test.ts`.

---

## Terminal context input

**Must give application-captured right-click to the terminal program**, retaining header right-click as the context entry point. Do not add a Shift-right-click override gesture.

**Must route clipboard chords and selection operations to the focused helper**, while leaving its Escape, Tab, arrows, and digits with xterm. Which of those disarm autorun follows `docs/specs/terminal-context.md` → "Helper lifecycle".

**Must copy selected context diagnostic text with Cmd+C on macOS and Ctrl+C elsewhere**, including the menu-less standalone host. Copy only a selection contained in the focused diagnostic, retaining it on clipboard failure; helper and editable-field chords keep their own routing. Pinned by `lib/src/components/wall/keyboard/handle-context-copy.test.ts`.

Source of truth: `handleContextCopy` in `lib/src/components/wall/keyboard/handle-context-copy.ts`; `TerminalPanel` in `lib/src/components/wall/TerminalPanel.tsx`; `useWallKeyboard` in `lib/src/components/wall/use-wall-keyboard.ts`; `markSessionTouched` in `lib/src/lib/terminal-lifecycle.ts`.


## 9. Future

Not implemented today; they may be added in response to user feedback.

### 9.1 Mouse and Selection

- Auto-scroll during a drag that reaches the viewport edge.
- Double-click to select word, triple-click to select line.
- More formats (strip line numbers, strip prompts, join hyphenated line-breaks, Markdown rebuilt from styling) and scopes (a command's output from OSC 133 marks, a TUI message).
- Contextual editor actions (Open URL, Open in `$EDITOR`, Copy hash).
- A "quiet mode" setting to suppress hints for experienced users.
- Content-matching selection tracking when the underlying content changes (today: cancel-on-change).
- Keyboard activation of the mouse icon and banner buttons.
- Refining Auto's heuristics based on dogfooding.

### 9.2 Paste

- Right-click context-menu Paste and OS Edit → Paste menu wiring.
- A settings toggle to disable Ctrl+V interception on Windows and Linux.
- A paste popup for previewing or transforming content before it is committed.
- Paste content transformations (strip trailing whitespace, normalize line endings, convert smart quotes).
- Paste history.
- Credential-shaped content detection and warnings.
- Multi-line paste confirmation dialogs.
- A "literal next keystroke" terminal-level shortcut (Ctrl+Alt+V or similar) for programs without Ctrl+Q-style `quoted-insert`.
- Middle-click paste / X11 PRIMARY selection integration on Linux.
- Drop-position-aware pane routing (drops go to the focused pane today).
- Drag-to-paste in the VSCode build — `WebviewView` is excluded from external-file drop routing and there is no API to opt in ([microsoft/vscode#111092](https://github.com/microsoft/vscode/issues/111092), closed as out-of-scope).
