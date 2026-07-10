# Driving Dormouse with `dor`

You are running inside Dormouse, a multitasking terminal. Every terminal it
launches has the `dor` CLI on `PATH`. `dor` lets you create, inspect, type
into, and kill other terminal panes, and open browser panes — so instead of
backgrounding a process inside your own shell (where its output is invisible
and it dies with you), you run it in its own **surface** that the user can see
and that outlives your session.

## Two hard rules

These override your usual defaults. They matter more than anything else here:

1. **NEVER start a long-running process — a dev server, a `--watch`, any daemon
   — as a background subprocess.** It would be invisible to the user and die
   with your shell. ALWAYS run it with `dor ensure -- <command>`, which puts it
   in a visible pane that outlives you and gets reused instead of duplicated.
2. **NEVER use a built-in, native, or bundled browser tool to open, view, or
   drive a web page.** ALWAYS use `dor ab` (agent-browser), so the page renders
   in a Dormouse pane the user can watch and you can drive.

The rest of this guide is how to do everything well.

## Targeting: three ways to name a surface

Action commands (`read`, `send`, `kill`) take a surface handle — there is
deliberately no `dor kill "npm dev"`. You name the surface you want one of
three ways:

1. **Hold the handle.** Commands that create surfaces (`split`, `ensure`,
   `iframe`) print the new ref (`created surface:3`). Capture it and act on
   it directly — refs stay valid across any layout churn.
2. **Address by identity key.** Surfaces with a natural identity skip handle
   bookkeeping: `dor ensure -- <command>` uses its exact command + cwd as an
   implicit key (match-or-create in one idempotent call), and browser
   surfaces are addressed by an explicit key (`dor ab --key <name>`).
3. **Rediscover.** When you hold nothing — a fresh session, or a process the
   user started by hand — `dor list` (filtered) turns a description
   (`--command`, `--cwd`, `--port`) into a handle.

Text output is designed for you to read: it is terse and carries the same
refs. Reach for `--json` (every command except `dor ab` supports it) only
when a shell script or pipeline using `jq` consumes the output.

## Surface handles

- `surface:N` — short ref, e.g. `surface:3`. Stable for the surface's whole
  life: reordering, minimizing, zooming, and focus changes never change it, and
  numbers are never reused after a kill. A ref for a killed surface fails
  loudly instead of silently retargeting, so refs from earlier in your session
  stay safe to use.
- A stable surface id (or `surface:<stable-id>`) — from `--json` output.
- `surface:self` — the terminal you are running in.
- `surface:focused` — whatever the user currently has focused.
- `title:<exact title>` — exists for human recovery; avoid it in automation
  (titles drift). Prefer refs from command responses or `dor list`.

Bare numbers and `pane:N` are not valid handles.

## Command reference

Run `dor <command> --help` for full details on any command.

### `dor list` — find surfaces

```sh
dor list                                   # everything in the workspace
dor list --command "npm run dev" --cwd .   # exact command + cwd match
dor list --port 5173                       # which terminal owns port 5173
dor list --kind terminal --view minimized  # filters AND together
dor list --ports                           # add each terminal's listening ports
```

Lists every surface in the current workspace — terminals and browser surfaces,
including minimized ones. `--command` matches the exact command the shell
reports it is running (`npm run dev` ≠ `npm run dev --host`). `--cwd` resolves
relative to your `PWD`. `--port`/`--ports` trigger an opt-in port scan and
`--port` only ever matches the terminal that owns the socket, never a browser
showing that URL. Text rows mark the user's focus with `*` and your own
terminal with `(you)`; `--json` adds stable ids and a host/identity block.

### `dor split` — create a terminal

```sh
dor split -- npm test          # runs in background; focus stays with you
dor split --minimize -- ./watch.sh
dor split --                   # blank terminal, focus stays with you
```

Direction flags `--left|--right|--up|--down` (default `--auto`).
`--surface <ref>` picks which surface to split from. The response includes the
new surface's ref — save it.

**Never run a bare `dor split` (no `--`).** It moves the user's keyboard focus
to the new pane, so their next keystrokes land there unpredictably. Bare
`dor split` exists for a human at the keyboard who wants to start typing in the
new pane. When you want an empty terminal, always write `dor split --` — same
blank pane, but focus stays put. The rule is simple: every `dor split` you run
has a `--`.

### `dor ensure` — idempotent "make sure this is running"

```sh
dor ensure -- npm run dev              # reuse if live, else create
dor ensure --restart -- npm run dev    # interrupt + re-run in place
dor ensure --minimize --cwd ../worktree-b -- npm run dev
```

Matches on exact command + resolved cwd against commands that are *currently
live* (via shell integration), so it also adopts a server the user started by
hand. It never changes focus, and never collapses the same command running in
two directories. `--restart` preserves the surface's place in the layout and
its minimized/visible state. Requires a shell with OSC 633 integration in the
target (Dormouse-launched shells have it; cmd.exe does not).

Prefer `ensure` over `split` for anything with a natural identity ("the dev
server for this directory") — it is your dedupe key across re-runs and layout
churn.

### `dor send` — type into a terminal

```sh
dor send surface:3 --text "npm test" --key enter   # the canonical run-a-command
dor send surface:3 --key ctrl-c                    # interrupt
cat answers.txt | dor send surface:3 --stdin
dor send surface:3 --sequence '[{"text":"y"},{"key":"enter"},{"key":"tab"}]'
```

Exactly one input mode per call: `--text`/`--key` (only in that order, text
first), `--stdin`, or `--sequence` for anything more complex. Special keys go
through `--key` (`enter`, `escape`, `tab`, `backspace`, `delete`, arrows,
`ctrl-a`..`ctrl-z`) so they are never confused with literal text. `--text`
interprets `\n` `\r` `\t` `\\` unless `--raw`.

### `dor read` — read a terminal's screen

```sh
dor read surface:3                       # visible screen, printed directly
dor read surface:3 --scrollback --lines 200
```

### `dor kill` — kill a surface (confirmation required)

```sh
dor kill surface:3 --confirm-if-read "npm test"   # preferred: verify then kill
dor kill surface:3 --confirm-dangerously          # only when already validated
```

`--confirm-if-read <text>` kills only if the surface's visible screen contains
the text (≥4 non-whitespace chars) — use it as a cheap guard that you are
killing what you think you are.

### `dor ab` / `dor agent-browser` — agent-drivable browser pane

Forwards everything to your installed `agent-browser` CLI (not bundled —
`npm i -g agent-browser`) and binds the session to a Dormouse browser surface
so the user watches what you drive.

```sh
dor ab open http://localhost:5173         # key "default"
dor ab --key server open http://localhost:3000
dor ab click @e3                          # further args are agent-browser's own
dor ab --key server reload
```

`--key <name>` is a workspace-scoped browser identity: one key = one session =
one surface, reused across commands. Use distinct keys when you need
independent browsers at once. `dor ab` has no `--json` of its own; any JSON
flags belong to `agent-browser`.

### `dor iframe` — high-fidelity URL pane for the user

```sh
dor iframe http://localhost:6006     # absolute http(s) URL required
```

For *showing* a page to the human at full fidelity (no automation hooks).
Provisional: some sites refuse framing. To *drive* a page, use `dor ab`.

## Recipes

**Run a dev server and show it to the user.** Ensure it, find its port, open a
browser on it:

```sh
dor ensure -- npm run dev
dor list --command "npm run dev" --cwd . --ports   # read the port
dor ab open http://localhost:<port>
```

**Launch and drive a sub-agent** (another CLI agent in a sibling pane):

```sh
dor split -- codex                  # prints "created surface:N"
dor send surface:N --text "/review" --key enter
dor read surface:N                  # poll its screen for progress/results
```

**Client/server browser testing.** Two keys, two independent browsers:

```sh
dor ab --key server open http://localhost:3000/admin
dor ab --key client open http://localhost:5173
```

**Same command in multiple worktrees.** cwd keeps them distinct:

```sh
dor ensure --cwd ~/wt/feature-a -- npm run dev
dor ensure --cwd ~/wt/feature-b -- npm run dev
dor list --command "npm run dev" --cwd ~/wt/feature-a   # picks one
```

**Long-running background job, out of the way.** Minimize it; rediscover it
later by command instead of remembering the ref:

```sh
dor ensure --minimize -- npm test -- --watch
dor list --command "npm test -- --watch"
dor read surface:N --lines 50
```

**Who owns this port?**

```sh
dor list --port 5173          # the terminal, never a browser surface
```

**Safe cleanup.** List, verify, kill:

```sh
dor list --command "npm run dev" --cwd .
dor kill surface:N --confirm-if-read "npm run dev"
```

## Rules and pitfalls

- **Never pre-quote command tails.** Everything after `--` is forwarded as a
  raw argv array; Dormouse quotes it correctly for whatever shell the target
  surface runs (POSIX, cmd, PowerShell). Pass `-- npm test -- --watch`, not
  `-- "npm test -- --watch"`.
- **Focus etiquette.** `dor ensure` and anything with a `--` tail (`dor split
  -- <command>`, or a bare-terminal `dor split --`) never steal focus. Only a
  bare `dor split` with no `--` does — never run that in automation; use
  `dor split --` for an empty pane instead.
- **Take refs from responses.** Capture the ref that `split`/`ensure`/`iframe`
  print rather than re-listing and guessing.
- **`--command` is exact.** Match the command string you launched with,
  including its flags.
- **Prefer `--confirm-if-read` over `--confirm-dangerously`** unless you have
  just read the surface yourself.
- **Scope:** `dor` sees the current workspace only. Terminals ring bells and
  carry todo flags (`[ringing]`/`[todo]` in `dor list`); browser surfaces are
  the only ones with explicit keys, because their sessions live in
  `agent-browser`.
