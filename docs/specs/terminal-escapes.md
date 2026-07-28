# Terminal Escape Sequence Registry

> Single registry of the terminal escape sequences Dormouse parses or responds to — OSC (Operating System Command) for out-of-band metadata, and the CSI/DCS sequences Dormouse handles directly rather than delegating to xterm.js. Behavioral details for OSCs live in `docs/specs/alert.md` (notifications) and `docs/specs/terminal-state.md` (CWD, prompt/command, title fallback). This file also documents iTerm2 self-identification because the same identity is what causes most of these sequences to be emitted at us.

## Goal

Dormouse parses a small set of escape sequences from PTY output to drive alerts, terminal state, titles, and identity responses. Most terminal control is delegated to xterm.js; Dormouse intervenes only where it must — OSCs that drive product state, CSI/DCS that Dormouse answers itself or that need observation, and the security-sensitive sequences the iTerm2 identity provokes. This document is the index — every supported sequence has one row in the tables below pointing to the spec that defines its full behavior.

## CSI vs OSC vs DCS

These are the three escape-sequence families that show up in this spec:

- **CSI** (`ESC [`, "Control Sequence Introducer") — terminal *control*: cursor movement, colors/SGR, scrolling, mode switches, key-input encoding. Numeric/short parameters, terminated by a final letter. Most CSIs are handled by xterm.js; Dormouse only intervenes where noted in [Supported CSI](#supported-csi).
- **OSC** (`ESC ]`, "Operating System Command") — *out-of-band metadata* to the terminal emulator itself: titles, CWD, notifications, hyperlinks, clipboard, prompt markers. String-shaped payloads, terminated by `BEL` or `ST`. Dormouse parses these at the PTY data boundary; see [Supported OSCs](#supported-oscs).
- **DCS** (`ESC P`, "Device Control String") — longer payloads, currently relevant only as the response shape for `CSI > q` (iTerm2 extended device attributes).

Rule of thumb: CSI talks to the screen, OSC talks to the application hosting the screen, DCS is the response channel for richer queries.

## Parsing location

OSC sequences are introduced by `ESC ]` and terminated by either `BEL` (`\x07`) or `ST` (`ESC \`). A `BEL` that terminates an OSC is part of that OSC sequence, not a standalone bell notification. Both terminators are accepted across all supported sequences, and the parser handles split chunks across PTY reads.

State-driving and security-sensitive OSCs are parsed at the PTY data boundary in the platform adapter:

- VS Code: in the extension host (`message-router.ts` / `pty-manager.ts`), before `pty:data` is forwarded to the webview.
- Standalone and fake adapters: in the frontend adapter, before xterm.js sees the bytes.

After parsing, state-driving supported sequences are consumed and not re-emitted. `OSC 8` hyperlinks are the exception: the parser leaves them in `pty:data` so xterm.js owns hyperlink regions and hover rendering, while Dormouse supplies the activation-confirmation handler. Known unsupported iTerm2/clipboard-capable OSCs listed in [Known-unimplemented iTerm2 and clipboard-capable sequences](#known-unimplemented-iterm2-and-clipboard-capable-sequences) are also consumed and ignored. The platform sends two streams to the webview:

- `pty:data` — terminal output with state-driving supported OSCs already parsed/stripped and `OSC 8` hyperlinks preserved. Feeds xterm.js.
- `terminal:semanticEvents` — normalized semantic events parsed in the platform (CWD, prompt/command boundaries, titles). Feeds `TerminalPaneState`; command boundaries also feed the command-exit alert track defined in `docs/specs/alert.md`.
- Notification-derived state is delivered through `AlertManager` calls / `alert:state` messages, not through `pty:data`.

For replay (`pty:replay`), the webview re-parses semantic OSCs from the buffered raw stream during reconstruction. Replay must not re-fire alerts, activity-monitor events, or protocol notifications: saved scrollback may contain raw OSC sequences, but replay filtering suppresses all protocol side effects so a resumed Session does not re-ring on every reload.

The parser also classifies each PTY data chunk for activity-monitor purposes:

- A chunk that contains only notification/progress OSCs after parsing must not be fed to the activity monitor's `onData()` as generic meaningful output.
- A chunk that contains visible output plus notification/progress OSCs still counts visible output as activity.

Unknown non-iTerm2 OSC families pass through to xterm.js unchanged so xterm.js can handle standard terminal behavior Dormouse does not model. Security-sensitive or iTerm2-identity-triggered OSCs must not rely on xterm.js defaults: if they are not in [Supported OSCs](#supported-oscs), Dormouse consumes and ignores them without visible terminal garbage, clipboard access, file access, focus changes, or other side effects.

## Supported OSCs

| Sequence | Purpose | Spec |
|---|---|---|
| `BEL` (standalone, outside an OSC) | Generic terminal-bell notification | [alert.md](alert.md#standalone-bel) |
| `OSC 0 ; <title> ST` | Window/icon title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 2 ; <title> ST` | Window title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 7 ; file://host/path ST` | CWD (xterm-style URI) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 8 ; <params> ; <URI> ST ... OSC 8 ; ; ST` | Explicit hyperlink region; passed through to xterm.js for rendering, then opened only after Dormouse shows the real target in a confirmation dialog. | This spec |
| `OSC 10 ; ? ST` / `OSC 11 ; ? ST` / `OSC 12 ; ? ST` | Foreground / background / cursor color **query**. Dormouse answers from the active terminal theme with `OSC <code> ; rgb:RRRR/GGGG/BBBB ST` (16-bit channels) and consumes the query, so background-detecting TUIs (e.g. Codex's adaptive composer "pill") see the real colors instead of assuming dark. The parser needs the theme colors: the **standalone** frontend adapter reads them directly (`getTerminalTheme()`); the **VS Code** extension-host parser has no DOM, so the webview pushes them up via `dormouse:themeColors` (see [vscode.md](vscode.md#osc-color-query-answering)). Only the `?` (report) form is intercepted; color *set* requests pass through to xterm.js. Until the theme is known (before the first push, or if unparseable) the query falls through to xterm.js. | This spec |
| `OSC 9 ; <message> ST` | iTerm2 legacy notification | [alert.md](alert.md#osc-9) |
| `OSC 9 ; 4 ; <state> [; <progress>] ST` | iTerm2 progress | [alert.md](alert.md#osc-94-progress) |
| `OSC 9 ; 9 ; <cwd> ST` | CWD (Windows Terminal / ConEmu) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 99 ; <metadata> ; <payload> ST` | kitty desktop notification | [alert.md](alert.md#osc-99) |
| `OSC 133 ; A/B/C/D [...] ST` | Prompt/command boundaries; command-exit alert input | [terminal-state.md](terminal-state.md#supported-osc-inputs), [alert.md](alert.md#command-exit-track) |
| `OSC 633 ; A/B/C/D ST` | VS Code prompt/command boundaries; command-exit alert input | [terminal-state.md](terminal-state.md#supported-osc-inputs), [alert.md](alert.md#command-exit-track) |
| `OSC 633 ; E ; <commandline> [; <nonce>] ST` | VS Code command line | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 633 ; P ; Cwd=<cwd> ST` | CWD (VS Code) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 777 ; notify ; <title> ; <body> ST` | rxvt/WezTerm notification | [alert.md](alert.md#osc-777) |
| `OSC 1337 ; CurrentDir=<cwd> ST` | CWD (iTerm2 compatibility) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |

(`BEL` is not itself an OSC; it has a row here because a standalone `BEL` is parsed and stripped at the same PTY data boundary as the OSCs.)

Some sequences are dual-purpose. The notification rows for `OSC 9 ; <message> ST`, `OSC 99` (`p=title`/`p=body`), and `OSC 777 ; notify` also feed the title-candidate channel in `terminal-state.md` — see its [Title candidate diagnostics](terminal-state.md#supported-osc-inputs) table. Only the OSC 9 *message* form can become a header/door label; OSC 99 and OSC 777 candidates are stored only for the diagnostic title-candidates table in the header context menu. The OSC 9 *progress* form (`OSC 9 ; 4`) carries no text and never contributes a title candidate.

#### OSC color queries on Windows require the bundled ConPTY

OSC 10/11/12 answering only works if the program's query actually reaches the consumer. On Windows that depends on the ConPTY backend node-pty uses: the **in-box `CreatePseudoConsole`** silently swallows color queries (they never reach the consumer, so nothing can answer and TUIs fall back to a dark background), while node-pty's **bundled OpenConsole** (`conpty.dll`, currently 1.25.x) forwards them to the consumer — the same passthrough Windows Terminal relies on. So `pty-core.js` spawns with `useConptyDll: true` on Windows; the parser then replies from the active theme (standalone reads it directly, VS Code from the webview-pushed colors — see the OSC 10/11/12 row above). That requires `node-pty/prebuilds/<arch>/conpty.node` plus its sibling `conpty/{conpty.dll,OpenConsole.exe}` to ship: standalone bundles them via the Tauri `resources: ["../sidecar/**/*"]` glob; the VS Code extension via `cp -RL node_modules/node-pty dist/node-pty`. macOS/Linux PTYs forward queries natively, so the flag is Windows-only. `useConptyDll: true` also has an installer consequence on Windows — see [auto-update.md](auto-update.md#sidecar-teardown-on-windows).

### OSC 8 hyperlinks

`OSC 8 ; <params> ; <URI> ST` starts a hyperlink region and `OSC 8 ; ; ST` closes it. `params` may be empty or include `id=<group-id>` for multi-line/shared link regions. Dormouse does not parse the `params` or URI at the PTY boundary; it passes the sequence through to xterm.js.

`terminal-lifecycle.ts` sets xterm.js's `linkHandler` so activation never opens directly. Every click opens Dormouse's external-link confirmation dialog first. The dialog must show the full target URI from the OSC sequence, the URI scheme, and a primary `Open URL` action plus a cancel action. Cancel is the safe default. Long targets wrap and scroll instead of truncating so users can inspect deceptive link text.

URI policy:

- Openable after confirmation: any absolute URI with a scheme, including `http:`, `https:`, `mailto:`, `file:`, and custom app schemes such as `vscode:`.
- Blocked: malformed URIs, control-character-bearing targets, and browser-executable or opaque pseudo-schemes (`javascript:`, `data:`, `blob:`, `about:`).
- Blocked targets are not silently dropped. They still open the dialog in a non-openable state with the full target and reason visible, and `Open URL` disabled.

VS Code revalidates in the extension host before `vscode.env.openExternal`; standalone and fake adapters also revalidate before opening. The frontend dialog is a user-consent affordance, not the security boundary.

## Supported CSI

The vast majority of CSI handling is delegated to xterm.js. Dormouse only intervenes in the cases below — either to answer a query itself (so the response shape is under our control), to observe a state change xterm.js processes, to enable an xterm.js feature, or to filter replay output.

| Sequence | Role | Disposition | Where |
|---|---|---|---|
| `CSI > q` | iTerm2 extended device-attributes query | Dormouse answers with `DCS > \| iTerm2 [version] ST` at the PTY boundary; not forwarded to xterm.js. | [iTerm2 identity](#iterm2-identity) |
| `CSI ? ... h` (DECSET) | Private-mode set, including mouse tracking and bracketed paste | Observed via an xterm.js parser hook that returns false (xterm still handles the sequence); the mouse-selection store reads `terminal.modes` in a microtask. | `docs/specs/mouse-and-clipboard.md` |
| `CSI ? ... l` (DECRST) | Private-mode reset, including mouse tracking and bracketed paste | Same observation pattern as DECSET. | `docs/specs/mouse-and-clipboard.md` |
| Kitty keyboard protocol | Disambiguated key-event reporting (CSI u with modifiers, e.g. Shift+Enter distinguishable from Enter) | Enabled by passing `vtExtensions: { kittyKeyboard: true }` to the xterm.js `Terminal` constructor; xterm.js handles the push/pop (`CSI > u` / `CSI < u`) and the modified key reports. | `lib/src/lib/terminal-lifecycle.ts` |
| `CSI ? 9001 h/l` (win32-input-mode) | Faithful Win32 `INPUT_RECORD` key reporting for ConPTY apps that read via the Console API (e.g. Codex on Windows), which cannot negotiate the kitty protocol there. Without it, a key like Shift+Enter or Ctrl+J reaches the app as a bare byte (or not at all) and is not recognized as a modified key. | Advertised **only on Windows** by passing `vtExtensions: { win32InputMode: IS_WINDOWS }` to the xterm.js `Terminal` constructor; xterm.js answers the program's `CSI ? 9001 h` and then emits `CSI Vk;Sc;Uc;Kd;Cs;Rc _` key records. **Mutually exclusive with the kitty protocol** — xterm.js gives win32-input-mode precedence per keypress — and ConPTY's conhost enables it proactively, so a per-pane arbiter (`keyboard-protocol-arbiter.ts`) toggles the option off when an app pushes kitty (`CSI > … u`) and back on when it pops (`CSI < … u`), so kitty-based TUIs (Claude Code) and win32 TUIs (Codex) both work in the same window. | `lib/src/lib/terminal-lifecycle.ts`, `lib/src/lib/keyboard-protocol-arbiter.ts` |

### Replay-time CSI filtering

During `pty:replay`, Dormouse reconstructs scrollback by replaying saved bytes through xterm.js. Apps in that scrollback often left behind cursor-position reports, device-attribute responses, focus reports, and similar terminal-generated replies. xterm.js may re-emit those during replay; routing them into the new shell would corrupt its input buffer. Dormouse's reply filter (`lib/src/lib/terminal-report-filter.ts`) drops replay-time CSI replies of the following shapes:

- Cursor-position / device-status (`CSI [?]\d+;\d+ R/n`)
- Primary/secondary/tertiary device attributes (`CSI [?>=]\d* c`)
- Window manipulation reports (`CSI \d+;\d+ t/x`)
- DECRQSS-style reports (`CSI [?]\d+ $y`)
- Focus reports (`CSI I` / `CSI O`)
- OSC and DCS replies of any shape

This filter is limited to *terminal-generated reports*. User keyboard escape sequences — arrows, function keys, bracketed paste, modified key reports from the kitty keyboard protocol, and win32-input-mode key records (`CSI …_`) — must not be swallowed. See `docs/specs/transport.md` and `docs/specs/layout.md` for the contexts that invoke the filter.

### Replay-time mode-reset tail (Dormouse-emitted)

Saved scrollback can end mid-TUI with private modes still latched. Replaying it verbatim re-applies those DECSETs with no process alive to ever DECRST them, so a restored pane can be stuck in mouse-tracking mode, the alt-screen, or with the cursor hidden. After a **dead** session's scrollback replays, Dormouse writes a fixed reset tail (`REPLAY_MODE_RESET`) to return the terminal to a sane baseline for the freshly spawned shell: exit alt-screen (`CSI ? 1049/47/1047 l`), disable mouse tracking (`CSI ? 9/1000/1002/1003 l`), disable mouse encodings (`CSI ? 1005/1006/1015 l`), focus reporting off (`CSI ? 1004 l`), bracketed paste off (`CSI ? 2004 l` — the new shell re-enables it at its prompt), show cursor (`CSI ? 25 h`), application cursor keys off (`CSI ? 1 l`), and `SGR 0`. The only DECSET in the tail is show-cursor; everything else is a DECRST or SGR reset.

The tail is emitted only for dead sessions: `restoreTerminal` (always — the saved process is gone and a fresh shell spawns) and `resumeTerminal` when `exitInfo.alive` is false. It is **never** emitted on a live resume (a VS Code webview reattaching to a still-running PTY), where the running process legitimately owns its modes. It is written inside `writeReplay`, so `isReplaying` covers it and the reply filter above drops any report it provokes; the mouse-mode observer's parser hooks fire on the DECRSTs and re-sync the mouse-selection store to `none`. Source of truth: `lib/src/lib/terminal-report-filter.ts` (`REPLAY_MODE_RESET`), applied in `lib/src/lib/terminal-lifecycle.ts`.

### Pass-through and fail-inertly

Unknown CSI sequences pass through to xterm.js so it can handle standard terminal behavior Dormouse does not model. The same fail-inertly rule that applies to OSCs (see [iTerm2 identity](#iterm2-identity)) applies to CSIs: any sequence that xterm.js does not recognize must be consumed silently — no visible terminal garbage, no clipboard or file access, no focus changes, no other side effects.

## iTerm2 identity

Dormouse reports an iTerm2-compatible identity so that tools (shells, build systems, agent clients) emit the iTerm2-style escape codes that this spec set supports.

Environment for spawned PTYs:

| Variable | Value |
|---|---|
| `TERM_PROGRAM` | `iTerm.app` |
| `TERM_PROGRAM_VERSION` | Dormouse's chosen iTerm2 compatibility version, not the package version |
| `LC_TERMINAL` | `iTerm2` — set unconditionally on every spawned PTY (some real-world shell integrations key off it rather than `TERM_PROGRAM`) |
| `LC_TERMINAL_VERSION` | same compatibility version as `TERM_PROGRAM_VERSION` |
| `COLORTERM` | `truecolor` — advertise 24-bit color, which xterm.js renders. The PTY is spawned as `xterm-256color` with no other depth hint, so env-sniffing tools (e.g. `supports-color`) would otherwise assume 256/ANSI-16 and quantize RGB output to the nearest palette entry. Truecolor-aware TUIs (Codex's composer pill, syntax highlighters) then render smooth RGB. Windows Terminal is recognized as truecolor via `WT_SESSION`; Dormouse isn't, so it advertises `COLORTERM` explicitly. This is a color-*depth* signal, **independent** of the light/dark *background* detection (OSC color queries above) that drives those TUIs' theme choice. Not iTerm2-identity-specific. |

Device/version query:

- On `CSI > q`, respond with `DCS > | iTerm2 [version] ST`, matching iTerm2's extended device attributes response shape.
- Use a single compatibility version across env and device responses.
- Do not advertise feature-specific support until the relevant behavior exists.

Because this identity can cause tools to emit more iTerm2 escape codes than Dormouse implements, **unsupported escape codes must fail inertly**: consume or ignore them without visible terminal garbage, privilege escalation, clipboard access, file access, or focus stealing. This rule applies to both OSC and CSI sequences (see [Known-unimplemented iTerm2 and clipboard-capable sequences](#known-unimplemented-iterm2-and-clipboard-capable-sequences) for OSCs and the [Pass-through and fail-inertly](#pass-through-and-fail-inertly) note under CSI).

## Shell-integration injection

The iTerm2 identity above makes well-behaved tools emit OSC 633/133 *if their own shell integration is loaded* — but most shells don't emit prompt/command boundaries on their own. So Dormouse injects its own integration when it spawns a shell, making the shell emit the `OSC 633` family (`A`/`B` prompt boundaries, `C` command start, `D;<exit>` command finish, `E;<commandline>`, `P;Cwd=`) that the parser above already consumes. This is the *emit* side of OSC 633; the parser is the *consume* side.

A binary on `PATH` only has to be **found**, so it injects via one env var (`DORMOUSE_CLI_BIN` → `PATH`). OSC 633 is different: the shell must **run hook code on every prompt**, which no single env var enables. The reliable per-shell mechanism therefore differs by shell:

| Shell | Mechanism | Channel | Notes |
|---|---|---|---|
| zsh | `ZDOTDIR` → our dotfiles chain to the user's, then install `precmd`/`preexec` hooks | env (as reliable as the `PATH` prepend) | User's real `ZDOTDIR` is passed through as `USER_ZDOTDIR`; our `.zshrc` hands `ZDOTDIR` back so `.zlogin` and child shells are unaffected. **Nothing may be written into our directory when shipped** — it sits inside the signed macOS app bundle, and any added file breaks the code signature (Gatekeeper then reports the app "damaged"). macOS `/etc/zshrc` runs while `ZDOTDIR` still points at our directory and sets `HISTFILE` inside it; our `.zshrc` redirects such a `HISTFILE` to `USER_ZDOTDIR` after sourcing the user's rc (a user-set `HISTFILE` is never touched). |
| bash | `--init-file` → our script replicates login-profile sourcing, then installs a `DEBUG`-trap / `PROMPT_COMMAND` hook | shellArgs | `--init-file` and login mode are mutually exclusive, so Dormouse drops `-l` and the script sources `/etc/profile` + the user's profile itself. Injected whenever the launch args are *only* interactive/login flags (`-i`/`-l`/`--login`) — so Git Bash, launched with `--login -i`, is covered too; a specific invocation like `-c <cmd>` is left untouched. Written for bash 3.2 (macOS system bash): no `PS0`, no array `PROMPT_COMMAND`. The `E` command line is the first simple command of a pipeline (a `DEBUG`-trap limitation); boundaries and exit codes stay exact. |
| PowerShell | `-Command ". '<script>'"` → the dot-sourced script wraps the user's `prompt` and PSReadLine's `PSConsoleHostReadLine` (covers `pwsh` and Windows `powershell.exe`) | shellArgs | `-NoProfile` is *not* passed, so the user's profile loads and defines their prompt before we wrap it. Injected for any **interactive** launch: a bare REPL gets `-NoExit -Command ". '<script>'"`, and a launch that already runs a startup command — e.g. the VS "Developer PowerShell" (`-NoExit -Command "& { Import-Module … }"`) — gets our dot-source *appended* to that command, so its environment is set up first and our wrapper installs after it. Non-interactive one-offs (a `-Command`/`-File`/`-EncodedCommand` without `-NoExit`) are left untouched. PowerShell has no `preexec`, so `E`/`C` (command line + start) are emitted by wrapping `PSConsoleHostReadLine`, which runs just before a submitted command executes — so the running command shows immediately, like bash/zsh. The matching `D` (finish, exit code from `$?`/`$LASTEXITCODE`) is emitted from the next `prompt` render. If PSReadLine is absent, the whole `E`/`C`/`D` triple is reported from the next prompt instead (command line from history): boundaries and exit codes stay exact, but the running command isn't shown until it finishes. |
| WSL | `wsl.exe -d <distro> -- sh -c <detector>` → the detector execs the distro's bash with our `--init-file` (the Windows bash script, referenced via its `/mnt/...` path) | shellArgs | Windows-side injection can't reach the Linux shell, so we append a command. The detector reads the login shell from `/etc/passwd`: it steps aside for an explicit zsh/fish login shell, execs bash+integration when bash exists (covering bash and an empty detection — the safe default), and falls back to the login shell only when bash is absent (e.g. Alpine). bash is the only WSL shell integrated for now. Assumes the default `/mnt` automount root. |
| cmd.exe | no per-command hook exists | — | Never gets real OSC 633; always uses the keystroke fallback below. |

Injection is wired in `resolveSpawnConfig` (`standalone/sidecar/pty-core.js`) and applies to both distributions (the standalone sidecar and the VS Code pty-host both spawn through it). The integration scripts are static files under `standalone/sidecar/shell-integration/`; the directory is resolved from `DORMOUSE_SHELL_INTEGRATION_DIR` (set by the host, mirroring `DORMOUSE_CLI_BIN`) and falls back to the sidecar's own directory. Standalone ships them via the tauri `../sidecar/**/*` resources glob; the VS Code build copies them into `dist/shell-integration`. If the scripts are missing, injection is skipped and the shell spawns exactly as before — injection is fail-safe.

### Keystroke fallback

When injection isn't possible (cmd.exe, an unknown shell, or scripts not present) or simply doesn't take, Dormouse falls back to its keystroke heuristic: it reads the submitted command off the rendered prompt line and synthesizes `commandStart{source:'user_input'}`. This fallback has no real exit codes and only a best-effort idle transition. The fallback rules — prompt-shape learning, submit parsing, and the per-pane promotion that retires the heuristic on the first authentic OSC boundary (which is what makes it fire "only if injection fails") — are owned by [terminal-state.md](terminal-state.md#keystroke-fallback).

> Packaging caveat: the zsh scripts are dotfiles (`.zshrc`, `.zshenv`, `.zprofile`). Confirm the VS Code `.vsix` actually includes `dist/shell-integration/.z*` — if a packaging step strips dotfiles, VS Code silently degrades to the keystroke fallback.

## Known-unimplemented iTerm2 and clipboard-capable sequences

Dormouse intentionally does not implement the following sequences. They are mostly iTerm2-proprietary; `OSC 50` (font) and `OSC 52` (clipboard) are standard xterm extensions included here because the iTerm2 identity prompts tools to emit them and they have security implications. All of them must fail inertly per the rule above, which means they are consumed/ignored rather than forwarded to xterm.js.

| Sequence | Purpose | Reason for non-support |
|---|---|---|
| `OSC 1337 ; SetMark` | Pin a navigable scrollback mark | No mark UI in Dormouse. |
| `OSC 1337 ; CursorShape=...` | Cursor shape override | Cursor shape comes from Dormouse settings, not the PTY. |
| `OSC 1337 ; SetBadgeFormat=...` | Display a badge string in the terminal | No badge UI. |
| `OSC 1337 ; ClearScrollback` | Clear scrollback buffer | xterm.js handles native clear-screen sequences. |
| `OSC 1337 ; CopyToClipboard=...` / `EndCopy` | Programmatic clipboard write | Security: untrusted PTY output cannot write the user's clipboard. See `docs/specs/mouse-and-clipboard.md`. |
| `OSC 1337 ; RequestUpload=...` | Begin file upload from terminal | No file-transfer protocol. |
| `OSC 1337 ; File=...` | Inline image protocol | No inline-image rendering. |
| `OSC 1337 ; SetUserVar=...` | Set a per-tab user variable | No user-variable surface. |
| `OSC 50 ; <font> ST` | Set font dynamically | Font is host-controlled. |
| `OSC 52 ; <selection> ; <data> ST` | Programmatic clipboard write | Security: same rationale as `CopyToClipboard`. |

This list is non-exhaustive. Any iTerm2-compatibility OSC family that Dormouse can identify and that is not in the [Supported OSCs](#supported-oscs) table is ignored.

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
