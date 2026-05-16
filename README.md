# Dormouse

**A dormouse knows when to wake up. Multitasking terminal for mice (and hotkey wizards too).**

So many terminals — which one needs attention? Dormouse tracks activity the
way you do: visual motion. When a pane stops changing for two seconds,
it's marked done. Works with any CLI tool that prints to a terminal —
no plugins, no configuration.

![Dormouse hero](website/src/assets/video-climb-blink-and-stare.webp)

## Try it

- **[Playground](https://dormouse.sh/playground)** — try in your browser, no install
- **[Demo videos and downloads](https://dormouse.sh)** — Mac, Windows, Linux
- **[Marketplace](https://marketplace.visualstudio.com/items?itemName=diffplug.dormouse)** / **[Open VSX](https://open-vsx.org/extension/diffplug/dormouse)** — VS Code extension (also works in Cursor, Windsurf, Antigravity)

## Features

- **Automatic completion detection.** When a pane goes quiet for two seconds, it's marked done. Works with builds, AI agents, scripts, anything.
- **tmux-compatible keybindings.** Same prefix, same splits, same pane navigation. Muscle memory transfers.
- **Full mouse support.** Click to split, drag to resize, scroll to navigate. Or stay on the keyboard.
- **Copy-paste that works.** Click and drag selects text the way you'd expect, even in mouse-aware TUIs that normally swallow it as escape codes. Ctrl+C copies; killing the program is a separate gesture.
- **Sleep/wake panes.** Minimize a terminal to a compact status indicator. It keeps running and you can still see whether its task finished.
- **Dual distribution.** Standalone desktop app (Mac/Windows/Linux) or VS Code extension.
- **Pocket (coming soon).** Tether your sessions to your phone over WebRTC — walk away, keep working.

## Development

This project uses pnpm, react, typescript, vite, tailwind, storybook, and xterm.js. The standalone app is built with Tauri.

The terminal is currently hosted by `node-pty`, but we plan on switching to a Rust backend for the PTY.

### Quickstart

```sh
pnpm install
pnpm dev:website    # vite hotreload at http://localhost:5173/playground
pnpm dev:standalone # tauri hotreload

pnpm dogfood:vscode # builds the VSCode extension and installs it into your local VSCode
pnpm dogfood:standalone           # builds and runs the standalone app
pnpm dogfood:standalone --install # installs your local build overtop of your existing system installation

pnpm storybook    # http://localhost:6006
pnpm test         # runs all tests
```

### Folder structure

| Path | Description |
|------|-------------|
| `lib/` | Shared terminal library |
| `website/` | dormouse.sh (including playground) |
| `standalone/` | Tauri desktop app |
| `vscode-ext/` | VSCode extension |

### Agent strategy

This project was built with a combination of Claude, Codex, and Devin. Recommend running `npx skills experimental_install` to install the skills we are using (namely [impeccable.style](https://impeccable.style/)). See [AGENTS.md](AGENTS.md) for more detail.

## License

[FSL-1.1-MIT](LICENSE) — Copyright 2026 DiffPlug LLC

[Production dependencies](https://dormouse.sh/dependencies)
