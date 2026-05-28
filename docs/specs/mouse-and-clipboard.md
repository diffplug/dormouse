# Terminal Mouse and Clipboard Behavior Specification

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
- **Mouse icon:** a header indicator showing the current mouse regime.

---

## 1. The Mouse Icon (Header Indicator)

**Visibility.** No icon when the inside program has not requested mouse reporting; a **Mouse icon** (Phosphor `CursorClickIcon`) when it has; replaced by a **No-Mouse icon** (Phosphor `SelectionSlashIcon`) in the same header location while the user has activated an override.

**Click.** Clicking the Mouse icon activates a **temporary override** (see §2). Clicking the No-Mouse icon ends the override immediately and restores mouse reporting to the inside program.

Source of truth: `lib/src/components/wall/TerminalPaneHeader.tsx` defines hover text for both icons.

---

## 2. Override State

There are two override modes: temporary (the default) and sticky.

**Temporary override.** Activated by clicking the Mouse icon. While active:

- Mouse events are handled by the terminal, not forwarded to the inside program.
- Wheel events are also suppressed so xterm cannot translate scroll input into mouse reports or alternate-screen arrow-key input for the inside program.
- The Mouse icon is replaced with the No-Mouse icon.
- A banner appears below the No-Mouse icon reading `Temporary mouse override until mouse-up.` followed by two buttons: **Make sticky** and **Cancel**.

The temporary override ends on the **next mouse-up event inside the terminal content area** (live region or scrollback) that is paired with a prior mouse-down in the same area. This includes plain clicks (a mouse-down/up pair that never crossed the drag threshold) and completed drags; it excludes clicks on the No-Mouse icon, the banner buttons, and any "orphan" mouse-up from a drag that started outside the terminal. After that mouse-up, mouse reporting is restored, the banner is dismissed, and the icon reverts to the Mouse icon. Clicking **Cancel** in the banner ends the override immediately with the same outcome. If the user activates an override and never performs a mouse action, it remains in place indefinitely; there is no timeout.

**Sticky override.** Clicking **Make sticky** in the banner converts the temporary override into a sticky one. The banner is dismissed; the No-Mouse icon remains visible with its "click to restore" hover text; mouse and wheel events continue to be handled by the terminal rather than the inside program. The sticky override persists until the user clicks the No-Mouse icon, or until the inside program stops requesting mouse reporting.

**Auto-clear on reporting off.** If the inside program stops requesting mouse reporting (e.g. exits or sends DECRST `?1000l`/`?1002l`/`?1003l`) while either override is active, the override is cleared. The icon and banner are removed because there is no longer anything to override.

**No keyboard activation.** The Mouse icon, No-Mouse icon, and banner buttons are mouse-only. They are not keyboard-activatable.

---

## 3. Selection Behavior

Selection is available whenever the terminal is handling mouse events — that is, whenever mouse reporting is not active, or an override is in effect, or the drag originates in scrollback (see §3.5).

### 3.1 Initiating a Selection

- A click-and-drag in the terminal content area begins a selection. A small movement threshold (~4px) separates a plain click (which only shifts pane focus) from a drag (which begins a selection).
- On touch or pen surfaces, a primary pointer tap-and-drag follows the same
  terminal selection path as mouse drag. Non-primary touch pointers are ignored.
- The selection is rendered by the terminal in a compositor layer **above** the cell grid, not by writing into the grid. This avoids conflicts with programs redrawing the screen.
- The selection rectangle is drawn as a single perimeter outline tracing the union of selected cells. Color is taken from `--vscode-focusBorder` with fallbacks to terminal foreground and selection background.

### 3.2 Selection Shapes

- **Linewise (default):** click-and-drag selects text in reading order, wrapping from end-of-line to start-of-next-line.
- **Block (rectangular):** hold **Alt** (Option on macOS) during the drag to select a rectangular region.
- The selection shape updates live as Alt is pressed and released during the drag, including while the mouse is stationary: pressing Alt mid-drag converts the current selection to block; releasing Alt converts it back to linewise.

### 3.3 Selection Hint Text

While a drag is in progress, a small hint is displayed adjacent to the selection (below when dragging downward, above when dragging upward). The exact hint strings (mouse vs. touch, block-selection, and the URL/path extension hint) live in `lib/src/components/SelectionOverlay.tsx`.

The hint is always shown during an active drag. It does not fade with use.

When a URL or path token is detected near the current drag position, an additional extension hint is shown alongside it. See §5 for full details.

### 3.4 Selection Follows Content

The selection is anchored to the characters under it, not to screen coordinates. Internally the selection is stored in absolute buffer rows (scrollback + viewport).

- **Pure scroll:** if content scrolls (translates vertically with no character changes), the selection scrolls with it. This is coordinate math only; no matching is required.
- **Content change:** if any cell overlapped by the selection changes after it is finalized, the selection is immediately canceled. Repaints outside the selected cells (e.g. a status line, clock, or progress bar elsewhere on screen) are irrelevant and do not cancel the selection. The check runs on each xterm render: a text snapshot of the selected cells is taken at finalize time and compared on each render.
- **Terminal resize:** a resize counts as a content change and cancels any active selection.
- There is no partial-match or content-tracking heuristic. Cancel-on-change is the rule.

### 3.5 Selection in the Live Region vs. Scrollback

- **Live region:** selection is available only when mouse reporting is off, or an override is in effect.
- **Scrollback:** selection is **always** available, regardless of mouse reporting or override state. The override state of the Mouse icon is irrelevant for drags that originate in scrollback.
- **Crossing the boundary:** a drag that begins in scrollback and continues into the live region is allowed and produces a single continuous selection. A drag that begins in the live region while mouse reporting is active (with no override) is forwarded to the inside program, not treated as a selection.

### 3.6 During a Drag

- **Keyboard routing:** while a terminal-handled drag is in progress, the terminal consumes keystrokes relevant to the drag — **Alt** for block-selection shape (§3.2), **e** for smart extension (§5), **Esc** to cancel the drag and any in-progress selection. All other keystrokes are consumed by the terminal and **not** forwarded to the inside program for the duration of the drag. Normal keyboard routing resumes when the mouse button is released.

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
- Performing a copy action (button click or keyboard shortcut) replaces the shortcut text on the active button with a checkmark for ~700 ms, then clears the selection and dismisses the popup.

### 4.4 Extensibility

The popup can accommodate additional copy modes in the future (e.g. strip ANSI codes, strip line numbers, strip prompt markers). They would appear as additional buttons or within an overflow menu. Only Copy Raw and Copy Rewrapped are wired today.

---

## 5. Smart Extension (URL / Path Detection)

Smart extension is offered **mid-drag**, in parallel with the Alt block-selection modifier (§3.2–§3.3). During an active drag, the terminal continuously examines the characters at the current drag cursor cell for a URL-shaped or path-shaped token; if one is detected, a hint is shown alongside the existing block-selection hint inviting the user to press **e** to extend to the full token.

### 5.1 Detection

A token is whitespace-delimited. Source of truth: `PATTERNS` in `lib/src/lib/smart-token.ts` defines the detected shapes in priority order. Error locations (`<path>:line` or `<path>:line:col`) are matched before the generic path patterns, and their trailing `:line` digits are preserved.

For all kinds **except** error locations, trailing characters that are unlikely to be part of the token — `.`, `,`, `;`, `:`, `!`, `?`, single quotes, double quotes — are stripped from the detected token's end. Unmatched closing brackets (`)`, `]`, `}`, `>`) are also stripped, but matched pairs are preserved (e.g. `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its trailing `)`).

### 5.2 Mid-Drag Hint

When a qualifying token is detected during a drag, a hint is shown alongside the existing block-selection hint (the exact strings live in `lib/src/components/SelectionOverlay.tsx`).

The hint appears and disappears live as the drag moves into and out of qualifying tokens. If no qualifying token is present at the current drag position, no extension hint is shown.

### 5.3 Extension Action

- Pressing **e** during a drag, while the hint is visible, immediately extends the selection to cover the full detected token. The drag anchor is preserved; the drag's far end moves to the token boundary on the side away from the anchor.
- After extension, the drag continues normally: further mouse movement updates the selection from the new boundary, and the Alt modifier continues to toggle block-selection shape.
- If **e** is pressed when no qualifying token is present, the keypress is consumed (per §3.6) but no extension occurs.
- Pressing **e** has no effect after the drag has ended (i.e. once the popup has appeared, §4). Extension is a mid-drag action only.

### 5.4 Interaction with Selection Completion

When the user releases the mouse button, the selection is finalized at whatever boundaries the drag (including any `e`-extensions) produced. The popup (§4) then appears with the standard copy actions operating on the final selection.

### 5.5 Simplicity Bound

Only the single extension step described above is offered. There is no multi-level extension (token → line → paragraph) and no "open URL" or "open in editor" action in the popup.

---

## 6. Interaction Summary

### 6.1 State Matrix

| Inside program requests mouse | Override active | Drag in live region goes to... | Drag in scrollback goes to... |
|-------------------------------|-----------------|--------------------------------|-------------------------------|
| No                            | —               | Terminal (selection)           | Terminal (selection)          |
| Yes                           | No              | Inside program                 | Terminal (selection)          |
| Yes                           | Temporary       | Terminal (selection), ends on mouse-up | Terminal (selection) |
| Yes                           | Sticky          | Terminal (selection)           | Terminal (selection)          |

### 6.2 Header Icon States

| Condition                                                 | Icon shown    | Banner shown                                                              |
|-----------------------------------------------------------|---------------|---------------------------------------------------------------------------|
| Inside program does not request mouse reporting           | None          | None                                                                      |
| Inside program requests mouse, no override                | Mouse         | None                                                                      |
| Temporary override active                                 | No-Mouse      | `Temporary mouse override until mouse-up.` + `[Make sticky]` `[Cancel]`   |
| Sticky override active                                    | No-Mouse      | None                                                                      |

---

## 7. Rendering Notes

- The selection highlight (perimeter outline) is rendered in a compositor SVG layer above the cell grid, sized to the measured xterm cell grid (not to evenly-divided element width) so it stays aligned across xterm's internal padding.
- The header icon and banner are part of persistent terminal chrome and are not affected by inside-program redraws.
- The selection popup is rendered above the cell grid and anchored to the selection; it repositions on scroll, resize, and output (subscribing to the same render-tick signal as the overlay), and dismisses if the selection is canceled.
- All hint text (`Hold Alt for block selection`, `Press e to select the full URL`, etc.) is rendered by the terminal above the cell grid and does not interfere with the inside program's output.

---

## 8. Paste Behavior

### 8.1 Overview

Paste reads the system clipboard and writes the content to the PTY. Paste keystrokes are **intercepted by the terminal**, not forwarded to the inside program. The inside program only receives the pasted bytes (optionally wrapped in bracketed-paste markers; see §8.5).

Paste behavior differs by platform to match each OS's native convention.

### 8.2 Paste Keybindings

#### 8.2.1 macOS

| Keystroke      | Behavior                                                                          |
|----------------|-----------------------------------------------------------------------------------|
| **Cmd+V**      | Terminal intercepts and performs a bracketed paste.                               |
| **Cmd+Shift+V**| Terminal intercepts and performs a bracketed paste. (Alias for Cmd+V.)            |
| **Ctrl+V**     | Not intercepted. Forwarded to the inside program as the raw control byte `0x16`.  |

macOS users have a clean separation: Cmd is the paste modifier, Ctrl passes through to the program.

#### 8.2.2 Windows and Linux

| Keystroke       | Behavior                                                                          |
|-----------------|-----------------------------------------------------------------------------------|
| **Ctrl+V**      | Terminal intercepts and performs a bracketed paste.                               |
| **Ctrl+Shift+V**| Terminal intercepts and performs a bracketed paste. (Alias for Ctrl+V.)           |

Because Ctrl+V is needed as both the paste shortcut (universal user expectation) and as the raw control byte `0x16` (for shell `quoted-insert`, vim literal-next, etc.), Ctrl+V is always intercepted; the raw byte is not sent to the inside program by this key. Users needing to send `0x16` can use the shell mechanism in §8.3.

### 8.3 Sending `0x16` on Windows and Linux (Ctrl+Q)

Users needing to insert a literal control character at a shell prompt can use the existing readline feature: press **Ctrl+Q**, then the desired key. This is a feature of bash, zsh, fish, and other readline-aware shells; the terminal does nothing special to enable it. The terminal provides no equivalent for programs that do not support Ctrl+Q-style `quoted-insert` (e.g. vim insert mode).

### 8.4 Platform Detection

Platform is detected at startup from `navigator.userAgentData.platform` (preferred), `navigator.platform`, or the user-agent string, matched against `/Mac|iPhone|iPad/`. The result is exposed as the `IS_MAC` constant in `lib/src/lib/platform/index.ts` and consulted by every place that selects between Cmd and Ctrl conventions.

### 8.5 Bracketed Paste

When the inside program has opted in via `\e[?2004h` (tracked as the `bracketedPaste` field on the per-terminal mouse-selection state), the terminal writes `\e[200~`, then the clipboard content, then `\e[201~`, to the PTY. Otherwise the content is written without brackets. This is standard xterm behavior; it allows shells and TUIs to distinguish pasted content from typed input.

The bracketed-paste mode is read at paste time from xterm's public `terminal.modes.bracketedPasteMode`, kept in sync via a parser hook on `CSI ? ... h`/`l` (see `lib/src/lib/mouse-mode-observer.ts`).

### 8.6 Paste Content

Paste reads the clipboard in three tiers, falling through in order:

1. **File references.** The platform adapter checks for OS file references (Finder/Explorer Copy of a file) via the sidecar/extension host. If present, each path is shell-escaped and the space-joined list is written to the PTY with a trailing space so the next token starts cleanly. Files are checked first so that a file-ref clipboard never reaches `navigator.clipboard.readText()` — on macOS WKWebView that call can trigger a native paste-permission popup when the clipboard came from another app.
2. **Plain text.** `navigator.clipboard.readText()`. If non-empty, the string is written to the PTY (with bracketed-paste wrapping when enabled by the inside program).
3. **Raw image data.** If neither of the above matches and the clipboard holds image bytes (e.g. a `Cmd+Shift+4` screenshot), the bytes are written to a newly-created private temp directory as `<uuid>.png` and that single path is pasted as in tier 1. On Unix-like systems the temp directory is owner-only and the image file is written owner-readable/writable to avoid exposing clipboard screenshots to other local users.

Each tier is implemented by a shared Node module (`standalone/sidecar/clipboard-ops.js`) that shells out to the OS-native clipboard tool: `osascript` on macOS, `Get-Clipboard` on Windows, `wl-paste`/`xclip` on Linux. The Tauri build reaches it through the existing sidecar; the VSCode build calls into the same module from its extension host. If every tier comes back empty, paste is a silent no-op.

Content-aware transformations, paste history, credential warnings, and middle-click (X11 PRIMARY) paste remain out of scope (see §9).

### 8.7 Drag-to-Paste

Dragging files onto a terminal pane mirrors the paste chain above: escaped paths are typed at the current prompt, space-joined with a trailing space. Tauri receives the drop natively via `WindowEvent::DragDrop` and routes paths to the focused pane.

Drag-to-paste is **not supported in the VSCode build**: VSCode's `WebviewView` (sidebar/panel) is excluded from external-file drop routing by the workbench, so the webview iframe never receives `dragover`/`drop` events for files dragged from the OS. See §9.2. VSCode users paste instead (§8.1/§8.5).

### 8.8 Right-Click and Menu Paste

Right-click and OS Edit-menu paste are not currently implemented; users paste via the keyboard shortcuts in §8.2.

---

## 9. Out of Scope / Future Considerations

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
