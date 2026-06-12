- [ ] In desktop, swap the Pointer icon for the "Text selection" to match up with Pocket
- [ ] remove CWD functionality
- [ ] Move mobile theme picker
- [ ] macOS app icon
- [ ] Test the new updater
- [ ] test bare defaults (delete all local state, what happens next?)
- [ ] When a terminal pane is crowded, it should hide the split icons first
- [ ] Standalone startup time
- [ ] right-click and-then
- [ ] Changelog styling for bold/italic/code

- [ ] Link in-app UI to signup for newsletter
- [ ] refactor
  - move bell-icon-class into terminal-registry

--------------------------------------------------------------------------------


  ┌────────────┬──────────────────────────────────┬──────────────────────────┐
  │   Shell    │        OSC 633 injection         │ Falls back to keystrokes │
  ├────────────┼──────────────────────────────────┼──────────────────────────┤
  │ zsh        │ ✅ (ZDOTDIR)                     │ only if injection fails  │
  ├────────────┼──────────────────────────────────┼──────────────────────────┤
  │ bash       │ ✅ (--rcfile/--init-file)        │ only if injection fails  │
  ├────────────┼──────────────────────────────────┼──────────────────────────┤
  │ fish       │ ✅ (vendor conf.d)               │ only if injection fails  │
  ├────────────┼──────────────────────────────────┼──────────────────────────┤
  │ PowerShell │ ✅ (-NoExit -Command dot-source) │ only if injection fails  │
  ├────────────┼──────────────────────────────────┼──────────────────────────┤
  │ cmd.exe    │ ❌ (no command hook)             │ always                   │
  └────────────┴──────────────────────────────────┴──────────────────────────┘


--------------------------------------------------------------------------------

[Intro]
Dormouse, Dormouse

[Verse]
Agent to the left, another agent to the right
Dev server at the bottom, information packed-in tight

[Pre-chorus build-up]
Alerts pop up when I need to know
CLI automation to build my own flow

[Chorus]
Dormouse, Dormouse, multitask more
Dormouse, Dormouse, D-O-R spells dor
Dormouse, Dormouse, VS Code or standalone
Dormouse, Dormouse, from my laptop to my phone

Dormouse!

--------------------------------------------------------------------------------

I want to do a thought experiment for a bit. Let's say I abandon compatibility completely, to focus only on what's best for Dormouse. In particular, we have a few unimplemented capabilities on the way:

1. Cmux-style Workspaces. Right now we essentially have a single workspace. I want users to be able to take that whole thing and swap between them. A workspace will aggregate the alerts and TODOs within it. My plan is that the VSCode app will stay limited to one workspace (no good place for the UI to go), and Dormouse standalone will support multiple like cmux.
2. `dor iframe https://blah` opens an iframe at the given URL. Creates a split unless this is the very first command in the terminal, in which case it kills the terminal and replaces it with this.
3. `dor agent-browser open https://blah` opens a browser using `agent-browser` and streams it to the pane. I'm thinking it will be idempotent, in that there's one agent-browser instance per workspace, it gets created if it isn't there already. Someday later on we'll support multiple instances in a workspace at once.

I think the output and JSON features of cmux are great, but its CLI is overly complex, especially since we don't have "tab stacks". I'm thinking about the following:

- `dor split [--left|--right|--up|--down|--auto] [--command <initial command>] [--iframe <initial URL>] [--agent-browser] [--minimize] [--new-workspace] [--surface <SURFACE_ID>]`
- `dor ensure [--minimize] [--workspace <workspaceID>] -- pnpm dev:workspace` (start a command if it doesn't already exist in this workspace, if it does already exist then return the info of the existing command)
- `dor kill [--surface] [--wait-for-user-confirm] [--confirm-has-text <AT LEAST 4 CHARS OF ONSCREENTEXT>] [--confirm-dangerously]` (one of the three confirm modes is required)


- TODO: `dor identify` to determine if you are running in vscode or standalone
- TODO: we need a `window` and `workspace` model which supports both standalone and vscode
  - the "Dormouse view" and every "Dormouse editor" can each be their own workspace?
  - in cmux, a single window can only ever show one workspace
  - in dormouse, 0 to n workspaces could be visible at once

Dormouse has a CLI, called `dor`. We use dormouse to 




  3. Confirm the integration script actually loaded

  In that Dormouse terminal, run:

  typeset -f __dormouse_633_precmd     # should print our hook function
  echo "USER_ZDOTDIR=$USER_ZDOTDIR"    # should be non-empty (only we set this)
  print -l $precmd_functions           # __dormouse_633_precmd should be listed FIRST

  - If __dormouse_633_precmd prints a function body → injection worked, OSC 633 is live.
  - If it prints nothing / USER_ZDOTDIR is empty → it fell back to keystrokes (tell me and we'll dig in).

  Also sanity-check your environment is intact: your normal prompt, aliases, and echo $PATH (Homebrew/asdf still there).

   4. Confirm it drives real command tracking

  The product-level difference between OSC 633 and the keystroke fallback is real exit codes and precise boundaries:

  false                 # exits 1 — Dormouse should mark this command as FAILED / exit 1
  true                  # exits 0 — succeeded
  sleep 3               # pane should flip to "running" instantly and to idle exactly at 3s
  false                 # exits 1 — Dormouse should mark this command as FAILED / exit 1
  true                  # exits 0 — succeeded
  sleep 3               # pane should flip to "running" instantly and to idle exactly at 3s
  cd /tmp && pwd        # cwd should update to /tmp

  The keystroke fallback can't know exit codes, so if Dormouse distinguishes false (failed) from true (ok) in the pane header / command history / alert,
  that's OSC 633 working.


---------------------

MINT GREEN - Remove `dor kill --confirm-await-user`
  cli-expanded ~/.codex/worktrees/0cbc/mousterm

FOREST GREEN - 
  cli-expanded ~/projects/dormouse.cli-expanded

PINK - inject zsh OSC 633 shell integration and show command status
  osc-633 ~/projects/dormouse.osc-633


