# Writing and changing Dor Tools

Read this when you are asked to create a Dor Tool or to improve a running one. It assumes `dor skill`: its two hard rules still hold, so run servers as Tools or with `dor ensure`, and look at pages only through `dor agent-browser` or `dor playwright`.

## What a Tool is for

A Tool gives the user, an agent, or both a web UI that is pleasant to use. It may back that UI with a terminal program that is cheap in tokens for an agent, and it may build itself from source on every run, so that changing it is a matter of editing that source. A Tool has up to three faces:

- the page a person uses;
- the same page as an agent drives it, through a snapshot of its accessibility tree;
- optionally, a command or terminal UI an agent can use without rendering a page at all.

## Where a Tool lives

A Tool is an entry under `tools:` in a `dormouse.yml`. `dor tool --list` prints both files it reads: the nearest project file above your directory, and the user's own (`$XDG_CONFIG_HOME/dormouse/dormouse.yml`, else `~/.config/dormouse/dormouse.yml`).

```yaml
tools:
  # Review board for this repo's fixtures. Agents: `node board.mjs --json` in this folder prints the same data as text.
  board:
    run: [node, $HERE/board.mjs, $ARGS]
    render: agent-browser-screencast   # or iframe (the default), playwright-screencast
    port: announced                    # the default; or auto
    prespawn_dedupe: [board, $HERE]
```

- `run` is a string, which is literal shell syntax and takes no arguments, or a list, which may use substitutions. In a list, `$HERE` is the directory of the declaring `dormouse.yml`, `$CWD` the caller's directory, and `$TARGET` the one local file or folder argument; an element that is exactly `$ARGS` takes all arguments, and without `$ARGS` or `$TARGET` they are appended. Any other `$NAME` is an error.
- `prespawn_dedupe` is the Tool's identity: running it again reveals the running one instead of starting another. Put `$HERE` in it so each checkout gets its own.
- `viewport` takes a preset name or dimensions; an `iframe` Tool takes only `pane-sync`.
- The comment directly above an entry is what `dor tool --list` shows the next agent. Say what the Tool is for and how an agent should use it.

A Tool the user keeps across projects can live in its own clone, imported from the user file. `from` is that clone's directory, relative to the user file or absolute, and `tool` names the entry there when it differs. `$HERE` is then the clone, which needs no approval.

```yaml
tools:
  # Notes board; its source is the clone in ~/src/notes-tool.
  notes:
    from: ../../src/notes-tool
```

A project file runs nothing until the user approves it in Dormouse, and no `dor` command grants that. Once approved, edits to it need no new approval.

## Finding the Tool you were asked to change

Given a Surface id, find its row:

```sh
dor list --json    # add --all when it is in another Workspace
```

A named Tool's row carries `tool_name`, `tool_scope` (`project`, `user`, or `builtin`), and `tool_origin.file`: the `dormouse.yml` that declares it, which for an import is the file inside the clone. Read that entry's `run` to find the source. A `builtin` Tool has no file: it ships with Dormouse.

## Serving

When the Tool serves, its pane shows a browser of the port. Only a port the Tool's own process tree listens on is ever framed.

- `port: auto` frames the one port the command opens; two or more show a conflict.
- `port: announced` frames nothing until the command announces its port.

Announce once the server listens. `path` is optional and must start with one `/`:

```sh
printf '\033]367;serve;{"v":1,"port":%s}\007' "$PORT"
printf '\033]367;serve;{"v":1,"port":%s,"path":"/review?tab=open"}\007' "$PORT"
```

Every sequence on this page is `ESC ] 367 ;`, a verb, `;`, one JSON object of at most 4,096 characters, and BEL. Write the same bytes from any language. `dor-tools-lib` encodes them but is not published yet, so a Tool outside the Dormouse repository writes them raw.

## Talking to the host

Report unsaved changes whenever they change. While dirty, Dormouse asks before closing the pane, and `dor kill` refuses it:

```sh
printf '\033]367;state;{"v":1,"dirty":true}\007'
printf '\033]367;state;{"v":1,"dirty":false}\007'
```

Open a file the user picked in your Tool: in the Workspace's preview pane with `"preview":true`, otherwise as `dor open` would. The path is absolute, and only the Tool's own run may send it:

```sh
printf '\033]367;open;{"v":1,"path":"/abs/notes/todo.md","preview":true}\007'
```

A shell script can run `dor open --preview <path>` instead.

Let Dormouse stop the Tool after 30 minutes out of sight and quiet, and start it again when it is shown, by declaring that its arguments alone restart it:

```sh
printf '\033]367;serve;{"v":1,"port":%s,"dehydrate":true}\007' "$PORT"
```

On Ctrl+C it may write a small state just before exiting. The restarted run finds that whole JSON object in `DORMOUSE_DEHYDRATE`, and should start from its arguments when the variable is absent or unreadable:

```sh
printf '\033]367;dehydrate;{"v":1,"state":{"tab":"open"}}\007'
```

`"persist":"never"` in a `serve` forbids stopping it.

## The loop: change, reload, look

1. Read its terminal: `dor read <id>`, or `dor read <id> --scrollback --lines 200`.
2. Look at its page. A `*-screencast` Tool is a browser you can drive: `dor agent-browser --surface <id> snapshot` for `agent-browser-screencast`, `dor playwright --surface <id> snapshot` for `playwright-screencast`. An `iframe` Tool is view-only: open its row's `url` in your own browser with `dor agent-browser --key <name> open <url>`.
3. After an edit:
   - A dev server with hot reload needs nothing.
   - If only the page's files changed, reload it (`dor agent-browser --surface <id> reload` for an `agent-browser-screencast` Tool).
   - If the server's code changed, restart it in place, passing its command as words (a list `run` after substitution) and the row's `cwd`:

     ```sh
     dor ensure --restart --cwd <cwd> -- <command words>
     ```

     It must print `restarted <id>`: the same Surface, still a Tool. If it prints `created`, the command did not match exactly and the new pane is a plain terminal: kill that pane and relaunch as below.
   - If you changed the entry itself (`run`, `render`, `port`), a restart retypes the old command. Relaunch: `dor kill <id> --confirm-if-read <text>`, then `dor tool <name>`, which prints a new id.

Never restart with `dor send <id> --key ctrl-c`: once its command exits, the pane becomes a plain terminal, and `dor tool <name>` starts another.

## Building for agents

- Give controls stable, accessible names and roles, so a snapshot stays small and its refs mean the same thing between runs.
- Keep state in the URL, so `path` and `open <url>` can deep-link to it.
- Give the command a mode that prints its facts as text or `--json`, so an agent can run it in its own shell instead of scraping the page.
- Say in the entry's comment which of these exist and when an agent should use each.
