# Terminal Escape Sequence Registry

> See `docs/specs/glossary.md` for the Session vocabulary used when a row talks about replay or resumed Sessions.

> **Owns:** the exhaustive registry — every sequence Dormouse parses, answers, or ignores has one row below — plus the parse sites, the strip/replay rules, and the iTerm2 identity that provokes most of them.
> **Defers** each row's behavior to its owner: `docs/specs/alert.md` (notifications), `docs/specs/terminal-state.md` (CWD, prompt/command, titles), `docs/specs/mouse-and-clipboard.md` (mouse modes, paste).

## Families

- **CSI** (`ESC [`, or the C1 `U+009B`) — screen control. xterm.js owns all of it except [Supported CSI](#supported-csi).
- **OSC** (`ESC ]`, or the C1 `U+009D`) — out-of-band metadata for the emulator itself. **The parser accepts all three terminators for every sequence** — `BEL` (`\x07`), `ST` (`ESC \`), the C1 ST `U+009C` — and handles OSCs split across PTY reads. See [Supported OSCs](#supported-oscs).
- **DCS** (`ESC P`, or the C1 `U+0090`) — device-control strings: SIXEL graphics input and the shape of Dormouse's `CSI > q` answer.
- **APC** (`ESC _`, or the C1 `U+009F`) — application-program commands; Kitty graphics uses `APC G`.

**The parser frames all five string controls — OSC, DCS, SOS, PM, APC — and models nothing outside OSC**, so DCS and APC are forwarded whole. **`BEL` terminates only OSC**; inside the others it is payload, never a bell (rationale).

## Parsing location

State-driving and security-sensitive OSCs — plus the `CSI > q` query — are parsed at the PTY data boundary in the platform adapter: the VS Code extension host (`vscode-ext/src/message-router.ts`, one parser per PTY from `ptyManager.addCallbacks`, before `pty:data` reaches any webview), and the frontend adapter for standalone, browser-sidecar and fake, before xterm.js sees the bytes.

**An unterminated OSC the parser will consume is buffered across chunks up to `OSC_INCOMPLETE_LIMIT` (16 KiB), then dropped — never buffered without bound** (rationale). It bounds only *unterminated* sequences; a complete one in a single read is parsed whole. **An unterminated OSC the parser will forward streams to xterm.js instead**, preserving a split `ESC \` terminator (rationale). **Route by the OSC id, and decide nothing while more digits could follow** — `133` becomes `1337` — for `1337` by the subcommand ([Inline graphics](#inline-graphics)).

**Every semantic value `TerminalProtocolParser` *retains* is bounded and stripped of control characters before storage**, whatever the emitter: `TITLE_LIMIT` / `BODY_LIMIT` for titles and notification bodies, whose whitespace controls collapse to spaces before the trim; `COMMAND_LINE_LIMIT` for the OSC 633 `E` command line, bounded *before* the `\xNN` unescape and sanitized *after* it (rationale); `MAX_CWD_LENGTH` for every CWD source, interior whitespace preserved. **Every limit counts code points**, so a cut never splits a surrogate pair. **A value that reduces to nothing is dropped, never stored empty.**

The remote Host in the Tauri sidecar is a second, **strip-only** parse site, **one parser per PTY it streams to a phone, never per attachment** (rationale). **Every event it produces must be discarded, responses included** — the webview that owns the terminal already answers, and a second answer writes duplicate bytes into the PTY's input. **OSC 10/11/12 queries must still be consumed there**, reply thrown away: a *declined* query stays in `visibleData` and the phone's xterm answers it. The VS Code Host needs no such parser ([vscode.md](vscode.md)).

Source of truth: `oscDispositionAt` in `lib/src/lib/terminal-protocol.ts`, `boundedCwdValue` in `lib/src/lib/terminal-state.ts`, `lib/src/host/remote/pty-strip.ts`, `lib/src/host/remote/sidecar-entry.ts`.

### `pty:data` strip semantics

**Supported semantic sequences are consumed and never re-emitted** — empty or unparseable payloads, unrecognized `OSC 1337` subcommands and `OSC 50` / `OSC 52` included. **`OSC 8` and the recognized ImageAddon `OSC 1337` forms are the exceptions**: they stay in `pty:data` so xterm.js owns hyperlink regions and inline graphics. Dormouse supplies only the hyperlink activation-confirmation handler. Every other OSC family passes through unchanged, so xterm.js handles standard behavior Dormouse does not model.

**`textData` is the same chunk with every string-control payload removed**, for consumers reading output as text; every other control is left for `stripTerminalControls`. Two streams then reach the webview: `pty:data` (the stripped output; feeds xterm.js) and `terminal:semanticEvents` (normalized CWD / prompt-command / title events; feeds `TerminalPaneState`, command boundaries also feeding the command-exit alert track in [alert.md](alert.md#command-exit-track)). **Notification-derived state travels as `AlertManager` calls / `alert:state` messages, never `pty:data`.**

Each chunk is also classified for the quiesce detector: **the activity monitor's `onData()` fires only when `visibleData` is non-empty**, so a chunk of nothing but notification/progress OSCs is not meaningful output, while one carrying visible output alongside them is.

For replay (`pty:replay`) the frontend re-parses the buffered raw stream, so semantic state repopulates and OSCs are stripped before xterm sees them. **Replay must not re-fire** alerts, quiesce events, protocol notifications, or query responses — it applies the semantic events and drops the rest (rationale).

## Supported OSCs

| Sequence | Purpose | Spec |
|---|---|---|
| `BEL` (standalone, outside an OSC) | Generic terminal-bell notification | [alert.md](alert.md#terminal-reports) |
| `OSC 0 ; <title> ST` | Window/icon title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 2 ; <title> ST` | Window title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 7 ; file://host/path ST` | CWD (xterm-style URI) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 8 ; <params> ; <URI> ST ... OSC 8 ; ; ST` | Explicit hyperlink region — the one supported OSC passed through to xterm.js, opened only after a confirmation dialog. | This spec |
| `OSC 10 ; ? ST` / `OSC 11 ; ? ST` / `OSC 12 ; ? ST` | Foreground / background / cursor color **query**. Consumed and answered `OSC <code> ; rgb:RRRR/GGGG/BBBB ST` (8-bit channels doubled) from the active terminal theme (rationale). Only the `?` (report) form is intercepted; *set* requests pass through, and an unknown or unparseable theme falls the query through to xterm.js. Theme: standalone's `getTerminalTheme()`; VS Code's push in [vscode.md](vscode.md#osc-color-query-answering). | This spec |
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
| `OSC 1337 ; File=...:<data> ST` / `MultipartFile=...` / `FilePart=...` / `FileEnd` | iTerm2 inline image protocol (IIP); passed through to ImageAddon. | [Inline graphics](#inline-graphics) |
| `OSC 1337 ; ReportCellSize ST` | iTerm2 cell-size query; passed through and answered by ImageAddon. | [Inline graphics](#inline-graphics) |
| `OSC 1337 ; <anything else> ST` | Unsupported iTerm2 extension; consumed and ignored. | This spec |
| `OSC 50 ; <font> ST` | Unsupported dynamic font change; consumed and ignored. | This spec |
| `OSC 52 ; <selection> ; <data> ST` | Unsupported clipboard write; consumed and ignored — untrusted PTY output cannot write the user's clipboard. | This spec |

**A `BEL` that terminates an OSC is part of that sequence, never a bell**; the `BEL` row covers a standalone one, parsed and stripped at the same boundary.

`OSC 9 ; <message>`, `OSC 99` and `OSC 777 ; notify` also feed the title-candidate channel, whose promotion rules [terminal-state.md](terminal-state.md#supported-osc-inputs) owns.

#### OSC color queries on Windows require the bundled ConPTY

**Windows must spawn with `useConptyDll: true`** (`pty-core.js`) — the in-box `CreatePseudoConsole` silently swallows color queries, while node-pty's bundled OpenConsole (`conpty.dll`) forwards them (rationale). **Both distributions must ship** `node-pty/prebuilds/<arch>/conpty.node` plus its sibling `conpty/{conpty.dll,OpenConsole.exe}`: standalone via the Tauri `resources: ["../sidecar/**/*"]` glob, the VS Code extension via `cp -RL node_modules/node-pty dist/node-pty`. macOS/Linux forward queries natively, so the flag is Windows-only; it also has an installer consequence ([auto-update.md](auto-update.md#sidecar-teardown-on-windows)).

### OSC 8 hyperlinks

Neither `params` nor the URI is parsed at the PTY boundary.

**Activation never opens directly**: `terminal-lifecycle.ts` sets xterm.js's `linkHandler`, so every click routes to the confirmation dialog carrying the URI *and* the link's rendered display text, read from the buffer range xterm supplies. The dialog shows the full target and picks one of three states:

| State | Target | Dialog |
|---|---|---|
| **Openable** | any absolute URI with a scheme — `http:`, `https:`, `mailto:`, `file:`, custom app schemes such as `vscode:` | cancel plus a primary open action labelled by scheme (`Open URL` / `Open file` / `Open email` / the raw `scheme:`) |
| **Deceptive** | display text URL-shaped (a full URL or a bare domain) but resolving to a different host than the target; one that merely *differs* — a human phrase, a same-host sibling URL — is **plain**, not deceptive, and stays openable | **No open action at all**: close and "Copy deceptive URL to clipboard", the copy button taking initial focus so a reflexive Enter cannot open anything |
| **Blocked** | malformed URIs, control-character-bearing targets, browser-executable or opaque pseudo-schemes (`javascript:`, `data:`, `blob:`, `about:`) | **Never silently dropped**: the dialog opens with the reason, close the only action |

**Cancel/close is the safe default**, and long targets wrap and scroll rather than truncate so a deceptive one cannot hide past the fold. **Every adapter must revalidate through `normalizeExternalUri` before opening** (VS Code before `vscode.env.openExternal`) — the dialog is a user-consent affordance, not the security boundary.

Source of truth: `lib/src/lib/external-links.ts`, `lib/src/lib/external-link-confirmation.ts`, `lib/src/components/ExternalLinkModal.tsx`.

## Supported CSI

Dormouse intervenes only in these cases.

| Sequence | Role | Disposition | Where |
|---|---|---|---|
| `CSI > q` | iTerm2 extended device-attributes query | Answered `DCS > \| iTerm2 <version> ST` at the PTY boundary and stripped, never forwarded to xterm.js. Both `ESC [ > q` and the C1 `U+009B > q` are recognized. | [iTerm2 identity](#iterm2-identity) |
| `CSI ? ... h` (DECSET) / `CSI ? ... l` (DECRST) | Private-mode set/reset, including mouse tracking and bracketed paste | Observed via xterm.js parser hooks returning false, so xterm still handles the sequence; the mouse-selection store reads `terminal.modes` in a microtask. | [mouse-and-clipboard.md](mouse-and-clipboard.md), `lib/src/lib/mouse-mode-observer.ts` |
| Kitty keyboard protocol | Disambiguated key-event reporting (CSI u with modifiers, e.g. Shift+Enter distinguishable from Enter) | Enabled by `vtExtensions: { kittyKeyboard: true }` on the xterm.js `Terminal` constructor; xterm.js handles the push/pop (`CSI > u` / `CSI < u`) and the modified key reports. | `lib/src/lib/terminal-lifecycle.ts` |
| `CSI ? 9001 h/l` (win32-input-mode) | Faithful Win32 `INPUT_RECORD` key reporting for ConPTY apps reading via the Console API — Codex on Windows, which cannot negotiate the kitty protocol there (rationale) | Advertised **only on Windows** (`vtExtensions: { win32InputMode: IS_WINDOWS }`); xterm.js then emits `CSI Vk;Sc;Uc;Kd;Cs;Rc _` key records. **Mutually exclusive with the kitty protocol**, so a per-pane arbiter watches `CSI > … u` / `CSI < … u` — counting nested pushes, honoring the pop count — and toggles the option off while any kitty consumer is on the stack (rationale). | `lib/src/lib/keyboard-protocol-arbiter.ts` |
| `CSI c` | Primary device-attributes query | ImageAddon answers `CSI ? 62 ; 4 ; 9 ; 22 c`, advertising SIXEL. | [Inline graphics](#inline-graphics) |
| `CSI 14 t` / `CSI 16 t` / `CSI 18 t` | Window-pixel, cell-pixel, and window-character size queries | Enabled and answered by xterm.js for image preparation. | [Inline graphics](#inline-graphics) |
| `CSI ? 80 h/l` | SIXEL scrolling off/on | Observed by ImageAddon; xterm.js continues handling the private mode. | [Inline graphics](#inline-graphics) |
| `CSI ? <item> ; <action> [; <value>] S` | XTSMGRAPHICS palette/canvas geometry | ImageAddon answers supported read/set actions and an error status for the rest. | [Inline graphics](#inline-graphics) |

### Inline graphics

**Must support SIXEL (`DCS ... q ... ST`), iTerm IIP (the `OSC 1337` rows above), and Kitty graphics (`APC G ... ST`) in every Session through stock `@xterm/addon-image`**, gated by `cfg.terminal.inlineImages`; Kitty support follows the addon's alpha-quality subset. **Must load the addon at Session creation, never on the first image**: it answers the DA1, XTSMGRAPHICS, and cell-size probes a program reads before sending one (rationale). IIP renders inline PNG, JPEG, GIF (first frame), QOI, WebP, and AVIF data; browser-native formats remain limited by the host engine.

**Must bound each Session to 8,388,608 pixels per image, 33,554,432 bytes per SIXEL/IIP/Kitty sequence, and 34 MB of FIFO image storage** — the storage figure at or above `pixelLimit` × 4 bytes, or one full-size image evicts the whole Session cache (rationale). Evicted cells show the addon's placeholder. **Dormouse forwards only the bytes carried in the sequence and resolves no filename**; ImageAddon discards a transfer without `inline=1`.

**Must remove string-control payloads statefully before the keystroke prompt heuristic's 1,024-character window**, including chunks that begin or end mid-sequence, so image base64 cannot be read as a returned prompt. Live PTY/replay bytes still reach xterm.js unchanged.

Source of truth: `IMAGE_ADDON_OPTIONS` in `lib/src/lib/terminal-lifecycle.ts`; `OSC1337_FORWARDED` and `TerminalProtocolParser.processForwardedOsc` in `lib/src/lib/terminal-protocol.ts`; `TerminalControlStreamFilter` in `lib/src/lib/terminal-controls.ts`.

### Report filtering on the input side

Everything xterm.js emits on `onData` is candidate PTY input, its own *replies* included. **The two classifiers below require every token of a chunk to match**, so a report glued onto real keystrokes is never mistaken for one.

- **`inputIsReplayTerminalReport`** — dropped outright while `isReplaying` (rationale). Shapes: cursor-position / device-status (`CSI [?]<params> R` / `n`), device attributes (`CSI [?>=]<params> c`), window-manipulation reports (`CSI <params> t` / `x`), DECRQSS and XTSMGRAPHICS reports (`CSI [?]<params> $y` / `S`), focus in/out (`CSI I` / `CSI O`), and OSC, DCS, or APC replies of any shape. It also gates the untouched-session flag ([layout.md](layout.md)).
- **`inputIsSyntheticTerminalReport`** — the broader machine-generated check (any chunk built only of CSI, SS3 `ESC O <final>`, OSC, or APC tokens). **Not dropped** — it suppresses input recording and alert attention for that chunk.
- **`stripMouseReportsFromInput`** — removes X10 (`CSI M <3 bytes>`), SGR (`CSI < b;x;y M/m`) and urxvt (`CSI b;x;y M`) mouse reports while a mouse-mode override is active, so a report slipping past the DOM-level intercept never reaches the PTY ([mouse-and-clipboard.md](mouse-and-clipboard.md)).

**No filter may swallow user keyboard escape sequences** — arrows, function keys, bracketed paste, kitty modified-key reports, win32-input-mode key records (`CSI …_`). Source of truth: `lib/src/lib/terminal-report-filter.ts`.

### Replay-time mode-reset tail (Dormouse-emitted)

**After a *dead* Session's scrollback replays, Dormouse writes the fixed `REPLAY_MODE_RESET` tail** (rationale): exit alt-screen (`CSI ? 1049/47/1047 l`), disable mouse tracking (`CSI ? 9/1000/1002/1003 l`), disable mouse encodings (`CSI ? 1005/1006/1015 l`), focus reporting off (`CSI ? 1004 l`), bracketed paste off (`CSI ? 2004 l` — the new shell re-enables it at its prompt), show cursor (`CSI ? 25 h`), application cursor keys off (`CSI ? 1 l`), `SGR 0`. Show-cursor is the tail's only DECSET; everything else is a DECRST or SGR reset.

**Emitted from exactly one place**, `resumeTerminal` when `exitInfo.alive` is false. **Never on a live resume**, where the running process legitimately owns its modes; a cold `restoreTerminal` needs none, nothing being replayed there. Written inside `writeReplay`, so `isReplaying` covers it and the filter above drops any report it provokes; the mouse-mode observer re-syncs the mouse-selection store to `none` from the DECRSTs.

Source of truth: `REPLAY_MODE_RESET` in `lib/src/lib/terminal-report-filter.ts`, applied in `lib/src/lib/terminal-lifecycle.ts`.

### Pass-through and fail-inertly

Unknown CSI sequences pass through to xterm.js, like unknown OSC families, and **anything xterm.js does not recognize must be consumed silently** — the fail-inertly rule in [iTerm2 identity](#iterm2-identity).

## iTerm2 identity

Dormouse reports an iTerm2-compatible identity to unlock the iTerm2-style escape codes this spec set supports (rationale). **One compatibility version spans env and device responses**: `ITERM2_COMPAT_VERSION`, currently `3.5.0`, defined twice — in `standalone/sidecar/pty-core.js` and `lib/src/lib/terminal-protocol.ts` — pinned together by `lib/src/lib/mirrored-constants.test.ts`.

Environment for spawned PTYs:

| Variable | Value |
|---|---|
| `TERM_PROGRAM` | `iTerm.app` |
| `TERM_PROGRAM_VERSION` | the compatibility version, not Dormouse's package version |
| `LC_TERMINAL` | `iTerm2` — set unconditionally, since some shell integrations key off it rather than `TERM_PROGRAM` |
| `LC_TERMINAL_VERSION` | the same compatibility version |
| `COLORTERM` | `truecolor` — a color-*depth* signal, **independent** of the light/dark *background* detection the OSC color queries above drive, and not iTerm2-specific (rationale) |

**Never advertise** feature-specific support before the behavior exists; the device answer's shape is in [Supported CSI](#supported-csi).

The identity provokes more iTerm2 escape codes than Dormouse implements, so **unsupported escape codes must fail inertly** — consumed or ignored, with no visible terminal garbage, privilege escalation, clipboard access, file access, or focus stealing; OSC and CSI alike ([Pass-through and fail-inertly](#pass-through-and-fail-inertly)).

## Shell-integration injection

**Dormouse injects its own shell integration when it spawns a shell** — most shells emit no prompt/command boundaries by themselves (rationale). The scripts are the *emit* side of the `OSC 633` family the parser above consumes: `A`/`B` prompt boundaries, `C` command start, `D;<exit>` command finish, `E;<commandline>`, `P;Cwd=`.

**The reliable mechanism differs per shell** — a `PATH` binary need only be *found* (`DORMOUSE_CLI_BIN` → `PATH`), while OSC 633 needs hook code run on every prompt (rationale):

| Shell | Mechanism | Channel | Notes |
|---|---|---|---|
| zsh | `ZDOTDIR` → our dotfiles chain to the user's, then install `precmd`/`preexec` hooks | env (as reliable as the `PATH` prepend) | **Nothing may be written into our directory when shipped** — signed macOS app bundle (rationale). The user's real `ZDOTDIR` rides in `USER_ZDOTDIR`; our `.zshrc` hands `ZDOTDIR` back so `.zlogin` and child shells are unaffected, and `.zshenv`/`.zprofile` re-pin `ZDOTDIR` to ours after sourcing the user's. **A `HISTFILE` set inside our directory is redirected to `USER_ZDOTDIR`** after sourcing the user's rc; a user-set one is never touched. |
| bash | `--init-file` → our script installs a `DEBUG`-trap / `PROMPT_COMMAND` hook | shellArgs | Dormouse drops `-l` (mutually exclusive with `--init-file`); the script sources `/etc/profile` + the user's profile itself. **Injected only when the launch args are *purely* interactive/login flags** (`-i`/`-l`/`--login`), so Git Bash's `--login -i` is covered and a specific `-c <cmd>` is not (rationale). **Written for bash 3.2**: no `PS0`, no array `PROMPT_COMMAND`. **`E` is a pipeline's first simple command**; boundaries and exit codes stay exact. |
| PowerShell | dot-source a script that wraps the user's `prompt` and PSReadLine's `PSConsoleHostReadLine`; covers `pwsh` and `powershell.exe` | shellArgs | **`-NoProfile` is never passed**, so the user's profile defines their prompt before we wrap it. Injected for any **interactive** launch — a bare REPL gets `-NoExit -Command ". '<script>'"`, one already carrying a startup command gets our dot-source *appended* (rationale); non-interactive one-offs (`-Command`/`-File`/`-EncodedCommand` without `-NoExit`) are left untouched. `E`/`C` come from that wrapper, `D` (`$?`/`$LASTEXITCODE`) from the next `prompt`. **Without PSReadLine the whole triple falls back to the next prompt**, boundaries and exit codes still exact (rationale). |
| WSL | `wsl.exe -d <distro> -- sh -c <detector>` → the detector execs the distro's bash with our `--init-file`, referenced via its `/mnt/...` path | shellArgs (Windows-side injection cannot reach inside the distro) | The detector reads `/etc/passwd`: it steps aside for an explicit zsh/fish login shell, execs bash+integration whenever bash exists (also the empty-detection default), and falls back to the login shell only when bash is absent (rationale). **bash is the only integrated WSL shell**; assumes the default `/mnt` automount root. |
| cmd.exe | no per-command hook exists | — | Never gets real OSC 633; always uses the keystroke fallback below. |

Wired in `applyShellIntegration`, called from `resolveSpawnConfig` (`standalone/sidecar/pty-core.js`), so both distributions spawn through it. The scripts are static files under `standalone/sidecar/shell-integration/`, located via `DORMOUSE_SHELL_INTEGRATION_DIR` (set by the host, mirroring `DORMOUSE_CLI_BIN`) and falling back to the sidecar's own directory; standalone ships them through the Tauri `../sidecar/**/*` glob, the VS Code build into `dist/shell-integration`. **Injection is fail-safe** — missing scripts mean it is skipped and the shell spawns as before.

**Emitted fields must be filtered before they are written — a security boundary, not tidiness.** An attacker-chosen directory name or command can carry an OSC terminator (BEL, `ESC \`, or the C1 ST `U+009C` — all three of what `findOscTerminator` scans for), ending the `633` sequence early so the remainder arrives as a fresh, fully-trusted OSC. **The parser cannot defend against this** — it scans raw bytes — so the boundary is emit-side, in the scripts Dormouse ships (rationale):

- **`E` (command line)** is escaped by `__dormouse_633_escape`: BEL, ESC and the C1 ST alongside `\`, `;`, LF and CR. The parser decodes `\xNN` back, so it still reports verbatim.
- **`Cwd=`** is read verbatim, no `\xNN` decoding, so a Windows path's backslashes arrive intact — `__dormouse_633_safe_cwd` therefore *removes* control characters instead of escaping them, preserving backslashes and semicolons. **Under `LC_ALL=C` the scripts strip the C1 ST explicitly first**, `[[:cntrl:]]` not matching its two ordinary bytes.

Source of truth: `__dormouse_633_escape` and `__dormouse_633_safe_cwd` in each of `standalone/sidecar/shell-integration/bash/shellIntegration.bash`, `standalone/sidecar/shell-integration/zsh/.zshrc`, `standalone/sidecar/shell-integration/pwsh/shellIntegration.ps1`; pinned by `standalone/sidecar/shell-integration.test.js`, which spawns real bash and zsh rather than mocking them, hard-fails if bash is absent, and names any uncovered shell out loud.

### Keystroke fallback

When injection isn't possible (cmd.exe, an unknown shell, missing scripts) or simply doesn't take, Dormouse falls back to its keystroke heuristic: the submitted command read off the rendered prompt line and synthesized as `commandStart{source:'user_input'}`, with no real exit codes. Its rules and the per-pane promotion that retires it on the first authentic OSC boundary belong to [terminal-state.md](terminal-state.md#keystroke-fallback).

> **The VS Code `.vsix` must include zsh's dotfiles** (`dist/shell-integration/.z*`), or zsh silently degrades to the keystroke fallback.

Two escape-aware consumers are **not** parse sites: `lib/src/lib/terminal-controls.ts` strips presentation controls ([transport.md](transport.md)) and `lib/src/lib/terminal-state-store.ts` elides alternate-screen spans ([terminal-state.md](terminal-state.md)). Both read already-stripped output; neither changes what reaches xterm.js.

## References

- iTerm2 escape codes: https://iterm2.com/documentation-escape-codes.html
- xterm control sequences: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- VS Code shell integration (OSC 633): https://code.visualstudio.com/docs/terminal/shell-integration
- Windows Terminal OSC 9;9: https://learn.microsoft.com/en-us/windows/terminal/tutorials/new-tab-same-directory
- xterm.js OSC 8 link handling: https://xtermjs.org/docs/guides/link-handling/
- kitty desktop notifications (OSC 99): https://sw.kovidgoyal.net/kitty/desktop-notifications/
- kitty keyboard protocol: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- WezTerm escape sequences (OSC 777): https://wezterm.org/escape-sequences.html

## Future

- **fish shell integration** — inject via `XDG_DATA_DIRS`: fish auto-sources `*/fish/vendor_conf.d/*.fish`, so the integration ships as a vendor conf file (env channel, as reliable as the `PATH` prepend). Until it lands, fish panes use the keystroke fallback above.
