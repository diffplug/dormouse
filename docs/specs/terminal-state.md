# Terminal CWD and Command State

> See `docs/specs/glossary.md` for Session vocabulary. This spec defines the per-Session terminal semantic state that layout and grouping consume. Alert/TODO behavior and notification OSCs (OSC 9 / 9;4 / 99 / 777 / BEL) live in `docs/specs/alert.md`. The escape-sequence registry and parsing-location rules live in `docs/specs/terminal-escapes.md`.

## Goal

Dormouse models terminal panes by their latest reported working directory, current command line, whether the shell is at a prompt / editing / running a foreground command / waiting after a finish, the command's exit status and start-time directory, and an app-sent title override.

Session CWD and command execution state are separate. `cwd` means "the shell/session reported this directory" — not necessarily the internal CWD of a foreground program. A command snapshots `cwdAtStart` when it starts, and grouping and header disambiguation use that snapshot while the command runs.

## Core Model

`TerminalPaneState` composes CWD, shell activity, pending/current/last command,
and latest/per-source title state. Exact fields and unions are canonical in
`lib/src/lib/terminal-state.ts` (`CwdState`, `ShellActivity`, `CommandRun`, and
`TerminalTitle`).

**Host identity is part of directory identity.** `file://localhost/Users/me/project` and `file://prod-box/home/me/project` are different locations even where their display labels compact to the same thing.

`ShellActivity` is not `isRunning`: the shell process normally keeps running, so the state that matters is whether a foreground command is active.

Terminal title is a label override, not a command lifecycle signal. `title` is the latest title event of any source; `titleCandidates` keeps the latest value per channel with its own timestamp, so app, shell, and user sources stay independently inspectable.

## Normalized Events

All protocol parsing emits the canonical `TerminalSemanticEvent` union in
`lib/src/lib/terminal-state.ts` before feature code sees the state.

Feature code **must** consume `TerminalPaneState` or `TerminalSemanticEvent`, never raw OSC sequences.
Protocol-derived semantic events are timestamped in stream order before they reach the reducer, so command-start boundaries and title candidates from the same PTY chunk remain comparable even when they were parsed in the same millisecond.

`AlertManager` also consumes command lifecycle semantic events for command-exit alerting, but only the ones the protocol parser produced — see `docs/specs/alert.md`.

## Supported OSC Inputs

CWD:

| Sequence | Source | Notes |
|---|---|---|
| `OSC 7 ; file://host/path ST` | `osc7` | Parses as `file:` URI, decodes the path, preserves host. |
| `OSC 9 ; 9 ; <cwd> ST` | `osc9_9` | Windows Terminal / ConEmu-style CWD. Drive-letter and UNC paths are Windows paths; every other path is `unknown`, not `posix` — this channel is a Windows-ism and a lone `/foo` is not evidence of a POSIX shell. |
| `OSC 633 ; P ; Cwd=<cwd> ST` | `osc633` | VS Code-style CWD. |
| `OSC 1337 ; CurrentDir=<cwd> ST` | `osc1337` | iTerm2-style CWD compatibility. |

Non-OSC CWD sources:

- `process` — adapter polled the PTY's process for its working directory. Applied only while no OSC source has ever reported for the pane (see CWD precedence below — the rule is source-based, not time-based).
- `manual` — caller seeded the CWD directly via `cwdFromManualPath()`. `seedTerminalManualCwd()` (session restore) writes it only into a pane that has no CWD yet; `seedLaunchedCommand()` (known spawn directory) emits it as a `cwd` event, which the reducer applies unconditionally — safe only because it runs at spawn, before any OSC has reported.

Command lifecycle:

| Sequence | Event |
|---|---|
| `OSC 133 ; A ST` / `OSC 633 ; A ST` | `promptStart` |
| `OSC 133 ; B ST` / `OSC 633 ; B ST` | `promptEnd` |
| `OSC 133 ; C ST` | `commandStart(source: "osc133_boundaries")` |
| `OSC 633 ; E ; <commandline> [; <nonce>] ST` | `commandLine`; parses only the command field and decodes VS Code `\xAB` / `\\` escapes before storing it. |
| `OSC 633 ; C ST` | `commandStart(source: "osc633_boundaries")`. The reducer re-labels the stored run `osc633_E` when a command line is pending; the *event* source stays a boundary, which is what promotes the pane to OSC-driven (see [Keystroke fallback](#keystroke-fallback)). |
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

Only the OSC 9 *message* form (`OSC 9 ; <message>`) feeds the title channel, taking the notification's body text. The OSC 9 *progress* form (`OSC 9 ; 4 ; <state> ; <progress>`) carries no text payload and contributes no title candidate; its semantics are in `docs/specs/alert.md`.

Non-OSC title source:

- `user` — user-pinned title set via the inline rename UI (`setTerminalUserTitle`). **Always wins** over every other candidate. Titles equal to or starting with `<idle>` are rejected as reserved: they would be indistinguishable from the derived idle header.

The `user_input` command fallback is best effort and renderer-only: enough for headers and grouping, but the `AlertManager` **never** sees it — the store synthesizes those events locally rather than through the protocol parse path that feeds alerts. `docs/specs/alert.md` owns that limitation.

Programmatic interactive launches that write directly to the platform PTY bypass xterm's keystroke fallback, so they **must** emit `commandLine` + `commandStart(source: "user_input")` synchronously before the write — both `dor split/ensure -- <command>` and a cold-restore agent resume use `seedLaunchedCommand`. This keeps headers, grouping, and `countRunningSessions` correct on shells without OSC integration; an integrated shell's later boundaries remain authoritative. Source of truth: `seedLaunchedCommand` and its callers in `lib/src/lib/terminal-state-store.ts` and `lib/src/lib/terminal-lifecycle.ts`.

The parser accepts both BEL and ST terminators and handles split chunks. Supported-but-malformed semantic OSCs are consumed without changing state. Unsupported OSC pass-through vs. consume/ignore behavior is defined centrally in `docs/specs/terminal-escapes.md`.

## Reducer

`reduceTerminalState(state, event)` is the only state transition surface.

### OSC-driven events

- `cwd` replaces the latest session CWD (no-op when both identity and source are unchanged).
- `promptStart` sets `{ kind: "prompt" }`; `promptEnd` sets `{ kind: "editing" }`. Both clear `currentCommand` and `pendingCommandLine`: a prompt boundary is the unambiguous signal that no command is in flight, so pending input never consumed by a `commandStart` is dropped, and a `user_input` run that never got an explicit finish returns the header to `<idle>`.
- `commandLine` stores `pendingCommandLine`.
- `commandStart` creates `currentCommand`, snapshots `cwdAtStart`, uses `event.startedAt` when present, clears `pendingCommandLine`, and sets `{ kind: "running" }`. `displayCommand` is the summarized pending command line; when none is pending (`OSC 133 ; C` carries no command), it falls back to the newest non-user title candidate, then to the literal `shell`.
- `commandFinish` moves `currentCommand` to `lastCommand`, stores `finishedAt`/`exitCode`, snapshots the latest in-run OSC 0/2/9 title into `lastCommand.finalTerminalTitle` (titles older than `startedAt` or younger than `finishedAt` are excluded), clears `currentCommand`, and sets `{ kind: "finished", exitCode }`. With no `currentCommand` it only sets the activity — it never invents a `lastCommand`.
- `title` updates `title` and the per-source entry in `titleCandidates`. Later OSC title events do not erase earlier user, shell, or notification candidates from other sources.

### Keystroke fallback

For shells without OSC 133/633 integration, the command is read from what is on screen rather than reconstructed from keystrokes.

```
idle prompt rendered ──learn──▶ prompt shape (terminator char + repeat count)
Enter (not bracketed paste) + known shape ──parse rendered line──▶ commandLine + commandStart(user_input)
prompt-looking output while a user_input command runs ──▶ synthesized finish → prompt
first authentic OSC boundary ──▶ pane promoted to OSC-driven; fallback retired
```

- **Prompt-shape learning.** The store learns a cwd-invariant prompt **shape** — the prompt's trailing terminator character (`%`, `$`, `#`, `>`, `❯`, `➜`, `λ`) plus how many times that character already appears earlier in the prompt — from every detected idle prompt, including the shell's first prompt at spawn. A prompt with no recognized terminator yields no shape, hence no title, rather than a wrong one.
- **Submit parsing.** On submit (an Enter that is not inside a bracketed paste) it reads the cursor's rendered logical line (`prompt + command`, soft-wrapped rows joined and bounded at the cursor column so zsh-autosuggestions ghost text is excluded) and splits the command off at the shape's terminator occurrence, trimming what follows. A non-empty result emits `commandLine` + `commandStart(source: "user_input")` immediately, so the active command shows without command-start integration. Parsing the rendered line makes the title correct regardless of how the command arrived — typed, history-recalled, or pasted — and independent of the race between shell output and idle detection. Command-internal terminators (`dir > out.txt`) survive because they sit after the prompt's own.
- **Shape survival and reconnect seeding.** The prompt shape survives across commands (it does not reset on `promptStart`/`promptEnd`/`commandStart`) and is pre-seeded from restored scrollback on session restore / VS Code panel reopen, so the first command after a reconnect — when the live shell will not re-emit its prompt — is still titled. Seeding is learn-only and fires no prompt transition.
- **Swap safety.** The fallback resolves the current Session id from the PTY id before recording submit input or prompt-looking output, so drag-to-swap moves the fallback state — including the learned prompt shape — with the visible pane.
- **Synthesized idle transitions.** Visible output that looks like a returned shell prompt always refreshes the learned prompt shape, but **may** synthesize the idle prompt transition only when `currentCommand.source === "user_input"` — shape learning stays available for all shells while finish/start synthesis is scoped to shells that emit no command boundaries of their own.
- **What counts as a returned prompt.** Judged over the last 1024 chars of a pane's output, with alt-screen spans dropped (a TUI's own `$` is not the user's prompt) and presentation controls removed by the shared `stripTerminalControls` (`lib/src/lib/terminal-controls.ts`; its stripping rules, including why an unterminated string control swallows the rest of the window, are specified in `docs/specs/transport.md`). Matching is anchored: PowerShell `PS <path>>`, cmd.exe `<drive>:\...>`, a leading `➜`/`❯`/`λ`, a bare `$`/`#`/`%` final line whose preceding non-blank line carries path/user context, or a generic line carrying a `/`, `~`, `@`, or `:` **and** ending in a prompt char plus space. A custom prompt with neither signal **must not** match: a false positive flips a running command back to idle.
- **Boundary mode, plus a trailing-boundary trim.** Stripping runs in **boundary mode** (every control becomes a line break), as resume detection does: deleting a redraw's cursor move welds text that was never adjacent on screen, so `building...\x1b[1;1HC:\Users\me>` would read as one line starting with `building` and no anchored shape would match. But a boundary is not a real line break, and the difference decides the safe direction: a **genuine** trailing newline means nothing is painted on the current line yet — no prompt — and **must** keep reading as `null`; a **boundary** at the tail means only that a control closed the line, which is what a prompt that clears to end-of-line after painting itself (`C:\Users\me>\x1b[K`) does, and reading that as an empty last line would hide every such prompt. Stripping the same text *without* boundaries leaves exactly the real breaks, which is how the two are told apart. Both directions are pinned by `lib/src/lib/terminal-state-store.test.ts`.
- **Per-pane retirement.** The keystroke fallback and real OSC 633/133 integration are mutually exclusive per pane. The first authentic OSC boundary a pane emits (`promptStart`/`promptEnd`/`commandFinish` always, or a `commandStart` whose event source is `osc633_boundaries`/`osc133_boundaries`) promotes the pane to **OSC-driven**, after which the keystroke path stops recording: `recordTerminalUserInput` early-returns and no further `user_input` `commandStart`/`commandLine` is synthesized, so injected shells never double-count. The synthesized prompt markers the fallback itself emits carry a `keystrokeHeuristic` flag so they **must not** trigger promotion — otherwise the fallback would retire the very path that emits them. The flag is per-pane runtime state, seeded fresh and cleared on pane reset/removal, never persisted. `isPaneOscDriven()` exposes it, because `dor ensure --restart` can only match a surface whose shell re-reports its command (`docs/specs/dor-cli.md`).

Source of truth: submit detection in
`lib/src/lib/terminal-command-input.ts`, rendered-line reading in
`lib/src/lib/terminal-buffer-read.ts`, and prompt derivation in
`lib/src/lib/terminal-prompt-shape.ts`.

### CWD precedence

- OSC-sourced CWD (`osc7`, `osc9_9`, `osc633`, `osc1337`) wins over everything. Once an OSC has reported a directory, only a later OSC can replace it.
- Process-polled CWD (`process`) updates only when the current source is `null`, `manual`, or another `process` reading. It fills the gap when the shell does not emit OSC 7 / 633;P / 1337 / 9;9.
- Manually seeded CWD (`manual`) is the initial seed during session restore or known-spawn-directory launches. It is replaceable by any later source.
- Default is `null`.

Asynchronous process CWD query results are applied through PTY-id resolution, so a result that arrives after `swap` updates the Session that currently owns that PTY — and is dropped entirely if the pane was disposed meanwhile, rather than resurrecting it.

## Header Derivation

The canonical `DerivedHeader` type lives in `lib/src/lib/terminal-state.ts`. It
carries the primary label, an optional secondary disambiguator, and
`lastCommandFailed` — a structured flag set when `primary` ends with the fail
glyph (see below). Richer activity state lives on `pane.activity`; consumers
that need it (status grouping) read it from there.

Header priority — first match wins:

1. User-pinned title.
2. While a command is running (`currentCommand` is set):
   - The alert manager's live `OSC 9` message text, unless the pane's own `osc9` candidate places that message outside the command's window. With no `osc9` candidate at all (a notification injected without going through the parser) the app title is trusted.
   - The newest in-run `OSC 0` / `OSC 2` / `OSC 9` candidate.
   - `currentCommand.displayCommand`.
3. After a command has finished (`currentCommand` is null and `lastCommand` is set): `<idle> ${LAST_TITLE}`, where `LAST_TITLE` follows the same priority applied to `lastCommand`, with the in-run title taken from `lastCommand.finalTerminalTitle` (snapshotted at finish) so a post-finish title event cannot overwrite it.

   When the finished command exited non-zero, a trailing fail glyph (`✗`) is appended — `<idle> ${LAST_TITLE} ✗` — and `lastCommandFailed` is set on the result. "Failed" requires a real non-zero `exitCode`: the keystroke fallback never records one, so it shows no glyph either way. The glyph rides in `primary` so plain-text title consumers (OS/tab titles) carry it, while the pane header reads `lastCommandFailed` to color it red without re-parsing the string.
4. Otherwise (no running command and no last command): `<idle>`.

**App-sent titles are filtered before they can override a command label.** A title that is only a bare interpreter name or executable path (`zsh`, `C:\WINDOWS\system32\cmd.exe`) is discarded: under Windows ConPTY the console title is relayed for every child process whether or not it chose one, so such a title carries no command information. cmd.exe's `<path>\cmd.exe - <command>` form is reduced to the `<command>` half. Titles carrying arguments or prose (`lazygit: dormouse`, `README.md - VIM`) are kept. Source of truth: `meaningfulTerminalTitle()` in `lib/src/lib/terminal-state.ts`.

`OSC 99` / `OSC 777` candidates are diagnostics only (the header context menu's title-candidates table). Shell titles from outside a command's window — before it started, or after it finished — are likewise **never** promoted: they do not replace `<idle>` or pollute `LAST_TITLE`.

`<idle> ${LAST_TITLE}` keeps visible, at a glance, which program just exited. It persists across subsequent prompt/editing transitions until a new `commandStart` replaces it; only a fresh pane (no `lastCommand` at all) shows plain `<idle>`. Failure is surfaced minimally — the `✗` glyph and nothing more; output and TODO notification belong to the alert/TODO machinery (`docs/specs/alert.md`).

Disambiguation:

- Duplicate primary labels get a shortest unique directory secondary label.
- Running commands disambiguate with `currentCommand.cwdAtStart`.
- Panes without a running command disambiguate with `pane.cwd`.

Callers that show one Session's label use `deriveSurfaceLabel()` — `deriveHeader` composed with `resolveDisplayPrimary()`, which substitutes the Session's saved/fallback title when the derived primary is the generic `shell` label. `<idle>` is never substituted, so a genuinely idle pane is not mislabeled with a stale saved title.

## Grouping

- Directory group keys use `cwdIdentity(cwd)` (`scheme|host|pathKind|path`), so remote hosts and Windows/POSIX path kinds stay distinct.
- Windows UNC display labels keep `\\server\share\` as the path root and do not repeat the server/share in the trailing path segments.
- `prompt` and `editing` collapse into a single `idle` bucket: the distinction between "at the prompt" and "typing a command" is not load-bearing for grouping. `finished` stays distinct so a recently-completed pane can be filtered separately even though its header label carries the same `<idle>` prefix.

Source of truth, both in `lib/src/lib/terminal-state.ts`: `groupTerminalPanes()` defines grouping modes (`TerminalGroupingMode`) and per-mode key derivation (directory uses `cwdAtStart ?? cwd`; command uses the running command's `displayCommand`, else the idle label); `statusBucket()` projects the 5 `ShellActivity.kind` values onto 4 buckets.
