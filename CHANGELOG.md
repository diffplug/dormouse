# Changelog

All notable changes to this project will be documented in this file. Also available at [blyg.dormouse.sh](https://blyg.dormouse.sh/).

- 🔌 - affects only the VS Code plugin
- 🖥️ - affects only the standalone desktop app
- no emoji - affects both distributions

The format is based on [Keep a Changelog](https://keepachangelog.com/). Release checklist in [deploy.md](docs/specs/deploy.md).

## [Unreleased]

## [1.3.0] - 2026-10-20
### Added
- **Built-in editors**
  - `.md` and `.markdown` files open in a rich Markdown editor — tables, task lists, front matter, Mermaid, source mode, image paste and drop — whose relative links open in place, with `#heading` links and per-pane Back/Forward ([#929](https://github.com/diffplug/dormouse/pull/929), [#975](https://github.com/diffplug/dormouse/pull/975), [#1172](https://github.com/diffplug/dormouse/pull/1172)).
  - A built-in PNG/JPEG image editor (markup, redact, crop, pixel tools) saves in place; Markdown images render at the size the document states, as on GitHub, with resize handles ([#1148](https://github.com/diffplug/dormouse/pull/1148), [#1174](https://github.com/diffplug/dormouse/pull/1174)).
  - `dor o` is short for `dor open`, and a bare `dor open` opens a fuzzy file picker that shows each file's handler; `builtin:code` opens any text file in Monaco ([#930](https://github.com/diffplug/dormouse/pull/930), [#965](https://github.com/diffplug/dormouse/pull/965), [#1092](https://github.com/diffplug/dormouse/pull/1092)). Confirmed terminal file links such as `[Image #2]` open in a Dor viewer ([#953](https://github.com/diffplug/dormouse/pull/953)).
- **Reopen** — command-mode `u` or `dor reopen` brings back closed Surfaces and Workspaces; clean viewers and untouched shells now close without a confirmation ([#967](https://github.com/diffplug/dormouse/pull/967)).
- **Tools** — a Break button turns a Tool back into a plain terminal and moves its page into a browser pane; Tools hidden and idle for 30 minutes stop and restart when shown, restoring their state when they opt in ([#980](https://github.com/diffplug/dormouse/pull/980), [#961](https://github.com/diffplug/dormouse/pull/961)).
- `dor` commands work from helper terminals without promoting them ([#952](https://github.com/diffplug/dormouse/pull/952)).
- Pi agent sessions resume across app restart ([#898](https://github.com/diffplug/dormouse/pull/898)).
- Settings → About names the exact build (official, development, or self-host) with a Copy details button; Activity settings moved under Notifications ([#1106](https://github.com/diffplug/dormouse/pull/1106)).
- A "Copy failed" dialog appears when a clipboard write fails every way, with diagnostics to share ([#1091](https://github.com/diffplug/dormouse/pull/1091)).
- Pocket: "Sign out and forget this phone" removes every paired computer and its push registrations ([#1251](https://github.com/diffplug/dormouse/pull/1251)).
- 🖥️ **Workspaces** — right-click a tab to Rename, Pin right, Copy ref, Move to new window, or Close, with `dor workspace pin` / `unpin`; tabs size to their names and animate reorders; Pocket groups its session list by Workspace ([#1009](https://github.com/diffplug/dormouse/pull/1009), [#1045](https://github.com/diffplug/dormouse/pull/1045), [#956](https://github.com/diffplug/dormouse/pull/956)).
- 🖥️ ⌘⇧T / File → Reopen Closed on macOS, including closed windows ([#967](https://github.com/diffplug/dormouse/pull/967)).
- 🖥️ On macOS, a frozen window is sampled and restarted onto the still-running terminals ([#993](https://github.com/diffplug/dormouse/pull/993)).
- 🖥️ Labs: "No-confirm delayed kill" replaces close confirmations with a 10-second restore window ([#969](https://github.com/diffplug/dormouse/pull/969)).

### Changed
- Surface and Workspace ids are `surface:<n>` / `workspace:<n>`: unique across the app, never reused, and unchanged when a pane moves. `DORMOUSE_SURFACE_ID` carries the same string. `dor list --id-format` and the `surface_ref` / `workspace_ref` JSON keys are removed, and old forms like `3` or `pane-…` are refused. Layouts saved by older builds are discarded on the first launch after upgrading; settings, pairings, and Tool trust are kept ([#1085](https://github.com/diffplug/dormouse/pull/1085)).
- A Tool lasts one run: when its command quits, crashes, or fails to boot, the pane becomes a plain terminal, and only the run Dormouse launched may open files ([#979](https://github.com/diffplug/dormouse/pull/979), [#1061](https://github.com/diffplug/dormouse/pull/1061)).
- Pane drag and drop: drop on a pane's middle to swap, on its outer thirds to split, or on gutters and window edges; pause on an edge and slide along it to drop beside a group of panes (replacing scroll-wheel scope cycling); Escape cancels; Tool and browser panes drag and resize like terminals ([#1177](https://github.com/diffplug/dormouse/pull/1177), [#905](https://github.com/diffplug/dormouse/pull/905), [#1168](https://github.com/diffplug/dormouse/pull/1168)).
- Alerts are never silently dropped: a task finishing while you watch becomes a TODO, deferral waits only while a program is confirmed busy, only output that changes the screen counts as working, and "pause" is now "defer" ([#1080](https://github.com/diffplug/dormouse/pull/1080), [#1083](https://github.com/diffplug/dormouse/pull/1083), [#1171](https://github.com/diffplug/dormouse/pull/1171), [#1107](https://github.com/diffplug/dormouse/pull/1107)).
- The terminal context panel is denser and torn from its source pane, with the other panes dimmed behind it ([#1010](https://github.com/diffplug/dormouse/pull/1010)).
- Browser panes nobody can see stop streaming; iframe pages keep their origin and data across Reload ([#958](https://github.com/diffplug/dormouse/pull/958)).
- Settings → Network levels are renamed "Nowhere", "Local networks only", "Anywhere", and "Anywhere, through \<your Relay>" ([#1039](https://github.com/diffplug/dormouse/pull/1039)).
- Pocket asks for a passkey far less often: it stays signed in across launches, and reconnects to a recently used computer within that computer's presence window ([#1044](https://github.com/diffplug/dormouse/pull/1044)).
- Only a paired phone can register for push notifications. Phones paired before this release keep their registrations, but must pair again to re-enable push ([#1226](https://github.com/diffplug/dormouse/pull/1226)).
- Natural Voice (formerly managed voice, still a Hosted preview) enrolls separately from remote control, offers a curated set of voices, works in VS Code, and deletes its token at Hosted when turned off ([#999](https://github.com/diffplug/dormouse/pull/999), [#1000](https://github.com/diffplug/dormouse/pull/1000), [#1191](https://github.com/diffplug/dormouse/pull/1191), [#1207](https://github.com/diffplug/dormouse/pull/1207)).
- A terminal link that opens another app names it in a confirmation, a document link to an HTML or SVG page asks first, and dangerous Windows protocol handlers are blocked ([#1101](https://github.com/diffplug/dormouse/pull/1101), [#1201](https://github.com/diffplug/dormouse/pull/1201)).
- The pairing approval dialog shows only the device names Pocket itself sends ([#1163](https://github.com/diffplug/dormouse/pull/1163)).

### Fixed
- Security hardening: safe path quoting for PowerShell and fish, control and bidi characters refused in Tool definitions and links, a tighter webview CSP, no repo-configured git fsmonitor, planted Windows executables and network-share browser paths refused, Playwright loaded only from its own install, owner-only logs, and stricter Local networks and passkey checks ([#1033](https://github.com/diffplug/dormouse/pull/1033), [#1065](https://github.com/diffplug/dormouse/pull/1065), [#1060](https://github.com/diffplug/dormouse/pull/1060), [#1040](https://github.com/diffplug/dormouse/pull/1040), [#1197](https://github.com/diffplug/dormouse/pull/1197), [#1162](https://github.com/diffplug/dormouse/pull/1162), [#1034](https://github.com/diffplug/dormouse/pull/1034), [#988](https://github.com/diffplug/dormouse/pull/988), [#1031](https://github.com/diffplug/dormouse/pull/1031), [#1224](https://github.com/diffplug/dormouse/pull/1224), [#1240](https://github.com/diffplug/dormouse/pull/1240), [#1223](https://github.com/diffplug/dormouse/pull/1223), [#1243](https://github.com/diffplug/dormouse/pull/1243), [#1237](https://github.com/diffplug/dormouse/pull/1237), [#1242](https://github.com/diffplug/dormouse/pull/1242)).
- Copying goes through the host's native clipboard, so copies no longer fail intermittently ([#1198](https://github.com/diffplug/dormouse/pull/1198)).
- On Windows, WSL and Git Bash terminals start correctly again, shells stop promptly on close, typing no longer lags while ports are probed, and copy-editor keys no longer leak to the terminal ([#1253](https://github.com/diffplug/dormouse/pull/1253), [#985](https://github.com/diffplug/dormouse/pull/985), [#928](https://github.com/diffplug/dormouse/pull/928), [#951](https://github.com/diffplug/dormouse/pull/951)).
- Agent-browser panes no longer freeze on a stale tab, hover and wheel reach unselected browser panes, and narrow viewports render cleanly and survive a provider swap; `dor agent-browser dor-diagnostics` reports on a frozen stream ([#1176](https://github.com/diffplug/dormouse/pull/1176), [#1175](https://github.com/diffplug/dormouse/pull/1175), [#1100](https://github.com/diffplug/dormouse/pull/1100), [#1124](https://github.com/diffplug/dormouse/pull/1124)).
- App restart resumes every supported agent, including Codex 0.160, agents interrupted mid-reply, and narrow or hidden panes ([#960](https://github.com/diffplug/dormouse/pull/960)).
- A crashed full-screen program no longer leaves mouse modes stuck, and starting Dormouse from Claude Code no longer turns off transcript saving in its panes ([#1157](https://github.com/diffplug/dormouse/pull/1157)).
- Restarting a command in place no longer rings a spurious exit alert, and a serving Tool shows its TODO pill ([#976](https://github.com/diffplug/dormouse/pull/976)).
- A shell displaced by session restore stops instead of streaming into the pane ([#1050](https://github.com/diffplug/dormouse/pull/1050), [#1070](https://github.com/diffplug/dormouse/pull/1070)).
- Pane resizing follows the pointer when minimum sizes clamp the layout ([#901](https://github.com/diffplug/dormouse/pull/901)).
- `dor ensure` and `dor tool` accept `--flag=value` before `--`, and `dor kill` / `dor reopen` help shows valid JSON ([#1116](https://github.com/diffplug/dormouse/pull/1116), [#1184](https://github.com/diffplug/dormouse/pull/1184)).
- Enabling Pocket push no longer fails on removed or other-account computers, and a removed computer's push registration is retired ([#1095](https://github.com/diffplug/dormouse/pull/1095), [#1238](https://github.com/diffplug/dormouse/pull/1238), [#1239](https://github.com/diffplug/dormouse/pull/1239)).
- One-time connection: a stalled attempt can be retried, and the phone page shows expiry at the deadline ([#918](https://github.com/diffplug/dormouse/pull/918), [#916](https://github.com/diffplug/dormouse/pull/916)).
- Fixed update approval during the launch check, `dor` request routing across windows, VS Code terminal adoption on reload, and lost pairing outcomes ([#959](https://github.com/diffplug/dormouse/pull/959)).
- 🔌 Closing VS Code shuts terminals down gracefully, and a malformed theme push no longer half-applies ([#983](https://github.com/diffplug/dormouse/pull/983)).
- 🔌 On Windows, remote control between VS Code windows uses an unpredictable pipe name ([#1252](https://github.com/diffplug/dormouse/pull/1252)).
- 🖥️ macOS logout or restart with Dormouse open no longer aborts ([#990](https://github.com/diffplug/dormouse/pull/990)).
- 🖥️ On macOS, Cmd+C/X/V and undo work inside Tool editors through a native Edit menu ([#943](https://github.com/diffplug/dormouse/pull/943)).
- 🖥️ Windows have a minimum size and reopen on screen ([#1058](https://github.com/diffplug/dormouse/pull/1058)).
- 🖥️ Updated rustls for GHSA-2mjx-qc3c-rqvc ([#1073](https://github.com/diffplug/dormouse/pull/1073)).

## [1.2.0] - 2026-10-01
### Added
- **Pairing improvements and phone connections**
  - Connect without an account using a one-time QR link. ([#836](https://github.com/diffplug/dormouse/pull/836), [#865](https://github.com/diffplug/dormouse/pull/865)).
  - Persistent pairing via hosted.dormouse.sh is allowed for beta users ([#512](https://github.com/diffplug/dormouse/pull/512), [#517](https://github.com/diffplug/dormouse/pull/517), [#422](https://github.com/diffplug/dormouse/pull/422), [#458](https://github.com/diffplug/dormouse/pull/458), [#467](https://github.com/diffplug/dormouse/pull/467)).
  - Enroll with Hosted from Settings; persistent Hosted connections and encrypted push delivery are available as an admin-only preview ([#872](https://github.com/diffplug/dormouse/pull/872), [#870](https://github.com/diffplug/dormouse/pull/870)).
- **Dor Tools and local files**
  - Run project-defined Tools with terminal and browser views. Browse files and folders with `dor open`, or reuse one preview pane with `--preview` ([#676](https://github.com/diffplug/dormouse/pull/676), [#835](https://github.com/diffplug/dormouse/pull/835)).
  - Added a built-in VS Code-style text editor and folder browser. ([#851](https://github.com/diffplug/dormouse/pull/851)).
- **Copy preview** — edit selected terminal text before copying ([#885](https://github.com/diffplug/dormouse/pull/885)).
- **Terminal context and agent controls**
  - Inspect commands, directories, notifications, and listening ports; open a helper terminal beside its source and promote it to a pane ([#573](https://github.com/diffplug/dormouse/pull/573), [#768](https://github.com/diffplug/dormouse/pull/768)).
  - Use `dor await` to wait for completion and paced `dor send` input to drive TUIs reliably ([#434](https://github.com/diffplug/dormouse/pull/434), [#689](https://github.com/diffplug/dormouse/pull/689)).
- **Alerts and alarms**
  - Watch commands across terminals, hear spoken alerts, and receive encrypted phone push notifications. Configure delivery delays and per-Workspace overrides ([#325](https://github.com/diffplug/dormouse/pull/325), [#327](https://github.com/diffplug/dormouse/pull/327), [#332](https://github.com/diffplug/dormouse/pull/332), [#667](https://github.com/diffplug/dormouse/pull/667)).
  - Alerts follow user attention and can wait for output to stop, preserving pending alerts without repeating alarms ([#776](https://github.com/diffplug/dormouse/pull/776), [#886](https://github.com/diffplug/dormouse/pull/886)).
- **Pocket improvements** — direct connections from both desktop hosts, edge scrolling with momentum, and more reliable Safari pairing and iOS push ([#613](https://github.com/diffplug/dormouse/pull/613), [#821](https://github.com/diffplug/dormouse/pull/821), [#848](https://github.com/diffplug/dormouse/pull/848), [#854](https://github.com/diffplug/dormouse/pull/854), [#629](https://github.com/diffplug/dormouse/pull/629), [#338](https://github.com/diffplug/dormouse/pull/338)).
- **Inline images** — display Sixel and iTerm2 images in desktop terminals and Pocket ([#548](https://github.com/diffplug/dormouse/pull/548)).
- 🖥️ **Workspaces and windows**
  - Organize terminals into tabs, transfer Workspaces between windows, or tear one into a new window while processes keep running ([#630](https://github.com/diffplug/dormouse/pull/630)).
  - Move panes between Workspaces by dragging or `dor move`; automatic names reflect the repository and branch, and tab TODO buttons jump to pending work ([#887](https://github.com/diffplug/dormouse/pull/887), [#760](https://github.com/diffplug/dormouse/pull/760), [#787](https://github.com/diffplug/dormouse/pull/787)).

### Changed
- **Agent recovery** — supported agents automatically resume captured conversations after orderly shutdown; cold starts restore layouts and working directories without replaying saved scrollback. Standalone can restart from the app menu or updater ([#391](https://github.com/diffplug/dormouse/pull/391), [#786](https://github.com/diffplug/dormouse/pull/786), [#686](https://github.com/diffplug/dormouse/pull/686)).
- **Browser controls** — use `dor agent-browser` and `dor playwright` in place of `dor ab` and `dor pw`. Update saved Tool renderer names to the full provider names and reopen old automated browser panes. Viewports default to 1440×900, with fixed presets or pane synchronization ([#791](https://github.com/diffplug/dormouse/pull/791), [#833](https://github.com/diffplug/dormouse/pull/833)).
- **Settings and network policy** — search Settings by topic and choose which connections Dormouse opens automatically. New installs start at Nothing; enable a network policy for remote control and automatic desktop update checks. Self-hosting requires a build configured for your Relay ([#792](https://github.com/diffplug/dormouse/pull/792), [#863](https://github.com/diffplug/dormouse/pull/863), [#857](https://github.com/diffplug/dormouse/pull/857)).
- **Rendering** — WebGL terminal text, smoother focus-ring motion, and preserved browser state when panes are minimized ([#326](https://github.com/diffplug/dormouse/pull/326), [#611](https://github.com/diffplug/dormouse/pull/611), [#612](https://github.com/diffplug/dormouse/pull/612)).

### Fixed
- **Security hardening** — safer paste and shell-path handling, authenticated control sockets, and stronger browser-proxy and VS Code message boundaries ([#453](https://github.com/diffplug/dormouse/pull/453), [#432](https://github.com/diffplug/dormouse/pull/432), [#433](https://github.com/diffplug/dormouse/pull/433), [#378](https://github.com/diffplug/dormouse/pull/378)).
- **Browser launches** — use the shell's environment to find provider commands, leave layout and focus intact on failure, and keep viewport resizing synchronized ([#830](https://github.com/diffplug/dormouse/pull/830), [#820](https://github.com/diffplug/dormouse/pull/820), [#788](https://github.com/diffplug/dormouse/pull/788)).
- 🖥️ Fixed the macOS 27 event-loop crash and slow clipboard reads freezing the app; Workspace moves and confirmations no longer lose saved state or act on superseded requests ([#824](https://github.com/diffplug/dormouse/pull/824), [#321](https://github.com/diffplug/dormouse/pull/321), [#888](https://github.com/diffplug/dormouse/pull/888)).

## [1.1.0] - 2026-07-16
### Changed
- Zooming a pane (`z`) now elevates and animates it above the tiled layout and couples it to focus: pressing `z` zooms the pane **and** enters passthrough, and the zoom ends the moment you leave passthrough or focus another pane (rather than staying maximized until you toggle it back). Manual splits (`|` `%` `-` `"`, header split buttons) and Host New Terminal actions now immediately select the new pane and enter passthrough, so building a layout with several splits in a row means re-entering command mode between them; background control-plane creation (`dor split`, `dor ensure`, `dor agent-browser`, `dor iframe`) is unchanged ([#265](https://github.com/diffplug/dormouse/pull/265)).

### Fixed
- 🖥️ zsh no longer writes its command history (`.zsh_history`) into the signed macOS app bundle, which could corrupt the app's code signature and make Gatekeeper refuse to launch it as "damaged"; history now lands in your home directory as it would without Dormouse ([#266](https://github.com/diffplug/dormouse/pull/266)).

## [1.0.1] - 2026-07-14
### Fixed
- 🖥️ CI release artifacts now include the zsh shell-integration files (`.zshenv`, `.zshrc`, `.zprofile`), which `actions/upload-artifact` silently dropped as hidden dotfiles. This is what blocked the standalone v1.0.0 binaries from shipping — hash verification correctly refused the incomplete artifacts — so 1.0.1 is the first standalone release of the 1.0 feature set. The VS Code extension was unaffected ([7ef0f440](https://github.com/diffplug/dormouse/commit/7ef0f440c8631a9616093e1c682b0425b682369a)).

## [1.0.0] - 2026-07-14
### Added
- Added the **`dor` CLI**, staged onto the `PATH` of every Dormouse-launched terminal so you — or a coding agent — can drive the terminal grid from the command line. Surface commands open in the background without stealing focus ([#120](https://github.com/diffplug/dormouse/pull/120), [#212](https://github.com/diffplug/dormouse/pull/212), [#234](https://github.com/diffplug/dormouse/pull/234), [#239](https://github.com/diffplug/dormouse/pull/239), [#240](https://github.com/diffplug/dormouse/pull/240)):
  - `dor split` / `dor ensure` — open a new surface, or reuse-or-launch a command by working directory (with `--restart` to interrupt and re-run in place).
  - `dor list` — one unified surface listing, with `--ports`, `--json`, and filters.
  - `dor send` / `dor read` / `dor kill` — drive input, read the screen, or close a surface, addressed by stable `surface:N` handles.
  - `dor skill` (`--install`) — print the bundled agent skill, or drop a bootstrap stub into your project so a coding agent knows how to use `dor`.
- Added **browser surfaces** — any pane can now host a web view in one of three swappable render modes: an AI-agent-driven browser screencast (`dor agent-browser`), a popped-out browser window, or a proxied iframe that loads pages which normally block framing (`dor iframe`), with back/forward, an editable URL bar, and one-click links to detected local dev servers ([#140](https://github.com/diffplug/dormouse/pull/140), [#143](https://github.com/diffplug/dormouse/pull/143), [#156](https://github.com/diffplug/dormouse/pull/156), [#241](https://github.com/diffplug/dormouse/pull/241)).
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
- `dor` and `dor agent-browser` now work on Windows — spawning `agent-browser` through its `.cmd` shim without hanging on the browser daemon, and on the standalone app `dor` output now appears, its `PATH` survives Git Bash login shells, and `dor --version` / `-v` is accepted ([#188](https://github.com/diffplug/dormouse/pull/188), [#224](https://github.com/diffplug/dormouse/pull/224)).
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
