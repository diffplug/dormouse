# Terminal Escapes — Rationale

> Informative companion to [terminal-escapes.md](terminal-escapes.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Families

**Why BEL terminates only OSC.** xterm's BEL-as-ST tolerance is an OSC-era convention; ECMA-48 ends DCS, SOS, PM, and APC with ST alone. Treating BEL as a terminator everywhere truncated sixel and Kitty payloads mid-image, and — because the parser reads a standalone BEL as a bell — turned a `0x07` byte inside binary graphics data into a spurious terminal-bell alert. Framing the four non-OSC families explicitly removed both.

**Why the forwarding state remembers the string's kind.** Resuming every forwarded string as an OSC read the first `BEL` in a later sixel or Kitty chunk as its terminator, cutting the image in half and promoting the rest of the payload to text — the same defect as reading BEL as a universal terminator, one chunk boundary later.

## Parsing location

**Why the incomplete-OSC buffer is capped.** The parser must hold bytes across PTY reads for a sequence split mid-flight, so an OSC that is never terminated would otherwise accumulate forever. No legitimate emitter sends a 16 KiB title, so dropping the held bytes past `OSC_INCOMPLETE_LIMIT` turns an unbounded-growth primitive into a discarded chunk.

**Why `COMMAND_LINE_LIMIT` is applied on both sides of the unescape.** Bounding first stops a hostile command line from making the unescape allocate; sanitizing after catches the `\xNN` decoding, which is precisely what puts control characters back into a value that looked clean going in.

**Why the sidecar no longer parses a second time.** It used to: standalone stripped in the frontend adapter, which the sidecar's stream to the phone never passed through, so without a second strip-only pass the phone saw OSC sequences the laptop never rendered. That pass needed a fake colour provider — "discarded" and "not parsed" are different things, and a *declined* OSC 10/11/12 survives in `visibleData` for the phone's xterm to answer a second time — and it began at first attach, so it could start mid-sequence. One parse at the process that owns the PTY removes the duplicate, the workaround, and the mid-sequence start together. What it costs is the theme push, since the sidecar has no DOM, and a webview that is told the semantic and notification events rather than deriving them.

**Why a late sink waits for ground.** An image is many PTY reads, and the renderer behind a sink is a real xterm: handed `AAAA…BEL` with no `OSC 1337;File=` in front of it, it paints the base64. Holding that sink to the next ground byte costs it the one image it landed inside and nothing else — the alternative, replaying the payload from its introducer, means retaining megabytes per PTY against the chance that someone attaches.

**Why the input bound is 128 Ki code units.** The cap it protects is on the *encoded* message: 1 MiB of base64url plus JSON framing (`MAX_APP_MESSAGE_LENGTH`). One UTF-16 code unit can encode to three UTF-8 bytes, and a parsed chunk can carry up to `OSC_INCOMPLETE_LIMIT` more than its input, so 128 Ki bounds the worst case near 576 KiB — where 256 Ki would reach the cap exactly and overflow on the framing. libuv reads 64 KiB, so the split is a ceiling on a pathological read rather than something the common path meets. Splitting between a surrogate pair's halves would be worse than not splitting at all: `utf8Encode` turns a lone surrogate into U+FFFD, so the character would not survive the wire.

## `pty:data` strip semantics

**Why replay is inert.** Buffered scrollback is a recording of protocol traffic, so re-parsing it without suppression would re-ring alerts for notifications the user dismissed weeks ago, re-fire quiesce transitions for commands that finished long ago, and write answers to queries whose asker is dead — all of it on every reload of a resumed Session. CWD, prompt/command and title survive the suppression because they are state rather than events.

## Supported OSCs

**Why the color queries are answered rather than passed through.** A TUI that adapts to a light or dark background asks with `OSC 11 ; ?`; with no answer it assumes dark, and on a light theme its adaptive chrome — Codex's composer "pill", for one — renders unreadable. xterm.js does not answer the query itself, so the parse boundary is the only place holding the real theme.

**Why a forwarded OSC streams past the buffer.** The limit exists to protect the parser's own `pending` string, which must hold bytes across PTY reads for a sequence split mid-flight. That reason applies only to a sequence the parser will consume: it has to see the whole payload to parse it. A sequence it will forward needs no terminator to be useful, and streaming retains at most one held `ESC`, so `pending` cannot grow — the guarantee is honored rather than waived. xterm.js caps its own OSC payload at 10 MB, and ImageAddon's registered handlers decode as bytes arrive, so nothing downstream accumulates without bound either.

Keying this on the disposition rather than on an IIP command list also fixes the case that motivated it in reverse: before, *any* forwarded OSC over 16 KiB was silently discarded rather than reaching xterm.js — an `OSC 8` hyperlink with a long URI, or a palette sequence. Images were merely the first payload big enough to notice.

**Why the id must settle before routing.** The disposition is read from the leading digits, but `133` (prompt boundary, consumed) is a prefix of `1337` (image, forwarded). Deciding on a partial id would route an image into the 16 KiB buffer. Returning "undecided" while the content is still all digits costs a few buffered bytes and removes the ambiguity.

## OSC color queries on Windows require the bundled ConPTY

**Two ConPTY backends, one of which eats the query.** Which backend node-pty spawns with decides whether a program's query reaches the consumer at all: under the in-box `CreatePseudoConsole` it never does, so nothing can answer and the light-theme failure under [Supported OSCs](#supported-oscs) is unavoidable on Windows. The bundled OpenConsole path is the same passthrough Windows Terminal itself relies on, which is what makes the extra prebuilds worth their packaging cost on both distributions.

## Supported CSI

**Why win32-input-mode exists alongside the kitty protocol.** A ConPTY app that reads through the Console API rather than the VT stream — Codex on Windows — cannot negotiate the kitty protocol at all, so without win32-input-mode a key like Shift+Enter or Ctrl+J reaches it as a bare byte, or not at all.

**Why an arbiter rather than a static choice.** xterm.js gives win32-input-mode precedence per keypress, and ConPTY's conhost enables it proactively rather than on the app's behalf, so leaving it on would silently break every kitty consumer in the window — and a kitty TUI (Claude Code) and a win32 TUI (Codex) routinely run in the same one.

**Why the device-attributes query is recognized in ground text only.** Scanning the assembled output instead reads a `U+009B > q` run inside a forwarded sixel or Kitty payload as a query: it deletes three bytes from an image on its way to xterm.js and writes an answer nobody asked for into the PTY's input. Only the C1 spelling can reach a payload — an `ESC` would have ended the string — so the assembled scan read as safe right up until the parser started forwarding string controls whole. The held-suffix half has the same shape: a chunk ending mid-payload on `U+009B` would park that byte in `pending`, which the forwarding path never reads, and re-emit it after the terminator of the string it belonged inside.

## Inline graphics

**Why the memory ceilings are below the addon's defaults.** ImageAddon storage is per Terminal instance, while Dormouse keeps minimized Sessions and their xterm instances alive. The upstream 128 MB cache and 16,777,216-pixel ceiling can therefore multiply across every visible and minimized pane. The 8,388,608-pixel ceiling admits a 3840×2160 image while halving the addon's worst decode-buffer footprint.

**Why `storageLimit` is 34 and not 32.** The addon derives cache capacity as `storageLimit / 4 * 1e6` pixels, so the cache must be at least `pixelLimit` × 4 bytes (33.55 MB) or admitting one full-size image evicts every other image in that Session and still exceeds the budget. 34 MB is the smallest round value that clears it; the two constants move together.

**Why the per-sequence byte caps are stated rather than inherited.** 33,554,432 bytes (32 MiB) for SIXEL, IIP, and Kitty and a 4,096-colour `sixelPaletteLimit` are not raises: they are `@xterm/addon-image@0.10.0-beta.301`'s own defaults, as are `enableSizeReports`, `showPlaceholder`, and the three `*Support` flags (verified against the pinned package's `DEFAULT_OPTIONS`; only `pixelLimit` and `storageLimit` differ from it). Restating them pins one encoded-size bound to reason about, so an addon bump that lowers a default cannot silently start rejecting a 4K PNG at the sequence boundary before the pixel ceiling can judge it. Decoded memory is bounded by the pixel and storage ceilings above regardless of encoded size.

**Why the addon loads eagerly rather than on the first image.** `ImageAddon.activate` answers DA1 with `62;4;9;22` (the `4` advertising SIXEL), registers XTSMGRAPHICS, and turns on the `CSI 14/16/18 t` size reports. A program probes those, decides, and only then sends pixels, so a Session that waited for image bytes would already have told it there is no graphics support and the bytes would never arrive. Keying activation on the probes instead is correct but buys little: `CSI c` is the ordinary "is this a real terminal" query most TUIs send at startup. What a Session actually pays eagerly is the handler registrations plus one sixel WASM instance — the module is compiled once per page, the sixel canvas starts empty, and the base64/QOI decoder memory and image storage are allocated on first use — so `cfg.terminal.inlineImages` is an on/off lever rather than a deferral.

**Why there is no page-global image budget.** `storageLimit` is per Terminal and Sessions outlive unmount, so the configured ceiling multiplies by pane count on paper. Measured, it does not: ImageAddon retains an image only while its tiles are live in the buffer, and deletes it when they are overwritten or scroll out of scrollback. A 600x300 pane showing a 1-megapixel image held 0.7 MB — the rendered area, not the source — and a 200x50-cell pane packed with forty such images held 3.1 MB, because each one overwrote its predecessor's tiles. Scrolling the image past a 1,000-line scrollback dropped the pane to 0 MB. So retained image memory tracks what is on screen and in scrollback, at a few MB per pane, and a registry-level LRU would be re-solving what buffer liveness already does. The 34 MB ceiling is a backstop, not a working set. (Measured in Chrome 152, 2026-09; the addon's accounting counts source pixels, so `storageUsage` is an upper bound on the real cost.)

**Why prompt filtering is stateful.** The keystroke fallback reads a rolling 1,024-character output tail. A stateless control stripper removes a complete `APC G`, SIXEL DCS, or IIP OSC, but a later PTY chunk begins with bare base64 after the introducer fell out of that window. Carrying only the string-control state across reads removes the payload without changing what xterm receives.

## Report filtering on the input side

**Why replayed reports are dropped rather than forwarded.** Replayed scrollback routinely contains terminal-generated replies from a long-dead app — cursor-position reports, device attributes, focus events. Forwarding them into the freshly spawned shell corrupts whatever it was parsing, and the user sees garbage typed into a prompt they never touched.

## Replay-time mode-reset tail (Dormouse-emitted)

**Why a reset tail at all.** Saved scrollback can end mid-TUI with private modes still latched — mouse tracking, the alt-screen, a hidden cursor, application cursor keys. Replaying it verbatim re-applies those DECSETs with no process alive to ever DECRST them, leaving a restored pane unable to select text, showing an alt-screen frame nothing will ever repaint, or with no visible cursor at its new shell's prompt.

## iTerm2 identity

**Why claim to be iTerm2.** Shells, build systems and agent clients gate their richest escape output on a terminal they recognize, and iTerm2 is the identity that unlocks the largest set of the sequences Dormouse actually implements; the fail-inertly rule pays for the ones it also provokes.

**Why `COLORTERM` is set even though it is not iTerm2's.** The PTY is spawned as `xterm-256color` with no other depth hint, so env-sniffing tools — `supports-color` and everything built on it — quantize RGB output to the nearest palette entry.

## Shell-integration injection

**Why the mechanism cannot be uniform.** One env var guarantees a `PATH` binary is *found*, but no shell has an env var for *run our hook code on every prompt* — hence a per-shell mechanism, and hence the Channel column: an env-var channel is as reliable as the `PATH` prepend, while a `shellArgs` channel only fires for the launch shapes Dormouse recognizes.

**Why nothing may be written into the zsh dotfile directory.** It ships inside the signed macOS app bundle, and any file added to a bundle after signing invalidates the signature — Gatekeeper then reports the app "damaged" rather than naming the real problem. macOS `/etc/zshrc` sets `HISTFILE` while `ZDOTDIR` still points at our directory, so it lands inside it and has to be redirected rather than tolerated.

**Why bash injection keys on the launch args.** `--init-file` and login mode are mutually exclusive, so the script has to replace login-profile sourcing itself, which is only safe when the launch was a plain interactive/login shell — Git Bash's `--login -i` is why login flags stay in the allowed set, while anything with a specific `-c <cmd>` is a job, not a session.

**Why the PowerShell dot-source is appended, not prepended.** A launch that already carries a startup command — the VS "Developer PowerShell" arrives as `-NoExit -Command "& { Import-Module … }"` — is setting up an environment our wrapper should install *after*, or the wrapper wraps a `prompt` that the startup command then replaces.

**Why PSReadLine matters.** PowerShell has no `preexec`, so the only hook that fires between submitting a command and running it is `PSConsoleHostReadLine`, which PSReadLine supplies; wrapping it is what makes the running command appear immediately, as it does under bash and zsh. The fallback reconstructs the `E`/`C`/`D` triple from the next prompt with the command line pulled from history, leaving the running command invisible until it finishes.

**Why the WSL detector prefers bash.** It has to decide without knowing the distro. Bash whenever it exists — including when detection returns nothing — integrates the common case, stepping aside for an explicitly configured zsh or fish login shell avoids replacing a shell the user chose, and the login-shell fallback covers a distro with no bash at all, e.g. Alpine.

**Why the emit-side filter is a security boundary and not tidiness.** A POSIX path component may hold any byte but `/` and NUL, and a command line anything at all, so an attacker who names a directory or a command controls bytes that can close the `633` sequence early. `OSC 9` is the most damaging thing to forge in the remainder the parser then trusts: an alert latches a ring, persists, is spoken aloud, and is pushed to the paired phone. The attack is invisible and durable — the injected bytes are consumed by the parser, so nothing appears on screen, and a poisoned directory re-fires for everyone who enters it, outliving the process that planted it.
