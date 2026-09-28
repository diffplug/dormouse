# Dormouse

**So many terminals. Which ones need attention?** A dormouse knows when to wake.

Dormouse is a multitasking terminal for mice and thumbs (and hotkey wizards too). It tiles your terminals and browsers side by side inside VS Code, and lights up the one that needs you.

TODO: hero image of the Dormouse panel with a few coding agents and a dev server tiled side by side, one pane ringing

- **Tmux with browsers.** A real tiling layout for terminals and browser panes. Do it all with the mouse, or keep your hands on tmux keybinds.
- **It knows which terminal needs you.** A pane lights up when its program asks for you, when a command finishes while you're away, or when a coding agent goes quiet.
- **Push notifications you can self-host** (in development). When you've walked away, Dormouse Pocket buzzes your phone, and one drag answers the prompt.
- **Terminals that know their ports.** Right-click a pane to see what it's serving, and open it in the pane next door.
- **Browsers for you (and your agents).** Your agent drives the same browser pane you're watching.
- **Select and copy-paste like you meant.** Even inside TUIs that grab the mouse.

Try it in your browser first, nothing to install: [dormouse.sh/playground](https://dormouse.sh/playground).

## Tmux with browsers

TODO: GIF of splitting, dragging, zooming, and minimizing panes (the homepage's tmux video would do)

Soft as a mouse, sharp as a tmux. Terminals and browsers tile side by side in VS Code's Panel or in editor tabs. Do it all with the mouse, or keep your hands on the keyboard with [tmux keybinds](#keyboard-shortcuts). Dormouse follows your VS Code theme exactly, so it's hard to tell it isn't built in.

- **Split** with the buttons in a pane's header, or with `|` and `-` in [command mode](#keyboard-shortcuts). The new pane opens in the same directory as the one you split.
- **Resize** by dragging the gap between panes.
- **Rearrange** by dragging a pane by its header. Drop it on the middle of another pane to swap the two, or on an edge to split beside it. Scroll while dragging to drop beside a whole row or column instead.
- **Zoom** a pane to lift it above the layout while you work in it. It settles back as soon as you move to another pane.
- **Minimize** a pane to a **door** on the baseboard, the strip along the bottom. It keeps running and keeps showing its alerts. Click the door to put the pane back where it was, or drag the door anywhere in the layout.
- **Titles name themselves** after the running command, or when the shell is idle, the last command, marked `✗` if it failed. Click a title to rename it.

## Alerts

TODO: image of a ringing pane with its alarm outline, beside a pane showing a TODO pill in its header

A pane **rings** — outlined and washed in the alarm color — when it needs you:

- **A program asks for you.** Any tool that sends a terminal bell or a standard notification (`BEL`, `OSC 9`, `OSC 99`, `OSC 777`, or the end of an `OSC 9;4` progress bar) rings its pane. No setup.
- **A command you started finishes while you're elsewhere.** No setup, and no minimum runtime.
- **A watched command goes quiet.** When its output goes busy and then falls quiet, it has probably finished or is waiting on you. [Supported coding agents](#coding-agents) are watched by default.

Nothing rings in the pane you're actively working in.

**Answering a ring.** Type into the pane and the ring is gone. If you only look — click the pane, or click its door — the ring becomes a **TODO** pill in the pane's header, so an alert you glanced at doesn't vanish without a trace. Typing into the pane, clicking the pill, or pressing `t` in command mode clears it. A ring nobody saw comes back as a TODO after a restart.

**Watching other commands.** Watching is a rule on a command name. Right-click a pane's header and switch on **Watch all `<command>` commands**, and every pane running that command is watched, now and later. Script runners are keyed by script, so watching `pnpm dev` leaves `pnpm test` alone. Remove a rule the same way, or in Settings.

**Shell integration.** Command-exit alerts and watching need to know where each command starts and ends (`OSC 633` / `OSC 133`). Dormouse sets this up automatically for zsh, bash, Git Bash, PowerShell, and WSL, and fish 4 and later report it on their own. In `cmd.exe`, only a program asking for you rings.

**Outside the panel.** While Dormouse is out of view, a ring or TODO still shows on VS Code's own chrome: a badge on the Panel's Dormouse tab, and `🔔` or `[TODO]` on a Dormouse editor tab's title.

**Spoken alarms.** Dormouse can say a ringing pane's name out loud, after a delay, if you haven't answered it. It uses your system voice. Turn it on for everything in **Settings** (the sliders at the right end of the baseboard), or for one Dormouse with the speaker button beside them; right-click that button to choose a voice.

## Push notifications you can self-host

TODO: image of Dormouse Pocket on a phone, showing a pane waiting on a permission prompt with the radial menu open (the homepage's phone mockup would do)

Your agent hits a permission prompt four minutes after you leave, then sits there until you get back. Dormouse already knows that pane is asking for a human, so Dormouse Pocket buzzes your phone: a real push notification, to an app that's completely closed. Tap the terminal and a radial menu opens under your thumb. One drag sends `y`, `n`, Esc, or Ctrl+C, and the agent's moving again.

The Relay between your phone and your computer is yours: one Node process with no database, behind `tailscale serve`, with no Dormouse account and no Dormouse-operated cloud. Your computer decides which phones get notified, not the Relay. Sessions are end-to-end encrypted between the two devices, and move off the Relay onto a direct connection whenever they can reach each other on your network or tailnet. The [self-host runbook](https://dormouse.sh/docs/self-host) walks the whole install.

**Pocket is in development.** Today the extension reaches a self-hosted Relay only when built from source. Try the phone interface in your browser at [dormouse.sh/playground/pocket](https://dormouse.sh/playground/pocket), or skip running a Relay with [Dormouse Hosted](#dormouse-hosted) once it launches.

## Terminals that know their ports

TODO: image of the right-click panel beside a pane, listing the ports it's listening on and its helper terminal

Six panes running and something's serving `:3000`. Which one? Right-click a pane and Dormouse lists the ports that pane's processes are actually listening on. Pick one to open it in a browser pane — no `lsof`, no scrolling back to find where Vite printed the URL.

The same panel (press `>` in command mode) also shows why the pane's title says what it says, its directory (to open in Finder or Explorer, or to copy), its Watch and TODO switches, and a **helper terminal**: a scratch shell in the same directory that runs `git status` as it opens. Change that command with **Modify**, or **Promote** the helper into a pane of its own.

## Browsers for you (and your agents)

TODO: image of a dev server's page in a browser pane, next to the terminal running `pnpm dev`

A browser is just another pane. Park your dev server next to the terminal that's running it — same tiling layout, same keybinds, no alt-tab and no second monitor.

```sh
dor ensure -- pnpm dev              # created surface:3  "pnpm dev"
dor agent-browser open surface:3    # open whatever port surface:3 is serving
dor agent-browser snapshot          # read the page...
dor agent-browser click @e3         # ...and click through it
```

Your agents run the same commands, so when an agent wants to see what it just built, it opens a pane you're already watching. Every other argument goes to your agent-browser; the [`dor agent-browser` reference](https://dormouse.sh/docs/dor#agent-browser) covers `--key`, `--surface`, and viewport sizing.

| Open as | Good for |
| --- | --- |
| **agent-browser** or **playwright** | You and your agent. A real Chromium streamed into the pane: any URL, and your agent can read and drive it while you watch. |
| **agent-browser popout** or **playwright popout** | The same browser in a real window, when you need the real thing. |
| **Iframe** | You. Feels native with no lag. `http://` pages only, no logins, and agents can't see it. |
| **System browser** | Handing off to your usual browser. |

Dormouse doesn't ship a browser of its own: it drives the agent-browser or Playwright CLI you already have (`npm i -g agent-browser` or `npm i -g @playwright/cli`). Every browser pane has a URL bar, back, forward, and reload, and a chip that jumps to the terminal serving a local page. A streamed page renders at a desktop-sized 1440×900 by default, so a narrow pane doesn't squash it; switch to a laptop, tablet, or phone preset, an emulated device, a custom size, or resize-with-pane from its display settings.

## Select and copy-paste like you meant

TODO: GIF of overriding a TUI's mouse capture, selecting wrapped text, and choosing Copy Rewrapped (the homepage's copy-paste video would do)

Click and drag in a "mouse conformant" terminal doesn't select text; it fires an escape code at whatever's running. Dormouse notices when a TUI has grabbed the mouse and puts a one-click override in the pane's header, so you can just select the thing.

Then copy it the way you meant it. **Copy Raw** keeps the hard wraps; **Copy Rewrapped** joins them back into the line the program actually printed, and strips box-drawing borders on the way. Press `e` mid-drag to snap the selection out to the whole URL or file path, and hold `Alt` (`Option` on a Mac) for a block selection.

Paste is safe too. Pasted text can't break out of a program's bracketed paste, copied files paste as paths quoted for the pane's shell, and a screenshot pastes as the path to a temporary PNG, ready for your agent to read. Hyperlinks printed by programs (`OSC 8`) are clickable; a confirmation shows where each one really goes, and a link whose text names a different site gets no open button at all.

Dormouse also renders inline images (Sixel, iTerm2 inline images, and partial Kitty graphics), draws on the GPU with WebGL, and answers color queries so TUIs pick the right palette for a light or dark theme.

## Getting started

1. Install Dormouse from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=diffplug.dormouse) or [Open VSX](https://open-vsx.org/extension/diffplug/dormouse). It also works in Cursor, Windsurf, Antigravity, and any other VS Code fork.
2. Open the **Dormouse** tab in the Panel, next to Terminal — or run **Dormouse: Focus** from the Command Palette.
3. Click the terminal and start typing.

| Command | What it does |
| --- | --- |
| **Dormouse: Focus** | Show Dormouse in the Panel. |
| **Dormouse: Open in Editor** | Open another Dormouse as an editor tab. Open as many as you like. |
| **Dormouse: New Terminal** | Add a terminal to the Panel's Dormouse. |
| **Dormouse: Select Shell** | Choose the shell new terminals launch, everywhere or for this VS Code workspace only. |

Each Dormouse — the Panel and every editor tab — has its own terminals and its own layout, and uses your editor font.

## Keyboard shortcuts

Dormouse has two modes. In **passthrough**, keys go to the terminal. In **command** mode, keys drive the layout, and the selected pane is outlined in marching ants. Tap **Left Shift, then Right Shift** (or Left ⌘, then Right ⌘ on a Mac) to enter command mode. Press `Enter` or click a pane to go back to typing.

| Key | Action |
| --- | --- |
| `\|` or `%` | Split left/right |
| `-` or `"` | Split top/bottom |
| Arrows | Move between panes; down from the bottom row reaches the doors |
| `⌘` or `Ctrl` + arrows | Swap with the neighboring pane |
| `z` | Zoom the pane and start typing in it |
| `m` or `d` | Minimize to a door, or reattach the selected door |
| `k` or `x` | Kill (type the letter shown to confirm) |
| `,` | Rename |
| `t` | Toggle the TODO |
| `a` | Dismiss the ring and open the pane's right-click panel |
| `>` | Open the pane's right-click panel |
| `Enter` | Start typing in the selected pane, or reattach the selected door |

For tmux hands, `%`, `"`, `x`, `d`, `z`, `,`, and the arrows do what they do in tmux, with the Shift tap in place of the prefix key.

Copy and paste work in both modes: `⌘C` / `Ctrl+C` copies raw, `⌘⇧C` / `Ctrl+Shift+C` copies rewrapped, and `⌘V` / `Ctrl+V` pastes, with or without Shift. With nothing selected, `Ctrl+C` still interrupts the running program. VS Code's own `⌘P` / `Ctrl+P`, `⌘⇧P` / `Ctrl+Shift+P`, `F1`, and `⌘B` / `Ctrl+B` keep working from inside a terminal.

The complete table is the [keyboard shortcut reference](https://github.com/diffplug/dormouse/blob/main/docs/specs/shortcuts.md).

## Coding agents

For [Claude Code, Codex, GitHub Copilot, Antigravity, Warp, and Cursor](https://dormouse.sh/docs/compatible-agents):

- **They're watched by default**, so a pane rings when its agent stops to wait for you.
- **Their conversations come back.** When VS Code reloads or quits, Dormouse catches the resume command each agent prints as it exits. Next time, each pane reopens in its directory and resumes its conversation. A prompt that was mid-flight isn't resubmitted. Closing a Dormouse editor tab kills its terminals outright, and a crash leaves nothing to resume.
- **Shift+Enter inserts a newline**, the way the agents expect.
- **They can use Dormouse too.** With [`dor`](#scripting-with-dor), an agent can open panes, keep a dev server running exactly once, and drive a browser pane you're watching.

## Scripting with dor

Every terminal Dormouse opens has `dor` on its `PATH`, a small CLI that lets scripts and agents drive the layout:

```sh
dor list                                          # every pane, with its surface:N handle
dor ensure -- pnpm dev                            # start it once; reuse the pane if it's already running
dor split -- codex                                # open a new pane running a command
dor send surface:4 --text "/review" --key enter   # type into a pane
dor await surface:4 --until quiet                 # wait until it finishes...
dor read surface:4                                # ...then read its screen
```

`dor ensure` and `dor split -- <command>` work in the background and never steal your focus.

`dor skill --install` adds a short block to your project's `AGENTS.md` or `CLAUDE.md` that teaches your agent to use Dormouse. It does nothing when the agent runs outside Dormouse, so it's safe to commit.

- [The `dor` CLI reference](https://dormouse.sh/docs/dor)
- [The bundled agent skill](https://dormouse.sh/docs/agent-skill)

## What survives a reload

| When you… | Your terminals | Your layout |
| --- | --- | --- |
| Hide the Panel or switch editor tabs | Keep running | Unchanged |
| Close the Dormouse view | Keep running, and their output replays when you reopen it | Unchanged |
| Reload Window or quit VS Code | Shells start fresh in their old directories, supported agents resume their conversations, and other programs end | Restored, with doors, titles, TODOs, and browser panes |
| Close a Dormouse editor tab | Killed | Gone |

Scrollback isn't saved.

## Dormouse Hosted

Dormouse, with less to run yourself. Keep Dormouse free and local, and pay only if you want the Relay operated for you or a more natural voice for spoken alarms. Both are coming soon:

- **Managed remote control.** Use Pocket without deploying and maintaining a Relay. Your terminals still run on your computer.
- **ElevenLabs voice.** A managed natural voice for spoken alarms, while your browser and system voices stay available.

[Compare the planned services and follow the launch](https://dormouse.sh/hosted).

## Standalone app

Don't settle for your operating system's built-in terminal. Get a nice one. The same terminal is a Tauri desktop app for macOS, Windows, and Linux that starts in a blink, with workspace tabs named after their repo and branch, a theme picker, and automatic updates. Download it from [dormouse.sh](https://dormouse.sh/#download).

## Links

- [Playground](https://dormouse.sh/playground) — the real interface in your browser
- [Changelog](https://dormouse.sh/changelog)
- [Report an issue](https://github.com/diffplug/dormouse/issues)
- [Source on GitHub](https://github.com/diffplug/dormouse)
- [Security](https://dormouse.sh/docs/security) and [supply chain](https://dormouse.sh/supply-chain)
- Brought to you by [DiffPlug](https://www.diffplug.com/)
