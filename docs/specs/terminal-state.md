# Terminal CWD and Command State

> See `docs/specs/glossary.md` for Session vocabulary. This spec defines the per-Session terminal semantic state that layout and grouping consume. Alert/TODO behavior and notification OSCs (OSC 9 / 9;4 / 99 / 777 / BEL) live in `docs/specs/alert.md`. The escape-sequence registry and parsing-location rules live in `docs/specs/terminal-escapes.md`.

## Goal

MouseTerm models terminal panes by:

- latest reported working directory
- current command line
- whether the shell is at a prompt, editing, running a foreground command, or waiting after command finish
- command exit status
- command directory at start time
- app-sent terminal or notification title as an override label

Session CWD and command execution state are separate. `cwd` means "the shell/session reported this directory"; it is not necessarily the internal CWD of a foreground program. A command snapshots `cwdAtStart` when it starts, and that snapshot is used for grouping and header disambiguation while the command is running.

## Core Model

```ts
type TerminalPaneState = {
  cwd: CwdState | null;
  activity: ShellActivity;
  pendingCommandLine: string | null;
  currentCommand: CommandRun | null;
  lastCommand: CommandRun | null;
  title: TerminalTitle | null;
  titleCandidates: Partial<Record<TerminalTitle["source"], TerminalTitle>>;
};
```

```ts
type CwdState = {
  uri?: string;
  path: string;
  host?: string;
  scheme?: "file";
  pathKind: "posix" | "windows" | "unknown";
  isRemote: boolean;
  source: "osc7" | "osc9_9" | "osc633" | "osc1337" | "process" | "manual";
  updatedAt: number;
};
```

Host identity is part of directory identity. `file://localhost/Users/me/project` and `file://prod-box/home/me/project` are different locations even if their display labels can be compact.

```ts
type ShellActivity =
  | { kind: "unknown" }
  | { kind: "prompt" }
  | { kind: "editing" }
  | { kind: "running" }
  | { kind: "finished"; exitCode?: number };
```

This intentionally is not `isRunning`. The shell process normally keeps running; the important state is whether a foreground command is active.

```ts
type CommandRun = {
  id: string;
  rawCommandLine: string | null;
  displayCommand: string;
  cwdAtStart: CwdState | null;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  source:
    | "osc633_E"
    | "osc633_boundaries"
    | "osc133_boundaries"
    | "user_input";
  /**
   * App-sent OSC 0/2/9 title that was active when this command finished. Snapshotted by
   * `commandFinish` so post-finish title events (e.g. the shell resetting OSC 0 to `zsh`) do
   * not overwrite the in-run title we want to show as `<idle> ${LAST_TITLE}`.
   * Only set on finished commands.
   */
  finalTerminalTitle?: TerminalTitle;
  outputRange?: {
    startMarkId?: string;
    endMarkId?: string;
  };
};
```

```ts
type TerminalTitle = {
  title: string;
  source:
    | "osc0"
    | "osc2"
    | "osc9"
    | "osc99"
    | "osc777"
    | "user";
  updatedAt: number;
};
```

Terminal title is separate from command state. `title` is the latest title event for compatibility. `titleCandidates` stores the latest value for each candidate channel, with its own timestamp, so app, shell, and user title sources can be inspected independently. It is useful as an app-sent label override, but it is not a command lifecycle signal.

## Normalized Events

All protocol parsing emits normalized semantic events before feature code sees the state:

```ts
type TerminalSemanticEvent =
  | { type: "cwd"; cwd: CwdState }
  | { type: "promptStart" }
  | { type: "promptEnd" }
  | { type: "commandLine"; commandLine: string }
  | { type: "commandStart"; source?: CommandRun["source"]; startedAt?: number }
  | { type: "commandFinish"; exitCode?: number }
  | { type: "title"; title: TerminalTitle };
```

Feature code consumes `TerminalPaneState` or `TerminalSemanticEvent`, never raw OSC sequences.
Protocol-derived semantic events are timestamped in stream order before they reach the reducer, so command-start boundaries and title candidates from the same PTY chunk remain comparable even when they were parsed in the same millisecond.

`AlertManager` also consumes command lifecycle semantic events for command-exit alerting. That alert path is specified in `docs/specs/alert.md`: a foreground command can arm an alert only after it was observed while the Session had attention and that attention later expired or was explicitly lost before the same command finished.

## Supported OSC Inputs

CWD:

| Sequence | Source | Notes |
|---|---|---|
| `OSC 7 ; file://host/path ST` | `osc7` | Parses as `file:` URI, decodes the path, preserves host. |
| `OSC 9 ; 9 ; <cwd> ST` | `osc9_9` | Windows Terminal / ConEmu-style CWD. Drive-letter and UNC paths are Windows paths; other paths are `unknown`. |
| `OSC 633 ; P ; Cwd=<cwd> ST` | `osc633` | VS Code-style CWD. |
| `OSC 1337 ; CurrentDir=<cwd> ST` | `osc1337` | iTerm2-style CWD compatibility. |

Non-OSC CWD sources:

- `process` — adapter polled the PTY's process for its working directory. Used when no OSC source has reported recently.
- `manual` — caller seeded the CWD directly (e.g., session restore from saved state, or a known spawn directory). Produced by `cwdFromManualPath()`.

Command lifecycle:

| Sequence | Event |
|---|---|
| `OSC 133 ; A ST` / `OSC 633 ; A ST` | `promptStart` |
| `OSC 133 ; B ST` / `OSC 633 ; B ST` | `promptEnd` |
| `OSC 133 ; C ST` | `commandStart(source: "osc133_boundaries")` |
| `OSC 633 ; E ; <commandline> [; <nonce>] ST` | `commandLine`; parses only the command field and decodes VS Code `\xAB` / `\\` escapes before storing it. |
| `OSC 633 ; C ST` | `commandStart(source: "osc633_E"` when a pending command line exists, otherwise `"osc633_boundaries")` |
| `OSC 133 ; D ; <exitCode?> ST` / `OSC 633 ; D ; <exitCode?> ST` | `commandFinish` |

Title fallback:

| Sequence | Event |
|---|---|
| `OSC 0 ; <title> ST` | `title(source: "osc0")` |
| `OSC 2 ; <title> ST` | `title(source: "osc2")` |

Title candidate diagnostics:

| Sequence | Candidate source | Header/door override |
|---|---|---|
| `OSC 9 ; <message> ST` | `osc9` | Yes |
| `OSC 99 ; ... title/body ... ST` | `osc99` | No |
| `OSC 777 ; notify ; <title> ; <body> ST` | `osc777` | No |

Only the OSC 9 *message* form (`OSC 9 ; <message>`) feeds the title channel. The OSC 9 *progress* form (`OSC 9 ; 4 ; <state> ; <progress>`) carries no text payload and does not contribute a title candidate; its semantics are documented in `docs/specs/alert.md`.

Non-OSC title source:

- `user` — user-pinned title set via the inline rename UI (`setTerminalUserTitle`). Always wins over every other candidate.

The `user_input` command fallback is best effort. It is sufficient for headers and grouping, but command-exit alerting may treat it as lower confidence or ignore it until deeper shell integration exists.

The parser accepts both BEL and ST terminators and handles split chunks. Supported-but-malformed semantic OSCs are consumed without changing state. Unsupported OSC pass-through vs. consume/ignore behavior is defined centrally in `docs/specs/terminal-escapes.md`.

## Reducer

`reduceTerminalState(state, event)` is the only state transition surface.

- `cwd` replaces the latest session CWD.
- `promptStart` sets `{ kind: "prompt" }`, clears `currentCommand`, and clears `pendingCommandLine`. Any pending input that was not yet consumed by a `commandStart` is dropped — a fresh prompt is the unambiguous signal that no command is in flight.
- `promptEnd` sets `{ kind: "editing" }`, clears `currentCommand`, and clears `pendingCommandLine` for the same reason.
- `commandLine` stores `pendingCommandLine`.
- User-entered prompt input may also store `pendingCommandLine` as an explicit fallback before an OSC 133/633 command-start boundary. This fallback is only used while the shell is idle/editing; foreground-program input is ignored. If the submitted line is non-empty, the input fallback may create a `currentCommand` immediately with `source: "user_input"` so shells without command-start integration still show the active command.
- The typed-command fallback resolves the current Session id from the PTY id before recording input or prompt-looking output, so drag-to-swap moves the fallback state with the visible pane.
- `commandStart` creates `currentCommand`, snapshots `cwdAtStart`, uses `event.startedAt` when present, clears `pendingCommandLine`, and sets `{ kind: "running" }`.
- `commandFinish` moves `currentCommand` to `lastCommand`, stores `finishedAt`/`exitCode`, snapshots the latest in-run OSC 0/2/9 title into `lastCommand.finalTerminalTitle` (titles older than `startedAt` or younger than `finishedAt` are excluded), clears `currentCommand`, and sets `{ kind: "finished", exitCode }`.
- `title` updates `title` and the per-source entry in `titleCandidates`. Later OSC title events do not erase earlier user, shell, or notification channel candidates from other sources.
- A later prompt signal moves the pane out of `finished`. If a command was started from `user_input` and no explicit `commandFinish` arrived, the prompt signal also clears `currentCommand` so the header returns to `<idle>`.
- For `user_input` fallback commands only, visible output that looks like a returned shell prompt may synthesize the same prompt transition. This is a scoped fallback for shells that do not emit command finish/start OSCs.

CWD precedence:

- OSC-sourced CWD (`osc7`, `osc9_9`, `osc633`, `osc1337`) wins over everything. Once an OSC has reported a directory, only a later OSC can replace it.
- Process-polled CWD (`process`) updates only when the current source is `null`, `manual`, or another `process` reading. It fills the gap when the shell does not emit OSC 7 / 633;P / 1337 / 9;9.
- Manually seeded CWD (`manual`) is the initial seed during session restore or known-spawn-directory launches. It is replaceable by any later source.
- Default is `null`.

Asynchronous process CWD query results are applied through PTY-id resolution, so a result that arrives after `swap` updates the Session that currently owns that PTY.

## Header Derivation

```ts
type DerivedHeader = {
  primary: string;
  secondary?: string;
};
```

The header carries only the primary label and an optional secondary disambiguator. Activity state lives on `pane.activity` directly; consumers that need it (status grouping, exit-code badges) read it from there.

Header priority — first match wins:

1. User-pinned title.
2. While a command is running (`currentCommand` is set):
   - App-sent title override emitted after the current command started — legacy `OSC 9` message text or `OSC 0`/`OSC 2` terminal title.
   - `currentCommand.displayCommand`.
3. After a command has finished (`currentCommand` is null and `lastCommand` is set): `<idle> ${LAST_TITLE}`, where `LAST_TITLE` follows the same priority as the running case applied to `lastCommand`:
   - App-sent title override that was emitted between `lastCommand.startedAt` and `lastCommand.finishedAt`. The candidate is taken from `lastCommand.finalTerminalTitle` (snapshotted at finish) so a post-finish title event cannot overwrite it.
   - `lastCommand.displayCommand`.
4. Otherwise (no running command and no last command): `<idle>`.

Rich notification titles from `OSC 99` and `OSC 777` are stored in `titleCandidates` for the diagnostic popup but never become header/door labels. Older shell titles (terminal titles emitted before the current command started, or after the last command finished) remain fallback-only and do not replace `<idle>` or pollute `LAST_TITLE`.

`<idle> ${LAST_TITLE}` keeps the just-finished context visible so the user can see at a glance which program just exited. Exit code, output, and TODO notification are still surfaced via the alert/TODO machinery (`docs/specs/alert.md`); the header itself stays peaceful but informative. `<idle> ${LAST_TITLE}` persists across subsequent prompt/editing transitions until a new `commandStart` replaces it; only a fresh pane (no `lastCommand` at all) shows plain `<idle>`.

Disambiguation:

- Duplicate primary labels get a shortest unique directory secondary label.
- Running commands disambiguate with `currentCommand.cwdAtStart`.
- Panes without a running command disambiguate with `pane.cwd`.

## Grouping

Supported grouping modes are `none`, `directory`, `command`, and `status`.

Directory grouping uses:

```ts
pane.currentCommand?.cwdAtStart ?? pane.cwd
```

Command grouping uses:

```ts
pane.currentCommand?.displayCommand ?? "<idle>"
```

Status grouping projects `ShellActivity.kind` (5 values) onto 4 buckets:

| `pane.activity.kind` | Status bucket |
|---|---|
| `unknown`            | `unknown`     |
| `prompt`             | `idle`        |
| `editing`            | `idle`        |
| `running`            | `running`     |
| `finished`           | `finished`    |

`prompt` and `editing` collapse into a single `idle` bucket because the user-visible distinction between "at the prompt" and "typing a command" is not load-bearing for grouping. `finished` stays distinct so a recently-completed pane can be filtered separately even though its header label has the same `<idle>` prefix as plain idle panes.

Directory group keys use `cwdIdentity(cwd)` so remote hosts and Windows/POSIX path kinds remain distinct.
Windows UNC display labels keep `\\server\share\` as the path root and do not repeat the server/share in the trailing path segments.
