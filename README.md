![Dormouse — Multitasking Terminal for Mice](website/public/og-image.jpg)

[![maintained with tend](https://img.shields.io/badge/maintained_with-tend-bba580?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCwxNikgc2NhbGUoMC4wMTI1LC0wLjAxMjUpIiBmaWxsPSIjZmZmIiBzdHJva2U9Im5vbmUiPjxwYXRoIGQ9Ik02ODAgMTEyOCBjNjIgLTk2IDY5IC0xNzggMjAgLTI0MSAtMTcgLTIyIC0yMCAtNDAgLTIwIC0xMzQgbDEgLTEwOCAyMSAyOCBjMTEgMTYgMzAgNDcgNDIgNzAgMTIgMjIgMzIgNDkgNDYgNTkgMzcgMjcgMTE0IDM4IDE4NCAyNyA5MyAtMTUgOTQgLTE4IDQ0IC03OSAtNzIgLTg4IC0xMDkgLTExMyAtMTc2IC0xMTcgLTMxIC0yIC02NCAxIC03MiA2IC0yMyAxNSAyMSA1NiAxMDcgOTggNDAgMjAgNzEgMzggNjkgNDAgLTYgNyAtODggLTE3IC0xMjYgLTM3IC00OSAtMjUgLTEwMCAtNzggLTEyMSAtMTI1IC0xNSAtMzMgLTE5IC02NiAtMTkgLTE4OCAwIC0xNTcgOCAtMTk1IDUwIC0yMzIgMTcgLTE2IDM2IC0yMCA4NSAtMTkgNjIgMSA2MyAxIDczIC0zMiA5IC0zMiA5IC0zMyAtMjIgLTQwIC01MCAtMTIgLTEzMiAtNyAtMTY0IDEwIC00MCAyMSAtNzkgNjkgLTkyIDExNCAtNSAyMCAtMTAgMTAyIC0xMCAxODIgMCA4MCAtNSAxNjIgLTExIDE4NCAtMjIgNzkgLTEzNSAxNjYgLTIzNCAxODEgLTM3IDYgLTM1IDMgMzAgLTI4IDc4IC0zOSAxNDQgLTkxIDEzMiAtMTA0IC01IC00IC0zNyAtOCAtNzEgLTggLTc3IDAgLTExNyAyNCAtMTgyIDEwOSAtNTIgNjggLTUxIDcwIDQyIDg1IDcxIDExIDE0MyAwIDE4MyAtMjkgMTYgLTExIDQwIC00MyA1NCAtNzMgMTMgLTI5IDMyIC01OSA0MSAtNjYgMTQgLTEyIDE2IC03IDE2IDU4IDAgNTkgNCA3NyAyMyAxMDIgMTkgMjYgMjMgNDYgMjUgMTMwIDMgNjcgMCA5OSAtNyA5OSAtNyAwIC0xMSAtMjMgLTEyIC01NyAwIC0zMiAtNiAtNzYgLTEyIC05NyBsLTEyIC00MCAtMjcgMzIgYy0zNCA0MSAtNDMgOTYgLTI0IDE1MSAxNCA0MSA3NSAxNDEgODYgMTQxIDMgMCAyMSAtMjQgNDAgLTUyeiIvPjwvZz48L3N2Zz4K)](https://github.com/max-sixty/tend)

A multitasking terminal for VS Code and the desktop — a real tiling layout, tmux keybindings, full mouse support, browser panes your agents can drive, and alerts that tell you when something needs you.

## Try it

- **[Playground](https://dormouse.sh/playground)** - try in your browser, no install
- **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=diffplug.dormouse)** / **[Open VSX](https://open-vsx.org/extension/diffplug/dormouse)** - works in VS Code and its forks
- **[Standalone app](https://dormouse.sh/#download)** - Mac, Windows, Linux

## Documentation

- [CLI reference](https://dormouse.sh/docs/dor) — every `dor` command
- [Agent skill](https://dormouse.sh/docs/agent-skill) — the operating guide Dormouse bundles for coding agents
- [Self-host](https://dormouse.sh/docs/self-host) — run the coordinating server on your own tailnet
- [Hosted](https://dormouse.sh/hosted) — upcoming managed server and ElevenLabs voice options
- [Security](https://dormouse.sh/docs/security) — what Dormouse guarantees, what it does not, and how that is checked

## Features

- **Alerts when something needs you.** Terminal notification protocols (`BEL`, `OSC 9/9;4/99/777`) and unattended command exits alert with no setup; opt in per command name to also be alerted when a watched command goes quiet.
- **tmux-compatible keybindings.** Same prefix, same splits, same pane navigation. Muscle memory transfers.
- **Full mouse support.** Click to split, drag to resize, scroll to navigate. Or stay on the keyboard.
- **Copy-paste that works.** Click and drag selects text the way you'd expect, even in mouse-aware TUIs that normally swallow it as escape codes.
- **Minimize to doors.** Minimize a terminal to a compact status indicator. It keeps running and keeps reporting whether its task needs attention.
- **Browser panes.** Put a browser in the tiling layout next to the terminal serving it, drivable by you or your agents.
- **Dual distribution.** Standalone desktop app (Mac/Windows/Linux) or VS Code extension.

## Development

This project uses pnpm, react, typescript, vite, tailwind, storybook, and xterm.js. The standalone app is built with Tauri.

The terminal is currently hosted by `node-pty`, but we plan on switching to a Rust backend for the PTY.

### Quickstart

```sh
pnpm install
pnpm dev:website    # vite hotreload at http://localhost:5173
pnpm dev:standalone # tauri hotreload
pnpm dev:server     # selfhost relay server for remote control

pnpm dogfood:vscode # builds the VSCode extension and installs it into your local VSCode
pnpm dogfood:standalone              # installs your local build overtop of your existing system installation
pnpm dogfood:standalone --no-install # builds and runs the standalone app from the build dir, without installing

pnpm storybook    # http://localhost:6006
pnpm test         # runs all tests (spec lint first)
pnpm lint:specs   # docs/specs conventions only
```

### Folder structure

| Path | Description |
|------|-------------|
| `lib/` | Shared React terminal library, plus the remote/Pocket modules |
| `website/` | dormouse.sh — marketing, playground, and the generated docs pages |
| `standalone/` | Tauri desktop app and its Node PTY sidecar |
| `vscode-ext/` | VS Code extension (the README there is the canonical product guide) |
| `server/` | Selfhost coordinating server for remote control |
| `dor/` | The `dor` CLI staged onto every Dormouse terminal's `PATH` |
| `docs/specs/` | Internal specs — the reference for how everything actually behaves |

### Agent strategy

This project was built with a combination of Claude, Codex, and Devin. We make heavy use of the [impeccable.style](https://impeccable.style/) agent skill, we recommend having it installed. See [AGENTS.md](AGENTS.md) for more detail.

## License

[FSL-1.1-MIT](LICENSE) — Copyright 2026 DiffPlug LLC

[Supply chain](https://dormouse.sh/supply-chain)
