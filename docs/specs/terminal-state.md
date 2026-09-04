# Terminal CWD and Command State

> See `docs/specs/glossary.md` for Session vocabulary. Owns the per-Session terminal semantic state that layout and grouping consume.
> **Defers:** alert/TODO behavior and the notification OSCs (OSC 9 / 9;4 / 99 / 777 / BEL) to `docs/specs/alert.md`; the escape-sequence registry and parsing-location rules to `docs/specs/terminal-escapes.md`.

## Goal

Dormouse models each terminal pane by its reported working directory, command line, shell activity, exit status, and title.

**`cwd` means "the shell/session reported this directory"** — not the internal CWD of a foreground program. **A command snapshots `cwdAtStart` at start**; grouping and header disambiguation use that snapshot while it runs.

## Core Model

`TerminalPaneState`'s fields and unions are canonical in `lib/src/lib/terminal-state.ts` (`CwdState`, `ShellActivity`, `CommandRun`, `TerminalTitle`).

- **Host identity is part of directory identity**: `file://localhost/Users/me/project` and `file://prod-box/home/me/project` are different locations even where their display labels compact alike.
- **`ShellActivity` is not `isRunning`** — the shell process keeps running; what matters is whether a foreground command is active.
- **Terminal title is a label override, never a command lifecycle signal.** `title` is the latest title event of any source; `titleCandidates` keeps the latest value per channel with its own timestamp, so app, shell, and user sources stay independently inspectable.

## Normalized Events

- **Feature code must consume `TerminalPaneState` or `TerminalSemanticEvent`, never raw OSC sequences** — all protocol parsing emits that canonical union (`lib/src/lib/terminal-state.ts`) first.
- **Protocol-derived events are timestamped in stream order before the reducer**, so command boundaries and title candidates from one PTY chunk stay comparable when parsed in the same millisecond.
- `AlertManager` consumes command lifecycle events too, but only those the protocol parser produced (`docs/specs/alert.md`).

## Supported OSC Inputs

CWD:

| Sequence | Source | Notes |
|---|---|---|
| `OSC 7 ; file://host/path ST` | `osc7` | Parsed as a `file:` URI; path decoded, host preserved. |
| `OSC 9 ; 9 ; <cwd> ST` | `osc9_9` | Windows Terminal / ConEmu. Drive-letter and UNC paths are Windows paths; every other path is `unknown`, never `posix` (rationale). |
| `OSC 633 ; P ; Cwd=<cwd> ST` | `osc633` | VS Code-style. |
| `OSC 1337 ; CurrentDir=<cwd> ST` | `osc1337` | iTerm2 compatibility. |

**Every CWD is bounded at `MAX_CWD_LENGTH` and stripped of control characters before storage**, whatever the source ([terminal-escapes.md](terminal-escapes.md), rationale).

Non-OSC CWD sources:

- `process` — the adapter polled the PTY's process for its working directory.
- `manual` — seeded via `cwdFromManualPath()`. `seedTerminalManualCwd()` (session restore) writes it **only into a pane with no CWD yet**; `seedLaunchedCommand()` (known spawn directory) emits a `cwd` event the reducer applies **unconditionally** — safe only at spawn, before any OSC has reported.

Command lifecycle:

| Sequence | Event |
|---|---|
| `OSC 133 ; A ST` / `OSC 633 ; A ST` | `promptStart` |
| `OSC 133 ; B ST` / `OSC 633 ; B ST` | `promptEnd` |
| `OSC 133 ; C ST` | `commandStart(source: "osc133_boundaries")` |
| `OSC 633 ; E ; <commandline> [; <nonce>] ST` | `commandLine`; parses only the command field, decoding VS Code `\xAB` / `\\` escapes. Bounded and sanitized like every retained value; one reducing to nothing emits nothing ([terminal-escapes.md](terminal-escapes.md)). |
| `OSC 633 ; C ST` | `commandStart(source: "osc633_boundaries")`. The reducer re-labels the stored run `osc633_E` when a command line is pending; the *event* source stays a boundary, which is what promotes the pane to OSC-driven ([Keystroke fallback](#keystroke-fallback)). |
| `OSC 133 ; D ; <exitCode?> ST` / `OSC 633 ; D ; <exitCode?> ST` | `commandFinish` |

Title fallback: `OSC 0 ; <title> ST` and `OSC 2 ; <title> ST` emit `title` with sources `osc0` and `osc2`.

Title candidate diagnostics:

| Sequence | Candidate source | Header/door override |
|---|---|---|
| `OSC 9 ; <message> ST` | `osc9` | Yes |
| `OSC 99 ; ... title/body ... ST` | `osc99` | No |
| `OSC 777 ; notify ; <title> ; <body> ST` | `osc777` | No |

**Only the OSC 9 *message* form feeds the title channel** (body text); the *progress* form `OSC 9 ; 4` has no text payload and contributes no candidate (`docs/specs/alert.md`).

Non-OSC title source:

- `user` — pinned via the inline rename UI (`setTerminalUserTitle`). **Always wins** over every other candidate. **Titles equal to or starting with `<idle>` are rejected as reserved**, being indistinguishable from the derived idle header.

**The `user_input` command fallback is best effort and renderer-only** — synthesized outside the parse path, it never reaches `AlertManager` (`docs/specs/alert.md` owns that limitation).

**A programmatic interactive launch writing directly to the platform PTY must emit `commandLine` + `commandStart(source: "user_input")` synchronously before the write** — it bypasses xterm's keystroke fallback, leaving headers, grouping and `countRunningSessions` wrong on shells with no OSC integration. `dor split/ensure -- <command>` and cold-restore agent resume both use `seedLaunchedCommand`; an integrated shell's later boundaries stay authoritative.

**Supported-but-malformed semantic OSCs are consumed without changing state.** Terminators, split chunks, and unsupported-OSC handling: `docs/specs/terminal-escapes.md`.

Source of truth: `cwdFromManualPath` in `lib/src/lib/terminal-state.ts`; `seedTerminalManualCwd` and `seedLaunchedCommand` in `lib/src/lib/terminal-state-store.ts`, their callers in `lib/src/lib/terminal-lifecycle.ts`.

## Reducer

`reduceTerminalState(state, event)` is the only state transition surface.

### OSC-driven events

- `cwd` replaces the latest session CWD (no-op when both identity and source are unchanged).
- `promptStart` sets `{ kind: "prompt" }`; `promptEnd` sets `{ kind: "editing" }`. **Both clear `currentCommand` and `pendingCommandLine`** — a prompt boundary is the unambiguous signal that no command is in flight. (rationale)
- `commandLine` stores `pendingCommandLine`.
- `commandStart` creates `currentCommand`, snapshots `cwdAtStart`, uses `event.startedAt` when present, clears `pendingCommandLine`, and sets `{ kind: "running" }`. `displayCommand` is the summarized pending command line; with none pending (`OSC 133 ; C` carries no command) it falls back to the newest non-user title candidate, then to the literal `shell`.
- `commandFinish` moves `currentCommand` to `lastCommand`, stores `finishedAt`/`exitCode`, snapshots the latest in-run OSC 0/2/9 title into `lastCommand.finalTerminalTitle` (titles older than `startedAt` or younger than `finishedAt` excluded), clears `currentCommand`, and sets `{ kind: "finished", exitCode }`. **With no `currentCommand` it only sets the activity**, never inventing a `lastCommand`.
- `title` updates `title` and the per-source entry in `titleCandidates`. **Later OSC title events never erase earlier candidates from other sources.**

Command-line tokenizing is dialect-free: **`\` escapes exactly the set `shellEscapePosix` writes** (`POSIX_ESCAPABLE` in `lib/src/lib/posix-escape.ts`; both halves pinned by `terminal-state.test.ts`). **A leading `&` is PowerShell's call operator, never a POSIX background suffix**, and is dropped rather than read as a boundary. **An unquoted Windows path containing spaces stays split.** **A launcher suffix is not part of a program's name** — `npm.cmd` and `C:\tools\claude.exe` are `npm` and `claude` for the header, the WATCHING key, and the bell tooltip alike. Accepted: `foo.bat` and `foo.exe` in one directory cannot be watched separately. (rationale)

### Keystroke fallback

For shells without OSC 133/633 integration, the command is read off the screen rather than reconstructed from keystrokes.

- **Prompt-shape learning.** Every detected idle prompt — the shell's first at spawn included — teaches a cwd-invariant prompt **shape**: the trailing terminator character (`%`, `$`, `#`, `>`, `❯`, `➜`, `λ`) plus how many times it already appears earlier in the prompt. **A prompt with no recognized terminator yields no shape**, hence no title rather than a wrong one.
- **Submit parsing.** On submit (an Enter not inside a bracketed paste) it reads the cursor's rendered logical line — `prompt + command`, soft-wrapped rows joined, bounded at the cursor column so zsh-autosuggestions ghost text is excluded — splits the command off at the shape's terminator occurrence, and trims what follows. **A non-empty result emits `commandLine` + `commandStart(source: "user_input")` immediately.** Command-internal terminators (`dir > out.txt`) survive, sitting after the prompt's own. (rationale)
- **Shape survival and reconnect seeding.** **The shape survives across commands** (no reset on `promptStart`/`promptEnd`/`commandStart`) and **is pre-seeded from restored scrollback** on session restore / VS Code panel reopen, so the first command after a reconnect is still titled. **Seeding is learn-only and fires no prompt transition.** (rationale)
- **Swap safety.** **The fallback resolves the current Session id from the PTY id before recording submit input or prompt-looking output**, so drag-to-swap moves the fallback state — learned shape included — with the visible pane.
- **Synthesized idle transitions.** Prompt-looking output always refreshes the learned shape, but **may synthesize the idle prompt transition only when `currentCommand.source === "user_input"`**. (rationale)
- **What counts as a returned prompt.** Judged over the last 1024 chars of a pane's output, **alt-screen spans dropped** and presentation controls removed by the shared `stripTerminalControls` (whose rules `docs/specs/transport.md` owns). **The window is cut from `TerminalProtocolParseResult.textData`, never the raw chunk**, so no image payload reaches it (rationale). **Matching is anchored**: PowerShell `PS <path>>`, cmd.exe `<drive>:\...>`, a leading `➜`/`❯`/`λ`, a bare `$`/`#`/`%` final line whose preceding non-blank line carries path/user context, or a generic line carrying a `/`, `~`, `@`, or `:` **and** ending in a prompt char plus space. **A custom prompt with neither signal must not match**: a false positive flips a running command back to idle.
- **Boundary mode, plus a trailing-boundary trim.** Stripping runs in **boundary mode** (every control becomes a line break), as resume detection does (`docs/specs/transport.md`). **A genuine trailing newline must keep reading as `null`; a trailing boundary must not** — stripping the same text *without* boundaries leaves exactly the real breaks, which tells the two apart. Both directions pinned by `lib/src/lib/terminal-state-store.test.ts`. (rationale)
- **Per-pane retirement.** **The keystroke fallback and real OSC 633/133 integration are mutually exclusive per pane.** The first authentic OSC boundary (`promptStart`/`promptEnd`/`commandFinish` always, or a `commandStart` sourced `osc633_boundaries`/`osc133_boundaries`) promotes the pane to **OSC-driven**: `recordTerminalUserInput` early-returns and no further `user_input` `commandStart`/`commandLine` is synthesized, so injected shells never double-count. **The fallback's own synthesized prompt markers carry a `keystrokeHeuristic` flag and must not trigger promotion**, or it would retire the path emitting them. The flag is per-pane runtime state, seeded fresh, cleared on pane reset/removal, **never persisted**; `isPaneOscDriven()` exposes it for `dor ensure --restart` (`docs/specs/dor-cli.md`).

Source of truth: `detectPromptSubmit` in `lib/src/lib/terminal-command-input.ts`, `readLogicalLineFromBuffer` in `lib/src/lib/terminal-buffer-read.ts`, `derivePromptShape` / `extractCommand` in `lib/src/lib/terminal-prompt-shape.ts`, `detectReturnedShellPrompt` / `recordTerminalUserInput` in `lib/src/lib/terminal-state-store.ts`, `stripTerminalControls` and `TerminalControlStreamFilter` (replay seeding only) in `lib/src/lib/terminal-controls.ts`.

### CWD precedence

| Source | Rule |
|---|---|
| `osc7`, `osc9_9`, `osc633`, `osc1337` | Wins over everything. **Once an OSC has reported a directory, only a later OSC can replace it.** |
| `process` | Updates only when the current source is `null`, `manual`, or another `process` reading — **source-based, never time-based**; fills the gap when the shell emits no CWD OSC. |
| `manual` | Initial seed only; replaceable by any later source. |
| (none) | Default `null`. |

**Asynchronous process-CWD results are applied through PTY-id resolution**, so one arriving after a `swap` updates the Session that now owns that PTY, and is dropped if the pane was disposed meanwhile rather than resurrecting it.

## Header Derivation

`DerivedHeader` (`lib/src/lib/terminal-state.ts`) carries the primary label, an optional secondary disambiguator, and `lastCommandFailed`. Richer activity state lives on `pane.activity`, where status grouping reads it.

Header priority — first match wins:

1. User-pinned title.
2. While a command is running (`currentCommand` is set):
   - The alert manager's live `OSC 9` message text, unless the pane's own `osc9` candidate places that message outside the command's window. **With no `osc9` candidate at all the app title is trusted.** (rationale)
   - The newest in-run `OSC 0` / `OSC 2` / `OSC 9` candidate.
   - `currentCommand.displayCommand`.
3. After a command has finished (`currentCommand` null and `lastCommand` set): `<idle> ${LAST_TITLE}`, `LAST_TITLE` applying the same priority to `lastCommand` with the in-run title taken from `lastCommand.finalTerminalTitle` (snapshotted at finish) **so a post-finish title event cannot overwrite it**.

   On a non-zero exit a trailing fail glyph is appended — `<idle> ${LAST_TITLE} ✗` — and `lastCommandFailed` set. **"Failed" requires a real non-zero `exitCode`**: the keystroke fallback never records one, so it shows no glyph either way. **The glyph rides in `primary`**; the pane header colors it red from `lastCommandFailed`. (rationale)
4. Otherwise (no running command and no last command): `<idle>`.

**App-sent titles are filtered before they can override a command label.** A title that is only a bare interpreter name or executable path (`zsh`, `C:\WINDOWS\system32\cmd.exe`) is discarded; cmd.exe's `<path>\cmd.exe - <command>` form is reduced to the `<command>` half; titles carrying arguments or prose (`lazygit: dormouse`, `README.md - VIM`) are kept. (rationale)

**`OSC 99` / `OSC 777` candidates are diagnostics only** (the header context menu's title-candidates table). **Shell titles from outside a command's window — before it started or after it finished — are never promoted**: they neither replace `<idle>` nor pollute `LAST_TITLE`.

**`<idle> ${LAST_TITLE}` persists across prompt/editing transitions** until a new `commandStart` replaces it, keeping visible which program just exited; only a pane with no `lastCommand` shows plain `<idle>`. **Failure is surfaced by the `✗` glyph and nothing more** — output and TODO notification belong to `docs/specs/alert.md`.

Callers showing one Session's label use `deriveSurfaceLabel()` = `deriveHeader` + `resolveDisplayPrimary()`, which substitutes the Session's saved/fallback title when the derived primary is the generic `shell` label. **`<idle>` is never substituted**, so an idle pane is not mislabeled with a stale saved title.

**Duplicate primary labels get a shortest unique directory secondary label** — from `currentCommand.cwdAtStart` while a command runs, else `pane.cwd`.

Source of truth: `deriveHeader` / `deriveSurfaceLabel` / `resolveDisplayPrimary` / `meaningfulTerminalTitle` in `lib/src/lib/terminal-state.ts`.

## Grouping

- **Directory group keys use `cwdIdentity(cwd)`** (`scheme|host|pathKind|path`), so remote hosts and Windows/POSIX path kinds stay distinct. Directory mode keys on `cwdAtStart ?? cwd`; command mode on the running command's `displayCommand`, else the idle label.
- **Windows UNC display labels keep `\\server\share\` as the path root** and do not repeat the server/share in the trailing path segments.
- **`prompt` and `editing` collapse into one `idle` bucket**; **`finished` stays distinct** so a recently-completed pane can be filtered separately though its header label carries the same `<idle>` prefix. `statusBucket` projects the 5 `ShellActivity.kind` values onto 4.

Source of truth: `groupTerminalPanes` / `TerminalGroupingMode` / `cwdIdentity` / `statusBucket` in `lib/src/lib/terminal-state.ts`.
