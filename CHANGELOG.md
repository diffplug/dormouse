# Changelog

All notable changes to this project will be documented in this file.

- 🔌 - affects only the VS Code plugin
- 🖥️ - affects only the standalone desktop app
- no emoji - affects both distributions

The format is based on [Keep a Changelog](https://keepachangelog.com/). Release checklist in [deploy.md](docs/specs/deploy.md).

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
