# Terminal Escape Sequence Registry

> See `docs/specs/glossary.md` for the Session vocabulary used when a row talks about replay or resumed Sessions.

> Single registry of the escape sequences Dormouse parses, answers, or deliberately ignores. Its value is being exhaustive: every sequence Dormouse intervenes in has one row below, pointing at the spec that owns its behavior — `docs/specs/alert.md` (notifications), `docs/specs/terminal-state.md` (CWD, prompt/command, titles), `docs/specs/mouse-and-clipboard.md` (mouse modes, paste). It also documents Dormouse's iTerm2 self-identification, because that identity is what provokes most of these sequences at us.

## Families

- **CSI** (`ESC [`, or the C1 `U+009B`) — screen control: cursor, SGR, scrolling, mode switches, key encoding. xterm.js owns all of it except the cases in [Supported CSI](#supported-csi).
- **OSC** (`ESC ]`, or the C1 `U+009D`) — out-of-band metadata for the emulator itself: titles, CWD, notifications, hyperlinks, clipboard, prompt markers. String payload terminated by `BEL` (`\x07`), `ST` (`ESC \`), or the C1 ST `U+009C`; the parser accepts all three for every sequence and handles OSCs split across PTY reads. See [Supported OSCs](#supported-oscs).
- **DCS** (`ESC P`) — the shape of Dormouse's `CSI > q` answer, and one of the reply families the replay filter drops wholesale.

## Parsing location

State-driving and security-sensitive OSCs — plus the `CSI > q` query — are parsed at the PTY data boundary in the platform adapter:

- VS Code: in the extension host, in `vscode-ext/src/message-router.ts` (a parser per PTY, fed from `ptyManager.addCallbacks`), before `pty:data` is forwarded to any webview.
- Standalone, browser-sidecar and fake adapters: in the frontend adapter, before xterm.js sees the bytes.

An unterminated OSC is buffered across chunks up to `OSC_INCOMPLETE_LIMIT` (16 KiB); past that the held bytes are dropped rather than buffered without bound, so a hostile never-terminated OSC cannot grow the parser's state.

There is one further parse site, and it is **strip-only**: the remote Host in the Tauri sidecar runs a second parser over each PTY it streams to a phone (`lib/src/host/remote/pty-strip.ts`, tapped in `lib/src/host/remote/sidecar-entry.ts`). The phone must see what the laptop's own xterm sees, and in standalone the stripping happens in the frontend adapter, which the sidecar's stream never passes through. Every event that parser produces is discarded — **responses included**: the webview that owns the terminal already answers, and a second answer would write duplicate bytes into the PTY's input. That is why it is constructed with a constant color provider: a query the parser *declines* stays in `visibleData` and reaches the phone's xterm, which answers it, so OSC 10/11/12 queries must be consumed here even though the reply is thrown away. The VS Code Host needs no such parser — the extension host already parsed the chunk once and streams the processed output (see [vscode.md](vscode.md)).

### `pty:data` strip semantics

After parsing, supported sequences are **consumed and not re-emitted** — including the ones whose payload turns out to be empty or unparseable, and every unrecognized `OSC 1337` subcommand. `OSC 8` hyperlinks are the one exception: they stay in `pty:data` so xterm.js owns hyperlink regions and hover rendering, while Dormouse supplies the activation-confirmation handler. The [known-unimplemented](#known-unimplemented-iterm2-and-clipboard-capable-sequences) `OSC 50` / `OSC 52` are also consumed. Every other OSC family passes through to xterm.js unchanged, so xterm.js can handle standard behavior Dormouse does not model.

The platform then sends two streams to the webview:

- `pty:data` — terminal output with supported OSCs already stripped and `OSC 8` preserved. Feeds xterm.js.
- `terminal:semanticEvents` — normalized semantic events (CWD, prompt/command boundaries, titles). Feeds `TerminalPaneState`; command boundaries also feed the command-exit alert track in [alert.md](alert.md#command-exit-track).

Notification-derived state is delivered through `AlertManager` calls / `alert:state` messages, not through `pty:data`.

The parser also classifies each chunk for quiesce-detector purposes: the activity monitor's `onData()` is called only when `visibleData` is non-empty, so a chunk of nothing but notification/progress OSCs does not count as meaningful output, while visible output alongside them does.

For replay (`pty:replay`), the frontend re-parses the buffered raw stream during reconstruction so semantic state repopulates and OSCs are stripped before xterm sees them. Replay must not re-fire alerts, quiesce events, protocol notifications, or query responses: the replay path applies only the semantic events and drops the rest, so a resumed Session does not re-ring or answer a long-dead query on every reload.

## Supported OSCs

| Sequence | Purpose | Spec |
|---|---|---|
| `BEL` (standalone, outside an OSC) | Generic terminal-bell notification | [alert.md](alert.md#terminal-reports) |
| `OSC 0 ; <title> ST` | Window/icon title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 2 ; <title> ST` | Window title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 7 ; file://host/path ST` | CWD (xterm-style URI) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 8 ; <params> ; <URI> ST ... OSC 8 ; ; ST` | Explicit hyperlink region; the only supported OSC passed through to xterm.js, then opened only after a confirmation dialog. | This spec |
| `OSC 10 ; ? ST` / `OSC 11 ; ? ST` / `OSC 12 ; ? ST` | Foreground / background / cursor color **query**. Dormouse consumes it and answers `OSC <code> ; rgb:RRRR/GGGG/BBBB ST` (each 8-bit channel doubled) from the active terminal theme, so background-detecting TUIs (e.g. Codex's adaptive composer "pill") see the real colors instead of assuming dark. Only the `?` (report) form is intercepted; color *set* requests pass through. Where the theme comes from: standalone reads it directly (`getTerminalTheme()`), VS Code pushes it up from the webview ([vscode.md](vscode.md#osc-color-query-answering)). While the theme is unknown or unparseable the query falls through to xterm.js. | This spec |
| `OSC 9 ; <message> ST` | iTerm2 legacy notification | [alert.md](alert.md#terminal-reports) |
| `OSC 9 ; 4 ; <state> [; <progress>] ST` | iTerm2 progress | [alert.md](alert.md#terminal-reports) |
| `OSC 9 ; 9 ; <cwd> ST` | CWD (Windows Terminal / ConEmu) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 99 ; <metadata> ; <payload> ST` | kitty desktop notification. Dormouse also **answers** the `p=?` capability query with `OSC 99 ; [i=<id>:]p=? ; o=always:p=title,body ST`. | [alert.md](alert.md#terminal-reports) |
| `OSC 133 ; A/B/C/D [...] ST` | Prompt/command boundaries; command-exit alert input | [terminal-state.md](terminal-state.md#supported-osc-inputs), [alert.md](alert.md#command-exit-track) |
| `OSC 633 ; A/B/C/D ST` | VS Code prompt/command boundaries; command-exit alert input | [terminal-state.md](terminal-state.md#supported-osc-inputs), [alert.md](alert.md#command-exit-track) |
| `OSC 633 ; E ; <commandline> [; <nonce>] ST` | VS Code command line | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 633 ; P ; Cwd=<cwd> ST` | CWD (VS Code) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 777 ; notify ; <title> ; <body> ST` | rxvt/WezTerm notification | [alert.md](alert.md#terminal-reports) |
| `OSC 1337 ; CurrentDir=<cwd> ST` | CWD (iTerm2 compatibility) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |

(`BEL` is not itself an OSC; it has a row because a standalone `BEL` is parsed and stripped at the same boundary as the OSCs. A `BEL` that terminates an OSC is part of that sequence, never a bell.)

Some sequences are dual-purpose. The notification rows for `OSC 9 ; <message>`, `OSC 99` (`p=title`/`p=body`), and `OSC 777 ; notify` also feed the title-candidate channel in [terminal-state.md](terminal-state.md#supported-osc-inputs). Only the OSC 9 *message* form can become a header/door label; OSC 99 and OSC 777 candidates are stored only for the diagnostic title-candidates table in the header context menu. The OSC 9 *progress* form (`OSC 9 ; 4`) carries no text and never contributes a title candidate.

#### OSC color queries on Windows require the bundled ConPTY

OSC 10/11/12 answering only works if the program's query actually reaches the consumer. On Windows that depends on the ConPTY backend node-pty uses: the **in-box `CreatePseudoConsole`** silently swallows color queries (they never reach the consumer, so nothing can answer and TUIs fall back to a dark background), while node-pty's **bundled OpenConsole** (`conpty.dll`) forwards them — the same passthrough Windows Terminal relies on. So `pty-core.js` spawns with `useConptyDll: true` on Windows. That requires `node-pty/prebuilds/<arch>/conpty.node` plus its sibling `conpty/{conpty.dll,OpenConsole.exe}` to ship: standalone bundles them via the Tauri `resources: ["../sidecar/**/*"]` glob; the VS Code extension via `cp -RL node_modules/node-pty dist/node-pty`. macOS/Linux PTYs forward queries natively, so the flag is Windows-only. It also has an installer consequence on Windows — see [auto-update.md](auto-update.md#sidecar-teardown-on-windows).

### OSC 8 hyperlinks

`OSC 8 ; <params> ; <URI> ST` starts a hyperlink region and `OSC 8 ; ; ST` closes it. Dormouse parses neither `params` nor URI at the PTY boundary; it passes the sequence through to xterm.js.

`terminal-lifecycle.ts` sets xterm.js's `linkHandler` so activation never opens directly — every click routes to Dormouse's external-link confirmation dialog with the URI *and* the link's rendered display text, read back out of the buffer range xterm supplies. The dialog shows the full target, and picks one of three states:

- **Openable** — cancel plus a primary open action, labelled by scheme (`Open URL` / `Open file` / `Open email` / the raw `scheme:`). Openable means any absolute URI with a scheme: `http:`, `https:`, `mailto:`, `file:`, custom app schemes such as `vscode:`.
- **Deceptive** — the display text is URL-shaped (a full URL or a bare domain) but resolves to a different host than the target. **There is no open action at all**: the only actions are close and "Copy deceptive URL to clipboard", and the copy button takes initial focus so a reflexive Enter cannot open anything. A label that merely differs from the URL (a human phrase, or a sibling URL on the same host) is *plain*, not deceptive, and stays openable.
- **Blocked** — malformed URIs, control-character-bearing targets, and browser-executable or opaque pseudo-schemes (`javascript:`, `data:`, `blob:`, `about:`). Not silently dropped: the dialog still opens, showing the full target and the reason, with close as the only action.

Cancel/close is the safe default everywhere else, and long targets wrap and scroll rather than truncate so a deceptive target cannot hide past the fold. Every adapter revalidates through `normalizeExternalUri` before opening (VS Code in the extension host before `vscode.env.openExternal`); the dialog is a user-consent affordance, not the security boundary. Source of truth: `lib/src/lib/external-links.ts`, `lib/src/lib/external-link-confirmation.ts`, `lib/src/components/ExternalLinkModal.tsx`.

## Supported CSI

The vast majority of CSI handling is delegated to xterm.js. Dormouse only intervenes in the cases below — to answer a query itself, to observe a state change xterm.js processes, to enable an xterm.js feature, or to filter replay output.

| Sequence | Role | Disposition | Where |
|---|---|---|---|
| `CSI > q` | iTerm2 extended device-attributes query | Answered with `DCS > \| iTerm2 <version> ST` at the PTY boundary and stripped; not forwarded to xterm.js. Both `ESC [ > q` and the C1 `U+009B > q` form are recognized. | [iTerm2 identity](#iterm2-identity) |
| `CSI ? ... h` (DECSET) / `CSI ? ... l` (DECRST) | Private-mode set/reset, including mouse tracking and bracketed paste | Observed via xterm.js parser hooks that return false (xterm still handles the sequence); the mouse-selection store reads `terminal.modes` in a microtask. | [mouse-and-clipboard.md](mouse-and-clipboard.md), `lib/src/lib/mouse-mode-observer.ts` |
| Kitty keyboard protocol | Disambiguated key-event reporting (CSI u with modifiers, e.g. Shift+Enter distinguishable from Enter) | Enabled by passing `vtExtensions: { kittyKeyboard: true }` to the xterm.js `Terminal` constructor; xterm.js handles the push/pop (`CSI > u` / `CSI < u`) and the modified key reports. | `lib/src/lib/terminal-lifecycle.ts` |
| `CSI ? 9001 h/l` (win32-input-mode) | Faithful Win32 `INPUT_RECORD` key reporting for ConPTY apps that read via the Console API (e.g. Codex on Windows), which cannot negotiate the kitty protocol there. Without it a key like Shift+Enter or Ctrl+J reaches the app as a bare byte, or not at all. | Advertised **only on Windows** (`vtExtensions: { win32InputMode: IS_WINDOWS }`); xterm.js then emits `CSI Vk;Sc;Uc;Kd;Cs;Rc _` key records. **Mutually exclusive with the kitty protocol** — xterm.js gives win32-input-mode precedence per keypress — and ConPTY's conhost enables it proactively, so a per-pane arbiter watches `CSI > … u` / `CSI < … u` (counting nested pushes, honoring the pop count) and toggles the option off while any kitty consumer is on the stack. That way kitty TUIs (Claude Code) and win32 TUIs (Codex) both work in the same window. | `lib/src/lib/keyboard-protocol-arbiter.ts` |

### Report filtering on the input side

Everything xterm.js emits on `onData` is candidate PTY input, including *replies* it generates itself. Three filters in `lib/src/lib/terminal-report-filter.ts` sit on that path. The two classifiers tokenize the chunk and require **every** token to match, so a report glued onto real keystrokes is never mistaken for one.

- **`inputIsReplayTerminalReport`** — dropped outright while `isReplaying`. Replayed scrollback often contains terminal-generated replies from a long-dead app; routing them into the freshly spawned shell would corrupt its input buffer. Shapes: cursor-position / device-status (`CSI [?]<params> R` / `n`), device attributes (`CSI [?>=]<params> c`), window-manipulation reports (`CSI <params> t` / `x`), DECRQSS reports (`CSI [?]<params> $y`), focus in/out (`CSI I` / `CSI O`), and OSC or DCS replies of any shape. It also gates the untouched-session flag ([layout.md](layout.md)).
- **`inputIsSyntheticTerminalReport`** — the broader "this chunk is machine-generated" check (any chunk built only of CSI, SS3 `ESC O <final>`, or OSC tokens). Not dropped; it suppresses input recording and alert attention for that chunk.
- **`stripMouseReportsFromInput`** — removes X10 (`CSI M <3 bytes>`), SGR (`CSI < b;x;y M/m`) and urxvt (`CSI b;x;y M`) mouse reports while a mouse-mode override is active, so a report that slips past the DOM-level intercept never reaches the PTY ([mouse-and-clipboard.md](mouse-and-clipboard.md)).

User keyboard escape sequences — arrows, function keys, bracketed paste, kitty modified-key reports, and win32-input-mode key records (`CSI …_`) — must not be swallowed by any of these.

### Replay-time mode-reset tail (Dormouse-emitted)

Saved scrollback can end mid-TUI with private modes still latched. Replaying it verbatim re-applies those DECSETs with no process alive to ever DECRST them, so a restored pane can be stuck in mouse-tracking mode, the alt-screen, or with the cursor hidden. After a **dead** session's scrollback replays, Dormouse writes a fixed reset tail (`REPLAY_MODE_RESET`): exit alt-screen (`CSI ? 1049/47/1047 l`), disable mouse tracking (`CSI ? 9/1000/1002/1003 l`), disable mouse encodings (`CSI ? 1005/1006/1015 l`), focus reporting off (`CSI ? 1004 l`), bracketed paste off (`CSI ? 2004 l` — the new shell re-enables it at its prompt), show cursor (`CSI ? 25 h`), application cursor keys off (`CSI ? 1 l`), and `SGR 0`. The only DECSET in the tail is show-cursor; everything else is a DECRST or SGR reset.

The tail rides along with a replay, so it is emitted from exactly one place: `resumeTerminal` when `exitInfo.alive` is false. It is **never** emitted on a live resume (a VS Code webview reattaching to a still-running PTY), where the running process legitimately owns its modes; and a cold `restoreTerminal` needs none, because scrollback is not persisted and nothing is replayed there at all. It is written inside `writeReplay`, so `isReplaying` covers it and the replay filter above drops any report it provokes; the mouse-mode observer's parser hooks fire on the DECRSTs and re-sync the mouse-selection store to `none`. Source of truth: `lib/src/lib/terminal-report-filter.ts` (`REPLAY_MODE_RESET`), applied in `lib/src/lib/terminal-lifecycle.ts`.

### Pass-through and fail-inertly

Unknown CSI sequences pass through to xterm.js so it can handle standard terminal behavior Dormouse does not model. The same fail-inertly rule that applies to OSCs (see [iTerm2 identity](#iterm2-identity)) applies to CSIs: any sequence that xterm.js does not recognize must be consumed silently — no visible terminal garbage, no clipboard or file access, no focus changes, no other side effects.

## iTerm2 identity

Dormouse reports an iTerm2-compatible identity so that tools (shells, build systems, agent clients) emit the iTerm2-style escape codes this spec set supports. One compatibility version is used across env and device responses: `ITERM2_COMPAT_VERSION`, currently `3.5.0`, defined twice — in `standalone/sidecar/pty-core.js` and `lib/src/lib/terminal-protocol.ts` — pinned together by `lib/src/lib/mirrored-constants.test.ts`.

Environment for spawned PTYs:

| Variable | Value |
|---|---|
| `TERM_PROGRAM` | `iTerm.app` |
| `TERM_PROGRAM_VERSION` | the compatibility version, not Dormouse's package version |
| `LC_TERMINAL` | `iTerm2` — set unconditionally, since some real-world shell integrations key off it rather than `TERM_PROGRAM` |
| `LC_TERMINAL_VERSION` | the same compatibility version |
| `COLORTERM` | `truecolor`. The PTY is spawned as `xterm-256color` with no other depth hint, so env-sniffing tools (e.g. `supports-color`) would otherwise quantize RGB output to the nearest palette entry. This is a color-*depth* signal, **independent** of the light/dark *background* detection driven by the OSC color queries above, and not iTerm2-specific. |

On `CSI > q`, Dormouse responds with `DCS > | iTerm2 <version> ST`, matching iTerm2's extended device-attributes shape. Feature-specific support is never advertised until the behavior exists.

Because this identity can cause tools to emit more iTerm2 escape codes than Dormouse implements, **unsupported escape codes must fail inertly**: consume or ignore them without visible terminal garbage, privilege escalation, clipboard access, file access, or focus stealing. This applies to both OSC and CSI (see [Known-unimplemented iTerm2 and clipboard-capable sequences](#known-unimplemented-iterm2-and-clipboard-capable-sequences) and [Pass-through and fail-inertly](#pass-through-and-fail-inertly)).

## Shell-integration injection

The iTerm2 identity makes well-behaved tools emit OSC 633/133 *if their own shell integration is loaded* — but most shells don't emit prompt/command boundaries on their own. So Dormouse injects its own integration when it spawns a shell, making the shell emit the `OSC 633` family (`A`/`B` prompt boundaries, `C` command start, `D;<exit>` command finish, `E;<commandline>`, `P;Cwd=`) that the parser above already consumes. This is the *emit* side of OSC 633; the parser is the *consume* side.

A binary on `PATH` only has to be **found**, so it injects via one env var (`DORMOUSE_CLI_BIN` → `PATH`). OSC 633 is different: the shell must **run hook code on every prompt**, which no single env var enables. The reliable per-shell mechanism therefore differs by shell:

| Shell | Mechanism | Channel | Notes |
|---|---|---|---|
| zsh | `ZDOTDIR` → our dotfiles chain to the user's, then install `precmd`/`preexec` hooks | env (as reliable as the `PATH` prepend) | User's real `ZDOTDIR` is passed through as `USER_ZDOTDIR`; our `.zshrc` hands `ZDOTDIR` back so `.zlogin` and child shells are unaffected. Our `.zshenv`/`.zprofile` re-pin `ZDOTDIR` to ours after sourcing the user's, so a user file that reassigns it can't divert zsh away from our `.zshrc`. **Nothing may be written into our directory when shipped** — it sits inside the signed macOS app bundle, and any added file breaks the code signature (Gatekeeper then reports the app "damaged"). macOS `/etc/zshrc` runs while `ZDOTDIR` still points at our directory and sets `HISTFILE` inside it; our `.zshrc` redirects such a `HISTFILE` to `USER_ZDOTDIR` after sourcing the user's rc (a user-set `HISTFILE` is never touched). |
| bash | `--init-file` → our script replicates login-profile sourcing, then installs a `DEBUG`-trap / `PROMPT_COMMAND` hook | shellArgs | `--init-file` and login mode are mutually exclusive, so Dormouse drops `-l` and the script sources `/etc/profile` + the user's profile itself. Injected whenever the launch args are *only* interactive/login flags (`-i`/`-l`/`--login`) — so Git Bash, launched with `--login -i`, is covered too; a specific invocation like `-c <cmd>` is left untouched. Written for bash 3.2 (macOS system bash): no `PS0`, no array `PROMPT_COMMAND`. The `E` command line is the first simple command of a pipeline (a `DEBUG`-trap limitation); boundaries and exit codes stay exact. |
| PowerShell | `-Command ". '<script>'"` → the dot-sourced script wraps the user's `prompt` and PSReadLine's `PSConsoleHostReadLine` (covers `pwsh` and Windows `powershell.exe`) | shellArgs | `-NoProfile` is *not* passed, so the user's profile loads and defines their prompt before we wrap it. Injected for any **interactive** launch: a bare REPL gets `-NoExit -Command ". '<script>'"`, and a launch that already runs a startup command — e.g. the VS "Developer PowerShell" (`-NoExit -Command "& { Import-Module … }"`) — gets our dot-source *appended* to that command, so its environment is set up first and our wrapper installs after it. Non-interactive one-offs (a `-Command`/`-File`/`-EncodedCommand` without `-NoExit`) are left untouched. PowerShell has no `preexec`, so `E`/`C` are emitted by wrapping `PSConsoleHostReadLine`, which runs just before a submitted command executes — so the running command shows immediately, like bash/zsh. The matching `D` (exit code from `$?`/`$LASTEXITCODE`) is emitted from the next `prompt` render. If PSReadLine is absent, the whole `E`/`C`/`D` triple is reported from the next prompt instead (command line from history): boundaries and exit codes stay exact, but the running command isn't shown until it finishes. |
| WSL | `wsl.exe -d <distro> -- sh -c <detector>` → the detector execs the distro's bash with our `--init-file` (the Windows bash script, referenced via its `/mnt/...` path) | shellArgs | Windows-side injection can't reach the Linux shell, so we append a command. The detector reads the login shell from `/etc/passwd`: it steps aside for an explicit zsh/fish login shell, execs bash+integration when bash exists (covering bash and an empty detection — the safe default), and falls back to the login shell only when bash is absent (e.g. Alpine). bash is the only WSL shell integrated for now. Assumes the default `/mnt` automount root. |
| cmd.exe | no per-command hook exists | — | Never gets real OSC 633; always uses the keystroke fallback below. |

Injection is wired in `applyShellIntegration`, called from `resolveSpawnConfig` (`standalone/sidecar/pty-core.js`), so it applies to both distributions — the standalone sidecar and the VS Code pty-host both spawn through it. The integration scripts are static files under `standalone/sidecar/shell-integration/`; the directory is resolved from `DORMOUSE_SHELL_INTEGRATION_DIR` (set by the host, mirroring `DORMOUSE_CLI_BIN`) and falls back to the sidecar's own directory. Standalone ships them via the tauri `../sidecar/**/*` resources glob; the VS Code build copies them into `dist/shell-integration`. If the scripts are missing, injection is skipped and the shell spawns exactly as before — injection is fail-safe.

**Emitted fields are filtered before they are written, and that is a security boundary, not tidiness.** A POSIX path component may hold any byte but `/` and NUL, and a command line may hold anything at all, so an attacker-chosen directory name or command can carry an OSC terminator — BEL, `ESC \`, or the C1 ST `U+009C` (all three are what `findOscTerminator` scans for). The parser cannot defend against this: the terminator scan runs on raw bytes, so by the time the parser sees them the `633` sequence is already over and the remainder arrives as a fresh, fully-trusted OSC. It would forge notifications, command lines, or titles in the shell's own voice — `OSC 9` most damagingly, since an alert latches a ring, persists, is spoken aloud, and is pushed to the paired phone. The injected bytes are consumed by the parser, so nothing appears on screen, and a poisoned directory re-fires for anyone who enters it, outliving the process that planted it. The boundary therefore has to be on the *emit* side, in the scripts Dormouse ships:

- **`E` (command line)** is escaped by `__dormouse_633_escape`, which covers BEL, ESC and the C1 ST alongside `\`, `;`, LF and CR. Escaping costs nothing here because the parser decodes `\xNN` back, so the command line still reports verbatim.
- **`Cwd=`** cannot be escaped — the parser reads it verbatim, with no `\xNN` decoding, precisely so a Windows path's backslashes arrive intact. `__dormouse_633_safe_cwd` therefore *removes* control characters rather than escaping them. Backslashes and semicolons are deliberately preserved. Under `LC_ALL=C` the C1 ST is two ordinary bytes that `[[:cntrl:]]` does not match, so the shell scripts strip it explicitly first.

`Source of truth:` `__dormouse_633_escape` and `__dormouse_633_safe_cwd` in each of `standalone/sidecar/shell-integration/bash/shellIntegration.bash`, `standalone/sidecar/shell-integration/zsh/.zshrc`, and `standalone/sidecar/shell-integration/pwsh/shellIntegration.ps1`. Because the injection is emit-side, the tests spawn the real shells rather than mocking them: `standalone/sidecar/shell-integration.test.js` (bash and zsh; it hard-fails if bash is absent and names any uncovered shell out loud).

### Keystroke fallback

When injection isn't possible (cmd.exe, an unknown shell, or scripts not present) or simply doesn't take, Dormouse falls back to its keystroke heuristic: it reads the submitted command off the rendered prompt line and synthesizes `commandStart{source:'user_input'}`. This fallback has no real exit codes and only a best-effort idle transition. The fallback rules — prompt-shape learning, submit parsing, and the per-pane promotion that retires the heuristic on the first authentic OSC boundary (which is what makes it fire "only if injection fails") — are owned by [terminal-state.md](terminal-state.md#keystroke-fallback).

> Packaging caveat: the zsh scripts are dotfiles (`.zshrc`, `.zshenv`, `.zprofile`). Confirm the VS Code `.vsix` actually includes `dist/shell-integration/.z*` — if a packaging step strips dotfiles, VS Code silently degrades to the keystroke fallback.

## Known-unimplemented iTerm2 and clipboard-capable sequences

Dormouse intentionally does not implement the following. They are mostly iTerm2-proprietary; `OSC 50` (font) and `OSC 52` (clipboard) are standard xterm extensions included here because the iTerm2 identity prompts tools to emit them and they have security implications. All of them fail inertly per the rule above — consumed and ignored rather than forwarded to xterm.js.

| Sequence | Purpose | Reason for non-support |
|---|---|---|
| `OSC 1337 ; SetMark` | Pin a navigable scrollback mark | No mark UI in Dormouse. |
| `OSC 1337 ; CursorShape=...` | Cursor shape override | Cursor shape comes from Dormouse settings, not the PTY. |
| `OSC 1337 ; SetBadgeFormat=...` | Display a badge string in the terminal | No badge UI. |
| `OSC 1337 ; ClearScrollback` | Clear scrollback buffer | xterm.js handles native clear-screen sequences. |
| `OSC 1337 ; CopyToClipboard=...` / `EndCopy` | Programmatic clipboard write | Security: untrusted PTY output cannot write the user's clipboard. See [mouse-and-clipboard.md](mouse-and-clipboard.md). |
| `OSC 1337 ; RequestUpload=...` | Begin file upload from terminal | No file-transfer protocol. |
| `OSC 1337 ; File=...` | Inline image protocol | No inline-image rendering. |
| `OSC 1337 ; SetUserVar=...` | Set a per-tab user variable | No user-variable surface. |
| `OSC 50 ; <font> ST` | Set font dynamically | Font is host-controlled. |
| `OSC 52 ; <selection> ; <data> ST` | Programmatic clipboard write | Security: same rationale as `CopyToClipboard`. |

The `OSC 1337` rows are illustrative, not a closed set: *every* `1337` payload other than `CurrentDir=` is consumed, named here or not. `OSC 50` and `OSC 52` are matched by code; every other unrecognized OSC family reaches xterm.js untouched.

## Files

| File | Role |
|---|---|
| `lib/src/lib/terminal-protocol.ts` | The parser: OSC dispatch, terminator/introducer scanning, standalone-BEL stripping, `CSI > q` stripping + the iTerm2 DCS answer, OSC 10/11/12 answering, OSC 99 chunk state, event → sink/response/semantic collectors |
| `lib/src/lib/terminal-report-filter.ts` | The three input-side report filters and `REPLAY_MODE_RESET` |
| `lib/src/lib/mouse-mode-observer.ts` | DECSET/DECRST parser hooks feeding the mouse-selection store |
| `lib/src/lib/keyboard-protocol-arbiter.ts` | kitty ↔ win32-input-mode arbitration on Windows |
| `lib/src/lib/terminal-lifecycle.ts` | `vtExtensions` + `linkHandler` wiring, replay + reset-tail application, input filtering on `onData` |
| `lib/src/lib/external-links.ts`, `external-link-confirmation.ts`, `lib/src/components/ExternalLinkModal.tsx` | OSC 8 activation: URI policy, display-text verdict, the dialog |
| `lib/src/host/remote/pty-strip.ts` | The strip-only parser the Node-resident remote Host runs per streamed PTY |
| `standalone/sidecar/pty-core.js` | iTerm2 identity env, `useConptyDll`, `applyShellIntegration` |
| `standalone/sidecar/shell-integration/` | The injected per-shell OSC 633 emitters (bash, zsh, pwsh) |

Two escape-aware modules sit *downstream* of the PTY boundary and are owned elsewhere: `lib/src/lib/terminal-controls.ts` (`stripTerminalControls`, whose rules are specified in [transport.md](transport.md)) and the alt-screen span elision in `lib/src/lib/terminal-state-store.ts` ([terminal-state.md](terminal-state.md)). Both read already-stripped output as *content*; neither changes what reaches xterm.js.

## References

- iTerm2 proprietary escape codes: https://iterm2.com/documentation-escape-codes.html
- xterm control sequences (OSC 0 / 2 / 7): https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- VS Code shell integration sequences (OSC 633): https://code.visualstudio.com/docs/terminal/shell-integration
- Windows Terminal CWD OSC 9;9: https://learn.microsoft.com/en-us/windows/terminal/tutorials/new-tab-same-directory
- xterm.js OSC 8 link handling: https://xtermjs.org/docs/guides/link-handling/
- kitty desktop notifications (OSC 99): https://sw.kovidgoyal.net/kitty/desktop-notifications/
- kitty keyboard protocol: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- WezTerm escape sequences (OSC 777): https://wezterm.org/escape-sequences.html

## Future

- **fish shell integration** — inject via `XDG_DATA_DIRS`: fish auto-sources `*/fish/vendor_conf.d/*.fish`, so the integration ships as a vendor conf file (env channel, as reliable as the `PATH` prepend). Until it lands, fish panes use the keystroke fallback above.
