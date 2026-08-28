# Keyboard Shortcuts

Quick-reference index of every keyboard shortcut, grouped by the mode/context in which it applies. This file owns only the table; the behavior behind each row is owned elsewhere and linked per section — [layout.md](layout.md) (command mode, mode switching, kill/rename), [mouse-and-clipboard.md](mouse-and-clipboard.md) (selection, copy, paste), [dor-browser.md](dor-browser.md) (browser surfaces), [tiling-engine.md](tiling-engine.md) (drag gestures), [vscode.md](vscode.md) (the workbench mirror). Change behavior there first, then keep this table in sync.

Dormouse has two modes (`docs/specs/glossary.md` owns the names):

- **Command mode** — keys drive pane layout and selection.
- **Passthrough mode** — keys reach the selected Surface's content (a terminal's PTY, a browser surface's page), except the mode-switch gesture and the clipboard chords.

The Wall runs one capture-phase `keydown` listener on `window` whose branches are tried in a fixed order: dual-tap gesture → text-field clipboard → terminal selection/clipboard keys → **passthrough gate** → **rename gate** → kill confirmation → **dialog gate** → pane shortcuts → arrow navigation. Rows reached before the passthrough gate therefore fire in *both* modes; everything after it is command-mode only. A popover or dialog that owns the keyboard (the alert dialog, the header context menu) adds its own listener on top and reports itself as dialog-keyboard-active, so the pane shortcuts stay dormant while it is open.

## Mode switching

| Key | Action | Description |
|-----|--------|-------------|
| Left ⌘ → Right ⌘ (within 500 ms) | Enter command mode | Left then right, distinguished by `KeyboardEvent.location`. The gesture only exits passthrough — it does nothing in command mode. |
| Left ⇧ → Right ⇧ (within 500 ms) | Enter command mode | An independent track from the ⌘ one, so Left ⌘ then Right ⇧ does not fire. This is the available gesture on keyboards with no right ⌘. |
| `Enter` (command) | Enter passthrough mode | Focus the selected pane, or reattach the selected door and focus it. Clicking a pane does the same. |

A focused cross-origin iframe surface swallows the gesture before the window listener sees it, so the proxy shim detects it in-frame and posts it back to the Wall (`docs/specs/dor-browser.md`).

## Pane actions (command mode)

| Key | Action | Description |
|-----|--------|-------------|
| `\|` or `%` | Split left/right | Create a pane to the right, select it, and enter passthrough. |
| `-` or `"` | Split top/bottom | Create a pane below, select it, and enter passthrough. |
| `z` | Zoom and focus | Elevate the selected pane and enter passthrough; leaving passthrough or focusing elsewhere ends zoom. Pressing it on the pane that already owns zoom unzooms instead. |
| `m` or `d` | Minimize / reattach | Minimize the selected pane to the baseboard, or reattach a minimized door (staying in command mode). |
| `k` or `x` | Kill | Kill the selected pane or door. Prompts for a random letter to confirm; untouched (never-typed-in) panes and doors are killed immediately without the prompt. |
| `,` | Rename | Enter rename mode for the selected pane's title. |
| `a` | Toggle alert | Dismiss or toggle the bell alert for the selected pane. Meaningful only for a terminal Surface — a browser surface has no bell to ring (`docs/specs/glossary.md`). Doors are excluded. |
| `t` | Toggle todo | Toggle the TODO marker on or off for the selected pane's Surface — a terminal Session or a browser surface. Doors are excluded. |
| `>` | Header context menu | Open the selected pane's header context menu — current title + `surface:N`, title candidates, and bound ports with digit-to-connect (mirrors tmux's pane `display-menu` binding). Terminal panes only; a consumed no-op on browser surfaces (they have no header context menu) and on doors. |

## Navigation (command mode)

| Key | Action | Description |
|-----|--------|-------------|
| `↑` / `↓` / `←` / `→` | Move selection | Move selection to the adjacent pane, or between doors in the baseboard (`↓` from the bottom pane row enters the baseboard, `↑` leaves it). Press the opposite direction to return to where you came from. |
| `⌘`+arrows or `Ctrl`+arrows | Swap surfaces | Swap the two panes' surfaces — layout and titles swap; selection stays on the moved surface, so the opposite chord swaps back exactly. Either modifier works on every platform. |

## Terminal selection & clipboard

These fire in both modes, before the passthrough gate, and act on the **selected** Surface — and only when it is a terminal. A browser surface owns its own clipboard keys (see below), and a focused Dormouse text field owns them ahead of everything (`docs/specs/mouse-and-clipboard.md` §8.9).

| Key | Action | Description |
|-----|--------|-------------|
| `e` | Extend to token | Mid-drag only: extend the selection to the full URL/path token detected at the drag cursor. Consumed but inert when no token is offered, and after the drag ends. |
| `Alt` (hold) | Block / linewise | Alt selects a block (rectangular) shape rather than linewise; tracked live through the drag. On touch, a double-tap-then-drag latches block mode for the whole drag. |
| `Esc` | Cancel selection | Cancel the in-progress drag, or clear a finalized selection while its popup is up. |
| *(any other key)* | — | Swallowed for the duration of a terminal-handled drag, not forwarded to the inside program (`docs/specs/mouse-and-clipboard.md` §3.6). |
| `⌘C` (macOS) / `Ctrl+C` (others) | Copy raw | Copy selected text as-is, without rewrapping. Requires a finalized (not in-progress) selection. |
| `⌘⇧C` (macOS) / `Ctrl+Shift+C` (others) | Copy rewrapped | Copy selected text with rewrapping for single-line display. |
| `⌘V` / `⌘⇧V` / `Ctrl+V` / `Ctrl+Shift+V` | Paste | Paste clipboard contents into the terminal. The `Ctrl` variants are intercepted on every platform, macOS included. |

On macOS, `Ctrl+C` passes through to the running program (only `⌘C` copies); `Ctrl+V` is intercepted for paste everywhere — use the shell's `quoted-insert` (`Ctrl+Q`) to send a literal `0x16` (`docs/specs/mouse-and-clipboard.md` §8.3).

Inside Dormouse's own text fields (pane rename, the browser URL editor, dialog inputs) the same chords cut/copy/paste that field's text instead — plain text only, and only on hosts whose webview has no native Edit menu, today the standalone builds (`docs/specs/mouse-and-clipboard.md` §8.9).

## Browser surfaces (passthrough)

Every key not claimed above is forwarded to the embedded page while a screencast browser pane is interactive; an `iframe`-rendered surface receives keys natively instead. See `docs/specs/dor-browser.md`.

| Key | Action | Description |
|-----|--------|-------------|
| `⌘V` / `Ctrl+V` | Paste into page | Reads the *local* clipboard and replays it as per-character key events — the embedded browser has its own, empty clipboard. |
| `⌘`/`Ctrl` + `a` / `c` / `x` | Select all / copy / cut | Routed through the host's `agentBrowserEdit` channel (macOS chords do not survive the CDP input path). Falls through to the page when the host has no such channel. |
| `c` / `Esc` (render-swap warning) | Continue / cancel | Confirm dropping the non-active tabs when swapping a multi-tab screencast surface to the `iframe` renderer. |

## Dialogs, menus & prompts

| Key | Action | Description |
|-----|--------|-------------|
| `Esc` | Close / cancel | Dismiss a dialog or popover, cancel a rename, cancel a kill confirmation, or abort an in-progress sash or pane drag (reverting the preview). |
| `Enter` | Confirm rename | Save the new name while renaming a pane. Blur commits too — whichever lands first settles the edit. |
| `Tab` / `Shift+Tab` | Focus cycle | Cycle focus through the focusable elements of an open popover or dialog (trapped, wrapping). |
| Prompted letter | Confirm kill | Type the letter shown in the kill prompt to confirm termination. **Any** other key cancels it with a shake, so `Esc` is only the documented spelling of "cancel". |
| `a` / `t` (alert dialog open) | Toggle alert / todo | Same as command-mode `a` / `t`, for the dialog's Session. |
| `1`–`9` (header context menu open) | Connect port | Open the nth port row in a browser surface, select it, and enter passthrough. Presses are dropped, never buffered, when the scan is still running or failed, when the digit is out of range, or on hosts that can't open a browser surface. |
| `↑` / `↓` (header context menu open) | Move row focus | Rove focus across port rows, wrapping; `Enter` or `Space` activates the focused row via the native button. |

## VS Code host

Mirrored workbench chords: the terminal still receives the key *and* Dormouse asks the extension host to run the matching command. The allowlist is fixed in `lib/src/lib/vscode-keybindings.ts` and re-validated extension-side; see [the VS Code host spec](vscode.md).

| Key | VS Code command |
|-----|-----------------|
| `⌘P` / `Ctrl+P` | `workbench.action.quickOpen` |
| `⌘⇧P` / `Ctrl+Shift+P`, or `F1` (unmodified) | `workbench.action.showCommands` |
| `⌘B` / `Ctrl+B` | `workbench.action.toggleSidebarVisibility` |

The standalone (Tauri) host contributes no chords of its own. Its menu is deliberately minimal — an App submenu on macOS plus a Window submenu, and **no Edit menu**, so a native `⌘C`/`⌘V` cannot fight the webview's DOM handlers; the remaining chords are the OS defaults of those predefined menu items (`docs/specs/standalone.md`).

## Implementation references

- `lib/src/components/wall/use-wall-keyboard.ts` — the single capture-phase listener and the dispatch order above, plus the iframe-shim leader `message` listener
- `lib/src/components/wall/keyboard/` — one module per branch: `handle-dual-tap.ts`, `handle-editable-clipboard.ts`, `handle-mouse-selection-keys.ts`, `handle-kill-confirm.ts`, `handle-pane-shortcuts.ts`, `handle-pane-navigation.ts`, with the platform modifier convention in `chords.ts`
- `lib/src/lib/vscode-keybindings.ts` — the VS Code workbench mirror allowlist
- `lib/src/lib/terminal-mouse-router.ts` — live Alt tracking during a selection drag
- `lib/src/components/SelectionPopup.tsx`, `lib/src/components/wall/PaneHeaderContextMenu.tsx`, `lib/src/components/TodoAlertDialog.tsx`, `lib/src/components/wall/InlineEditInput.tsx`, `lib/src/components/use-popover-focus-trap.ts` — the popover/dialog handlers
- `lib/src/components/wall/agent-browser-surface-controller.ts` — browser-surface key forwarding and the edit-chord bridge

## Future

Workspace switch / create / close / rename shortcuts (command mode) are staged with the workspaces rollout — see [layout.md](layout.md#future) (**Scope: workspaces-rollout**). They follow the tmux *window* bindings the rest of the keymap mirrors and are listed here once bound.
