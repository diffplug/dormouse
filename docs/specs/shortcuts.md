# Keyboard Shortcuts

Quick-reference index of Dormouse's keyboard shortcuts, grouped by the mode/context in which they apply. This file is a derived convenience table: `docs/specs/layout.md` owns command-mode dispatch and mode switching, and `docs/specs/mouse-and-clipboard.md` owns selection/copy/paste. Change behavior there first, then keep this table in sync.

Dormouse has two modes (`docs/specs/glossary.md` owns the names):

- **Command mode** — keys drive pane and workspace layout.
- **Passthrough mode** — keys go to the running program, except copy/paste and the mode-switch gesture.

In the VS Code extension host, selected workbench chords are mirrored: the terminal receives the key, and Dormouse also runs the matching VS Code workbench command. See [the VS Code host spec](vscode.md) for the exact allowlist.

## Mode switching

| Key | Action | Description |
|-----|--------|-------------|
| Left ⌘ → Right ⌘ (within 500 ms) | Enter command mode | Tap left Command, then right Command within 500 ms while in passthrough. The gesture only exits passthrough — it does nothing in command mode. |
| Left Shift → Right Shift (within 500 ms) | Enter command mode | Same as above, but with the Shift keys. |
| `Enter` (command) | Enter passthrough mode | Switch the selected pane into passthrough (or reattach a minimized door). Clicking a pane also enters passthrough. |

## Pane actions (command mode)

| Key | Action | Description |
|-----|--------|-------------|
| `\|` or `%` | Split left/right | Create a pane to the right, select it, and enter passthrough. |
| `-` or `"` | Split top/bottom | Create a pane below, select it, and enter passthrough. |
| `z` | Zoom and focus | Elevate the selected pane and enter passthrough; leaving passthrough or focusing elsewhere ends zoom. |
| `m` or `d` | Minimize / reattach | Minimize the selected pane to the baseboard, or reattach a minimized door. |
| `k` or `x` | Kill | Kill the selected pane or door. Prompts for a random character to confirm; untouched (never-typed-in) panes and doors are killed immediately without the prompt. |
| `,` | Rename | Enter rename mode for the selected pane's title. |
| `a` | Toggle alert | Dismiss or toggle the bell alert for the selected pane. Meaningful only for a terminal Surface — a browser surface has no bell to ring (`docs/specs/glossary.md`). |
| `t` | Toggle todo | Toggle the TODO marker on or off for the selected pane's Surface. Works on any Surface — a terminal Session or a browser surface. |
| `>` | Header context menu | Open the selected pane's header context menu — current title + `surface:N`, title candidates, and bound ports with digit-to-connect (mirrors tmux's pane `display-menu` binding). Terminal panes only; no-op on browser surfaces and doors. |

## Navigation (command mode)

| Key | Action | Description |
|-----|--------|-------------|
| `↑` / `↓` / `←` / `→` | Move selection | Move selection to the adjacent pane or door. Press the opposite direction to return. |
| `⌘`+arrows or `Ctrl`+arrows | Swap terminals | Swap terminal sessions between two panes — layout and titles swap; selection follows the terminal. Either modifier works on every platform. |

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
| `⌘V` / `⌘⇧V` / `Ctrl+V` / `Ctrl+Shift+V` | Paste | Paste clipboard contents into the terminal. The Ctrl variants are intercepted on every platform, macOS included. |

On macOS, `Ctrl+C` passes through to the running program (only `⌘C` copies); `Ctrl+V` is intercepted for paste everywhere — use the shell's `quoted-insert` (`Ctrl+Q`) to send a literal `0x16` (`docs/specs/mouse-and-clipboard.md` §8.3).

## Dialogs & prompts

| Key | Action | Description |
|-----|--------|-------------|
| `Esc` | Close / cancel | Dismiss the alert dialog, cancel a rename, or cancel a kill confirmation. |
| `Enter` | Confirm rename | Save the new name while renaming a pane. |
| `Tab` / `Shift+Tab` | Focus cycle | Cycle focus through elements of an open popover or dialog. |
| Prompted character | Confirm kill | Type the character shown in the kill prompt to confirm termination. |
| `a` (alert dialog open) | Toggle alert | Same as command-mode `a`. |
| `t` (alert dialog open) | Toggle todo | Same as command-mode `t`. |
| `1`–`9` (header context menu open) | Connect port | Open a browser surface on the nth port row. Dropped while the port scan is running; inert on hosts that can't open a browser surface. |
| `↑` / `↓` (header context menu open) | Move row focus | Rove focus across port rows, wrapping; `Enter` or `Space` activates the focused row. |

## Implementation references

- Primary keyboard handler: `lib/src/components/wall/use-wall-keyboard.ts` (command-mode key dispatch, mode toggle, dialog key handlers)
- Selection popup copy bindings: `lib/src/components/SelectionPopup.tsx`
- Alt-to-toggle-block selection: `lib/src/lib/terminal-mouse-router.ts`

## Future

Workspace switch / create / close / rename shortcuts (command mode) are staged with the workspaces rollout — see `docs/specs/layout.md` `## Future` (workspaces-rollout). They follow the tmux *window* bindings the rest of the keymap mirrors and are listed here once bound.
