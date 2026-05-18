# Dormouse

A mouse-friendly multitasking terminal built with pnpm, react, typescript, vite, tailwind, storybook, and xterm.js.

## Setup

```
pnpm install     # install deps
pnpm build       # build lib, vscode extension, and website
```

## Architecture

- **lib/** — Shared React + TailwindCSS frontend library (components, platform abstraction, tests, Storybook)
- **standalone/** — Tauri desktop app with Node.js sidecar for native PTY via node-pty
- **vscode-ext/** — VS Code extension wrapping the lib in a webview with native PTY backend
- **website/** — Marketing website bundling part of the lib as an interactive demo

## Project Structure

- `lib/` — Core UI library (pnpm) — Storybook, tests, shared components
- `lib/src/lib/platform/` — Platform abstraction layer (`PlatformAdapter` interface, fake + VSCode adapters)
- `standalone/` — Tauri app (Rust + Vite frontend)
- `standalone/sidecar/` — Node.js PTY manager, bundled as Tauri sidecar
- `standalone/src-tauri/` — Rust backend that bridges webview ↔ Node.js sidecar
- `vscode-ext/` — VS Code extension (esbuild, node-pty via forked child process)
- `website/` — Marketing site (Vite, uses FakePtyAdapter for demo)

## Specs

The primary job of a spec is to be an accurate reference for the current state of the code. Read the relevant spec before modifying a feature it covers — the spec describes invariants, edge cases, and design decisions that are not obvious from the code alone.

- **`docs/specs/glossary.md`** — Canonical vocabulary for Session states, layers (Process / Registry / View / Link / Activity / Snapshot), transition verbs, and the Liskov contract on Registry APIs. Read this first. Other specs defer to it when naming a state or a verb.
- **`docs/specs/layout.md`** — Tiling layout, pane/door containers, dockview configuration, modes (passthrough/command), keyboard shortcuts, selection overlay, spatial navigation, minimize/reattach, inline rename, session lifecycle, session persistence, and theming. Read this when touching: `Wall.tsx`, `Baseboard.tsx`, `Door.tsx`, `TerminalPane.tsx`, `spatial-nav.ts`, `layout-snapshot.ts`, `terminal-registry.ts`, `session-save.ts`, `session-restore.ts`, `reconnect.ts`, `index.css`, `theme.css`, or any keyboard/navigation/mode behavior.
- **`docs/specs/alert.md`** — Activity monitoring state machine, alert trigger/clearing rules, attention model, TODO lifecycle, bell button visual states and interaction, door alert indicators, hardening (a11y, motion, i18n, overflow), notification protocols (`OSC 9` / `OSC 9;4` / `OSC 99` / `OSC 777` / `BEL`), the `ActivityNotification` model, notification text handling and security, and the notification preview/detail UI. Read this when touching: `activity-monitor.ts`, `alert-manager.ts`, `AlertManager` notification/progress paths, the alert bell or TODO pill in `Wall.tsx` (TerminalPaneHeader), alert indicators in `Door.tsx`, the `a`/`t` keyboard shortcuts, or TODO notification preview UI. Layout.md defers to this spec for all alert/TODO behavior.
- **`docs/specs/terminal-state.md`** — Terminal semantic state for CWD, shell prompt/editing/running/finished lifecycle, command runs, terminal title fallback, normalized semantic OSC events (`OSC 7`, `OSC 9;9`, `OSC 133`, `OSC 633`, `OSC 1337`, `OSC 0/2`), title-candidate diagnostics, header derivation, and grouping keys. Read this when touching `terminal-state.ts`, `terminal-state-store.ts`, semantic event parsing in `terminal-protocol.ts`, adapter semantic event forwarding, or derived pane/door labels.
- **`docs/specs/OSC.md`** — Registry of every supported OSC sequence with pointers to the spec defining its behavior (alert.md or terminal-state.md), the canonical parsing-location and `pty:data` strip semantics, iTerm2 self-identification (env vars, `CSI > q` response, fail-inertly rule), and known-unimplemented iTerm2 and clipboard-capable sequences. Read this when touching: OSC parsing at the PTY data boundary, the iTerm2 identity env vars (`TERM_PROGRAM`, `LC_TERMINAL`), or adding support for a new OSC sequence.
- **`docs/specs/transport.md`** — Adapter-agnostic protocol shared across VS Code, standalone, and fake adapters: PTY lifecycle (decoupled from webview), `replayChunks`/`scrollbackChunks` buffering, reconnection sequence (`dormouse:init` → `pty:list` + `pty:replay`), the full webview ↔ host message protocol, persisted-session types, and universal invariants (shell login args, scrollback trailing newline, replay drop-replies-only). Read this when touching: `pty-manager.ts`, `pty-host.js`, `pty-core.js`, `message-router.ts`, `message-types.ts`, `vscode-adapter.ts`, `fake-adapter.ts`, `reconnect.ts`, `session-save.ts`, `session-restore.ts`, `session-types.ts`, or any code crossing the webview/host boundary.
- **`docs/specs/vscode.md`** — VS Code-specific layer: hosting modes (WebviewView + WebviewPanel), extension manifest, VS Code persistence flow (`workspaceState`, `vscode.setState`, `WebviewPanelSerializer`, deactivate ordering, `mergeAlertStates` rule, `retainContextWhenHidden`), theme integration (`--vscode-*` → `--color-*` with the runtime resolver), CSP, build pipeline, and dream-architecture commands. The transport protocol it speaks (PTY lifecycle, message protocol, persisted-session types) lives in `transport.md`. Read this when touching: `extension.ts`, `webview-view-provider.ts`, `session-state.ts`, `webview-html.ts`, the theme resolver/observer in `terminal-theme.ts`, or VS Code commands and context keys.
- **`docs/specs/tutorial.md`** — Playground tutorial on the website: 3-pane layout, interactive `tut` TUI runner with three sections (keyboard navigation, alerts/TODOs, copy/paste), per-item detection wired to `WallEvent` / activity store / mouse-selection store, single-key `dormouse-tut-v3` localStorage scheme, theme picker, and FakePtyAdapter extensions (`sendOutput`, `pumpActivity`, `setInputHandler`). Read this when touching: `website/src/pages/Playground.tsx`, `website/src/lib/tut-runner.ts`, `website/src/lib/tut-detector.ts`, `website/src/lib/tutorial-state.ts`, `website/src/lib/tut-items.ts`, `website/src/lib/tutorial-shell.ts`, `lib/src/components/ThemePicker.tsx`, `lib/src/lib/themes/`, `lib/src/lib/platform/fake-scenarios.ts` (tutorial scenarios), the `WallEvent` union, or the `onApiReady`/`onEvent`/`initialPaneIds` props on Wall.
- **`docs/specs/theme.md`** — Theme system: two-layer CSS variable strategy, theme data model, conversion pipeline, bundled themes, localStorage store, shared ThemePicker component, standalone AppBar picker, runtime OpenVSX installer. Read this when touching: `lib/src/lib/themes/`, `lib/src/components/ThemePicker.tsx`, `lib/src/theme.css`, `lib/scripts/bundle-themes.mjs`, `standalone/src/AppBar.tsx` (theme picker), `standalone/src/main.tsx` (theme restore), or `website/src/components/SiteHeader.tsx` (themeAware mode).
- **`docs/specs/mouse-and-clipboard.md`** — Terminal-owned text selection, copy (Raw / Rewrapped), bracketed paste, smart URL/path extension, mouse-reporting override UI (icon + banner), and the state matrix for which layer owns mouse events. Read this when touching: `lib/src/lib/mouse-selection.ts`, `lib/src/lib/mouse-mode-observer.ts`, `lib/src/lib/clipboard.ts`, `lib/src/lib/rewrap.ts`, `lib/src/lib/selection-text.ts`, `lib/src/lib/smart-token.ts`, `lib/src/components/SelectionOverlay.tsx`, `lib/src/components/SelectionPopup.tsx`, the mouse icon / override banner / Cmd+C-V handling in `lib/src/components/Wall.tsx`, or the parser hooks + mouse listeners in `lib/src/lib/terminal-registry.ts`.

When updating code covered by a spec, update the spec to match. When the two specs overlap (e.g. pane header elements appear in both), layout.md documents placement and sizing while alert.md documents behavior and visual states.

## Design

See [.impeccable.md](.impeccable.md) for full design context. Key principles:

1. **Native first** — Inside VSCode, feel indistinguishable from a built-in feature. Use the host's theme tokens.
2. **Information density without intimidation** — Dense for power users, approachable for beginners. Progressive disclosure.
3. **Status at a glance** — Scannable in under a second across many terminals.
4. **No chrome, all content** — Minimize UI chrome. Terminals are the content.
5. **Theme-adaptive** — Never hardcode colors. Support light and dark from day one.

The concrete type scale, color strategy (surfaces, foregrounds, header palette, dynamic door bg, selection ring), and shared chrome constants live in
[`lib/src/components/design.tsx`](lib/src/components/design.tsx) — read it
before adding or changing any `text-*`, `bg-*`, `text-color-*`, or border
class anywhere in `lib/src/`. The actual `@theme` token definitions are in
[`lib/src/theme.css`](lib/src/theme.css); when adding or removing a token,
update both files together.
