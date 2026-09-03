# Terminal Escapes — Rationale

> Informative companion to [terminal-escapes.md](terminal-escapes.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

Much of the registry is irreducibly normative — a table row naming a sequence, its disposition and its owning spec is a rule, not evidence — so this file holds only the narratives behind the rules that have one.

## Parsing location

**Why the incomplete-OSC buffer is capped.** The parser must hold bytes across PTY reads for a sequence split mid-flight, which means an OSC that is never terminated would otherwise accumulate forever. Dropping the held bytes past `OSC_INCOMPLETE_LIMIT` costs nothing real — no legitimate emitter sends a 16 KiB title — and turns an unbounded-growth primitive into a discarded chunk.

**Why `COMMAND_LINE_LIMIT` is applied on both sides of the unescape.** The bound has to come first so a hostile command line cannot make the unescape allocate, and the sanitization has to come after because the `\xNN` decoding is precisely what puts control characters back into a value that looked clean going in.

**Why the sidecar parses a second time.** The phone renders the same bytes the laptop's own xterm renders, and in standalone the stripping happens in the frontend adapter — which the sidecar's stream to the phone never passes through. Without a parser of its own the sidecar would ship the phone raw OSC sequences the laptop never sees. "Discarded" and "not parsed" are different things there, and the difference is a bug: a query the parser *declines* stays in `visibleData`, reaches the phone, and gets answered a second time.

## `pty:data` strip semantics

**Why replay is inert.** Buffered scrollback is a recording of protocol traffic, so re-parsing it without suppression would re-ring alerts for notifications the user dismissed weeks ago, re-fire quiesce transitions for commands that finished long ago, and write answers to queries whose asker is dead — every one of them on every reload of a resumed Session. Only the semantic events (CWD, prompt/command, title) are worth re-applying, because those are state rather than events.

## Supported OSCs

**Why the color queries are answered rather than passed through.** A TUI that adapts to a light or dark background asks with `OSC 11 ; ?`; with no answer it assumes dark, and on a light theme its adaptive chrome — Codex's composer "pill", for one — renders unreadable. xterm.js does not answer the query itself, so the choice is between answering at the parse boundary from the real theme and shipping a terminal that lies about its own colors.

## OSC color queries on Windows require the bundled ConPTY

**Two ConPTY backends, one of which eats the query.** OSC 10/11/12 answering only works if the program's query actually reaches the consumer, and on Windows that is decided entirely by which ConPTY backend node-pty spawns with. The in-box `CreatePseudoConsole` swallows color queries silently: they never reach the consumer, so nothing can answer, and a background-detecting TUI is left assuming a dark terminal. node-pty's bundled OpenConsole (`conpty.dll`) forwards them instead — the same passthrough Windows Terminal itself relies on, which is the reason the extra prebuilds are worth their packaging cost on both distributions.

## Supported CSI

**Why win32-input-mode exists alongside the kitty protocol.** A ConPTY app that reads through the Console API rather than the VT stream — Codex on Windows — cannot negotiate the kitty protocol at all, so without win32-input-mode a key like Shift+Enter or Ctrl+J reaches it as a bare byte, or not at all.

**Why an arbiter rather than a static choice.** xterm.js gives win32-input-mode precedence per keypress, and ConPTY's conhost enables it proactively rather than on the app's behalf, so leaving it on would silently break every kitty consumer in the window. Tracking the kitty push/pop stack and toggling win32 off while any kitty consumer is on it is what lets a kitty TUI (Claude Code) and a win32 TUI (Codex) both work in the same window.

## Report filtering on the input side

**Why replayed reports are dropped rather than forwarded.** Replayed scrollback routinely contains terminal-generated replies from a long-dead app — cursor-position reports, device attributes, focus events. Forwarding them into the freshly spawned shell writes them into its input buffer, corrupting whatever it was parsing, and the user sees garbage typed into a prompt they never touched.

## Replay-time mode-reset tail (Dormouse-emitted)

**Why a reset tail at all.** Saved scrollback can end mid-TUI with private modes still latched — mouse tracking, the alt-screen, a hidden cursor, application cursor keys. Replaying it verbatim re-applies those DECSETs with no process alive to ever DECRST them, leaving a restored pane stuck: unable to select text, showing an alt-screen frame nothing will ever repaint, or with no visible cursor at its new shell's prompt.

## iTerm2 identity

**Why claim to be iTerm2.** Shells, build systems and agent clients gate their richest escape output on a terminal they recognize, and iTerm2 is the identity that unlocks the largest set of the sequences Dormouse actually implements. The cost is that it also provokes sequences Dormouse does not implement, which is what the fail-inertly rule pays for.

**Why `COLORTERM` is set even though it is not iTerm2's.** The PTY is spawned as `xterm-256color` with no other depth hint, so env-sniffing tools — `supports-color` and everything built on it — quantize RGB output to the nearest palette entry unless something says otherwise.

## Shell-integration injection

**Why the mechanism cannot be uniform.** Staging a binary onto `PATH` succeeds if the shell merely *finds* it, which one env var guarantees. OSC 633 needs the shell to *run our hook code on every prompt*, and no shell has an env var for that — hence a per-shell mechanism, and hence the Channel column: an env-var channel is as reliable as the `PATH` prepend, while a `shellArgs` channel only fires for launch shapes we recognize.

**Why nothing may be written into the zsh dotfile directory.** It ships inside the signed macOS app bundle, and any file added to a bundle after signing invalidates the signature — Gatekeeper then reports the app "damaged" rather than naming the real problem. That is also why macOS `/etc/zshrc`'s `HISTFILE`, which lands inside our directory because it runs while `ZDOTDIR` still points there, has to be redirected rather than tolerated.

**Why bash injection keys on the launch args.** `--init-file` and login mode are mutually exclusive, so the script has to replace login-profile sourcing itself, which is only safe when the launch was a plain interactive/login shell. Git Bash launches as `--login -i` and therefore qualifies; anything with a specific `-c <cmd>` is a job, not a session, and gets nothing.

**Why the PowerShell dot-source is appended, not prepended.** A launch that already carries a startup command — the VS "Developer PowerShell" arrives as `-NoExit -Command "& { Import-Module … }"` — is setting up an environment our wrapper should install *after*, or the wrapper wraps a `prompt` that the startup command then replaces.

**Why PSReadLine matters.** PowerShell has no `preexec`, so the only hook that fires between submitting a command and running it is `PSConsoleHostReadLine`, which PSReadLine supplies. Wrapping it is what makes the running command appear immediately, as it does under bash and zsh. Without PSReadLine the whole `E`/`C`/`D` triple has to be reconstructed from the next prompt (command line pulled from history), which keeps boundaries and exit codes exact but leaves the running command invisible until it finishes.

**Why the WSL detector prefers bash.** Windows-side injection cannot reach inside the distro, so the only lever is the appended command, and the detector has to decide without knowing the distro. Preferring bash whenever it exists — including when detection returns nothing — integrates the common case, while stepping aside for an explicitly configured zsh or fish login shell avoids replacing a shell the user chose. Falling back to the login shell covers a distro with no bash at all, e.g. Alpine.

**Why the emit-side filter is a security boundary and not tidiness.** A POSIX path component may hold any byte but `/` and NUL, and a command line anything at all. Once an attacker-chosen name closes the `633` sequence early, the remainder arrives as a fresh OSC that the parser trusts completely — and `OSC 9` is the most damaging thing to forge there, because an alert latches a ring, persists, is spoken aloud, and is pushed to the paired phone. The attack is also invisible and durable: the injected bytes are consumed by the parser, so nothing appears on screen, and a poisoned directory re-fires for everyone who enters it, outliving the process that planted it.
