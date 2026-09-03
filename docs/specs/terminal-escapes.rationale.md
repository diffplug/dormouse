# Terminal Escapes — Rationale

> Informative companion to [terminal-escapes.md](terminal-escapes.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Parsing location

**Why the incomplete-OSC buffer is capped.** The parser must hold bytes across PTY reads for a sequence split mid-flight, so an OSC that is never terminated would otherwise accumulate forever. No legitimate emitter sends a 16 KiB title, so dropping the held bytes past `OSC_INCOMPLETE_LIMIT` turns an unbounded-growth primitive into a discarded chunk.

**Why `COMMAND_LINE_LIMIT` is applied on both sides of the unescape.** Bounding first stops a hostile command line from making the unescape allocate; sanitizing after catches the `\xNN` decoding, which is precisely what puts control characters back into a value that looked clean going in.

**Why the sidecar parses a second time, once per PTY.** In standalone the stripping happens in the frontend adapter, which the sidecar's stream to the phone never passes through — without a second parser the sidecar would ship the phone raw OSC sequences the laptop never sees. "Discarded" and "not parsed" are different things there, and the difference is a bug: a declined query survives in `visibleData` and is answered twice. Per PTY rather than per attachment because an incomplete sequence's remainder belongs to that PTY's byte boundaries, so a late joiner inheriting it beats a fresh parser emitting a tail whose head it never saw.

## `pty:data` strip semantics

**Why replay is inert.** Buffered scrollback is a recording of protocol traffic, so re-parsing it without suppression would re-ring alerts for notifications the user dismissed weeks ago, re-fire quiesce transitions for commands that finished long ago, and write answers to queries whose asker is dead — all of it on every reload of a resumed Session. CWD, prompt/command and title survive the suppression because they are state rather than events.

## Supported OSCs

**Why the color queries are answered rather than passed through.** A TUI that adapts to a light or dark background asks with `OSC 11 ; ?`; with no answer it assumes dark, and on a light theme its adaptive chrome — Codex's composer "pill", for one — renders unreadable. xterm.js does not answer the query itself, so the parse boundary is the only place holding the real theme.

## OSC color queries on Windows require the bundled ConPTY

**Two ConPTY backends, one of which eats the query.** Which backend node-pty spawns with decides whether a program's query reaches the consumer at all: under the in-box `CreatePseudoConsole` it never does, so nothing can answer and the light-theme failure under [Supported OSCs](#supported-oscs) is unavoidable on Windows. The bundled OpenConsole path is the same passthrough Windows Terminal itself relies on, which is what makes the extra prebuilds worth their packaging cost on both distributions.

## Supported CSI

**Why win32-input-mode exists alongside the kitty protocol.** A ConPTY app that reads through the Console API rather than the VT stream — Codex on Windows — cannot negotiate the kitty protocol at all, so without win32-input-mode a key like Shift+Enter or Ctrl+J reaches it as a bare byte, or not at all.

**Why an arbiter rather than a static choice.** xterm.js gives win32-input-mode precedence per keypress, and ConPTY's conhost enables it proactively rather than on the app's behalf, so leaving it on would silently break every kitty consumer in the window — and a kitty TUI (Claude Code) and a win32 TUI (Codex) routinely run in the same one.

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
