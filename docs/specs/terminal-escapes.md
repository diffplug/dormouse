# Terminal Escape Sequence Registry

> See `docs/specs/glossary.md` for the Session vocabulary used when a row talks about replay or resumed Sessions.

> **Owns:** the exhaustive registry — every sequence Dormouse parses, answers, or ignores has one row below — plus the string-control framing, the parse sites, and the strip/replay rules.
> **Defers** each row's behavior to the spec its row names.

## Families

- **CSI** (`ESC [`, or the C1 `U+009B`) — screen control. xterm.js owns all of it except [Supported CSI](#supported-csi).
- **OSC** (`ESC ]`, or the C1 `U+009D`) — out-of-band metadata for the emulator itself. **All three OSC terminators are accepted**: `BEL` (`\x07`), `ST` (`ESC \`), the C1 ST `U+009C`. See [Supported OSCs](#supported-oscs).
- **DCS** (`ESC P`, or the C1 `U+0090`) — device-control strings: SIXEL graphics input and the shape of Dormouse's `CSI > q` answer.
- **APC** (`ESC _`, or the C1 `U+009F`) — application-program commands; Kitty graphics uses `APC G`.

**The parser frames all five string controls — OSC, DCS, SOS, PM, APC — and models nothing outside OSC**, so DCS and APC are forwarded whole. **`BEL` terminates only OSC**; inside the others it is payload, never a bell (rationale). **CAN, SUB, or a bare `ESC` cancels any string control** — the cancelled sequence yields no semantic event, and a bare `ESC` is re-read as the start of the sequence it actually opens. **A forwarding parser must remember the kind it is resuming** (rationale). **A string control may split across PTY reads at any position** — introducer, terminator, and cancel alike.

**The parser and the text filter frame through one tokenizer.** Source of truth: `STRING_CONTROL_INTRODUCER` and `stringControlEndScan` in `lib/src/lib/terminal-controls.ts`, consumed by `findStringControlEnd` in `lib/src/lib/terminal-protocol.ts`; the two are pinned against each other by `lib/src/lib/terminal-controls.test.ts`.

## Parsing location

State-driving and security-sensitive OSCs — plus the `CSI > q` query — are parsed by the process that owns the PTY: **one parser per PTY generation, fed from spawn, never one per consumer**, because **a second over the same bytes answers every query twice and writes the duplicate into the PTY's input**. One site per host, the same `createOwnerPtyStream` in both — the VS Code extension host and the standalone sidecar — each ahead of `pty:data`; the fake adapter is the same rule with the owner in the browser.

**Must buffer an unterminated consumed OSC up to `OSC_INCOMPLETE_LIMIT` (16,384 UTF-16 code units), then discard through its terminator or cancellation**, retaining only a split `ESC`, never promoting payload to text or its terminating BEL to an alert (rationale). A complete sequence in a single read is parsed whole. Pinned by `discards an oversized consumed OSC through its %j terminator` in `lib/src/lib/terminal-protocol.test.ts`. **An unterminated OSC the parser will forward streams to xterm.js instead**, preserving a split `ESC \` terminator (rationale). **Route by the OSC id, and decide nothing while more digits could follow** — `133` becomes `1337` — for `1337` by the subcommand ([layout.md](layout.md#inline-graphics)).

Retained semantic-value bounds: `docs/specs/terminal-state.md` -> "Supported OSC Inputs".

**The owner alone acts on the events** its parse produced — writing the responses, feeding its `AlertManager`, forwarding the semantic and Tool events to the owning renderer — and hands every consumer the same chunk ([remote-api.md](remote-api.md#terminal-surfaces)).

**A sink that subscribes inside a forwarded string control starts at the next ground byte**, a cancel releasing it as surely as a terminator (rationale); only a late attachment is ever held, the owner's renderer being there from spawn.

**The owner splits a PTY read above `MAX_PARSER_INPUT_CHARS` (64 Ki UTF-16 code units) before parsing it, and never through a surrogate pair**, so **both** projections — one message, not two — fit the 1 MiB application-message cap after base64url and JSON framing (rationale; [remote-api.md](remote-api.md)).

Two escape-aware consumers are **not** parse sites: `lib/src/lib/terminal-controls.ts` strips presentation controls and `lib/src/lib/terminal-state-store.ts` elides alternate-screen spans ([terminal-state.md](terminal-state.md)). Both read already-stripped output; neither changes what reaches xterm.js.

Source of truth: `oscDispositionAt` in `lib/src/lib/terminal-protocol.ts`, `createProcessedPtyStream` in `lib/src/lib/processed-pty-stream.ts`, `createOwnerPtyStream` in `lib/src/host/owner-pty.ts`.

### `pty:data` strip semantics

**Supported semantic sequences are consumed and never re-emitted** — empty or unparseable payloads, unrecognized `OSC 1337` subcommands, `OSC 50`, and `OSC 52` included. **`OSC 8` and the recognized ImageAddon `OSC 1337` forms are the exceptions**: they stay in `pty:data` so xterm.js owns hyperlink regions and inline graphics. Dormouse supplies only the hyperlink activation handler. Every other OSC family passes through unchanged, so xterm.js handles standard behavior Dormouse does not model.

**`textData` is the same chunk with every string-control payload removed**, for consumers reading output as text; every other control is left for `stripTerminalControls`. The webview receives them apart: `pty:data` (the stripped output; feeds xterm.js), `terminal:semanticEvents` (normalized CWD / prompt-command / title events; feeds `TerminalPaneState`), and `terminal:toolEvents` (OSC 367, [dor-tool.md](dor-tool.md#osc-367)). **Notification-derived state never travels as `pty:data`**: the parse site feeds its own process's `AlertManager`.

Each chunk is also classified for the quiesce detector: **the activity monitor's `onData()` fires only when `visibleData` is non-empty**, so a chunk of nothing but notification/progress OSCs is not meaningful output, while one carrying visible output alongside them is.

Replay (`pty:replay`) is the raw stream requiring re-parse: **the webview runs a one-shot parser over the buffered bytes** (`parseReplay` in `lib/src/lib/platform/replay-parse.ts`), so semantic state repopulates and OSCs are stripped before xterm sees them. **Historical replay must not re-fire** alerts, quiesce events, protocol notifications, or query responses — it applies the semantic and Tool events and drops the rest (rationale). **Every parser in a realm holding the theme takes `themeColorProvider`**, one-shot replay parsers included: a *declined* query stays in `visibleData` for the receiving renderer to answer, and answering is the owner's alone (rationale).

## Supported OSCs

| Sequence | Purpose | Spec |
|---|---|---|
| `BEL` (standalone, outside an OSC) | Generic terminal-bell notification, collapsed per batch | [alert.md](alert.md#terminal-reports) |
| `OSC 0 ; <title> ST` | Window/icon title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 2 ; <title> ST` | Window title | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 7 ; file://host/path ST` | CWD (xterm-style URI) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 8 ; <params> ; <URI> ST ... OSC 8 ; ; ST` | Explicit hyperlink region; passed through to xterm.js, activated by Dormouse's link handler | [mouse-and-clipboard.md](mouse-and-clipboard.md#osc-8-hyperlinks) |
| `OSC 10 ; ? ST` / `OSC 11 ; ? ST` / `OSC 12 ; ? ST` | Foreground / background / cursor color **query**; consumed and answered from the terminal theme, *set* forms passed through | [theme.md](theme.md#terminal-color-contract) |
| `OSC 9 ; <message> ST` | iTerm2 legacy notification | [alert.md](alert.md#terminal-reports) |
| `OSC 9 ; 4 ; <state> [; <progress>] ST` | iTerm2 progress | [alert.md](alert.md#terminal-reports) |
| `OSC 9 ; 9 ; <cwd> ST` | CWD (Windows Terminal / ConEmu) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 9 ; <n> [; ...] ST` | Any other ConEmu subcommand — sleep, tab title, GuiMacro, the `9;12` prompt mark, a bare `9;9`; consumed and ignored | [alert.md](alert.md#terminal-reports) |
| `OSC 99 ; <metadata> ; <payload> ST` | kitty desktop notification. Dormouse also **answers** the `p=?` capability query with `OSC 99 ; [i=<id>:]p=? ; o=always:p=title,body ST`. | [alert.md](alert.md#terminal-reports) |
| `OSC 133 ; A/B/C/D [...] ST` | Prompt/command boundaries, `C` optionally carrying the command line (`cmdline_url=` / `cmdline=`); command-exit alert input | [terminal-state.md](terminal-state.md#supported-osc-inputs), [alert.md](alert.md#command-exit-track) |
| `OSC 633 ; A/B/C/D ST` | VS Code prompt/command boundaries, which Dormouse's shell integration emits; command-exit alert input | [terminal-state.md](terminal-state.md#supported-osc-inputs) and [its injection](terminal-state.md#shell-integration-injection), [alert.md](alert.md#command-exit-track) |
| `OSC 633 ; E ; <commandline> [; <nonce>] ST` | VS Code command line | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 633 ; P ; Cwd=<cwd> ST` | CWD (VS Code) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 777 ; notify ; <title> ; <body> ST` | rxvt/WezTerm notification | [alert.md](alert.md#terminal-reports) |
| `OSC 367 ; serve ; <json> ST` | Dor Tool announcement: selects a bound port and optional same-origin path, plus a reserved name and runtime re-key | [dor-tool.md](dor-tool.md#osc-367) |
| `OSC 367 ; state ; <json> ST` | Tool-reported unsaved state | [dor-tool.md](dor-tool.md#unsaved-changes) |
| `OSC 367 ; open ; <json> ST` | A running Tool's request to open a local path as `dor open`, preview or not; live output only | [dor-tool.md](dor-tool.md#osc-367) |
| `OSC 367 ; dehydrate ; <json> ST` | A stopping Tool's restore payload; live output only | [dor-tool.md](dor-tool.md#reaping) |
| `OSC 367 ; <any other verb> ST` | Consumed and ignored | [dor-tool.md](dor-tool.md#osc-367) |
| `OSC 1337 ; CurrentDir=<cwd> ST` | CWD (iTerm2 compatibility) | [terminal-state.md](terminal-state.md#supported-osc-inputs) |
| `OSC 1337 ; File=...:<data> ST` / `MultipartFile=...` / `FilePart=...` / `FileEnd` | iTerm2 inline image protocol (IIP); passed through to ImageAddon. | [layout.md](layout.md#inline-graphics) |
| `OSC 1337 ; ReportCellSize ST` | iTerm2 cell-size query; passed through and answered by the owner's ImageAddon. | [layout.md](layout.md#inline-graphics) |
| `OSC 1337 ; <anything else> ST` | Unsupported iTerm2 extension; consumed and ignored. | [security-local.md](security-local.md#terminal-output) |
| `OSC 50 ; <font> ST` | Unsupported dynamic font change; consumed and ignored. | [security-local.md](security-local.md#terminal-output) |
| `OSC 52 ; <selection> ; <data> ST` | Clipboard write: consumed, and only offered to the copy editor over a shadowed drag; a `?` read is never answered. | [mouse-and-clipboard.md](mouse-and-clipboard.md) §4.6 |

**A `BEL` that terminates an OSC is part of that sequence, never a bell**; the `BEL` row covers a standalone one, parsed and stripped at the same boundary.

`OSC 9 ; <message>`, `OSC 99` and `OSC 777 ; notify` also feed the title-candidate channel, whose promotion rules [terminal-state.md](terminal-state.md#supported-osc-inputs) owns.

## Supported string controls

| Sequence | Purpose | Spec |
|---|---|---|
| `DCS ... q ... ST` | SIXEL graphics; forwarded whole to ImageAddon | [layout.md](layout.md#inline-graphics) |
| `APC G ... ST` | Kitty graphics; forwarded whole, its queries answered by the owner's ImageAddon | [layout.md](layout.md#inline-graphics) |

## Supported CSI

| Sequence | Role | Disposition | Where |
|---|---|---|---|
| `CSI > q` | iTerm2 extended device-attributes query | Answered `DCS > \| iTerm2 <version> ST` at the PTY boundary and stripped, never forwarded to xterm.js. Both `ESC [ > q` and the C1 `U+009B > q` are recognized, **in ground text only** (rationale). | [transport.md](transport.md#iterm2-identity) |
| `CSI ? ... h` (DECSET) / `CSI ? ... l` (DECRST) | Private-mode set/reset, including mouse tracking and bracketed paste | Observed without consuming; xterm.js still handles the sequence. | [mouse-and-clipboard.md](mouse-and-clipboard.md#61-state-matrix), §8.5 |
| Kitty keyboard protocol | Disambiguated key-event reporting (CSI u with modifiers, e.g. Shift+Enter distinguishable from Enter) | Enabled; xterm.js handles the push/pop (`CSI > u` / `CSI < u`) and the modified key reports. | `xtermVtExtensions` in `lib/src/lib/xterm-options.ts` |
| `CSI ? 9001 h/l` (win32-input-mode) | Faithful Win32 `INPUT_RECORD` key reporting for ConPTY apps reading via the Console API — Codex on Windows (rationale) | Advertised **only on Windows**; off for a pane while any kitty consumer is on its protocol stack, the two being mutually exclusive in xterm.js (rationale). | `lib/src/lib/keyboard-protocol-arbiter.ts` |
| `CSI ? 996 n` / `CSI ? 2031 h/l` | Color-scheme query; change reports on/off | Answered by the owner's xterm.js (`colorSchemeQuery`); its reply is a [terminal reply](transport.md#report-filtering-on-the-input-side). | `xtermVtExtensions` in `lib/src/lib/xterm-options.ts` |
| `CSI c` | Primary device-attributes query | Answered by the owner's ImageAddon, advertising SIXEL. | [layout.md](layout.md#inline-graphics) |
| `CSI 14 t` / `CSI 16 t` / `CSI 18 t` | Window-pixel, cell-pixel, and window-character size queries | Enabled and answered by the owner's xterm.js for image preparation. | [layout.md](layout.md#inline-graphics) |
| `CSI ? 80 h/l` | SIXEL scrolling off/on | Observed by ImageAddon; xterm.js continues handling the private mode. | [layout.md](layout.md#inline-graphics) |
| `CSI ? <item> ; <action> [; <value>] S` | XTSMGRAPHICS palette/canvas geometry | The owner's ImageAddon answers supported read/set actions and an error status for the rest. | [layout.md](layout.md#inline-graphics) |
| `REPLAY_MODE_RESET` (Dormouse-emitted) | Private-mode and SGR reset written after a dead Session's replay | DECRSTs plus one DECSET and `SGR 0`, written by Dormouse into the renderer; no program sends it. | [transport.md](transport.md#replay-time-mode-reset-tail-dormouse-emitted) |

### Pass-through and fail-inertly

Unknown CSI sequences pass through to xterm.js, like unknown OSC families; the fail-inertly rule for what neither recognizes is `docs/specs/security-local.md` -> "Terminal output".

## References

- iTerm2 escape codes: https://iterm2.com/documentation-escape-codes.html
- xterm control sequences: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- VS Code shell integration (OSC 633): https://code.visualstudio.com/docs/terminal/shell-integration
- Windows Terminal OSC 9;9: https://learn.microsoft.com/en-us/windows/terminal/tutorials/new-tab-same-directory
- xterm.js OSC 8 link handling: https://xtermjs.org/docs/guides/link-handling/
- kitty desktop notifications (OSC 99): https://sw.kovidgoyal.net/kitty/desktop-notifications/
- kitty keyboard protocol: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- WezTerm escape sequences (OSC 777): https://wezterm.org/escape-sequences.html
