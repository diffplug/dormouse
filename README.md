# MouseTerm

**Multitasking terminal for the mouse, tmux-compatible.**

Run multiple terminals side-by-side, click to split, drag to resize.
When a pane stops outputting for two seconds, it's marked done — works
with any CLI tool, no plugins or config.

![MouseTerm hero](website/src/assets/video-climb-blink-and-stare.webp)

## Try it

- **[Playground](https://mouseterm.com/playground)** — try in your browser, no install
- **[Demo videos and downloads](https://mouseterm.com)** — Mac, Windows, Linux
- **[Marketplace](https://marketplace.visualstudio.com/items?itemName=diffplug.mouseterm)** / **[Open VSX](https://open-vsx.org/extension/diffplug/mouseterm)** — VS Code extension (also works in Cursor, Windsurf, Antigravity)

## Features

- **Automatic completion detection.** When a pane goes quiet for two seconds, it's marked done. Works with builds, AI agents, scripts, anything.
- **tmux-compatible keybindings.** Same prefix, same splits, same pane navigation. Muscle memory transfers.
- **Full mouse support.** Click to split, drag to resize, scroll to navigate. Or stay on the keyboard.
- **Copy-paste that works.** Click and drag selects text the way you'd expect, even in mouse-aware TUIs that normally swallow it as escape codes. Ctrl+C copies; killing the program is a separate gesture.
- **Sleep/wake panes.** Minimize a terminal to a compact status indicator. It keeps running and you can still see whether its task finished.
- **Dual distribution.** Standalone desktop app (Mac/Windows/Linux) or VS Code extension.

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
| `website/` | mouseterm.com (including playground) |
| `standalone/` | Tauri desktop app |
| `vscode-ext/` | VSCode extension |

### Agent strategy

This project was built with a combination of Claude, Codex, and Devin. Recommend running `npx skills experimental_install` to install the skills we are using (namely [impeccable.style](https://impeccable.style/)). See [AGENTS.md](AGENTS.md) for more detail.

## License

[FSL-1.1-MIT](LICENSE) — Copyright 2026 DiffPlug LLC

[Production dependencies](https://mouseterm.com/dependencies)
