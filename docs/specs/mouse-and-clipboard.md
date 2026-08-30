# Terminal Mouse and Clipboard Behavior Specification

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it for the pane-level scoping of mouse regime, override state, and selection.

> Sections are numbered for cross-spec reference (`§8.6` etc.); the numbers are stable, so append rather than renumber.

## Overview

Mouse handling and clipboard (copy and paste) behavior for the terminal across macOS, Linux, and Windows. The core design goal is to make text selection, copying, pasting, and mouse-driven interaction with TUI programs coexist cleanly, with visible state and predictable transitions between modes.

## Background: The Two Mouse Regimes

At any moment, mouse events in the terminal belong to one of two consumers:

1. **The terminal itself.** Drags paint a selection on the terminal surface; clicks shift focus or interact with terminal chrome. This is the default.
2. **The running application inside the terminal.** When a program emits a mouse-reporting escape sequence (e.g. `\e[?1000h`, `\e[?1002h`, `\e[?1003h`, with optional `\e[?1006h` SGR encoding), the terminal forwards mouse events to the program as input. Programs such as `tmux`, `vim`, `less`, and `htop` use this. The terminal's own selection behavior becomes unreachable while mouse reporting is active.

The terminal makes the current regime visible in the pane header, provides a way for the user to override it when they want to select text, and preserves selection actions (copy, copy-rewrapped, extend-to-URL) across both regimes.

## Terminology

- **Live region:** the portion of the terminal showing the active screen buffer (what the running program is currently drawing).
- **Scrollback:** the history of previously-drawn content above the live region.
- **Mouse reporting:** the state in which the inside program has requested and is receiving mouse events.
- **Override:** a state in which the terminal intercepts mouse events for selection purposes even though the inside program has requested mouse reporting.

---

## 1. The Mouse Icon (Header Indicator)

**Visibility.** No icon when the inside program has not requested mouse reporting; a **Mouse icon** (Phosphor `CursorClickIcon`) when it has; replaced by a **No-Mouse icon** (Phosphor `CursorTextIcon`) in the same header location while the user has activated an override. Both are dropped in the narrowest header tier, where the header has no room for optional actions (`docs/specs/layout.md`).

**Click.** Clicking the Mouse icon activates a **temporary override** (see §2). Clicking the No-Mouse icon ends the override immediately and restores mouse reporting to the inside program.

Source of truth: `lib/src/components/wall/TerminalPaneHeader.tsx` defines hover text for both icons (suppressed during a temporary override, where the banner carries the explanation).

---

## 2. Override State

There are two override modes: temporary (the default) and sticky.

**Temporary override.** Activated by clicking the Mouse icon. While active:

- Mouse events are handled by the terminal, not forwarded to the inside program. Belt and braces: any mouse report xterm still manages to emit is stripped from its `onData` stream before the write reaches the PTY (`stripMouseReportsFromInput`, `docs/specs/terminal-escapes.md`), so a report that slips past the DOM-level intercept never lands as input.
- Wheel events are also suppressed so xterm cannot translate scroll input into mouse reports or alternate-screen arrow-key input for the inside program.
- The Mouse icon is replaced with the No-Mouse icon.
- A banner appears at the top-right of the pane content area reading `Temporary mouse override until mouse-up.` followed by two buttons: **Make sticky** and **Cancel**.

The temporary override ends on the **next mouse-up event inside the terminal content area** (live region or scrollback) that is paired with a prior mouse-down in the same area. This includes plain clicks (a mouse-down/up pair that never crossed the drag threshold) and completed drags; it excludes clicks on the No-Mouse icon, the banner buttons, and any "orphan" mouse-up from a drag that started outside the terminal. After that mouse-up, mouse reporting is restored, the banner is dismissed, and the icon reverts to the Mouse icon. Clicking **Cancel** in the banner ends the override immediately with the same outcome. If the user activates an override and never performs a mouse action, it remains in place indefinitely; there is no timeout.

**Sticky override.** Clicking **Make sticky** in the banner converts the temporary override into a sticky one (the store calls this state `permanent`). The banner is dismissed; the No-Mouse icon remains visible with its "click to restore" hover text; mouse and wheel events continue to be handled by the terminal rather than the inside program. The sticky override persists until the user clicks the No-Mouse icon, or until the inside program stops requesting mouse reporting.

**Auto-clear on reporting off.** If the inside program stops requesting mouse reporting (e.g. exits or sends DECRST `?1000l`/`?1002l`/`?1003l`) while either override is active, the override is cleared. The icon and banner are removed because there is no longer anything to override. Restoring a **dead** session likewise resets terminal-owned mouse modes: replaying its saved scrollback ends with a Dormouse-emitted reset tail (`REPLAY_MODE_RESET`; see the replay-time mode-reset tail in `docs/specs/terminal-escapes.md`) that DECRSTs mouse tracking so a stale mode latched by a dead TUI does not block selection in the restored pane. The mouse-mode observer syncs the store back to `none` from those DECRSTs like any other.

**No designed keyboard path.** The Mouse icon, No-Mouse icon, and banner buttons are mouse-first: no keybinding or focus management targets them. They are plain buttons, so focus-based activation is not actively prevented — making them properly keyboard-activatable is listed in §9.1.

---

## 3. Selection Behavior

Selection is available whenever the terminal is handling mouse events — that is, whenever mouse reporting is not active, or an override is in effect, or the drag originates in scrollback (see §3.5).

### 3.1 Initiating a Selection

- A click-and-drag in the terminal content area begins a selection. A small movement threshold (~4px) separates a plain click (which only shifts pane focus) from a drag (which begins a selection).
- On touch or pen surfaces, a primary pointer tap-and-drag follows the same
  terminal selection path as mouse drag. Non-primary touch pointers are ignored.
- The selection is drawn as a single perimeter outline tracing the union of selected cells (§7 owns the rendering rules). Color comes from `--color-focus-ring` (the dynamic pick in `docs/specs/theme.md`: chromatic `focusBorder`, else chromatic active-header background), with a final hardcoded cornflower-blue fallback in `SelectionOverlay.tsx`.
- A drag whose button comes up **outside** the webview iframe still finalizes. The router takes pointer capture on mouse-down, and Chromium delivers that captured `pointerup` across the frame boundary; engines that don't get a backstop instead — the next window `mousemove` reporting `buttons === 0` is treated as the mouse-up we missed. A real drag that leaves and re-enters still holding the button reports `buttons === 1`, so the backstop never fires mid-drag.

### 3.2 Selection Shapes

- **Linewise (default):** click-and-drag selects text in reading order, wrapping from end-of-line to start-of-next-line.
- **Block (rectangular):** hold **Alt** (Option on macOS) during the drag to select a rectangular region.
- The selection shape updates live as Alt is pressed and released during the drag, including while the mouse is stationary: pressing Alt mid-drag converts the current selection to block; releasing Alt converts it back to linewise.
- Touch has no Alt key, so block mode is armed by **starting the drag with a double-tap** — a press that lands within 300 ms and 24 px of a previous touch that *ended as a tap*. Recording the tap only on a no-drag release keeps two quick consecutive drags from reading as a double-tap. Unlike Alt, this latches for the whole drag.

### 3.3 Selection Hint Text

While a drag is in progress, a small hint is displayed adjacent to the selection — below when dragging downward, above when dragging upward, and always above in the touch UI so the dragging thumb does not cover it. The exact hint strings (mouse vs. touch, block-selection, and the URL/path extension hint) live in `lib/src/components/SelectionOverlay.tsx`.

The hint is shown for the whole drag whenever the drag's current end row is on screen. It does not fade with use.

When a URL or path token is detected near the current drag position, an additional extension hint is shown alongside it. See §5 for full details.

### 3.4 Selection Follows Content

The selection is anchored to the characters under it, not to screen coordinates. Internally the selection is stored in absolute buffer rows (scrollback + viewport).

- **Pure scroll:** if content scrolls (translates vertically with no character changes), the selection scrolls with it. This is coordinate math only; no matching is required.
- **Content change:** if any cell overlapped by the selection changes after it is finalized, the selection is immediately canceled. Repaints outside the selected cells (e.g. a status line, clock, or progress bar elsewhere on screen) are irrelevant and do not cancel the selection. The check runs on each xterm render: a text snapshot of the selected cells is taken at finalize time and compared on each render. There is no partial-match or content-tracking heuristic — cancel-on-change is the rule.
- **Terminal resize:** a resize counts as a content change and cancels any active selection.

### 3.5 Selection in the Live Region vs. Scrollback

- **Live region:** selection is available only when mouse reporting is off, or an override is in effect.
- **Scrollback:** selection is **always** available, regardless of mouse reporting or override state. The override state of the Mouse icon is irrelevant for drags that originate in scrollback.
- **Crossing the boundary:** a drag that begins in scrollback and continues into the live region is allowed and produces a single continuous selection. A drag that begins in the live region while mouse reporting is active (with no override) is forwarded to the inside program, not treated as a selection.

### 3.6 During a Drag

- **Keyboard routing:** while a terminal-handled drag is in progress, the terminal claims the keyboard. **e** extends to a detected token (§5), **Esc** cancels the drag and any in-progress selection, and every other keystroke is swallowed rather than forwarded to the inside program. The one exception is **Alt** itself, which is deliberately left un-swallowed so the OS still sees the modifier that drives block shape (§3.2). Normal routing resumes on mouse-up. Source of truth: `lib/src/components/wall/keyboard/handle-mouse-selection-keys.ts`, which yields entirely when the selected Surface is not a terminal.

### 3.7 Ending a Selection

- Releasing the mouse button ends the drag and fixes the selection.
- The selection popup (§4) appears.
- The selection persists until the user acts on it (copy, extend, etc.), clicks elsewhere to dismiss it, presses **Esc**, or the underlying content changes.
- Starting a new drag (mouse-down in the terminal content area) immediately replaces any existing selection with the new one; the previous popup is dismissed.

---

## 4. Selection Popup

When a selection is finalized, a popup appears adjacent to the selection (on the side opposite the drag direction, mirroring where the drag hint sat) with action buttons.

### 4.1 Copy Buttons

Source of truth: `lib/src/components/SelectionPopup.tsx` defines the Copy Raw and Copy Rewrapped buttons and their platform-dependent shortcut labels.

#### 4.1.1 Copy Raw

Copies the selected text to the system clipboard exactly as it appears in the terminal cells, including hard line breaks and any box-drawing or decorative characters.

#### 4.1.2 Copy Rewrapped

Copies the selected text with two transformations applied (see `lib/src/lib/rewrap.ts`):

1. **Drop frame-only lines** and **strip leading/trailing runs of box-drawing characters** (Unicode `U+2500–U+259F`, covering both Box Drawing and Block Elements) from each line.
2. **Group remaining lines into paragraphs** separated by blank lines. Lines within a paragraph are joined with a single space (unwrapping display wrapping). Paragraphs are joined with `\n\n`.

Block-shape selections are never rewrapped — they are intentionally rectangular slabs, so the Copy Rewrapped action falls back to the raw text for them.

### 4.2 Keyboard Shortcuts

While the terminal has an active, finalized selection:

- **Cmd+C** (Ctrl+C on non-macOS) triggers Copy Raw.
- **Cmd+Shift+C** (Ctrl+Shift+C on non-macOS) triggers Copy Rewrapped.

These shortcuts work whether or not the popup is focused. The precedence rule is narrow: Ctrl+C is intercepted as Copy Raw **only** when a terminal selection is active. With no terminal selection, Ctrl+C is forwarded to the inside program as usual (SIGINT for shells, app-defined behavior for TUIs). An in-program selection maintained by a TUI (e.g. vim visual mode, less search highlight) is **not** a terminal selection for this purpose and does not change Ctrl+C routing.

### 4.3 Dismissing the Popup

- Pressing **Esc** dismisses the popup and cancels the selection.
- Clicking outside the selection dismisses the popup and cancels the selection.
- Performing a copy action (button click or keyboard shortcut) replaces the shortcut text on the active button with a checkmark for ~700 ms, then clears the selection and dismisses the popup. (The touch UI has no shortcut label, so the checkmark simply appears.)

---

## 5. Smart Extension (URL / Path Detection)

Smart extension is offered **mid-drag**, alongside the Alt block-selection modifier (§3.2–§3.3): on every drag update the terminal re-examines the cell under the cursor for a URL-shaped or path-shaped token, and offers **e** to extend the selection to the whole token.

### 5.1 Detection

A token is whitespace-delimited. Trailing characters unlikely to be part of it — `.`, `,`, `;`, `:`, `!`, `?`, single quotes, double quotes — are stripped from its end, along with unmatched closing brackets (`)`, `]`, `}`, `>`); matched pairs are preserved, so `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its trailing `)`. Stripping runs **before** pattern matching, not after, so an error location at the end of a sentence (`Error at src/foo.ts:42.`) is still recognized once the period is gone; the `:line[:col]` digits themselves survive because they are not trailing punctuation.

Source of truth: `PATTERNS` in `lib/src/lib/smart-token.ts` defines the detected shapes in priority order, with error locations (`<path>:line[:col]`) ahead of the generic path patterns. Note that the generic patterns require an anchor (`~/`, `/`, `./`, `../`, or a drive letter), so a bare relative path like `src/foo.ts` qualifies only in its error-location form.

### 5.2 Mid-Drag Hint

A second line is added to the block-selection hint naming the detected kind — URL or path (exact strings in `lib/src/components/SelectionOverlay.tsx`). It appears and disappears live as the drag moves into and out of qualifying tokens; with no qualifying token under the cursor, no extension hint is shown.

### 5.3 Extension Action

- Pressing **e** during a drag, while the hint is visible, immediately extends the selection to cover the full detected token. The drag anchor is preserved; the drag's far end moves to the token boundary on the side away from the anchor.
- After extension, the drag continues normally: further mouse movement updates the selection from the new boundary, and the Alt modifier continues to toggle block-selection shape.
- If **e** is pressed when no qualifying token is present, the keypress is consumed (per §3.6) but no extension occurs.
- Pressing **e** has no effect after the drag has ended (i.e. once the popup has appeared, §4). Extension is a mid-drag action only; on release the selection is finalized at whatever boundaries the drag, including any `e`-extensions, produced.
- Only this single extension step is offered — no multi-level extension and no "open URL" action (§9.1).

---

## 6. Interaction Summary

### 6.1 State Matrix

| Inside program requests mouse | Override active | Drag in live region goes to... | Drag in scrollback goes to... |
|-------------------------------|-----------------|--------------------------------|-------------------------------|
| No                            | —               | Terminal (selection)           | Terminal (selection)          |
| Yes                           | No              | Inside program                 | Terminal (selection)          |
| Yes                           | Temporary       | Terminal (selection), ends on mouse-up | Terminal (selection) |
| Yes                           | Sticky          | Terminal (selection)           | Terminal (selection)          |

Ownership is decided at **mouse-down** and latched for the whole drag, which is what makes the scrollback→live-region crossing in §3.5 a single continuous selection. Wheel events follow the override rows only: while an override is active they are swallowed (§2); in the "Yes / No override" row they reach the inside program in both regions. Source of truth: `terminalOwnsEvent` in `lib/src/lib/terminal-mouse-router.ts`, plus `stateRequiresNativeMouseSuppression` in `lib/src/lib/mouse-selection.ts` for the in-flight drag.

### 6.2 Header Icon States

| Condition                                                 | Icon shown    | Banner shown                                                              |
|-----------------------------------------------------------|---------------|---------------------------------------------------------------------------|
| Inside program does not request mouse reporting           | None          | None                                                                      |
| Inside program requests mouse, no override                | Mouse         | None                                                                      |
| Temporary override active                                 | No-Mouse      | `Temporary mouse override until mouse-up.` + `[Make sticky]` `[Cancel]`   |
| Sticky override active                                    | No-Mouse      | None                                                                      |

---

## 7. Rendering Notes

- The outline, hints, and popup all render in a compositor layer above the cell grid, so nothing the inside program draws can disturb them and nothing they draw reaches its output. Geometry comes from the *measured* xterm cell grid (`cellWidth`/`cellHeight`/`gridLeft`/`gridTop`), never from element-width ÷ cols, so the outline stays aligned across xterm's internal padding.
- Overlay and popup both subscribe to the same render-tick signal, bumped on every xterm render (scroll, resize, output), so they re-measure and re-anchor together; the popup dismisses if the selection is canceled.
- The header icon and banner are persistent terminal chrome and are not affected by inside-program redraws.

---

## 8. Paste Behavior

### 8.1 Overview

Paste reads the system clipboard and writes the content to the PTY. Paste keystrokes are **intercepted by the terminal**, not forwarded to the inside program. The inside program only receives the pasted bytes (optionally wrapped in bracketed-paste markers; see §8.5). A non-empty clipboard or file-path paste counts as user input: before the direct PTY write it marks the Session touched (`docs/specs/layout.md`).

### 8.2 Paste Keybindings

`Cmd/Ctrl (+Shift) + V` — all four combinations, on every platform — are intercepted and perform a paste. The chord takes **either** modifier and ignores Shift (`hasPasteModifier`), so `Ctrl+V` pastes on macOS too.

Copy keeps the clean macOS separation — only `⌘C` is intercepted there, `Ctrl+C` passes through (§4.2) — but paste does not, because `Ctrl+V` is the universal expectation everywhere. The price is that the raw control byte `0x16` (readline `quoted-insert`, vim literal-next) is never delivered by this key; §8.3 is the escape hatch.

### 8.3 Sending `0x16` (Ctrl+Q)

Because Ctrl+V is intercepted on every platform, users needing to insert a literal control character at a shell prompt use the existing readline feature: press **Ctrl+Q**, then the desired key. This is a feature of bash, zsh, fish, and other readline-aware shells; the terminal does nothing special to enable it. The terminal provides no equivalent for programs that do not support Ctrl+Q-style `quoted-insert` (e.g. vim insert mode).

### 8.4 Platform Detection

`IS_MAC` (`lib/src/lib/platform/index.ts`) is computed once at startup from `navigator.userAgentData.platform`, else `navigator.platform`, else the user-agent string, matched against `/Mac|iPhone|iPad/i`. It gates only the copy chord (§4.2) and hint strings — the paste chord is platform-independent (§8.2).

### 8.5 Bracketed Paste

When the inside program has opted in via `\e[?2004h` (tracked as the `bracketedPaste` field on the per-terminal mouse-selection state), the terminal writes `\e[200~`, then the clipboard content, then `\e[201~`, to the PTY. Otherwise the content is written without brackets. This is standard xterm behavior; it allows shells and TUIs to distinguish pasted content from typed input.

**The bracketed payload is filtered: every `\e` in it is replaced with a visible U+241B before wrapping.** Without that, clipboard content containing `\e[201~` closes the bracket early and everything after it reaches the shell as ordinary typed input — newlines included, which submit — so anything that can write the clipboard could run a command the user never pasted. Brackets are the *only* defense here, since §9.2 leaves multi-line paste confirmation unbuilt. The filter is byte-for-byte xterm's own `bracketTextForPaste`, repeated because `writePasteToPty` calls `writePty` directly and so never reaches xterm's paste path; it covers file-path pastes (§8.6 tiers 1 and 3) as well, because they share that writer. The unbracketed branch is deliberately unfiltered: the inside program has not asked to tell pasted bytes from typed ones, so there is no boundary left to protect, and filtering would break a deliberate paste of an escape sequence. `Source of truth:` `defangPasteEscapes` in `lib/src/lib/clipboard.ts`.

The mode is read at paste time from the per-terminal `bracketedPaste` field, which `lib/src/lib/mouse-mode-observer.ts` keeps in sync with xterm's public `terminal.modes.bracketedPasteMode` (same parser hook on `CSI ? ... h`/`l` that tracks mouse reporting; the sync is deferred to a microtask because the hook runs before xterm updates `modes`).

### 8.6 Paste Content

Paste reads the clipboard in three tiers, preferred in order:

1. **File references.** OS file references (a Finder/Explorer Copy of a file). If present, each path is shell-escaped and the space-joined list is written to the PTY with a trailing space so the next token starts cleanly.
2. **Plain text.** The adapter's native `readClipboardText` when it implements one, else `navigator.clipboard.readText()`. Native is preferred because on macOS WKWebView the `navigator` call pops a `Paste from <App>` confirmation menu at the cursor on every invocation, which defeats the point of a paste shortcut. If non-empty, the string is written to the PTY (bracket-wrapped per §8.5).
3. **Raw image data.** Only when both of the above come back empty and the clipboard holds image bytes (e.g. a `Cmd+Shift+4` screenshot): the bytes are written to a newly-created private temp directory as `<uuid>-clipboard.png` and that single path is pasted as in tier 1. On Unix-like systems the temp directory is owner-only and the image file owner-read/write, so clipboard screenshots are not exposed to other local users. The file and its directory are unlinked ~5 minutes later — long enough for whatever command the user launched against the path to have read it, short enough that a long session does not accumulate one file per image paste.

Tiers 1 and 2 are read **in parallel** (independent IPC roundtrips) and the file-reference result wins; tier 3 is sequential because it allocates a temp file. If every tier comes back empty, paste is a silent no-op.

The native reads come from one shared Node module, `standalone/sidecar/clipboard-ops.js`, reached through the sidecar (Tauri on macOS/Linux) or the extension host (VSCode on all platforms, via the `lib/clipboard-ops.cjs` shim — it wires tiers 1 and 3 only, so VSCode's tier 2 falls through to `navigator.clipboard.readText()`). The module shells out to OS-native tools: `osascript` for file URLs and image bytes plus `pbpaste` for text on macOS; `powershell` (`Get-Clipboard -Format FileDropList` / `-Raw`, `System.Windows.Forms.Clipboard`) on Windows; `wl-paste` and `xclip` on Linux, tried in whichever order `WAYLAND_DISPLAY` suggests and falling through to the other. Every spawn passes `windowsHide` (CREATE_NO_WINDOW), because on Windows the sidecar is a windowless GUI child and an unhidden console subprocess allocates a fresh console window that flickers and steals focus — several per paste, enough to freeze the GUI.

The **standalone/Tauri build on Windows** goes further and reads the Win32 clipboard directly in Rust, removing the subprocess entirely: `standalone/src-tauri/src/clipboard_win.rs`, using `CF_HDROP` for file paths, `CF_UNICODETEXT` for text, and `CF_DIB` for an image saved as a `.bmp` temp file — note the extension differs from the sidecar path's `.png`, and the same ~5-minute cleanup applies. Non-Windows Tauri stays on the sidecar path, where `pbpaste`/`xclip` never pop a console window.

**Path escaping (tiers 1 and 3, and §8.7).** A pasted path is quoted for **the Session's launch shell**, never for the host platform or the app-global shell currently selected for future terminals — those diverge on Windows, where PowerShell, Git Bash, WSL, and `cmd.exe` Sessions can remain live together, and quoting for the wrong parser is a code-execution bug rather than a cosmetic one. Each terminal registry entry captures its `shellKind` at spawn. A live reconnect's `pty:list` row carries the launch-shell path so the rebuilt entry keeps the same kind; a cold restore launches every terminal with the current default and captures that shell. Only a missing registry entry falls back to the app-global selected shell, then to the platform (`cmd` on Windows, posix elsewhere). Classification uses the same `shellCommandKind` that `dor` uses to quote commands (docs/specs/dor-cli.md). Three rules:

- **posix** — backslash-escape each metacharacter, matching macOS Terminal's drag-and-drop format so TUIs like `claude` recognize the token as a path. Paths containing newline/CR are single-quote-wrapped instead, since bash swallows `\<newline>` as a line continuation.
- **cmd** — wrap in double quotes, doubling any embedded `"`. This keeps whitespace and command separators in one token and leaves PowerShell-style `$` syntax inert. cmd's own `%NAME%` expansion (and `!NAME!` when delayed expansion is enabled) remains a parser limitation of this legacy path.
- **powershell** — a path built only from characters that are inert in argument mode is left bare; anything else is single-quote-wrapped with embedded `'` doubled, reusing `dor`'s `quotePowerShellArg`. PowerShell's *double*-quoted strings are expandable, so cmd-style quoting there would leave `$(...)` subexpressions and `$name` interpolations live in a filename the user is about to press Enter on (dormouse#430). The bare set deliberately excludes `,`, which argument mode reads as the array operator, and `@`, which starts splatting or another expression form at the beginning of a token.

Source of truth: `lib/src/lib/clipboard.ts` (Session-kind selection), `lib/src/lib/shell-escape.ts` (dispatch + posix/cmd rules), `lib/src/lib/terminal-lifecycle.ts` (captured `shellKind`), `dor/src/commands/shell-quote.ts` (`shellCommandKind`, `quotePowerShellArg`), and the live-PTY list contract in `docs/specs/transport.md`.

### 8.7 Drag-to-Paste

Dragging files onto a terminal pane mirrors the paste chain above: escaped paths are typed at the current prompt, space-joined with a trailing space. Tauri receives the drop natively via `WindowEvent::DragDrop` and routes the paths to the selected pane (dropped if the selection is a Door or has left the layout) — but this wiring is **inert today**: `tauri.conf.json` sets `dragDropEnabled: false` so HTML5 drag-and-drop inside the webview keeps working (tauri-apps/tauri#14373, dormouse#38), so the native handler never fires and drag-to-paste is currently unavailable in the standalone build. (Lath's pane dragging is pointer-based, not HTML5 DnD, so it no longer depends on this flag; flipping it to re-enable native drag-to-paste is a separate change.)

Drag-to-paste is **not supported in the VSCode build**: VSCode's `WebviewView` (sidebar/panel) is excluded from external-file drop routing by the workbench, so the webview iframe never receives `dragover`/`drop` events for files dragged from the OS. See §9.2. VSCode users paste instead (§8.1/§8.5).

### 8.8 Right-Click and Menu Paste

Right-click and OS Edit-menu paste are not implemented; users paste via the keyboard shortcuts in §8.2.

### 8.9 Clipboard Chords Inside Dormouse's Own Text Fields

Everything above is about the terminal. Dormouse also renders real `<input>`s — pane rename, the browser URL editor, dialog fields — and the standalone build gives them no *native* clipboard chords: the app replaces macOS's default menu so its native Paste item stops fighting the terminal's DOM-level Cmd+V (`standalone/src-tauri/src/lib.rs`), and WKWebView routes Cmd+C/X/V through exactly that menu. `handleEditableClipboard` (`lib/src/components/wall/keyboard/handle-editable-clipboard.ts`) supplies them in JS instead, ahead of the wall's mode and rename gates so a focused field wins whatever the wall is doing:

- **Paste** reads text through `readTextFromClipboard` (the same native-read preference as §8.6 tier 2, so no "Paste from <App>" popup) and replaces the field's selection. **Copy** and **cut** write the selected substring with `navigator.clipboard.writeText`; a collapsed selection copies nothing. Only text — the file-reference and image tiers stay terminal-only.
- The edit goes through `document.execCommand('insertText')` when the webview allows it (native undo), otherwise through the prototype `value` setter plus a synthetic `input` event, which is what keeps a React-controlled field's state in sync.
- The chord table is §8.2's: paste takes either modifier on every platform, copy/cut take `⌘` on macOS and `Ctrl` elsewhere.
- Scope is deliberately narrow. xterm's `.xterm-helper-textarea` is excluded (the terminal owns its chords), as are read-only and disabled fields, and the handler runs only where the adapter implements the optional `readClipboardText` — today the two standalone adapters. That is the menu-less macOS build it is written for; it also takes in `standalone/src/browser-sidecar-adapter.ts`, whose Chrome webview *does* have native chords, so there the JS path replaces a working native one rather than standing down. Everywhere else — VS Code, the website, Pocket — the handler never fires and the webview's own chords are untouched.
- Because the clipboard read is asynchronous (an IPC roundtrip on the standalone host), the field can unmount before the edit lands — Escape, or the blur that commits a rename. The edit is skipped when that happens: `execCommand` acts on whatever is focused at the time, which is usually the terminal by then, so an unguarded write would type the clipboard into the shell.

---

## Files

| File | Role |
|------|------|
| `lib/src/lib/mouse-selection.ts` | Per-terminal selection / override / bracketed-paste state store |
| `lib/src/lib/mouse-mode-observer.ts` | DECSET/DECRST parser hook; syncs mouse-reporting and bracketed-paste modes |
| `lib/src/lib/terminal-mouse-router.ts` | Drag routing (mouse + touch), smart-token hinting, temporary-override clearing |
| `lib/src/lib/clipboard.ts` | Copy/paste entry points and the tiered paste chain |
| `lib/src/lib/shell-escape.ts` | Per-shell path quoting for the paste/drop path (§8.6) |
| `lib/src/components/wall/keyboard/handle-mouse-selection-keys.ts` | Drag-time key routing (§3.6), `e` extension, copy/paste chords |
| `lib/src/components/wall/keyboard/handle-editable-clipboard.ts` | Copy/cut/paste inside Dormouse's own text fields (§8.9) |
| `lib/src/components/wall/keyboard/chords.ts` | The copy vs. paste modifier convention (§8.2), shared by both keyboard handlers |
| `lib/src/lib/rewrap.ts` | Copy Rewrapped transformations |
| `lib/src/lib/selection-text.ts` | Selected-cell text extraction + selection normalization |
| `lib/src/lib/selection-geometry.ts` | Selected cells → visible rects → single perimeter SVG path |
| `lib/src/lib/smart-token.ts` | URL / path / error-location patterns (`PATTERNS`) |
| `lib/src/components/SelectionOverlay.tsx` | Perimeter outline and drag hints |
| `lib/src/components/SelectionPopup.tsx` | Copy popup and shortcut labels |
| `lib/src/components/wall/MouseOverrideBanner.tsx` | Temporary-override banner |
| `standalone/sidecar/clipboard-ops.js` | OS-native clipboard tiers (file refs / text / image) for VSCode on all platforms and Tauri on macOS/Linux |
| `standalone/src-tauri/src/clipboard_win.rs` | Native Win32 clipboard tiers for Tauri on Windows (`CF_HDROP` / `CF_UNICODETEXT` / `CF_DIB`) |

---

## 9. Future

The following are explicitly not implemented today; they may be added in response to user feedback.

### 9.1 Mouse and Selection

- Auto-scroll during a drag that reaches the viewport edge.
- Double-click to select word, triple-click to select line.
- Additional copy modes beyond Raw and Rewrapped (strip ANSI, strip line numbers, strip prompts, join hyphenated line-breaks).
- Contextual actions in the popup (Open URL, Open in `$EDITOR`, Copy hash).
- Multi-level `e` extension (token → line → paragraph).
- A "quiet mode" setting to suppress hints for experienced users.
- Content-matching selection tracking when the underlying content changes (current behavior is cancel-on-change).
- Keyboard activation of the mouse icon and banner buttons.
- Refining the Copy Rewrapped heuristics based on dogfooding.

### 9.2 Paste

- Right-click context-menu Paste and OS Edit → Paste menu wiring.
- A settings toggle to disable Ctrl+V interception on Windows and Linux.
- A paste popup (parallel to the copy popup) for previewing or transforming paste content before it is committed.
- Paste content transformations (strip trailing whitespace, normalize line endings, convert smart quotes).
- Paste history.
- Credential-shaped content detection and warnings.
- Multi-line paste confirmation dialogs.
- A "literal next keystroke" terminal-level shortcut (Ctrl+Alt+V or similar) for programs that don't support Ctrl+Q-style `quoted-insert`.
- Middle-click paste / X11 PRIMARY selection integration on Linux.
- Drop-position-aware pane routing (currently drops always go to the focused pane).
- Drag-to-paste in the VSCode build. `WebviewView` is excluded from external-file drop routing by the workbench and there is no API to opt in (see [microsoft/vscode#111092](https://github.com/microsoft/vscode/issues/111092), closed as out-of-scope). Users paste via Ctrl+V / Cmd+V instead.
