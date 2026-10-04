# Terminal CWD and Command State

> - See `docs/specs/glossary.md` for Session vocabulary.
> - Owns the per-Session terminal semantic state that layout and grouping consume, and the shell integration that reports it.
> - **Defers:** alert/TODO behavior and the notification OSCs (OSC 9 / 9;4 / 99 / 777 / BEL) to `docs/specs/alert.md`; the escape-sequence registry and parsing-location rules to `docs/specs/terminal-escapes.md`.

**`cwd` means "the shell/session reported this directory"** — not the internal CWD of a foreground program. **A command snapshots `cwdAtStart` at start**; grouping and header disambiguation use that snapshot while it runs.

## Core Model

`TerminalPaneState`'s canonical types: `lib/src/lib/terminal-state.ts` (`CwdState`, `ShellActivity`, `CommandRun`, `TerminalTitle`).

- **Host identity is part of directory identity**: `file://localhost/Users/me/project` and `file://prod-box/home/me/project` are different locations even where their display labels compact alike.
- **`ShellActivity` is not `isRunning`** — the shell process keeps running; what matters is whether a foreground command is active.
- **Terminal title is a label override, never a command lifecycle signal.** `titleCandidates` keeps the latest value per channel with its own timestamp — the only store of it — so app, shell, and user sources stay independently inspectable; a later title never erases another source's candidate.

**Must transfer semantic state and OSC-driven status at the stream mark, before applying the destination's since-mark replay.** Screen serialization carries no command lifecycle; newer replay events still win, including command finish. Source of truth: `snapshotTerminalState` / `restoreTransferredTerminalState` in `lib/src/lib/terminal-state-store.ts`; tested in `standalone/src/workspace-move.test.ts`.

## Normalized Events

- **Feature code must consume `TerminalPaneState` or `TerminalSemanticEvent`, never raw OSC sequences** — all protocol parsing emits that canonical union (`lib/src/lib/terminal-state.ts`) first.
- **Must timestamp protocol-derived events in stream order before the reducer, across PTY chunks and clock adjustments**, including a stalled or backward clock (pinned by `lib/src/lib/terminal-protocol.test.ts`).
- `AlertManager` consumes command lifecycle events only from the protocol parser (`docs/specs/alert.md` -> "WATCHING Track").

## Supported OSC Inputs

CWD, sourced `osc7`, `osc9_9`, `osc633` (`P ; Cwd=`), `osc1337` (`CurrentDir=`):

- **OSC 7 is parsed as a `file:` URI, its host taken from the URL parser's normalized hostname, preserving raw case and the literal `localhost` spelling only.**
- **OSC 9;9 drive-letter and UNC paths are Windows paths; every other path is `unknown`, never `posix`** (rationale).
- **Must preserve native CWD text, including percent signs, semicolons and edge spaces; percent-decode only OSC 7 file URIs** (rationale).
- `process` — the adapter polled the PTY's process for its working directory.
- `manual` — seeded via `cwdFromManualPath()`. `seedTerminalManualCwd()` (session restore) writes it **only into a pane with no CWD yet**; `seedLaunchedCommand()` (known spawn directory) applies it **unconditionally** — safe only at spawn, before any OSC has reported.

Command lifecycle, for both `OSC 133` and `OSC 633`, as `ShellActivity` (from `unknown`); any event applies in any state:

| Boundary | Event | `ShellActivity` |
| --- | --- | --- |
| `A` | `promptStart` | `prompt` |
| `B` | `promptEnd` | `editing` |
| `C` | `commandStart` | `running` |
| `D` | `commandFinish` | `finished`, with an optional exit code |

**An `A`, a `B`, or another `C` drops a run that saw no `D`**, recording no last command.

`C` and the command line, by emitter:

- `OSC 133 ; C` → `commandStart(source: "osc133_boundaries")`, preceded by `commandLine` when it carries one: fish ≥ 4's percent-encoded UTF-8 `cmdline_url`, else kitty's `printf %q` `cmdline`, which runs to the end of the sequence.
- `OSC 633 ; E ; <commandline> [; <nonce>]` → `commandLine` from the command field alone, decoding VS Code `\xAB` / `\\` escapes.
- `OSC 633 ; C` → `commandStart(source: "osc633_boundaries")`. **The stored run is re-labelled `osc633_E` when a command line is pending; the *event* source stays a boundary**, which is what promotes the pane to OSC-driven ([Keystroke fallback](#keystroke-fallback)).

Titles:

- `OSC 0` / `OSC 2` → `title` sourced `osc0` / `osc2`.
- **Only the OSC 9 *message* form feeds the title channel** (`osc9`, which may override the header); the *progress* form `OSC 9 ; 4` contributes no candidate.
- **`OSC 99` / `OSC 777 ; notify` candidates (`osc99`, `osc777`) are diagnostics only** — the header context menu's title-candidates table, never a header override.
- `user` — pinned via the inline rename UI (`setTerminalUserTitle`). **Always wins** over every other candidate. **Titles starting with `<idle>` are rejected as reserved**.

**A programmatic interactive launch writing directly to the platform PTY must emit `commandLine` + `commandStart(source: "user_input")` synchronously before the write**, through `seedLaunchedCommand` — it bypasses xterm's keystroke fallback; an integrated shell's later boundaries stay authoritative.

**Every semantic value `TerminalProtocolParser` *retains* is bounded and stripped of control characters before storage**, whatever the emitter: `TITLE_LIMIT` / `BODY_LIMIT` for titles and notification bodies, whose whitespace controls collapse to spaces before the trim; `COMMAND_LINE_LIMIT` for the command line (`OSC 633 ; E`, `OSC 133 ; C`), source bounded at 4× `COMMAND_LINE_LIMIT` code points for OSC 633 or shell-quoted input, or 12× for percent-encoded UTF-8, then decoded, sanitized, and capped at `COMMAND_LINE_LIMIT` code points (rationale), **line breaks kept as `\n`**; `MAX_CWD_LENGTH` for every CWD source, interior whitespace preserved. **Semantic value limits count code points**, so a cut never splits a surrogate pair. **A value that reduces to nothing is dropped, never stored empty.**

**Supported-but-malformed semantic OSCs are consumed without changing state.**

Source of truth: `TerminalProtocolParser` / `commandLineEvents` in `lib/src/lib/terminal-protocol.ts`; `fileUriHost` / `cwdFromManualPath` / `boundedCwdValue` in `lib/src/lib/terminal-state.ts`; `seedTerminalManualCwd` and `seedLaunchedCommand` in `lib/src/lib/terminal-state-store.ts`.

## Shell-integration injection

**Dormouse injects its own shell integration when it spawns a shell** (rationale); the scripts emit the `OSC 633` boundaries above (`A`, `B`, `C`, `D;<exit>`, `E`, `P;Cwd=`). **Injection is fail-safe**: missing scripts skip it and the shell spawns as before, on the [Keystroke fallback](#keystroke-fallback). An env channel fires as reliably as the `PATH` prepend; an args channel only for the launch shapes below (rationale).

| Shell | Channel | Injected when |
|---|---|---|
| zsh | env (`ZDOTDIR`) | Always. **Nothing may be written into that directory at runtime** — it ships inside the signed macOS bundle (`.zshrc` has the why). |
| bash | args (`--init-file`) | **The launch args are only `-i` / `-l` / `--login`** — Git Bash's `--login -i` included, a `-c <cmd>` not (rationale). |
| PowerShell (`pwsh`, `powershell.exe`) | args (dot-source via `-Command`) | **A bare launch or one carrying `-NoExit`, unless it uses `-File` / `-EncodedCommand`**; appended after any startup command it carries (rationale). |
| WSL | args (a `sh -c` detector inside the distro, reaching the bash script by its `/mnt/...` path) | **Only the exact two-argument `-d <distro>` launch.** **bash is the only integrated WSL shell** (rationale). |
| cmd.exe | — | Never: always the keystroke fallback, with no exit codes. |

**bash's `E` is the submitted line, read back from history only when the last entry provably is it, else its first simple command** (`$BASH_COMMAND`) (rationale).

**Both distributions ship the scripts**: standalone per `docs/specs/standalone.md` -> "Build and development", the VS Code build into `dist/shell-integration`, which the host names in `DORMOUSE_SHELL_INTEGRATION_DIR`.

**Emitted fields must be filtered before they are written — a security boundary.** An attacker-chosen directory name or command can carry an OSC terminator (BEL, `ESC \`, or the C1 ST `U+009C`) that ends the `633` sequence early, so the remainder arrives as a fresh, fully-trusted OSC. **The parser cannot defend against this** — it scans raw bytes (rationale). The field grammar the parser decodes:

- **`E` escapes** BEL, ESC and the C1 ST alongside `\`, `;`, LF and CR; the parser decodes `\xNN` back, so it still reports verbatim.
- **`Cwd=` is read verbatim**, no `\xNN` decoding, so a Windows path's backslashes arrive intact — its control characters are therefore *removed*, not escaped.

Source of truth: `applyShellIntegration` in `standalone/sidecar/pty-core.js`; the scripts under `standalone/sidecar/shell-integration/`; pinned by `standalone/sidecar/shell-integration.test.js`.

## Reducer

`reduceTerminalState(state, event)` is the only state transition surface.

### OSC-driven events

- **`promptStart` and `promptEnd` clear the running command and any pending command line** (rationale).
- **A `commandStart` with no pending command line** (a bare `OSC 133 ; C`) takes its `displayCommand` from the newest OSC 0/2/9 title candidate, else the literal `shell`.
- **`commandFinish` snapshots the latest in-run OSC 0/2/9 title into `lastCommand.finalTerminalTitle`; with no `currentCommand` it only sets the activity**, never inventing a `lastCommand`.

**Must tokenize without selecting a shell dialect, and read back exactly the `POSIX_ESCAPABLE` set that `shellEscapePosix` writes.** **Must derive the same suffix-free program name for headers, WATCHING keys, and terminal context**: `npm.cmd` and `C:\tools\claude.exe` become `npm` and `claude`; launcher variants in one directory cannot be watched separately. (rationale)

**`displayCommand` is a one-line, per-program summary of those tokens.**

Source of truth: `reduceTerminalState` / `tokenizeCommand` / `commandProgramName` / `summarizeCommandLine` in `lib/src/lib/terminal-state.ts`; `POSIX_ESCAPABLE` in `lib/src/lib/posix-escape.ts`; pinned by `lib/src/lib/terminal-state.test.ts`.

### Keystroke fallback

For shells without OSC 133/633 integration, the command is read off the screen rather than reconstructed from keystrokes (rationale). **It is best effort and renderer-only.**

- **Prompt shape.** Every detected idle prompt — the shell's first at spawn included — teaches a cwd-invariant shape keyed on the prompt's trailing terminator. **A prompt with no recognized terminator yields no shape**, hence no title rather than a wrong one.
- **Submit.** On an Enter outside a bracketed paste, the command is split off the cursor's rendered logical line at the shape. **A non-empty result emits `commandLine` + `commandStart(source: "user_input")` immediately, and nothing further while it is current** — keystrokes into a running program are not submissions.
- **The shape survives across commands and is pre-seeded from replay during resume**, including VS Code panel reopen; cold restore has no transcript to seed from. **Seeding is learn-only and fires no prompt transition.** (rationale)
- **Must key fallback state, including learned prompt shapes, by the stable Session id** (`docs/specs/layout.md` → Session lifecycle and terminal registry).
- **A returned prompt may synthesize the idle transition only when `currentCommand.source === "user_input"`**; prompt-looking output always refreshes the shape. (rationale)
- **What counts as a returned prompt.** Judged over a bounded tail of `TerminalProtocolParseResult.textData`, never the raw chunk (rationale), **with alternate-screen spans (DEC modes 47/1047/1049) removed statefully before truncation, across chunk and command boundaries; RIS resets this state** (rationale). **Matching is anchored to a fixed set of prompt shapes; a custom prompt carrying neither a path/user signal (`/`, `~`, `@`, `:`) nor a recognized terminator must not match**, a false positive flipping a running command back to idle.
- **Stripping runs in boundary mode** (`docs/compatible-agents.md` → "Detection"): **a genuine trailing newline must keep reading as no prompt, a trailing boundary must not**; both directions pinned by `lib/src/lib/terminal-state-store.test.ts` (rationale).
- **Per-pane retirement.** **The keystroke fallback and real OSC 633/133 integration are mutually exclusive per pane.** The first authentic boundary (`promptStart`/`promptEnd`/`commandFinish` always, or a `commandStart` sourced `osc633_boundaries`/`osc133_boundaries`) promotes the pane to **OSC-driven**, after which no `user_input` event is synthesized, so injected shells never double-count. **The fallback's own synthesized prompt markers must not trigger promotion.** The flag is per-pane runtime state, **never persisted**; `isPaneOscDriven()` exposes it for `dor ensure --restart` (`docs/specs/dor-cli.md`; rationale).

Source of truth: `recordTerminalUserInput` / `recordTerminalOutput` / `seedPromptShapeFromScrollback` in `lib/src/lib/terminal-state-store.ts`.

### CWD precedence

| Source | Rule |
|---|---|
| `osc7`, `osc9_9`, `osc633`, `osc1337` | Wins over everything. **Once an OSC has reported a directory, only a later OSC can replace it.** |
| `process` | Updates only when the current source is `null`, `manual`, or another `process` reading — **source-based, never time-based**; fills the gap when the shell emits no CWD OSC. |
| `manual` | Initial seed only; replaceable by any later source. |
| (none) | Default `null`. |

**Must apply asynchronous process-CWD results to their originating Session and drop results for a disposed Session** (pinned by `lib/src/lib/terminal-state-store.test.ts`).

Source of truth: `processCwdMayReplace` in `lib/src/lib/terminal-state.ts`, applied by `updateCwdIfAllowed` in `lib/src/lib/terminal-state-store.ts`.

## Header Derivation

`DerivedHeader` and its fields are canonical in `lib/src/lib/terminal-state.ts`; status grouping reads `pane.activity`.

Header priority — first match wins:

1. User-pinned title.
2. While a command is running (`currentCommand` is set):
   - The alert manager's live `OSC 9` message text, unless the pane's own `osc9` candidate places that message outside the command's window. **With no `osc9` candidate at all the app title is trusted.** (rationale)
   - The newest in-run `OSC 0` / `OSC 2` / `OSC 9` candidate.
   - `currentCommand.displayCommand`.
3. After a command has finished (`currentCommand` null and `lastCommand` set): `<idle> ${LAST_TITLE}`, `LAST_TITLE` applying the same priority to `lastCommand` with the in-run title taken from `lastCommand.finalTerminalTitle` **so a post-finish title event cannot overwrite it**.

   On a non-zero exit a trailing fail glyph is appended — `<idle> ${LAST_TITLE} ✗` — and `lastCommandFailed` set. **"Failed" requires a real non-zero `exitCode`**: the keystroke fallback never records one, so it shows no glyph either way. **The glyph rides in `primary`** and is the header's only failure signal. (rationale)
4. Otherwise (no running command and no last command): `<idle>`.

**Must filter app-sent title overrides.** A bare interpreter name or executable path (`zsh`, `C:\WINDOWS\system32\cmd.exe`) is discarded; cmd.exe's `<path>\cmd.exe - <command>` form is reduced to the `<command>` half; titles carrying arguments or prose (`lazygit: dormouse`, `README.md - VIM`) are kept. (rationale)

**Shell titles from outside a command's window — before it started or after it finished — are never promoted**: they neither replace `<idle>` nor pollute `LAST_TITLE`.

**`<idle> ${LAST_TITLE}` persists across prompt/editing transitions** until a new `commandStart` replaces it, keeping visible which program just exited; only a pane with no `lastCommand` shows plain `<idle>`.

Callers showing one Session's label use `deriveSurfaceLabel()` = `deriveHeader` + `resolveDisplayPrimary()`, which substitutes the Session's saved/fallback title when the derived primary is the generic `shell` label. **`<idle>` is never substituted**, so an idle pane is not mislabeled with a stale saved title.

**Duplicate primary labels get a shortest unique directory secondary label** — from `currentCommand.cwdAtStart` while a command runs, else `pane.cwd`.

Source of truth: `deriveHeader` / `deriveSurfaceLabel` / `resolveDisplayPrimary` / `meaningfulTerminalTitle` in `lib/src/lib/terminal-state.ts`.

## Grouping

- **Directory group keys use `cwdIdentity(cwd)`** (`scheme|host|pathKind|path`), so remote hosts and Windows/POSIX path kinds stay distinct. Directory mode keys on `cwdAtStart ?? cwd`; command mode on the running command's `displayCommand`, else the idle label.
- **Windows UNC display labels keep `\\server\share\` as the path root** and do not repeat the server/share in the trailing path segments.
- **`prompt` and `editing` collapse into one `idle` bucket**; **`finished` stays distinct** so a recently-completed pane can be filtered separately though its header label carries the same `<idle>` prefix.

Source of truth: `groupTerminalPanes` / `TerminalGroupingMode` / `cwdIdentity` / `statusBucket` in `lib/src/lib/terminal-state.ts`.

## Terminal context diagnostics

**Must derive title explanation from the header's winning-title functions**, including user override, eligible OSC candidate, notification title, and command fallback. Retain the last command's captured title when later shell OSCs replace live candidates; the diagnostic table is not an OSC history.

**Must abbreviate home only at a complete path boundary**, retaining the absolute path for copying and native directory operations. Compare helper and source host identity as well as directory paths.

Source of truth: `explainTerminalTitle` / `cwdDisplay` in `lib/src/lib/terminal-state.ts`; `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`.

## Future

**Scope: fish-integration**

- **fish shell integration** — inject via `XDG_DATA_DIRS`: fish auto-sources `*/fish/vendor_conf.d/*.fish`, so the integration ships as a vendor conf file (env channel, as reliable as the `PATH` prepend). Until it lands, fish ≥ 4 reports `OSC 133` itself, command line included, and older fish uses the keystroke fallback.
