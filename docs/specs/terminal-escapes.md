# Terminal Escape Sequence Registry

> Single registry of the terminal escape sequences MouseTerm parses or responds to — OSC (Operating System Command) for out-of-band metadata, and the CSI/DCS sequences MouseTerm handles directly rather than delegating to xterm.js. Behavioral details for OSCs live in `docs/specs/alert.md` (notifications) and `docs/specs/terminal-state.md` (CWD, prompt/command, title fallback). This file also documents iTerm2 self-identification because the same identity is what causes most of these sequences to be emitted at us.

## Goal

MouseTerm parses a small set of escape sequences from PTY output to drive alerts, terminal state, titles, and identity responses. Most terminal control is delegated to xterm.js; MouseTerm intervenes only where it must — OSCs that drive product state, CSI/DCS that MouseTerm answers itself or that need observation, and the security-sensitive sequences the iTerm2 identity provokes. This document is the index — every supported sequence has one row in the tables below pointing to the spec that defines its full behavior.

## CSI vs OSC vs DCS

These are the three escape-sequence families that show up in this spec:

- **CSI** (`ESC [`, "Control Sequence Introducer") — terminal *control*: cursor movement, colors/SGR, scrolling, mode switches, key-input encoding. Numeric/short parameters, terminated by a final letter. Most CSIs are handled by xterm.js; MouseTerm only intervenes where noted in [Supported CSI](#supported-csi).
- **OSC** (`ESC ]`, "Operating System Command") — *out-of-band metadata* to the terminal emulator itself: titles, CWD, notifications, hyperlinks, clipboard, prompt markers. String-shaped payloads, terminated by `BEL` or `ST`. MouseTerm parses these at the PTY data boundary; see [Supported OSCs](#supported-oscs).
- **DCS** (`ESC P`, "Device Control String") — longer payloads, currently relevant only as the response shape for `CSI > q` (iTerm2 extended device attributes).

Rule of thumb: CSI talks to the screen, OSC talks to the application hosting the screen, DCS is the response channel for richer queries.

## Parsing location

OSC sequences are introduced by `ESC ]` and terminated by either `BEL` (`\x07`) or `ST` (`ESC \`). A `BEL` that terminates an OSC is part of that OSC sequence, not a standalone bell notification. Both terminators are accepted across all supported sequences, and the parser handles split chunks across PTY reads.

Supported OSCs are parsed at the PTY data boundary in the platform adapter:

- VS Code: in the extension host (`message-router.ts` / `pty-manager.ts`), before `pty:data` is forwarded to the webview.
- Standalone and fake adapters: in the frontend adapter, before xterm.js sees the bytes.

After parsing, supported sequences are consumed and not re-emitted. Known unsupported iTerm2/clipboard-capable OSCs listed in [Known-unimplemented iTerm2 and clipboard-capable sequences](#known-unimplemented-iterm2-and-clipboard-capable-sequences) are also consumed and ignored. The platform sends two streams to the webview:

- `pty:data` — terminal output with supported OSCs already parsed/stripped. Feeds xterm.js.
- `terminal:semanticEvents` — normalized semantic events parsed in the platform (CWD, prompt/command boundaries, titles). Feeds `TerminalPaneState`; command boundaries also feed the command-exit alert track defined in `docs/specs/alert.md`.
- Notification-derived state is delivered through `AlertManager` calls / `alert:state` messages, not through `pty:data`.

For replay (`pty:replay`), the webview re-parses semantic OSCs from the buffered raw stream during reconstruction. Replay must not re-fire alerts, activity-monitor events, or protocol notifications: saved scrollback may contain raw OSC sequences, but replay filtering suppresses all protocol side effects so a resumed Session does not re-ring on every reload.

The parser also classifies each PTY data chunk for activity-monitor purposes:

- A chunk that contains only notification/progress OSCs after parsing must not be fed to the activity monitor's `onData()` as generic meaningful output.
- A chunk that contains visible output plus notification/progress OSCs still counts visible output as activity.

Unknown non-iTerm2 OSC families pass through to xterm.js unchanged so xterm.js can handle standard terminal behavior MouseTerm does not model. Security-sensitive or iTerm2-identity-triggered OSCs must not rely on xterm.js defaults: if they are not in [Supported OSCs](#supported-oscs), MouseTerm consumes and ignores them without visible terminal garbage, clipboard access, file access, focus changes, or other side effects.

## Supported OSCs

| Sequence | Purpose | Spec |
|---|---|---|
| `BEL` (standalone, outside an OSC) | Generic terminal-bell notification | [alert.md](alert.md#standalone-bel) |
| `OSC 0 ; <title> ST` | Window/icon title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 2 ; <title> ST` | Window title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 7 ; file://host/path ST` | CWD (xterm-style URI) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
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

Some sequences are dual-purpose. The notification rows for `OSC 9 ; <message> ST`, `OSC 99` (`p=title`/`p=body`), and `OSC 777 ; notify` also feed the title-candidate channel in `terminal-state.md` — see its [Title candidate diagnostics](terminal-state.md#supported-osc-inputs) table. Only the OSC 9 *message* form can become a header/door label; OSC 99 and OSC 777 candidates are stored for the diagnostic popup only. The OSC 9 *progress* form (`OSC 9 ; 4`) carries no text and never contributes a title candidate.

## Supported CSI

The vast majority of CSI handling is delegated to xterm.js. MouseTerm only intervenes in the cases below — either to answer a query itself (so the response shape is under our control), to observe a state change xterm.js processes, to enable an xterm.js feature, or to filter replay output.

| Sequence | Role | Disposition | Where |
|---|---|---|---|
| `CSI > q` | iTerm2 extended device-attributes query | MouseTerm answers with `DCS > \| iTerm2 [version] ST` at the PTY boundary; not forwarded to xterm.js. | [iTerm2 identity](#iterm2-identity) |
| `CSI ? ... h` (DECSET) | Private-mode set, including mouse tracking and bracketed paste | Observed via an xterm.js parser hook that returns false (xterm still handles the sequence); the mouse-selection store reads `terminal.modes` in a microtask. | `docs/specs/mouse-and-clipboard.md` |
| `CSI ? ... l` (DECRST) | Private-mode reset, including mouse tracking and bracketed paste | Same observation pattern as DECSET. | `docs/specs/mouse-and-clipboard.md` |
| Kitty keyboard protocol | Disambiguated key-event reporting (CSI u with modifiers, e.g. Shift+Enter distinguishable from Enter) | Enabled by passing `vtExtensions: { kittyKeyboard: true }` to the xterm.js `Terminal` constructor; xterm.js handles the push/pop (`CSI > u` / `CSI < u`) and the modified key reports. | `lib/src/lib/terminal-lifecycle.ts` |

### Replay-time CSI filtering

During `pty:replay`, MouseTerm reconstructs scrollback by replaying saved bytes through xterm.js. Apps in that scrollback often left behind cursor-position reports, device-attribute responses, focus reports, and similar terminal-generated replies. xterm.js may re-emit those during replay; routing them into the new shell would corrupt its input buffer. MouseTerm's reply filter (`lib/src/lib/terminal-report-filter.ts`) drops replay-time CSI replies of the following shapes:

- Cursor-position / device-status (`CSI [?]\d+;\d+ R/n`)
- Primary/secondary/tertiary device attributes (`CSI [?>=]\d* c`)
- Window manipulation reports (`CSI \d+;\d+ t/x`)
- DECRQSS-style reports (`CSI [?]\d+ $y`)
- Focus reports (`CSI I` / `CSI O`)
- OSC and DCS replies of any shape

This filter is limited to *terminal-generated reports*. User keyboard escape sequences — arrows, function keys, bracketed paste, and modified key reports from the kitty keyboard protocol — must not be swallowed. See `docs/specs/transport.md` and `docs/specs/layout.md` for the contexts that invoke the filter.

### Pass-through and fail-inertly

Unknown CSI sequences pass through to xterm.js so it can handle standard terminal behavior MouseTerm does not model. The same fail-inertly rule that applies to OSCs (see [iTerm2 identity](#iterm2-identity)) applies to CSIs: any sequence that xterm.js does not recognize must be consumed silently — no visible terminal garbage, no clipboard or file access, no focus changes, no other side effects.

## iTerm2 identity

MouseTerm reports an iTerm2-compatible identity so that tools (shells, build systems, agent clients) emit the iTerm2-style escape codes that this spec set supports.

Environment for spawned PTYs:

| Variable | Value |
|---|---|
| `TERM_PROGRAM` | `iTerm.app` |
| `TERM_PROGRAM_VERSION` | MouseTerm's chosen iTerm2 compatibility version, not the package version |
| `LC_TERMINAL` | `iTerm2` only if needed by real-world shell integrations |
| `LC_TERMINAL_VERSION` | same compatibility version as `TERM_PROGRAM_VERSION` |

Device/version query:

- On `CSI > q`, respond with `DCS > | iTerm2 [version] ST`, matching iTerm2's extended device attributes response shape.
- Use a single compatibility version across env and device responses.
- Do not advertise feature-specific support until the relevant behavior exists.

Because this identity can cause tools to emit more iTerm2 escape codes than MouseTerm implements, **unsupported escape codes must fail inertly**: consume or ignore them without visible terminal garbage, privilege escalation, clipboard access, file access, or focus stealing. This rule applies to both OSC and CSI sequences (see [Known-unimplemented iTerm2 and clipboard-capable sequences](#known-unimplemented-iterm2-and-clipboard-capable-sequences) for OSCs and the [Pass-through and fail-inertly](#pass-through-and-fail-inertly) note under CSI).

## Known-unimplemented iTerm2 and clipboard-capable sequences

MouseTerm intentionally does not implement the following sequences. They are mostly iTerm2-proprietary; `OSC 50` (font) and `OSC 52` (clipboard) are standard xterm extensions included here because the iTerm2 identity prompts tools to emit them and they have security implications. All of them must fail inertly per the rule above, which means they are consumed/ignored rather than forwarded to xterm.js.

| Sequence | Purpose | Reason for non-support |
|---|---|---|
| `OSC 1337 ; SetMark` | Pin a navigable scrollback mark | No mark UI in MouseTerm. |
| `OSC 1337 ; CursorShape=...` | Cursor shape override | Cursor shape comes from MouseTerm settings, not the PTY. |
| `OSC 1337 ; SetBadgeFormat=...` | Display a badge string in the terminal | No badge UI. |
| `OSC 1337 ; ClearScrollback` | Clear scrollback buffer | xterm.js handles native clear-screen sequences. |
| `OSC 1337 ; CopyToClipboard=...` / `EndCopy` | Programmatic clipboard write | Security: untrusted PTY output cannot write the user's clipboard. See `docs/specs/mouse-and-clipboard.md`. |
| `OSC 1337 ; RequestUpload=...` | Begin file upload from terminal | No file-transfer protocol. |
| `OSC 1337 ; File=...` | Inline image protocol | No inline-image rendering. |
| `OSC 1337 ; SetUserVar=...` | Set a per-tab user variable | No user-variable surface. |
| `OSC 50 ; <font> ST` | Set font dynamically | Font is host-controlled. |
| `OSC 52 ; <selection> ; <data> ST` | Programmatic clipboard write | Security: same rationale as `CopyToClipboard`. |

This list is non-exhaustive. Any iTerm2-compatibility OSC family that MouseTerm can identify and that is not in the [Supported OSCs](#supported-oscs) table is ignored.

## References

- iTerm2 proprietary escape codes: https://iterm2.com/documentation-escape-codes.html
- xterm control sequences (OSC 0 / 2 / 7): https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- VS Code shell integration sequences (OSC 633): https://code.visualstudio.com/docs/terminal/shell-integration
- Windows Terminal CWD OSC 9;9: https://learn.microsoft.com/en-us/windows/terminal/tutorials/new-tab-same-directory
- kitty desktop notifications (OSC 99): https://sw.kovidgoyal.net/kitty/desktop-notifications/
- kitty keyboard protocol: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- WezTerm escape sequences (OSC 777): https://wezterm.org/escape-sequences.html
