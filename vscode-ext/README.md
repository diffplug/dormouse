# Dormouse

Terminal multiplexer for VS Code (or [standalone app](https://dormouse.sh/#download)) — tmux keybindings, mouse support, human-friendly copy-paste, and alerts for completed tasks.

[dormouse.sh/playground](https://dormouse.sh/playground) — try before you install

TODO: Hero GIF.

## Alert System

Dormouse tracks activity the same way you do — visual motion. When a pane stops changing for two seconds, it marks the task complete and alerts you. Works with any CLI tool that prints to a terminal, no plugins or configuration.

- <img width="22" height="22" alt="todo-disabled" src="https://github.com/user-attachments/assets/29178d1e-062f-4e4d-8de8-250e01b73125" /> alerts disabled
- <img width="22" height="22" alt="todo-enabled" src="https://github.com/user-attachments/assets/1f6dfeb3-7d8e-4724-b777-af6b350cbc80" /> alerts enabled
- <img width="22" height="22" alt="todo-armed" src="https://github.com/user-attachments/assets/a02e9b7c-4a48-459d-910a-ef0b0ae2a27f" /> task is running, will send an alert when task completes
- <img width="22" height="22" alt="todo-ringing" src="https://github.com/user-attachments/assets/55082f42-ddcc-402c-b550-814d84b86630" /> task is finished and needs your attention

When you click a task that was ringing, it adds a TODO next to the terminal's title. This TODO will remain until you hit `Enter` in that terminal, or until you explicitly dismiss the TODO by clicking it or typing `t` in command mode.

This lightweight TODO system remembers which tasks need follow-up so you don't have to.

## Mouse-Friendly Copy and Paste

When you copy-paste from a terminal, you are usually stuck with a bunch of newlines that you wouldn't get if you were copying from any other kind of program. Dormouse can optionally remove these with `Copy Rewrapped`.

<img width="744" height="378" alt="copy-paste" src="https://github.com/user-attachments/assets/8e905ba1-a8b7-43c5-86af-e7dfd84f04db" />

For TUIs which register for xterm mouse interception (such as `htop` and `neovim`), most terminals make it impossible for you to copy using the mouse. Dormouse makes it easy to temporarily override the mouse interception.

TODO: GIF showing htop and the override mechanism

## Tiling Layout with Minimize

Run builds, agents, servers, and scripts side by side. Minimize the ones you're not watching to a compact status indicator — every pane keeps running and every alert still fires whether minimized or not.

You can spawn, layout, and relayout everything in the terminal using any of:

- default tmux shortcuts
- intuitive modern shortcuts
- the mouse

TODO: layout GIF

## Keyboard Shortcuts

If you use the mouse, then Dormouse is always in **passthrough** mode, where all keypresses passthrough to the selected terminal. If you press `LShift` followed by `RShift` in quick succession (or `LCmd → RCmd`, or `LCtrl → RCtrl`), then you will enter **command** mode where keypresses can spawn terminals, navigate panes, and rearrange the layout.

### Command Mode Shortcuts


| Key | Action |
|-----|--------|
| `Enter` | Return to **passthrough** mode |
| `\|` tmux `%` | Split left/right |
| `-` tmux `"` | Split top/bottom |
| Arrow keys | Navigate between panes |
| `Cmd+Arrow` | Swap pane positions |
| `z` | Zoom / unzoom the selected pane |
| `m` tmux `d` | Minimize pane to baseboard |
| `k` tmux `x` | Kill pane |
| `,` | Rename pane |

## Any Theme, Anywhere

Dormouse uses your VSCode theme — colors, styling, everything. Switch themes and Dormouse switches with you. No separate configuration, no mismatched colors.

TODO: GIF showing theme switching — user changes VSCode theme and Dormouse updates instantly to match

You can also use Dormouse in the Panel area (bottom, next to the built-in terminal), in the Editor area (center region where you edit files), or both.

TODO: GIF showing Dormouse in various areas

## Getting Started

1. Install the extension
2. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
  - **Dormouse: Focus** to open the "Panel" version of Dormouse (next to the terminal)
  - **Dormouse: Open in Editor** to open a Dormouse tab in the content area (you can open multiple)

## Links

- Prefer a standalone terminal app? Self-updating installers available for Win, Mac and Linux at [dormouse.sh](https://dormouse.sh/#download)
- You can try it in a [browser playground](https://dormouse.sh/playground)
- [GitHub](https://github.com/diffplug/dormouse)
- Brought to you by [DiffPlug](https://www.diffplug.com/)
