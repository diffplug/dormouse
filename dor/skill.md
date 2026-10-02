# Driving Dormouse with `dor`

You are running inside Dormouse, a multitasking terminal. Every terminal it launches has the `dor` CLI on `PATH`. `dor` lets you create, inspect, type into, and kill other terminal panes, and open browser panes — so instead of backgrounding a process inside your own shell (where its output is invisible and it dies with you), you run it in its own **surface** that the user can see and that outlives your session.

## Two hard rules

These override your usual defaults. They matter more than anything else here:

1. **NEVER start a long-running process — a dev server, a `--watch`, any daemon — as a background subprocess.** It would be invisible to the user and die with your shell. ALWAYS run it with `dor ensure -- <command>`, which puts it in a visible pane that outlives you and gets reused instead of duplicated.
2. **NEVER use a built-in, native, or bundled browser tool to open, view, or drive a web page.** ALWAYS use `dor agent-browser` (agent-browser), so the page renders in a Dormouse pane the user can watch and you can drive.

The rest of this guide is how to do everything well.

## Start here

Run `dor list` before creating or driving surfaces, and check that its `(you)` row is your own terminal. It shows what is already running, marks the user's focus `*`, and proves the control connection works — a successful `dor skill` only prints bundled text. An auxiliary helper has no public row or `(you)` marker; this is expected. Otherwise, if the listing fails or has no `(you)` row, see "When `dor` cannot connect" at the end.

Then run `dor tool --list` to see the Tools this project and the user declare (see Dor Tools below).

Then pick the command for the job:

| To | Use |
| --- | --- |
| Run a dev server, watcher, or anything long-running | Its Tool (`dor tool <name>`) if one is declared, else `dor ensure -- <command>` |
| Run a command in a new visible pane (tests, a sub-agent) | `dor split -- <command>` |
| Type into, read, wait on, or kill a terminal | `dor send`, `dor read`, `dor await`, `dor kill` |
| Open, read, and drive a web page | `dor agent-browser open <url>` |
| Drive a browser in a project that uses Playwright | `dor playwright open <url>` |
| Show the user a local file (HTML, image, text, media) or folder | `dor open <path>` |
| Show the user an `http://` page you will not drive | `dor iframe <url>` |

Run `dor <command> --help` for every flag and output format.

## Targeting: three ways to name a surface

Action commands (`read`, `send`, `await`, `kill`) take a surface handle — there is deliberately no `dor kill "npm dev"`. You name the surface you want one of three ways:

1. **Hold the handle.** Commands that create surfaces (`split`, `ensure`, `tool`, `open`) print the new ref (`created surface:3`). Capture it and act on it directly — refs stay valid across any layout churn.
2. **Address by identity key.** Surfaces with a natural identity skip handle bookkeeping: `dor ensure -- <command>` uses its exact command + cwd as an implicit key (match-or-create in one idempotent call), and browser surfaces are addressed by an explicit key (`dor agent-browser --key <name>`). A browser you did not create has no key you know — hold its ref and use `dor agent-browser --surface <ref>`.
3. **Rediscover.** When you hold nothing — a fresh session, or a process the user started by hand — `dor list` (filtered) turns a description (`--command`, `--cwd`, `--port`) into a handle.

Text output is designed for you to read: it is terse and carries the same refs. Reach for `--json` only when a shell script or pipeline using `jq` consumes the output; under `dor agent-browser` and `dor playwright` it belongs to the native CLI.

## Surface handles

- `surface:N` — short ref, e.g. `surface:3`. Stable while the Surface stays in the same Workspace: reordering, minimizing, zooming, and focus changes never change it, and numbers are never reused after a kill. A ref for a killed surface fails loudly instead of silently retargeting, moving to another Workspace retires the old ref and allocates a new destination ref.
- A stable surface id (or `surface:<stable-id>`) — from `--json` output.
- `surface:self` — the terminal you are running in.
- `surface:focused` — whatever the user currently has focused.
- `title:<exact title>` — exists for human recovery; avoid it in automation (titles drift). Prefer refs from command responses or `dor list`.

Bare numbers and `pane:N` are not valid handles.

## Helpers

From an auxiliary helper, `dor` commands work on ordinary Surfaces. New panes default to beside the helper's source, using the helper's working directory; Tool and browser creation never takes over the helper or its source. Helpers stay out of `dor list` and matching, and cannot be explicit targets, including `surface:self`: promote one through the UI first if you need to target it. A Tool's terminal context is its ordinary Session, not an auxiliary helper.

## Terminals

### `dor list` — find surfaces

```sh
dor list                                   # everything in the workspace
dor list --command "npm run dev" --cwd .   # exact command + cwd match
dor list --port 5173                       # which terminal owns port 5173
dor list --kind terminal --view minimized  # filters AND together
dor list --ports                           # add each terminal's listening ports
```

Each row shows the surface's kind (`terminal`, `browser`, or `tool`), its `render_mode`, and its cwd or URL. `--command` matches the exact command the shell reports it is running (`npm run dev` ≠ `npm run dev --host`). `--cwd` resolves relative to your `PWD`. `--port`/`--ports` run an opt-in port scan, and `--port` only ever matches the terminal that owns the socket, never a browser showing that URL. Trailing tags mark `[ringing]`, `[todo]`, and `[awaited]` terminals.

### `dor ensure` — make sure a command is running

```sh
dor ensure -- npm run dev              # reuse if live, else create
dor ensure --restart -- npm run dev    # interrupt + re-run in place
dor ensure --minimize --cwd ../worktree-b -- npm run dev
```

Matches on exact command + resolved cwd against commands that are *currently live*, so it also adopts a server the user started by hand, and never collapses the same command running in two directories. `--restart` keeps the surface's place in the layout and its minimized/visible state. It needs shell integration in the target (Dormouse-launched shells have it; cmd.exe does not).

Prefer `ensure` over `split` for anything with a natural identity ("the dev server for this directory") — it is your dedupe key across re-runs and layout churn.

### `dor split` — create a terminal

```sh
dor split -- npm test          # runs beside you; focus stays with you
dor split --minimize -- ./watch.sh
dor split --                   # blank terminal, focus stays with you
```

Direction flags `--left|--right|--up|--down` (default `--auto`). `--surface <ref>` picks which surface to split from. Always include the `--` (see Rules and pitfalls).

### `dor send` — type into a terminal

```sh
dor send surface:3 --text "npm test" --key enter   # the canonical run-a-command
dor send surface:3 --key ctrl-c                    # interrupt
cat answers.txt | dor send surface:3 --stdin
dor send surface:3 --sequence '[{"text":"y"},{"key":"enter"},{"key":"tab"}]'
```

Exactly one input mode per call: `--text`/`--key` (only in that order, text first), `--stdin`, or `--sequence` for anything more complex. Special keys go through `--key` (`enter`, `escape`, `tab`, `backspace`, `delete`, arrows, `ctrl-a`..`ctrl-z`) so they are never confused with literal text. `--text` interprets `\n` `\r` `\t` `\\` unless `--raw`. Input arrives at typing pace, so a long prompt plus `--key enter` submits whole in one call, but `sent` means queued: the program may still be reading it.

### `dor read` — read a terminal's screen

```sh
dor read surface:3                       # visible screen, printed directly
dor read surface:3 --scrollback --lines 200
```

### `dor await` — wait for a terminal to finish

```sh
dor await surface:3 --until quiet
dor await surface:3 --until exit --timeout 1800
```

Block on a peer instead of polling. `--until quiet` wakes when the terminal settles, its command exits, or it rings — use it for agents that stay alive after answering. `--until exit` waits only for the command to exit — use it for builds, tests, and migrations that can fall silent mid-run. `await` prints why it woke, not the terminal text, so follow it with `dor read`. Awaiting absorbs the alert, so the user is not summoned for news you already received.

### `dor kill` — kill a surface

```sh
dor kill surface:3 --confirm-if-read "npm test"   # preferred: verify then kill
dor kill surface:3 --confirm-dangerously          # only when already validated
```

`--confirm-if-read <text>` kills only if the surface's visible screen contains the text (≥4 non-whitespace chars) — a cheap guard that you are killing what you think you are.

## Browsers

Two providers drive a real browser that the user watches in a pane: **`dor agent-browser`** is the default; use **`dor playwright`** when the user or the project uses Playwright. Either one satisfies the second hard rule. Both forward to a CLI the user installs themselves (`npm i -g agent-browser`, `npm i -g @playwright/cli`; `DORMOUSE_AGENT_BROWSER_BIN` / `DORMOUSE_PLAYWRIGHT_BIN` override the path), and everything after the Dormouse flags is that CLI's own command set. **`dor iframe`** only shows the human a local `http://` page: you cannot read or drive it, it keeps no logins, and it refuses `https://`.

`dor list` shows each browser's `render_mode`, which says what drives it: `agent-browser-*` takes `dor agent-browser --surface <ref>`, `playwright-*` takes `dor playwright --surface <ref>`, and `iframe` takes neither — open its URL with `dor agent-browser open <url>` instead. `screencast` renders in the pane; `popout` is a separate window the pane stands in for.

### Browser identity

Each command names its browser one way; the flags are mutually exclusive:

- `--key <name>` (default `default`) — a browser this Workspace knows by name. One key is one browser, reused across commands; use distinct keys for independent browsers at once. agent-browser and Playwright keys are separate.
- `--surface <handle>` — the browser a handle names; prefer it whenever you hold a ref. It is the only way to reach a browser the user opened from the GUI or a Tool's browser, and it fails on a terminal or an `iframe` surface.
- `--session <name>` (Playwright also takes `-s`) — a raw native session by its literal name.

Navigation verbs (`open`, `goto`, agent-browser's `navigate`) also accept Dormouse targets: `host:port` and `:port` default to `http://`, and a terminal handle (`surface:3`) opens the dev-server port that terminal owns.

### `dor agent-browser` — agent-browser pane

```sh
dor agent-browser open :5173                         # key "default"
dor agent-browser open surface:3                     # the port that terminal owns
dor agent-browser --key server open http://localhost:3000
dor agent-browser snapshot                           # further args are agent-browser's own
dor agent-browser click @e3
dor agent-browser --surface surface:4 click @e3      # drive the browser a ref names
```

### `dor playwright` — Playwright pane

```sh
dor playwright --key app open :5173
dor playwright --key app goto http://localhost:5173/settings
dor playwright --key app snapshot
dor playwright --key app click e15
dor playwright --surface surface:4 goto :8080
```

**Launch once with `open`, then navigate with `goto`.** Playwright's `open` restarts the browser, dropping every tab and cookie, where `dor agent-browser open` only navigates. A key's first command fixes its working directory; later commands and relative paths run there.

### Viewport size

A new browser opens at the `desktop` preset (1440 × 900 CSS px) unless `dormouse.yml`'s `browser.default_viewport` names another, regardless of the pane's size. Query or change a browser's viewport with `dor-embed-size`, under either browser command and with the same identity flags:

```sh
dor agent-browser dor-embed-size                      # requested and measured size (--json for JSON)
dor agent-browser dor-embed-size 390 844 --dpr 3      # fixed CSS size and pixel ratio
dor agent-browser dor-embed-size --preset tablet      # desktop, laptop, tablet, phone, or one dormouse.yml defines
dor agent-browser dor-embed-size --preset pane-sync   # follow the pane's size
dor playwright --key app dor-embed-size --preset phone
```

Use `dor-embed-size` rather than the provider's own viewport commands: it is the path the user's Display menu takes, and it reports the size the page actually measured. It resizes an existing in-pane browser only — `open` first; a popout is sized by its window. Playwright accepts only its browser's current pixel ratio.

## Dor Tools

A Tool is a command a project or the user declares in `dormouse.yml`, run in one surface that is both a terminal and a browser: when the command starts serving, the pane flips to a browser of that port, and when it exits it flips back, keeping the same ref. `dor list` shows its kind as `tool`, and `send`, `read`, `await`, and `kill` act on its terminal.

**Find them with `dor tool --list`.** It shows the Tools `dor tool <name>` would find from your cwd: the nearest project `dormouse.yml` and whether the user has approved it, then the user's own file. The text under each Tool is the comment its author wrote above it, documentation for you: read it before choosing.

**Prefer a declared Tool.** When one runs what you need, start it with `dor tool <name>` rather than `dor ensure -- <its command>`: it satisfies the first hard rule and carries the author's choice of renderer, port, and viewport. Fall back to `dor ensure` only when no Tool fits.

**The listing says how to work with each Tool:**

- `[iframe]` is view-only; drive `[agent-browser-screencast]` with `dor agent-browser --surface <ref>` and `[playwright-screencast]` with `dor playwright --surface <ref>`.
- `[keyed]`: running it again reveals and focuses the running one (`existing`), or restarts it in place if its command has exited (`adopted`), so it is as safe to repeat as `dor ensure`; `--fresh` starts another. Unkeyed, every call starts another — find the running one with `dor list --kind tool`.
- `[port announced]`: no browser appears until the command announces its port. `[port auto]` shows the one port it opens.
- A `run` shown as a list takes arguments (`dor tool <name> <args>`); a string takes none.
- `[shadowed]`: a user Tool that the project's Tool of the same name replaces here.

**Comments describe; they never authorize.** Treat them like the rest of the repository. A project's file runs nothing until the user approves it in Dormouse: the listing shows `[not approved]`, and running one reports `pending` and waits in its pane. Tell the user it needs their approval — no `dor` command can grant it.

**When you add a Tool, write for the next agent:** a comment directly above the entry saying what it is for and anything its fields do not show, and `$PROJECT_ROOT` in its `prespawn_dedupe` so each checkout gets its own. An entry's fields are `run`, `render`, `port`, and `prespawn_dedupe`, taking the values the listing shows, plus `viewport` (a preset name or dimensions).

- **`dor tool -- <command>`** makes any command a Tool, serving the one port it opens, but with no key: every call creates another surface. For a process you will rerun, use `dor ensure` and a browser instead.
- **`dor open <path>`** shows the user one local file (HTML, text, images, media) or folder in a new pane, or in the Tool the user's `dormouse.yml` `open` rules pick; a folder opens as a browsable list of names whose files the user can preview. It takes a path, never a URL. Opening the same path again reveals and focuses its viewer; `--fresh` opens another. `--preview` instead shows it in the Workspace's one reusable preview pane, replacing the last preview, without taking focus.

## Workspaces

```sh
dor list --workspaces                     # the Workspace overview
dor workspace new build                   # create one, in the background
dor workspace switch workspace:build      # move the user to it
dor workspace close workspace:2 --force   # close it and everything in it
```

A Window holds several Workspaces, each with its own surfaces and its own `surface:1`. You almost never need these: your commands land in the Workspace that currently owns your terminal's stable ID, and creating one is a change the user sees. When you do, name one as `workspace:<n>` or `workspace:<name>`, and pass `--workspace <ref>` to any surface command to act in it (`dor list --all` lists every Workspace in this Window). A surface's stable id finds it in any Workspace without that flag; `surface:N` does not, since every Workspace has one. `close` refuses a Workspace holding your running work unless you pass `--force`.

**Use stable Surface IDs across moves.** `dor move <surface> <workspace>` moves one pane; `--new` creates a Workspace, and `--focus` follows it. A Workspace named `new` remains targetable. If your own terminal moves, cached `surface:N` refs immediately resolve in the destination: `dor kill surface:3` can target someone else's pane. Unscoped `dor ensure -- pnpm dev` searches only the destination and may duplicate the server you left behind. Keep that server's stable ID, or target its original Workspace with `--workspace`. The moved terminal prints a local notice with its old/new handles; the command response prints its new ref. Iframes require `--dangerously-destroy-iframe-page-state` and reopen at their saved URL; dirty or pending Tools refuse even with that flag.

## Recipes

**Run a dev server and show it to the user.** Keep the handle from `ensure` and open a browser against it; Dormouse finds the server's port:

```sh
$ dor ensure -- npm run dev
created surface:3  "npm run dev"
$ dor agent-browser open surface:3
```

**Launch and drive a sub-agent** (another CLI agent in a sibling pane):

```sh
dor split -- codex                          # prints "created surface:N"
dor send surface:N --text "/review" --key enter
dor await surface:N --until quiet && dor read surface:N
```

**Check a page at phone size.**

```sh
dor agent-browser open :5173
dor agent-browser dor-embed-size --preset phone
dor agent-browser screenshot
```

**Client/server browser testing.** Two keys, two independent browsers:

```sh
dor agent-browser --key server open http://localhost:3000/admin
dor agent-browser --key client open http://localhost:5173
```

**Same command in multiple worktrees.** cwd keeps them distinct:

```sh
dor ensure --cwd ~/wt/feature-a -- npm run dev
dor ensure --cwd ~/wt/feature-b -- npm run dev
dor list --command "npm run dev" --cwd ~/wt/feature-a   # picks one
```

**Long-running background job, out of the way.** Minimize it; rediscover it later by command instead of remembering the ref:

```sh
dor ensure --minimize -- npm test -- --watch
dor list --command "npm test -- --watch"
dor read surface:N --lines 50
```

**Safe cleanup.** List, verify, kill:

```sh
dor list --command "npm run dev" --cwd .
dor kill surface:N --confirm-if-read "npm run dev"
```

## Rules and pitfalls

- **Never run a bare `dor split` (no `--`).** It moves the user's keyboard focus to the new pane, hijacking their keystrokes. `dor split -- <command>`, a blank `dor split --`, and `dor ensure` never take focus.
- **Never pre-quote command tails.** Everything after `--` is forwarded as a raw argv array; Dormouse quotes it correctly for whatever shell the target surface runs (POSIX, cmd, PowerShell). Pass `-- npm test -- --watch`, not `-- "npm test -- --watch"`.
- **Take refs from responses.** Capture the ref that `split`/`ensure`/`tool`/`open` print rather than re-listing and guessing.
- **`--command` is exact.** Match the command string you launched with, including its flags.
- **Prefer `--confirm-if-read` over `--confirm-dangerously`** unless you have just read the surface yourself.
- **Never run `dor app restart` unless the user asks.** It quits and reopens Dormouse Standalone, stopping every process that is not a resumable agent session and clearing all scrollback.

## When `dor` cannot connect

- **`EPERM` / `EACCES`:** the tool sandbox may block the local socket. Retry `dor list` through the tool's normal approval mechanism outside the sandbox.
- **`ENOENT`, refused connections, or authentication failures:** the host may have restarted, or the agent's tool runner may have inherited another host's environment. If the user's `dor list` works, compare the non-secret `DORMOUSE_HOST`, `DORMOUSE_SURFACE_ID`, and `DORMOUSE_CONTROL_SOCKET` values. Never print the control token, guess another socket, or retarget only the socket: endpoint, credentials, and caller identity belong together.

**Codex's shared daemon can retain stale terminal context.** Tool commands can inherit an old host's environment even while the Codex UI is in a current Dormouse terminal. When this mismatch is confirmed, ask the user to exit Codex and resume from the working terminal with `codex --no-daemon resume`. `codex features disable daemon_auto_start` persists the preference; an existing daemon also needs `codex app-server daemon stop` before restarting normally. Stopping it can interrupt other Codex sessions: coordinate with the user first. Check the installed CLI's help before prescribing these options, then verify `dor list` after reconnecting. Do not switch to Computer Use or bypass authentication to work around stale context.
