# Keyboard Shortcuts

> See `docs/specs/glossary.md` for the Session / Pane / Door / baseboard vocabulary and the two mode names used in every row.
> Behavior belongs to [layout.md](layout.md) (modes, kill/rename, navigation, header menu), [mouse-and-clipboard.md](mouse-and-clipboard.md) (selection, copy, paste), [dor-browser.md](dor-browser.md) (browser surfaces), [tiling-engine.md](tiling-engine.md) (drag gestures) and [vscode.md](vscode.md) (the workbench mirror) — change it there first, then sync here.
> Bindings dispatched before layout's passthrough gate fire in both modes; the rest are command-mode only ([layout.md](layout.md#keyboard-shortcuts-command-mode) owns dispatch order and the dialog gate).

## Mode switching

| Key | Action | Description |
|-----|--------|-------------|
| Left ⌘ → Right ⌘ (within 500 ms) | Enter command mode | Only exits passthrough; inert in command mode. |
| Left ⇧ → Right ⇧ (within 500 ms) | Enter command mode | Independent of the ⌘ track; the gesture for keyboards with no right ⌘. |
| `Enter` (command) | Enter passthrough mode | Focus the selected pane; reattach the selected door and focus it. |

A focused cross-origin iframe surface swallows the gesture; the proxy shim detects it in-frame and re-posts it to the Wall (`docs/specs/dor-browser.md`).

## Pane actions (command mode)

| Key | Action | Description |
|-----|--------|-------------|
| `\|` or `%` | Split left/right | New pane to the right, selected, in passthrough. |
| `-` or `"` | Split top/bottom | New pane below, selected, in passthrough. |
| `z` | Zoom and focus | Enters passthrough; on the pane that already owns zoom, unzooms. |
| `m` or `d` | Minimize / reattach | Stays in command mode, unlike `Enter` on a door. |
| `k` or `x` | Kill | Kills the selected pane or door behind a random-letter prompt; an untouched Surface skips it. |
| `,` | Rename | Inline rename of the selected pane's title. |
| `a` | Toggle alert | Dismiss or toggle the bell alert. Terminal Surfaces only; doors excluded. |
| `t` | Toggle todo | Toggle the TODO marker on the selected Surface, terminal or browser; doors excluded. |
| `>` | Header context menu | Terminal panes only; a consumed no-op on browser surfaces and doors. |

## Navigation (command mode)

| Key | Action | Description |
|-----|--------|-------------|
| `↑` / `↓` / `←` / `→` | Move selection | To the adjacent pane, or into and out of the baseboard's doors; the opposite direction returns to the origin. |
| `⌘`+arrows or `Ctrl`+arrows | Swap surfaces | Swap the two panes' Surfaces; the opposite chord swaps back exactly. Either modifier, every platform. |

## Terminal selection & clipboard

Both modes, ahead of the passthrough gate, and only on a terminal **selected** Surface — a browser surface owns its clipboard keys (below), a focused Dormouse text field owns them ahead of everything (`docs/specs/mouse-and-clipboard.md` §8.9).

| Key | Action | Description |
|-----|--------|-------------|
| `e` | Extend to token | Mid-drag only: extend the selection to the full URL/path token at the cursor; consumed but inert with no token. |
| `Alt` (hold) | Block / linewise | Block (rectangular) rather than linewise, live through the drag; touch latches it with a double-tap-then-drag. |
| `Esc` | Cancel selection | Cancel the in-progress drag, or clear a finalized selection while its popup is up. |
| *(any other key)* | — | Swallowed during a terminal-handled drag, never reaching the inside program (`docs/specs/mouse-and-clipboard.md` §3.6). |
| `⌘C` (macOS) / `Ctrl+C` (others) | Copy raw | Copy the selection as-is; requires a finalized selection. |
| `⌘⇧C` (macOS) / `Ctrl+Shift+C` (others) | Copy rewrapped | Copy the selection rewrapped for single-line display. |
| `⌘N` (macOS) / `Ctrl+N` (others) | Add to notepad | Capture the finalized selection as a note on that Surface; unbound where the browser reserves the chord (`docs/specs/notepad.md`). |
| `⌘V` / `⌘⇧V` / `Ctrl+V` / `Ctrl+Shift+V` | Paste | Paste into the terminal; the `Ctrl` variants are intercepted on every platform, macOS included. |

On macOS `Ctrl+C` still reaches the running program; a literal `0x16` needs the shell's `quoted-insert` (`Ctrl+Q`) (`docs/specs/mouse-and-clipboard.md` §8.3).

## Browser surfaces (passthrough)

Every key not claimed above forwards to the embedded page while a screencast pane is interactive; an `iframe`-rendered surface receives keys natively (`docs/specs/dor-browser.md`).

| Key | Action | Description |
|-----|--------|-------------|
| `⌘V` / `Ctrl+V` | Paste into page | Replays the *local* clipboard as per-character key events — the embedded browser's own clipboard is empty. |
| `⌘`/`Ctrl` + `a` / `c` / `x` | Select all / copy / cut | Routed through the host's `agentBrowserEdit` channel. |
| `c` / `Esc` (render-swap warning) | Continue / cancel | Confirm dropping the non-active tabs when swapping a multi-tab screencast surface to the `iframe` renderer. |

## Dialogs, menus & prompts

| Key | Action | Description |
|-----|--------|-------------|
| `Esc` | Close / cancel | Dismiss a dialog or popover; cancel a rename or kill confirmation; abort an in-progress sash or pane drag. |
| `Enter` | Confirm rename | Save the new name while renaming a pane; blur commits too. |
| `Tab` / `Shift+Tab` | Focus cycle | Cycle focus through an open popover or dialog (trapped, wrapping). |
| Prompted letter | Confirm kill | Type the letter shown to confirm; **any** other key cancels, so `Esc` is only the documented spelling. |
| `a` / `t` (alert dialog open) | Toggle alert / todo | Same as command-mode `a` / `t`, for the dialog's Session. |
| `1`–`9` (header context menu open) | Connect port | Open the nth port row in a browser surface, select it, enter passthrough. Dropped, never buffered, unless the scan loaded a row for that digit and the host can open one. |
| `↑` / `↓` (header context menu open) | Move row focus | Rove focus across port rows, wrapping; `Enter`/`Space` activates the focused row. |

## VS Code host

Mirrored workbench chords — the terminal still receives the key too; [vscode.md](vscode.md) owns the `lib/src/lib/vscode-keybindings.ts` allowlist and its revalidation.

| Key | VS Code command |
|-----|-----------------|
| `⌘P` / `Ctrl+P` | `workbench.action.quickOpen` |
| `⌘⇧P` / `Ctrl+Shift+P`, or `F1` (unmodified) | `workbench.action.showCommands` |
| `⌘B` / `Ctrl+B` | `workbench.action.toggleSidebarVisibility` |

The standalone host contributes no chords; `docs/specs/standalone.md` owns its native-menu contract.

## Implementation references

- `lib/src/components/wall/use-wall-keyboard.ts` — the capture-phase listener; the iframe-shim leader `message` listener
- `lib/src/components/wall/keyboard/` — one module per dispatch branch: `handle-dual-tap.ts`, `handle-editable-clipboard.ts`, `handle-mouse-selection-keys.ts`, `handle-kill-confirm.ts`, `handle-pane-shortcuts.ts`, `handle-pane-navigation.ts`; platform modifiers in `chords.ts`
- `lib/src/lib/vscode-keybindings.ts` — the workbench mirror allowlist
- `lib/src/lib/terminal-mouse-router.ts` — live Alt tracking during a drag
- `lib/src/components/SelectionPopup.tsx`, `lib/src/components/wall/PaneHeaderContextMenu.tsx`, `lib/src/components/TodoAlertDialog.tsx`, `lib/src/components/wall/InlineEditInput.tsx`, `lib/src/components/use-popover-focus-trap.ts` — the popover/dialog handlers
- `lib/src/components/wall/agent-browser-surface-controller.ts` — browser key forwarding and the edit-chord bridge

## Future

Workspace switch / create / close / rename shortcuts (command mode) are staged with the workspaces rollout ([layout.md](layout.md#future), **Scope: workspaces-rollout**), following the tmux *window* bindings the rest of the keymap mirrors; listed here once bound.
