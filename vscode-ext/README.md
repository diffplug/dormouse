# Dormouse

**So many terminals. Which one needs you?**

Dormouse is a tiling terminal for VS Code, built for running several coding agents, dev servers, and builds at once. It tiles them side by side in one panel, lights up the pane that needs you, and brings your agent conversations back after VS Code restarts.

TODO: image of the Dormouse panel with three coding agents and a dev server tiled side by side, one pane ringing

- **A real tiling layout.** Split, drag, zoom, and minimize panes with the mouse, or drive it all from the keyboard with tmux-style keys.
- **Alerts that find you.** A pane lights up when its program asks for you, when a command finishes while you're elsewhere, or when a coding agent goes quiet — on the pane itself and on the VS Code tab.
- **Agents that survive a reload.** Claude Code, Codex, GitHub Copilot, Antigravity, Warp, and Cursor reopen their conversations after Reload Window.
- **Browsers in the layout.** Open the page your dev server is serving right beside it, and let your agent drive that browser while you watch.
- **A mouse that works.** Select text even inside TUIs that grab the mouse, copy it with or without the hard wraps, and paste screenshots straight into your agent.

Try it in your browser first, nothing to install: [dormouse.sh/playground](https://dormouse.sh/playground).

## Getting started

1. Install Dormouse from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=diffplug.dormouse) or [Open VSX](https://open-vsx.org/extension/diffplug/dormouse). It also works in Cursor, Windsurf, Antigravity, and other VS Code forks.
2. Open the **Dormouse** tab in the Panel, next to Terminal — or run **Dormouse: Focus** from the Command Palette.
3. Click the terminal and start typing.

| Command | What it does |
| --- | --- |
| **Dormouse: Focus** | Show Dormouse in the Panel. |
| **Dormouse: Open in Editor** | Open another Dormouse as an editor tab. Open as many as you like. |
| **Dormouse: New Terminal** | Add a terminal to the Panel's Dormouse. |
| **Dormouse: Select Shell** | Choose the shell new terminals launch, everywhere or for this VS Code workspace only. |

Each Dormouse — the Panel and every editor tab — has its own terminals and its own layout. All of them follow your VS Code color theme as you switch it, and use your editor font.

## Layout

TODO: GIF of splitting a pane, dragging one pane beside another, zooming one, and minimizing one to a door

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
- **A watched command goes quiet.** When its output goes busy and then falls quiet, it has probably finished or is waiting on you. Supported coding agents are watched by default.

Nothing rings in the pane you're actively working in.

**Answering a ring.** Type into the pane and the ring is gone. If you only look — click the pane, or click its door — the ring becomes a **TODO** pill in the pane's header, so an alert you glanced at doesn't vanish without a trace. Typing into the pane, clicking the pill, or pressing `t` in command mode clears it. A ring nobody saw comes back as a TODO after a restart.

**Watching other commands.** Watching is a rule on a command name. Right-click a pane's header and switch on **Watch all `<command>` commands**, and every pane running that command is watched, now and later. Script runners are keyed by script, so watching `pnpm dev` leaves `pnpm test` alone. Remove a rule the same way, or in Settings.

**Shell integration.** Command-exit alerts and watching need to know where each command starts and ends (`OSC 633` / `OSC 133`). Dormouse sets this up automatically for zsh, bash, Git Bash, PowerShell, and WSL, and fish 4 and later report it on their own. In `cmd.exe`, only a program asking for you rings.

**Outside the panel.** While Dormouse is out of view, a ring or TODO still shows on VS Code's own chrome: a badge on the Panel's Dormouse tab, and `🔔` or `[TODO]` on a Dormouse editor tab's title.

**Spoken alarms.** Dormouse can say a ringing pane's name out loud, after a delay, if you haven't answered it. It uses your system voice. Turn it on for everything in **Settings** (the sliders at the right end of the baseboard), or for one Dormouse with the speaker button beside them; right-click that button to choose a voice. A more natural managed voice is planned for [Dormouse Hosted](https://dormouse.sh/hosted).

## Coding agents

Dormouse is built for running several agents at once. For [Claude Code, Codex, GitHub Copilot, Antigravity, Warp, and Cursor](https://dormouse.sh/docs/compatible-agents):

- **They're watched by default**, so a pane rings when its agent stops to wait for you.
- **Their conversations come back.** When VS Code reloads or quits, Dormouse catches the resume command each agent prints as it exits. Next time, each pane reopens in its directory and resumes its conversation. A prompt that was mid-flight isn't resubmitted. Closing a Dormouse editor tab kills its terminals outright, and a crash leaves nothing to resume.
- **Shift+Enter inserts a newline**, the way the agents expect.
- **Pasting a screenshot** saves it to a temporary PNG and pastes the path, so your agent can read the image.
- **They can use Dormouse too.** With [`dor`](#scripting-with-dor), an agent can open panes, keep a dev server running exactly once, and drive a browser pane you're watching.

## Browser panes

TODO: image of a dev server's page in a browser pane, next to the terminal running `pnpm dev`

A browser is just another pane. Right-click a terminal that's serving something, and Dormouse lists the ports its processes are listening on — no `lsof`, no scrolling back to find the URL. Pick a port and choose how to open it:

| Open as | Good for |
| --- | --- |
| **Iframe** | You. Feels native with no lag. `http://` pages only, no logins, and agents can't see it. |
| **agent-browser** or **playwright** | You and your agent. A real Chromium streamed into the pane: any URL, and your agent can read and drive it while you watch. |
| **agent-browser popout** or **playwright popout** | The same browser in a real window, when you need the genuine article. |
| **System browser** | Handing off to your usual browser. |

Dormouse doesn't ship a browser. The streamed panes use the automation CLI you install: `npm i -g agent-browser` or `npm i -g @playwright/cli`.

Every browser pane has a URL bar, back, forward, and reload, and a chip that jumps to the terminal serving a local page. A streamed page renders at a desktop-sized 1440×900 by default, so a narrow pane doesn't squash the layout; switch it to a laptop, tablet, or phone preset, an emulated device, a custom size, or resize-with-pane from its display settings.

Agents open and drive the same panes from the command line:

```sh
dor ensure -- pnpm dev              # created surface:3  "pnpm dev"
dor agent-browser open surface:3    # open whatever port surface:3 is serving
dor agent-browser snapshot          # read the page...
dor agent-browser click @e3         # ...and click through it
```

## Terminal context

TODO: image of the terminal context panel open beside a pane, showing its ports and helper terminal

Right-click a pane's header, or press `>` in command mode, to see everything about that terminal in one panel:

- **Why its title says what it says**, and its `surface:N` handle for `dor`.
- **Its directory**, to open in Finder or Explorer, or to copy.
- **The ports it's listening on**, each one click from a browser pane.
- **Its Watch and TODO switches.**
- **A helper terminal**: a scratch shell in the same directory that runs `git status` as it opens. Change or turn off that command with **Modify**, or **Promote** the helper into a pane of its own.

## Mouse, selection, and clipboard

TODO: GIF of overriding a TUI's mouse capture, selecting wrapped text, and choosing Copy Rewrapped

- **Select inside TUIs.** When a program such as `htop` or `vim` grabs the mouse, a mouse icon appears in the pane's header. Click it to take the mouse back for one drag, or make the override sticky.
- **Copy what you meant.** After a selection, **Copy Raw** keeps the lines exactly as drawn. **Copy Rewrapped** strips box-drawing borders and joins wrapped lines back into the text the program printed.
- **Block selection**: hold `Alt` (`Option` on a Mac) while dragging.
- **Grab a whole URL or path**: press `e` mid-drag.
- **Paste safely.** Pasted text can't break out of a program's bracketed paste. Copied files paste as paths quoted for the pane's shell, and images paste as the path to a temporary PNG.
- **Follow links with care.** Hyperlinks printed by programs (`OSC 8`) are clickable. A confirmation shows where each one really goes, and a link whose text names a different site gets no open button at all.

Dormouse also renders inline images (Sixel, iTerm2 inline images, and partial Kitty graphics), draws on the GPU with WebGL, and answers color queries so TUIs pick the right palette for a light or dark theme.

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
| `a` | Dismiss the ring and open terminal context |
| `>` | Open terminal context |
| `Enter` | Start typing in the selected pane, or reattach the selected door |

For tmux hands, `%`, `"`, `x`, `d`, `z`, `,`, and the arrows do what they do in tmux, with the Shift tap in place of the prefix key.

Copy and paste work in both modes: `⌘C` / `Ctrl+C` copies raw, `⌘⇧C` / `Ctrl+Shift+C` copies rewrapped, and `⌘V` / `Ctrl+V` pastes, with or without Shift. With nothing selected, `Ctrl+C` still interrupts the running program. VS Code's own `⌘P` / `Ctrl+P`, `⌘⇧P` / `Ctrl+Shift+P`, `F1`, and `⌘B` / `Ctrl+B` keep working from inside a terminal.

The complete table is the [keyboard shortcut reference](https://github.com/diffplug/dormouse/blob/main/docs/specs/shortcuts.md).

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

## Phone control (in development)

Dormouse Pocket puts your terminals on your phone: pick a pane, read it, type into it, and get a push notification when one needs you while you're away. Sessions are end-to-end encrypted between your phone and your computer. Today Pocket needs a self-hosted Relay and a Dormouse built from source; [Dormouse Hosted](https://dormouse.sh/hosted) will run the Relay for you. You can try the phone interface in your browser at [dormouse.sh/playground/pocket](https://dormouse.sh/playground/pocket).

## Standalone app

The same terminal is also a desktop app for macOS, Windows, and Linux, with workspace tabs named after their repo and branch, a theme picker, and automatic updates. Download it from [dormouse.sh](https://dormouse.sh/#download).

## Links

- [Playground](https://dormouse.sh/playground) — the real interface in your browser
- [Changelog](https://dormouse.sh/changelog)
- [Report an issue](https://github.com/diffplug/dormouse/issues)
- [Source on GitHub](https://github.com/diffplug/dormouse)
- [Security](https://dormouse.sh/docs/security) and [supply chain](https://dormouse.sh/supply-chain)
- Brought to you by [DiffPlug](https://www.diffplug.com/)
