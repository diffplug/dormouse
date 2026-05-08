# Terminal CWD and Command State

> See `docs/specs/ontology.md` for Session vocabulary. This spec defines the per-Session terminal semantic state that layout and grouping consume. Alert/TODO behavior remains in `docs/specs/alert.md`; notification OSCs remain in `docs/specs/iTerm2.md`.

## Goal

MouseTerm models terminal panes by:

- latest reported working directory
- current command line
- whether the shell is at a prompt, editing, running a foreground command, or waiting after command finish
- command exit status
- command directory at start time
- app-sent terminal or notification title as an override label

Session CWD and command execution state are separate. `cwd` means "the shell/session reported this directory"; it is not necessarily the internal CWD of a foreground program. A command snapshots `cwdAtStart` when it starts, and that snapshot is used for grouping and header disambiguation while the command is running or freshly finished.

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
    | "foreground_process"
    | "user_input"
    | "title";
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
    | "notification"
    | "user"
    | "profile"
    | "derived";
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

## Supported OSC Inputs

CWD:

| Sequence | Source | Notes |
|---|---|---|
| `OSC 7 ; file://host/path ST` | `osc7` | Parses as `file:` URI, decodes the path, preserves host. |
| `OSC 9 ; 9 ; <cwd> ST` | `osc9_9` | Windows Terminal / ConEmu-style CWD. Drive-letter and UNC paths are Windows paths; other paths are `unknown`. |
| `OSC 633 ; P ; Cwd=<cwd> ST` | `osc633` | VS Code-style CWD. |
| `OSC 1337 ; CurrentDir=<cwd> ST` | `osc1337` | iTerm2-style CWD compatibility. |

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

The parser accepts both BEL and ST terminators and handles split chunks. Unsupported OSCs pass through to xterm unchanged; supported-but-malformed semantic OSCs are consumed without changing state.

## Reducer

`reduceTerminalState(state, event)` is the only state transition surface.

- `cwd` replaces the latest session CWD.
- `promptStart` sets `{ kind: "prompt" }` and clears stale pending command-line fallback.
- `promptEnd` sets `{ kind: "editing" }` and clears stale pending command-line fallback.
- `commandLine` stores `pendingCommandLine`.
- User-entered prompt input may also store `pendingCommandLine` as an explicit fallback before an OSC 133/633 command-start boundary. This fallback is only used while the shell is idle/editing; foreground-program input is ignored. If the submitted line is non-empty, the input fallback may create a `currentCommand` immediately with `source: "user_input"` so shells without command-start integration still show the active command.
- The typed-command fallback resolves the current Session id from the PTY id before recording input or prompt-looking output, so drag-to-swap moves the fallback state with the visible pane.
- `commandStart` creates `currentCommand`, snapshots `cwdAtStart`, uses `event.startedAt` when present, clears `pendingCommandLine`, and sets `{ kind: "running" }`.
- `commandFinish` moves `currentCommand` to `lastCommand`, stores `finishedAt`/`exitCode`, clears `currentCommand`, and sets `{ kind: "finished", exitCode }`.
- `title` updates `title` and the per-source entry in `titleCandidates`. Later OSC title events do not erase earlier user, shell, or notification channel candidates from other sources.
- A later prompt signal moves the pane out of `finished`. If a command was started from `user_input` and no explicit `commandFinish` arrived, the prompt signal also clears `currentCommand` so the header returns to `<idle>`.
- For `user_input` fallback commands only, visible output that looks like a returned shell prompt may synthesize the same prompt transition. This is a scoped fallback for shells that do not emit command finish/start OSCs.

CWD fallback order is:

1. OSC-reported CWD
2. process CWD, if available
3. initial launch or restored directory
4. `null`

Process-derived CWD may fill `null` or replace manual/restored CWD, but it must not overwrite explicit OSC CWD.
Asynchronous process CWD query results are applied through PTY-id resolution, so a result that arrives after `swap` updates the Session that currently owns that PTY.

## Header Derivation

```ts
type DerivedHeader = {
  primary: string;
  secondary?: string;
  status: "unknown" | "idle" | "running" | "finished";
  exitCode?: number;
};
```

Rules:

- A user-pinned title is primary.
- An app-sent title override is primary after user-pinned titles. This includes legacy `OSC 9` message text and OSC 0/2 terminal titles sent after the current command started. Rich notification titles from `OSC 99` and `OSC 777` are stored in `titleCandidates` for diagnostics and stay in TODO notification UI; they do not become header/door labels.
- A running command uses `currentCommand.displayCommand` when there is no app-sent title override.
- A freshly finished command uses `lastCommand.displayCommand` until the next prompt signal.
- Idle terminals use `<idle>` unless a user-pinned title exists.
- Unknown active commands may use terminal title or shell fallback.
- Duplicate primary labels get a shortest unique directory label.
- Running and finished commands disambiguate with `cwdAtStart`.
- Idle terminals disambiguate with `pane.cwd`.

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

Status grouping uses:

```ts
unknown | idle | running | finished
```

Directory group keys use `cwdIdentity(cwd)` so remote hosts and Windows/POSIX path kinds remain distinct.
Windows UNC display labels keep `\\server\share\` as the path root and do not repeat the server/share in the trailing path segments.
