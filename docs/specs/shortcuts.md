# Keyboard Shortcuts

Complete reference for Dormouse's keyboard shortcuts. Shortcuts are grouped by the mode/context in which they apply.

Dormouse has two modes:

- **Workspace mode** (a.k.a. "command" mode internally) — keys drive pane layout.
- **Terminal mode** (a.k.a. "passthrough" mode) — keys go to the running program, except copy/paste and the mode-switch gesture.

In the VS Code extension host, selected workbench chords are mirrored: the terminal receives the key, and Dormouse also runs the matching VS Code workbench command. See [the VS Code host spec](vscode.md) for the exact allowlist.

## Mode switching

| Key | Action | Description |
|-----|--------|-------------|
| Left ⌘ → Right ⌘ (within 500 ms) | Toggle mode | Tap left Command, then right Command within 500 ms to swap between workspace and terminal mode. |
| Left Shift → Right Shift (within 500 ms) | Toggle mode | Same as above, but with the Shift keys. |
| `Enter` (workspace) | Enter terminal mode | Switch the selected pane into passthrough (or reattach a minimized door). |

## Pane actions (workspace mode)

| Key | Action | Description |
|-----|--------|-------------|
| `\|` or `%` | Split left/right | Split the selected pane into two side-by-side panes. |
| `-` or `"` | Split top/bottom | Split the selected pane into two stacked panes. |
| `z` | Toggle zoom | Fullscreen the selected pane, or return to the normal layout. |
| `m` or `d` | Minimize / reattach | Minimize the selected pane to the baseboard, or reattach a minimized door. |
| `k` or `x` | Kill | Kill the selected pane or door. Prompts for a random character to confirm. |
| `,` | Rename | Enter rename mode for the selected pane's title. |
| `a` | Toggle alert | Dismiss or toggle the bell alert for the selected pane. |
| `t` | Toggle todo | Toggle the TODO marker on or off for the selected pane. |

## Navigation (workspace mode)

| Key | Action | Description |
|-----|--------|-------------|
| `↑` / `↓` / `←` / `→` | Move selection | Move selection to the adjacent pane or door. Press the opposite direction to return. |
| `⌘↑` / `⌘↓` / `⌘←` / `⌘→` (macOS)<br>`Ctrl`+arrows (others) | Swap terminals | Swap terminal sessions between two panes — layout and titles swap; selection follows the terminal. |

## Selection & drag

| Key | Action | Description |
|-----|--------|-------------|
| `e` | Extend to token | During a drag, extend the current selection to the next smart token. |
| `Alt` (hold) | Block / linewise | Hold Alt while dragging to toggle between block and linewise selection shape. |
| `Esc` | Cancel selection | Cancel or clear the active mouse selection. |

## Copy & paste

| Key | Action | Description |
|-----|--------|-------------|
| `⌘C` (macOS) / `Ctrl+C` (others) | Copy raw | Copy selected text as-is, without rewrapping. Requires a finalized selection. |
| `⌘⇧C` (macOS) / `Ctrl+Shift+C` (others) | Copy rewrapped | Copy selected text with rewrapping for single-line display. |
| `⌘V` / `⌘⇧V` (macOS) | Paste | Paste clipboard contents into the terminal. |
| `Ctrl+V` / `Ctrl+Shift+V` (others) | Paste | Paste clipboard contents into the terminal. |

On macOS, `Ctrl+C` / `Ctrl+V` pass through to the running program; only the ⌘-prefixed variants are intercepted.

## Dialogs & prompts

| Key | Action | Description |
|-----|--------|-------------|
| `Esc` | Close / cancel | Dismiss the alert dialog, cancel a rename, or cancel a kill confirmation. |
| `Enter` | Confirm rename | Save the new name while renaming a pane. |
| `Tab` / `Shift+Tab` | Focus cycle | Cycle focus through elements of an open popover or dialog. |
| Prompted character | Confirm kill | Type the character shown in the kill prompt to confirm termination. |
| `a` (alert dialog open) | Toggle alert | Same as workspace `a`. |
| `t` (alert dialog open) | Toggle todo | Same as workspace `t`. |

## Implementation references

- Primary keyboard handler: `lib/src/components/wall/use-wall-keyboard.ts` (workspace key dispatch, mode toggle, dialog key handlers)
- Selection popup copy bindings: `lib/src/components/SelectionPopup.tsx`
- Alt-to-toggle-block selection: `lib/src/lib/terminal-mouse-router.ts`
