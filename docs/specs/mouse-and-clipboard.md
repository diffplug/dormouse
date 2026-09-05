# Terminal Mouse and Clipboard Behavior Specification

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it for the pane-level scoping of mouse regime, override state, and selection.

> Sections are numbered for cross-spec reference (`§8.6` etc.); the numbers are stable, so append rather than renumber.

## Overview

Terminal mouse and clipboard behavior across macOS, Linux, and Windows: selection, copy, paste, and their coexistence with mouse-driven TUI programs. Owns the mouse-override icon and banner, the selection overlay and popup, and every paste path into a terminal; `docs/specs/layout.md` owns where the header icon sits, `docs/specs/terminal-escapes.md` registers the sequences.

## Background: The Two Mouse Regimes

Mouse events belong to one of two consumers:

1. **The terminal** — the default. Drags paint a selection; clicks shift focus or hit terminal chrome.
2. **The inside program** (`tmux`, `vim`, `less`, `htop`), once it emits a mouse-reporting escape sequence (`\e[?1000h`, `\e[?1002h`, `\e[?1003h`, optionally `\e[?1006h` SGR encoding). Events reach it as input, and the terminal's own selection is unreachable meanwhile.

The pane header makes the current regime visible, the user can override it to select text, and the selection actions (copy, copy-rewrapped, extend-to-URL) work across both.

## Terminology

- **Live region:** the terminal area showing the active screen buffer.
- **Scrollback:** history of previously-drawn content above the live region.
- **Mouse reporting:** the inside program has requested and is receiving mouse events.
- **Override:** the terminal takes mouse events for selection despite mouse reporting.

---

## 1. The Mouse Icon (Header Indicator)

**Visibility.** The **Mouse icon** (Phosphor `CursorClickIcon`) marks an inside program requesting mouse reporting; the **No-Mouse icon** (`CursorTextIcon`) takes the same slot while an override is active (full matrix: §6.2). Both drop in the narrowest header tier (`docs/specs/layout.md`).

**Click.** The Mouse icon starts a **temporary override** (§2); the No-Mouse icon ends any override immediately and restores mouse reporting.

Source of truth: `lib/src/components/wall/TerminalPaneHeader.tsx` (icons), `lib/src/components/wall/MouseOverrideBanner.tsx` (banner and its actions).

---

## 2. Override State

**Temporary override.** Clicking the Mouse icon starts one. While active:

- Mouse events go to the terminal, not the inside program; belt and braces, any report xterm still emits is stripped from its `onData` stream before the write reaches the PTY (`stripMouseReportsFromInput`, `docs/specs/terminal-escapes.md`).
- **Wheel events are suppressed too**, so xterm cannot turn scroll into mouse reports or alternate-screen arrow keys.
- The No-Mouse icon replaces the Mouse icon, and a banner at the top-right of the pane content area reads `Temporary mouse override until mouse-up.` plus **Make sticky** and **Cancel**.

It ends on the **next mouse-up inside the terminal content area** paired with a prior mouse-down there:

- **Counts:** a plain click (down/up that never crossed the drag threshold) or a completed drag.
- **Does not count:** clicks on the No-Mouse icon or the banner buttons, and an orphan mouse-up from a drag that started outside the terminal.
- **On end** — or on **Cancel**, immediately — reporting is restored, banner dismissed, Mouse icon back. **No timeout:** absent any mouse action the override stays indefinitely.

**Sticky override.** **Make sticky** converts it (the store calls this state `permanent`): banner dismissed, No-Mouse icon kept with its "click to restore" hover text, mouse and wheel still going to the terminal. It persists until the user clicks the No-Mouse icon.

**Auto-clear on reporting off.** **Either override clears when the inside program stops requesting mouse reporting** (it exits, or DECRSTs `?1000l`/`?1002l`/`?1003l`); icon and banner go with it. A **dead** session's replay ends in the `REPLAY_MODE_RESET` tail that DECRSTs mouse tracking (`docs/specs/terminal-escapes.md`), so a mode latched by a dead TUI cannot block selection in the restored pane.

**No keyboard path is designed** for the icons or banner buttons; as plain buttons, focus-based activation is not actively prevented — §9.1.

---

## 3. Selection Behavior

Selection is available whenever the terminal handles the mouse (§3.5, §6.1).

### 3.1 Initiating a Selection

- A click-and-drag in the terminal content area begins a selection; a ~4px movement threshold separates a plain click (which only shifts pane focus) from a drag.
- On touch or pen, a primary pointer tap-and-drag takes the same path; non-primary touch pointers are ignored.
- The selection draws as a single perimeter outline tracing the union of selected cells (§7 owns rendering). Color is `--color-focus-ring` (`docs/specs/theme.md`), with a hardcoded cornflower-blue final fallback in `SelectionOverlay.tsx`.
- **A drag whose button comes up outside the webview iframe must still finalize**, by captured `pointerup` or the window-`mousemove` backstop (rationale).

Source of truth: `lib/src/lib/terminal-mouse-router.ts`.

### 3.2 Selection Shapes

- **Linewise (default):** reading order, wrapping end-of-line to start-of-next-line.
- **Block (rectangular):** hold **Alt** (Option on macOS) during the drag.
- **The shape updates live as Alt is pressed and released mid-drag**, including while the mouse is stationary.
- Touch has no Alt key, so block mode is armed by **starting the drag with a double-tap** — a press within 300 ms and 24 px of a previous touch that *ended as a tap*. Unlike Alt, it latches for the whole drag.

### 3.3 Selection Hint Text

A small hint sits adjacent to an in-progress selection — below when dragging downward, above when dragging upward, always above in the touch UI so the thumb does not cover it. It shows for the whole drag whenever the drag's current end row is on screen, and never fades. §5.2 adds the extension line. Exact strings — mouse, touch, block, extension — in `lib/src/components/SelectionOverlay.tsx`.

### 3.4 Selection Follows Content

A selection is anchored to the characters under it, not to screen coordinates: stored in absolute buffer rows (scrollback + viewport).

- **Pure scroll** — vertical translation with no character changes — carries the selection along; coordinate math only, no matching.
- **Content change:** any change to a cell the finalized selection overlaps cancels it immediately; repaints elsewhere on screen are irrelevant. A text snapshot taken at finalize is compared on each xterm render; **never add a partial-match or content-tracking heuristic** — cancel-on-change is the rule (§9.1).
- **Terminal resize** counts as a content change and cancels any active selection.

### 3.5 Selection in the Live Region vs. Scrollback

- **Scrollback selection is always available**, whatever the reporting or override state; live-region availability follows §6.1's matrix.
- **Crossing the boundary:** a drag beginning in scrollback and continuing into the live region is a single continuous selection. A drag beginning in the live region under mouse reporting, with no override, goes to the inside program instead.

### 3.6 During a Drag

**A terminal-handled drag claims the keyboard.** **e** extends to a detected token (§5), **Esc** cancels the drag and any in-progress selection, and every other keystroke is swallowed, not forwarded. **Alt** alone is left un-swallowed, so the OS still sees the modifier that drives block shape (§3.2). Normal routing resumes on mouse-up; the handler yields entirely when the selected Surface is not a terminal.

Source of truth: `lib/src/components/wall/keyboard/handle-mouse-selection-keys.ts`.

### 3.7 Ending a Selection

- Releasing the button ends the drag and fixes the selection; the popup (§4) appears.
- It persists until something ends it: a completed copy, a content change (§3.4), **Esc**, or a click outside (§4.3).
- **A new mouse-down in the terminal content area replaces any existing selection immediately** and dismisses its popup.

---

## 4. Selection Popup

A finalized selection gets a popup of action buttons adjacent to it, on the side opposite the drag direction — mirroring where the drag hint sat.

### 4.1 Copy Buttons

Source of truth: `lib/src/components/SelectionPopup.tsx` (Copy Raw, Copy Rewrapped, platform-dependent shortcut labels).

A third button, **Add to notepad**, follows the two copies on every host that has a notepad; it captures the selection, flashes in place, and dismisses the popup without opening the notepad (`docs/specs/notepad.md` → "Capture").

#### 4.1.1 Copy Raw

Copies the selection exactly as it appears in the terminal cells, hard line breaks and any box-drawing or decorative characters included.

#### 4.1.2 Copy Rewrapped

Copies with two transformations applied (`lib/src/lib/rewrap.ts`):

1. **Drop frame-only lines**, and **strip leading/trailing runs of box-drawing characters** (`U+2500–U+259F`, both Box Drawing and Block Elements) from each remaining line.
2. **Group remaining lines into paragraphs** at blank lines: lines within a paragraph join with a single space (unwrapping display wrapping), paragraphs join with `\n\n`.

**Never rewrap a block-shape selection** — it is an intentionally rectangular slab, so Copy Rewrapped falls back to its raw text.

### 4.2 Keyboard Shortcuts

With an active, finalized terminal selection, popup focused or not: **Cmd+C** (Ctrl+C on non-macOS) triggers Copy Raw, **Cmd+Shift+C** (Ctrl+Shift+C) triggers Copy Rewrapped.

**Cmd+N** (Ctrl+N on non-macOS) adds the selection to the notepad, **gated exactly like Ctrl+C** — intercepted only with a finalized selection, otherwise reaching the program as readline's next-history — and shown only where the host binds it (`docs/specs/notepad.md` → "Notepad UI").

**Intercept Ctrl+C as Copy Raw only while a terminal selection is active.** With none it is forwarded to the inside program as usual (SIGINT for shells, app-defined for TUIs). An in-program selection a TUI maintains itself (vim visual mode, less search highlight) is **not** a terminal selection and does not change that routing.

### 4.3 Dismissing the Popup

- **Esc**, or a click outside the selection, dismisses the popup and cancels the selection.
- A copy action (button or shortcut) swaps the shortcut text on the active button for a checkmark for ~700 ms, then clears the selection and dismisses the popup. (The touch UI has no shortcut label, so the checkmark just appears.)

---

## 5. Smart Extension (URL / Path Detection)

Offered **mid-drag**, alongside the Alt block modifier (§3.2–§3.3): each drag update re-examines the cell under the cursor for a URL- or path-shaped token, and offers **e** to extend the selection over the whole token.

### 5.1 Detection

A token is whitespace-delimited. Trailing characters unlikely to be part of it — `.`, `,`, `;`, `:`, `!`, `?`, single quotes, double quotes — are stripped from its end, along with unmatched closing brackets (`)`, `]`, `}`, `>`); matched pairs are preserved. **Strip before pattern matching, never after** (rationale).

Source of truth: `PATTERNS` in `lib/src/lib/smart-token.ts` — the detected shapes in priority order, error locations (`<path>:line[:col]`) ahead of the generic path patterns. The generic patterns require an anchor (`~/`, `/`, `./`, `../`, or a drive letter), so a bare relative path like `src/foo.ts` qualifies only in its error-location form.

### 5.2 Mid-Drag Hint

A second line on the block-selection hint names the detected kind — URL or path (exact strings in `lib/src/components/SelectionOverlay.tsx`). It appears and disappears live as the drag moves into and out of qualifying tokens; no qualifying token, no extension hint.

### 5.3 Extension Action

- **e** during a drag, while the hint is visible, extends the selection over the full detected token: the anchor is preserved, the far end moves to the token boundary away from it. The drag then continues normally — movement updates the selection from the new boundary, Alt still toggles block shape.
- **e** with no qualifying token is consumed (per §3.6) but extends nothing, and has no effect once the drag has ended (once the popup has appeared, §4); on release the selection is finalized at whatever boundaries the drag, `e`-extensions included, produced.
- **Only this single extension step is offered** — no multi-level extension, no "open URL" action (§9.1).

---

## 6. Interaction Summary

### 6.1 State Matrix

Where a drag goes; **Terminal** means the terminal's own selection.

| Program requests mouse | Override | Live-region drag | Scrollback drag |
|---|---|---|---|
| No | — | Terminal | Terminal |
| Yes | No | Inside program | Terminal |
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

- Outline, hints, and popup render in a compositor layer above the cell grid, so nothing the inside program draws disturbs them and nothing they draw reaches its output. The header icon and banner are persistent terminal chrome, likewise unaffected by inside-program redraws.
- **Geometry comes from the *measured* xterm cell grid** (`cellWidth`/`cellHeight`/`gridLeft`/`gridTop`), never element-width ÷ cols, so the outline stays aligned across xterm's internal padding.
- Overlay and popup share one render-tick signal, bumped on every xterm render (scroll, resize, output), so they re-measure and re-anchor together; the popup dismisses if the selection is canceled.

Source of truth: `lib/src/lib/selection-text.ts` (text extraction and normalization), `lib/src/lib/selection-geometry.ts` (perimeter construction).

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

**`IS_MAC` (`lib/src/lib/platform/index.ts`) is computed once at startup** from `navigator.userAgentData.platform`, else `navigator.platform`, else the user-agent string, matched against `/Mac|iPhone|iPad/i`. It gates only the copy chord (§4.2) and hint strings — the paste chord is platform-independent (§8.2).

### 8.5 Bracketed Paste

When the inside program has opted in via `\e[?2004h`, the PTY gets `\e[200~`, the clipboard content, then `\e[201~`; otherwise the content is written unwrapped.

**Must defang every bracketed payload:** replace each `\e` with visible U+241B before wrapping, or an embedded `\e[201~` closes the boundary and later newlines submit. This covers file-path pastes (§8.6 tiers 1 and 3), which share the writer. **Never filter the unbracketed branch:** with no paste boundary, filtering only corrupts deliberate escape sequences. Both branches are pinned by `lib/src/lib/clipboard.test.ts`.

The mode is read at paste time from the per-terminal `bracketedPaste` field, which `lib/src/lib/mouse-mode-observer.ts` syncs from xterm's public `terminal.modes.bracketedPasteMode` (the same `CSI ? ... h`/`l` parser hook that tracks mouse reporting).

Source of truth: `defangPasteEscapes` in `lib/src/lib/clipboard.ts`.

### 8.6 Paste Content

Paste reads the clipboard in three tiers, preferred in order:

1. **File references** (a Finder/Explorer Copy of a file). Each path is shell-escaped; the space-joined list is written to the PTY with a trailing space, so the next token starts cleanly.
2. **Plain text.** The adapter's native `readClipboardText` where it has one, else `navigator.clipboard.readText()`. **Never reverse that order:** on macOS WKWebView the `navigator` call pops a confirmation menu at the cursor on every invocation (rationale). A non-empty string goes to the PTY (bracket-wrapped, §8.5).
3. **Raw image data.** Only when both of the above come back empty and the clipboard holds image bytes (e.g. a `Cmd+Shift+4` screenshot): the bytes are written to a newly-created private temp directory as `<uuid>-clipboard.png`, and that path is pasted as in tier 1. **On Unix-like systems the temp directory is owner-only and the image file owner-read/write**, so clipboard screenshots are not exposed to other local users. File and directory are unlinked ~5 minutes later (rationale).

**Tiers 1 and 2 are read in parallel** (independent IPC roundtrips) and the file reference wins; tier 3 is sequential because it allocates a temp file. Every tier empty ⇒ silent no-op.

One shared Node module, `standalone/sidecar/clipboard-ops.js`, serves both hosts: the sidecar (Tauri on macOS/Linux) and the extension host (VSCode on all platforms, via the `lib/clipboard-ops.cjs` shim — tiers 1 and 3 only, so VSCode's tier 2 falls through to `navigator.clipboard.readText()`). It shells out:

| Platform | Tools |
|---|---|
| macOS | `osascript` (file URLs, image bytes), `pbpaste` (text) |
| Windows | `powershell` — `Get-Clipboard -Format FileDropList` / `-Raw`, `System.Windows.Forms.Clipboard` |
| Linux | `wl-paste` and `xclip`, in whichever order `WAYLAND_DISPLAY` suggests, each falling through to the other |

**Every spawn must pass `windowsHide`** (CREATE_NO_WINDOW), or each Windows subprocess allocates a console window that flickers and steals focus, several per paste (rationale).

**The standalone/Tauri build on Windows reads the Win32 clipboard directly in Rust**, dropping the subprocess: `CF_HDROP` for file paths, `CF_UNICODETEXT` for text, `CF_DIB` for an image saved as a `.bmp` temp file — the extension differs from the sidecar path's `.png`, and the same ~5-minute cleanup applies. Non-Windows Tauri stays on the sidecar path.

**Path escaping (tiers 1 and 3, and §8.7). Quote a pasted path for the Session's launch shell** — never for the host platform, never for the app-global shell selected for future terminals; they diverge on Windows, where several shell kinds run side by side and the wrong parser is a code-execution bug (rationale). Each terminal registry entry captures its `shellKind` at spawn; a live reconnect's `pty:list` row carries the launch-shell path so the rebuilt entry keeps that kind; a cold restore launches every terminal with the current default and captures it. **Only a missing registry entry falls back** — to the app-global selected shell, then the platform (`cmd` on Windows, posix elsewhere). Classification uses the same `shellCommandKind` `dor` uses to quote commands (`docs/specs/dor-cli.md`). Three rules:

- **posix** — backslash-escape each metacharacter, matching macOS Terminal's drag-and-drop format (rationale). Newline/CR paths are single-quote-wrapped instead, since bash swallows `\<newline>` as a line continuation.
- **cmd** — double-quote-wrap, doubling embedded `"`. cmd's own `%NAME%` (and `!NAME!` under delayed expansion) remains a parser limitation of this legacy path.
- **powershell** — bare when every character is inert in argument mode, else single-quote-wrapped with embedded `'` doubled, reusing `dor`'s `quotePowerShellArg`. **Never reuse the cmd rule here:** PowerShell's *double*-quoted strings are expandable (rationale). The bare set excludes `,` (array operator in argument mode) and `@` (splatting, or another expression form at a token's start).

Source of truth: `lib/src/lib/clipboard.ts` (Session-kind selection), `lib/src/lib/shell-escape.ts` (dispatch + posix/cmd rules, pinned by `lib/src/lib/shell-escape.test.ts`), `lib/src/lib/terminal-lifecycle.ts` (captured `shellKind`), `dor/src/commands/shell-quote.ts` (`shellCommandKind`, `quotePowerShellArg`), `standalone/src-tauri/src/clipboard_win.rs` (Win32 read), and the live-PTY list contract in `docs/specs/transport.md`.

### 8.7 Drag-to-Paste

Dropping files on a terminal pane types their escaped paths at the current prompt, exactly as tier 1 does (§8.6). Tauri takes the drop natively via `WindowEvent::DragDrop` and routes the paths to the selected pane (dropped if the selection is a Door or has left the layout) — but **the wiring is inert today**: `tauri.conf.json` sets `dragDropEnabled: false` so HTML5 drag-and-drop keeps working inside the webview (tauri-apps/tauri#14373, dormouse#38), so the native handler never fires. Flipping the flag is a live option, and a deliberate, separate change (rationale).

**Drag-to-paste is not supported in the VSCode build**: the workbench excludes `WebviewView` (sidebar/panel) from external-file drop routing, so the iframe never receives `dragover`/`drop` for OS files (§9.2). VSCode users paste instead (§8.1/§8.5).

### 8.8 Right-Click and Menu Paste

Right-click and OS Edit-menu paste are not implemented; users paste via §8.2's shortcuts.

### 8.9 Clipboard Chords Inside Dormouse's Own Text Fields

Dormouse's own `<input>`s — pane rename, the browser URL editor, dialog fields — have no *native* clipboard chords in the menu-less standalone build (`docs/specs/standalone.md` → "Application menu"). `handleEditableClipboard` (`lib/src/components/wall/keyboard/handle-editable-clipboard.ts`) supplies them in JS, **ahead of the wall's mode and rename gates** so a focused field wins whatever the wall is doing:

- **Paste** reads through `readTextFromClipboard` (the §8.6 tier-2 preference, so no "Paste from <App>" popup) and replaces the field's selection. **Copy** and **cut** write the selected substring with `navigator.clipboard.writeText`; a collapsed selection copies nothing. **Text only** — the file-reference and image tiers stay terminal-only.
- The edit goes through `document.execCommand('insertText')` where the webview allows it (native undo), else **the prototype `value` setter plus a synthetic `input` event** — a plain `value` assignment desyncs a React-controlled field.
- Chords are §8.2's: paste takes either modifier on every platform, copy/cut take `⌘` on macOS and `Ctrl` elsewhere.
- **Scope is narrow.** Excluded: xterm's `.xterm-helper-textarea` (the terminal owns its chords), read-only and disabled fields. The handler runs only where the adapter implements the optional `readClipboardText` — today the two standalone adapters, slightly over-reaching the menu-less macOS build it is written for (rationale). Elsewhere — VS Code, the website, Pocket — it never fires and the webview's own chords are untouched.
- **Must skip the edit when the field has unmounted** during the asynchronous clipboard read (Escape, or the blur that commits a rename): `execCommand` acts on whatever is focused at that moment, usually the terminal, so an unguarded write would type the clipboard into the shell.

---

## 9. Future

Not implemented today; they may be added in response to user feedback.

### 9.1 Mouse and Selection

- Auto-scroll during a drag that reaches the viewport edge.
- Double-click to select word, triple-click to select line.
- Copy modes beyond Raw and Rewrapped (strip ANSI, strip line numbers, strip prompts, join hyphenated line-breaks).
- Contextual popup actions (Open URL, Open in `$EDITOR`, Copy hash).
- Multi-level `e` extension (token → line → paragraph).
- A "quiet mode" setting to suppress hints for experienced users.
- Content-matching selection tracking when the underlying content changes (today: cancel-on-change).
- Keyboard activation of the mouse icon and banner buttons.
- Refining the Copy Rewrapped heuristics based on dogfooding.

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
