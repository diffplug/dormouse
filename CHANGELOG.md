# Changelog

All notable changes to this project will be documented in this file.

- 🔌 - affects only the VS Code plugin
- 🖥️ - affects only the standalone desktop app
- no emoji - affects both distributions

The format is based on [Keep a Changelog](https://keepachangelog.com/). Release checklist in [deploy.md](docs/specs/deploy.md).

## [1.0.1] - 2026-07-14

_Recommended bump: **bugfix** — the only change repairs release packaging; no feature or behavior changes._

### Fixed
- 🖥️ CI release artifacts now include the zsh shell-integration files (`.zshenv`, `.zshrc`, `.zprofile`), which `actions/upload-artifact` silently dropped as hidden dotfiles. This is what blocked the standalone v1.0.0 binaries from shipping — hash verification correctly refused the incomplete artifacts — so 1.0.1 is the first standalone release of the 1.0 feature set. The VS Code extension was unaffected ([7ef0f440](https://github.com/diffplug/dormouse/commit/7ef0f440c8631a9616093e1c682b0425b682369a)).

## [1.0.0] - 2026-07-14
### Added
- Added the **`dor` CLI**, staged onto the `PATH` of every Dormouse-launched terminal so you — or a coding agent — can drive the terminal grid from the command line. Surface commands open in the background without stealing focus ([#120](https://github.com/diffplug/dormouse/pull/120), [#212](https://github.com/diffplug/dormouse/pull/212), [#234](https://github.com/diffplug/dormouse/pull/234), [#239](https://github.com/diffplug/dormouse/pull/239), [#240](https://github.com/diffplug/dormouse/pull/240)):
  - `dor split` / `dor ensure` — open a new surface, or reuse-or-launch a command by working directory (with `--restart` to interrupt and re-run in place).
  - `dor list` — one unified surface listing, with `--ports`, `--json`, and filters.
  - `dor send` / `dor read` / `dor kill` — drive input, read the screen, or close a surface, addressed by stable `surface:N` handles.
  - `dor skill` (`--install`) — print the bundled agent skill, or drop a bootstrap stub into your project so a coding agent knows how to use `dor`.
- Added **browser surfaces** — any pane can now host a web view in one of three swappable render modes: an AI-agent-driven browser screencast (`dor ab`), a popped-out browser window, or a proxied iframe that loads pages which normally block framing (`dor iframe`), with back/forward, an editable URL bar, and one-click links to detected local dev servers ([#140](https://github.com/diffplug/dormouse/pull/140), [#143](https://github.com/diffplug/dormouse/pull/143), [#156](https://github.com/diffplug/dormouse/pull/156), [#241](https://github.com/diffplug/dormouse/pull/241)).
- Terminals now detect shell prompts and command boundaries automatically via injected OSC 633 shell integration — covering zsh, bash, PowerShell, Git Bash, and WSL — so pane titles and command-run tracking populate without any setup ([#133](https://github.com/diffplug/dormouse/pull/133), [#147](https://github.com/diffplug/dormouse/pull/147)).
- Dormouse now answers terminal color queries (OSC 10/11/12) from the active theme, so TUIs like Codex that probe the background color render their adaptive UI correctly instead of assuming a dark terminal on light themes ([#202](https://github.com/diffplug/dormouse/pull/202)).
- 🔌 The VS Code extension reflects a workspace's attention status onto native chrome — appending a bell and/or `[TODO]` to the panel/tab title and showing a badge on the view — so ringing terminals and pending TODOs are visible even when the Dormouse view isn't focused ([#197](https://github.com/diffplug/dormouse/pull/197)).

### Changed
- **BREAKING** Rebuilt the tiling layout engine in-house (replacing the dockview library): rearranging panes no longer blurs the focused terminal or reloads embedded browser views, drag-and-drop can drop against an ancestor split (scroll to cycle drop depth), and split/close/restore animations were reworked. Upgrading from an earlier version starts with a fresh window — terminals, layout, and minimized panes saved by older releases are not restored; sessions save and restore normally from 1.0.0 onward ([#228](https://github.com/diffplug/dormouse/pull/228), [#232](https://github.com/diffplug/dormouse/pull/232)).
- Smoother browser screencast: byte-identical frames skip re-decoding and off-screen browser panes park their stream; on the standalone app, screenshot data no longer shares the terminal's data pipe, so terminals no longer stutter while a screencast streams ([#204](https://github.com/diffplug/dormouse/pull/204)).
- 🖥️ The standalone app now intercepts every quit path (Cmd+Q, window close, Dock quit, OS shutdown) to shut terminals down gracefully, capture their final scrollback, and durably save your session before exiting — prompting for confirmation when terminals are still running ([#230](https://github.com/diffplug/dormouse/pull/230)).

### Fixed
- Pane header minimize and close buttons stay fully visible as a pane narrows, instead of being clipped or pushed off ([#148](https://github.com/diffplug/dormouse/pull/148)).
- Terminal text selection no longer gets stuck when the mouse button is released over an adjacent browser or iframe pane; the drag finalizes immediately ([#157](https://github.com/diffplug/dormouse/pull/157)).
- The command-mode selection highlight now wraps the entire browser-surface pane, including its tab header, instead of stopping short below the tab bar ([#164](https://github.com/diffplug/dormouse/pull/164)).
- `dor` and `dor ab` now work on Windows — spawning `agent-browser` through its `.cmd` shim without hanging on the browser daemon, and on the standalone app `dor` output now appears, its `PATH` survives Git Bash login shells, and `dor --version` / `-v` is accepted ([#188](https://github.com/diffplug/dormouse/pull/188), [#224](https://github.com/diffplug/dormouse/pull/224)).
- On Windows, Shift+Enter and Ctrl+J now insert a newline (instead of submitting or doing nothing) in TUIs that read keyboard input via the Console API behind ConPTY, such as Codex. Dormouse advertises win32-input-mode so those apps receive faithful Win32 key events, the same way Windows Terminal does. Claude Code and macOS/Linux are unaffected — they continue to use the kitty keyboard protocol ([#117](https://github.com/diffplug/dormouse/pull/117)).
- 🖥️ Windows auto-update no longer fails with an "Error opening file for writing" on `conpty.node`; the Node sidecar is killed and fully exits before the installer runs ([#119](https://github.com/diffplug/dormouse/pull/119)).
- 🖥️ Pasting on the Windows desktop app no longer spawns flickering, focus-stealing PowerShell windows; clipboard reads go through native Win32 calls ([#205](https://github.com/diffplug/dormouse/pull/205)).
- 🖥️ The macOS desktop app shows the correct, padded Dock icon at launch ([#163](https://github.com/diffplug/dormouse/pull/163)).
- 🖥️ Native controls (scrollbars, form inputs, autofill) in the desktop app follow the selected theme's light or dark appearance instead of the OS setting ([#238](https://github.com/diffplug/dormouse/pull/238)).
- 🖥️ Long-running standalone sessions no longer grow the app's on-disk storage without bound; session state now uses a bounded Rust-backed per-window file store instead of WebKit `localStorage` ([#225](https://github.com/diffplug/dormouse/pull/225)).


## [0.11.0] - 2026-05-28
### Added
- Pane titles now read the running command off the rendered prompt line, so the title is correct whether the command was typed, recalled from history, or pasted, and it survives session restore / VS Code panel reopen ([#102](https://github.com/diffplug/dormouse/pull/102)).
### Changed
- 🖥️ The standalone app is now named **Dormouse Terminal** so it surfaces when you search for "Term" ([#111](https://github.com/diffplug/dormouse/pull/111)).
### Fixed
- On Windows, pane titles no longer show a bare interpreter path such as **cmd.exe**; the detected command is shown instead, and cmd.exe and Git Bash prompts are now recognized ([#103](https://github.com/diffplug/dormouse/pull/103)).
- 🖥️ A stray Windows Terminal window no longer flashes behind the standalone app on Windows 11 where Windows Terminal is the default terminal ([#110](https://github.com/diffplug/dormouse/pull/110)).
- 🔌 VS Code workbench chords now reach the terminal: **Cmd/Ctrl+P** (Go to File), **Cmd/Ctrl+Shift+P** and **F1** (Command Palette), and **Cmd/Ctrl+B** (toggle sidebar) fire even when a focused TUI has switched on an enhanced keyboard protocol ([#112](https://github.com/diffplug/dormouse/pull/112)).


## [0.10.2] - 2026-05-19
### Changed
- Internal refactor unifying modal primitives and renaming dialog components to modals; Storybook entries reorganized to match ([#78](https://github.com/diffplug/dormouse/pull/78)).

## [0.10.1] - 2026-05-19
### Changed
- Refreshed dependencies ([#76](https://github.com/diffplug/dormouse/pull/76)).

## [0.10.0] - 2026-05-18
### Added
- OSC 8 hyperlinks emitted by terminal programs are now clickable, with a confirmation dialog before opening external URLs ([#75](https://github.com/diffplug/dormouse/pull/75)).
- Kitty keyboard protocol is enabled so TUIs like Claude Code can distinguish Shift+Enter from Enter ([#71](https://github.com/diffplug/dormouse/pull/71)).
- Per-pane shell CWD tracking, plus an inline warning popover when a terminal program attempts an illegal rename ([#59](https://github.com/diffplug/dormouse/pull/59)).
- iTerm2-style OSC notifications and terminal bells are now recognized and surfaced as alerts ([#57](https://github.com/diffplug/dormouse/pull/57)).
- New panes inherit the working directory of the source pane when splitting ([#66](https://github.com/diffplug/dormouse/pull/66), closes [#4](https://github.com/diffplug/dormouse/issues/4)).
- Panes whose shell is still untouched skip the kill-confirmation prompt ([#61](https://github.com/diffplug/dormouse/pull/61)).

### Changed
- **BREAKING** Rebranded from MouseTerm to Dormouse — new VS Code extension (`diffplug.dormouse`), new standalone bundle identifier (`sh.dormouse.standalone`), and new home at [dormouse.sh](https://dormouse.sh). Existing MouseTerm installs will not auto-update; install Dormouse fresh ([#70](https://github.com/diffplug/dormouse/pull/70)).
- Alert model reworked to unify our existing "watching" model with OSC 9/99/777 and command-exit ([#67](https://github.com/diffplug/dormouse/pull/67)).
- 🖥️ Auto-update banner now requires explicit approval before downloading, and "What's new" links are pinned to the target version ([#48](https://github.com/diffplug/dormouse/pull/48)).

### Fixed
- Mouse events no longer leak through to the PTY while the mouse-override modifier is held ([#55](https://github.com/diffplug/dormouse/pull/55)).
- 🖥️ Ctrl+V no longer triggers the macOS WKWebView paste permission prompt on standalone ([#65](https://github.com/diffplug/dormouse/pull/65)).

## [0.9.1] - 2026-05-01
### Changed
- 🖥️ Drop-to-paste from the OS file explorer is temporarily inert on standalone while we wait on upstream Tauri ([tauri#14373](https://github.com/tauri-apps/tauri/issues/14373)) to allow native drag-drop without blocking HTML5 drag events ([#39](https://github.com/diffplug/dormouse/pull/39)).

### Fixed
- The mouse-override banner now renders inline in the terminal pane body and no longer stacks with the action-button tooltip ([#43](https://github.com/diffplug/dormouse/pull/43)).
- Themes with translucent selection backgrounds (e.g. Selenized Dark) no longer bleed through MouseTerm's solid AppBar and tab fills ([#37](https://github.com/diffplug/dormouse/pull/37)).
- 🖥️ Force-closing the standalone host now reliably kills the Node sidecar tree via a Windows Job Object / Unix process group, so subsequent builds no longer hit orphan `node.exe` processes locking files ([#41](https://github.com/diffplug/dormouse/pull/41)).
- 🖥️ Standalone macOS terminals run zsh as a login shell when no args are provided, so `~/.zprofile` runs and Homebrew/asdf land on `PATH` ([#40](https://github.com/diffplug/dormouse/pull/40)).
- 🖥️ Pane drag-and-drop reordering works again on standalone ([#39](https://github.com/diffplug/dormouse/pull/39)).

## [0.9.0] - 2026-04-30

### Added
- 🖥️ Debug dialog for failed auto-updates — surfaces the error and copies a pre-filled bug report (version, platform, last ~10 KB of `mouseterm.log`) ([#35](https://github.com/diffplug/dormouse/pull/35)).

### Fixed
- Terminals auto-spawned from a blank workspace now respect the selected shell ([#33](https://github.com/diffplug/dormouse/pull/33)).
- 🖥️ Polish app bar header to align with pane chrome and shared design tokens ([#34](https://github.com/diffplug/dormouse/pull/34)).
- 🖥️ macOS auto-update — strip AppleDouble (`._*`) sidecars from the signed tarball that were breaking every v0.7.x → v0.8.0 install ([#35](https://github.com/diffplug/dormouse/pull/35)).

## [0.8.0] - 2026-04-29
- Add intuitive shortcuts alongside the tmux shortcuts.
- Simplify the TODO behavior to clear when ENTER pressed within a session, got rid of the "soft TODO" system.
- Improve VS Code theme translation.
  - Added a "Theme debugger" to assist with this.
- Fix terminal selection on Windows.

## [0.7.0] - 2026-04-22
- Overhaul the theming system.
- Overhaul mouse and clipboard handling.
- Overhaul alerting system.

## [0.6.2] - 2026-04-13
- Fix issues with deployed Tauri on Win and Mac (Linux is working great!)

## [0.6.1] - 2026-04-13
- Fix missing Tauri update permissions.

## [0.6.0] - 2026-04-13
- Standalone: fix some issues with node sidecar.
- Standalone: app-rendered title bar.

## [0.5.2] - 2026-04-10
- Codex fixes.

## [0.5.1] - 2026-04-10
- Fix uploading glob.

## [0.5.0] - 2026-04-10
- Get ready to test auto-update for the standalone apps.
- Add icons to the standalone apps.

## [0.4.0] - 2026-04-10
- Yet yet another initial release to test publishing.

## [0.3.0] - 2026-04-10
- Yet another initial release to test publishing.

## [0.2.0] - 2026-04-09
- Another initial release to test publishing.

## [0.1.0] - 2026-04-09
- Initial release to test publishing.
