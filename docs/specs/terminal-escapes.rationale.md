# Terminal Escapes — Rationale

> Informative companion to [terminal-escapes.md](terminal-escapes.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Families

**Why BEL terminates only OSC.** xterm's BEL-as-ST tolerance is an OSC-era convention; ECMA-48 ends DCS, SOS, PM, and APC with ST alone. Treating BEL as a terminator everywhere truncated sixel and Kitty payloads mid-image, and — because the parser reads a standalone BEL as a bell — turned a `0x07` byte inside binary graphics data into a spurious terminal-bell alert. Framing the four non-OSC families explicitly removed both.

**Why the forwarding state remembers the string's kind.** Resuming every forwarded string as an OSC read the first `BEL` in a later sixel or Kitty chunk as its terminator, cutting the image in half and promoting the rest of the payload to text — the same defect as reading BEL as a universal terminator, one chunk boundary later.

## Parsing location

**Why the incomplete-OSC buffer is capped.** The parser must hold bytes across PTY reads for a sequence split mid-flight, so an OSC that is never terminated would otherwise accumulate forever. No legitimate emitter sends a 16 KiB title, so dropping the held bytes past `OSC_INCOMPLETE_LIMIT` turns an unbounded-growth primitive into a discarded chunk.

**What the CWD bound and control-character strip protect.** A directory name may hold any byte but `/` and NUL, and the CWD it produces is retained per Session, rendered in the pane header, and used as a grouping key — so unbounded or control-bearing text reaches the UI and a map key, not just a log line.

**Why command-line source and decoded output have separate bounds.** The source caps allow encoding expansion (4× for OSC 633 or shell quoting, 12× for percent-encoded UTF-8) while bounding decoder allocation. The retained result has its own cap; post-decode sanitization removes controls introduced by decoding.

**Why the sidecar no longer parses a second time.** It used to: standalone stripped in the frontend adapter, which the sidecar's stream to the phone never passed through, so without a second strip-only pass the phone saw OSC sequences the laptop never rendered. That pass needed a fake colour provider — "discarded" and "not parsed" are different things, and a *declined* OSC 10/11/12 survives in `visibleData` for the phone's xterm to answer a second time — and it began at first attach, so it could start mid-sequence. One parse at the process that owns the PTY removes the duplicate, the workaround, and the mid-sequence start together. What it costs is the theme push, since the sidecar has no DOM, and a webview that is told the semantic and Tool events rather than deriving them.

**Why a late sink waits for ground.** An image is many PTY reads, and the renderer behind a sink is a real xterm: handed `AAAA…BEL` with no `OSC 1337;File=` in front of it, it paints the base64. Holding that sink to the next ground byte costs it the one image it landed inside and nothing else — the alternative, replaying the payload from its introducer, means retaining megabytes per PTY against the chance that someone attaches.

**Why the input bound is 64 Ki code units.** The cap it protects is on the *encoded* message: 1 MiB of base64url plus JSON framing (`MAX_APP_MESSAGE_LENGTH`). One `terminal.data` carries **both** projections, so the budget halves before anything else. One UTF-16 code unit can encode to three UTF-8 bytes, and a parsed chunk can carry up to `OSC_INCOMPLETE_LIMIT` more than its input, so 64 Ki bounds each projection near 320 KiB and the pair near 640 KiB. 128 Ki would fit `bytes` alone and blow the cap the moment a single forwarded string made `text` differ — and an over-cap message is not truncated but dropped, silently, mid-stream. libuv reads 64 KiB, so the split is a ceiling on a pathological read rather than something the common path meets. Splitting between a surrogate pair's halves would be worse than not splitting at all: `utf8Encode` turns a lone surrogate into U+FFFD, so the character would not survive the wire.

**Why a forwarded OSC streams past the buffer.** The limit exists to protect the parser's own `pending` string, which must hold bytes across PTY reads for a sequence split mid-flight. That reason applies only to a sequence the parser will consume: it has to see the whole payload to parse it. A sequence it will forward needs no terminator to be useful, and streaming retains at most one held `ESC`, so `pending` cannot grow — the guarantee is honored rather than waived. xterm.js caps its own OSC payload at 10 MB, and ImageAddon's registered handlers decode as bytes arrive, so nothing downstream accumulates without bound either.

Keying this on the disposition rather than on an IIP command list also fixes the case that motivated it in reverse: before, *any* forwarded OSC over 16 KiB was silently discarded rather than reaching xterm.js — an `OSC 8` hyperlink with a long URI, or a palette sequence. Images were merely the first payload big enough to notice.

**Why the id must settle before routing.** The disposition is read from the leading digits, but `133` (prompt boundary, consumed) is a prefix of `1337` (image, forwarded). Deciding on a partial id would route an image into the 16 KiB buffer. Returning "undecided" while the content is still all digits costs a few buffered bytes and removes the ambiguity.

## `pty:data` strip semantics

**Why the replay parser takes the theme too, and what it is not.** Consuming the query is the rule; the replay report filter is a backstop. `inputIsReplayTerminalReport` does drop an OSC reply xterm generates while `isReplaying`, so a provider-less one-shot parser was not in fact writing colour reports into a live PTY — but that window covers one `writeReplay` call, and it catches the reply rather than preventing the query from being asked of the wrong answerer. A parser that declines has consumed nothing, and the owner is the sole reply authority everywhere else.

**Why replay is inert.** Buffered scrollback is a recording of protocol traffic, so re-parsing it without suppression would re-ring alerts for notifications the user dismissed weeks ago, re-fire quiesce transitions for commands that finished long ago, and write answers to queries whose asker is dead — all of it on every reload of a resumed Session. CWD, prompt/command and title survive the suppression because they are state rather than events.

## Supported CSI

**Why win32-input-mode exists alongside the kitty protocol.** A ConPTY app that reads through the Console API rather than the VT stream — Codex on Windows — cannot negotiate the kitty protocol at all, so without win32-input-mode a key like Shift+Enter or Ctrl+J reaches it as a bare byte, or not at all.

**Why an arbiter rather than a static choice.** xterm.js gives win32-input-mode precedence per keypress, and ConPTY's conhost enables it proactively rather than on the app's behalf, so leaving it on would silently break every kitty consumer in the window — and a kitty TUI (Claude Code) and a win32 TUI (Codex) routinely run in the same one.

**Why the device-attributes query is recognized in ground text only.** Scanning the assembled output instead reads a `U+009B > q` run inside a forwarded sixel or Kitty payload as a query: it deletes three bytes from an image on its way to xterm.js and writes an answer nobody asked for into the PTY's input. Only the C1 spelling can reach a payload — an `ESC` would have ended the string — so the assembled scan read as safe right up until the parser started forwarding string controls whole. The held-suffix half has the same shape: a chunk ending mid-payload on `U+009B` would park that byte in `pending`, which the forwarding path never reads, and re-emit it after the terminator of the string it belonged inside.
