# Terminal CWD and Command State — Rationale

> Informative companion to [terminal-state.md](terminal-state.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Supported OSC Inputs

**Why a non-Windows path on `osc9_9` is `unknown`, not `posix`.** The channel is a Windows-ism (Windows Terminal, ConEmu), so a lone `/foo` on it is no evidence of a POSIX shell; guessing `posix` would collide two genuinely different locations on the `scheme|host|pathKind|path` grouping key.

**What the CWD bound and control-character strip protect.** A directory name may hold any byte but `/` and NUL, and the CWD it produces is retained per Session, rendered in the pane header, and used as a grouping key — so unbounded or control-bearing text reaches the UI and a map key, not just a log line.

Native path payloads are not URLs: decoding `%20` or trimming edge spaces changes directory identity. The [iTerm2 CurrentDir contract](https://iterm2.com/documentation-escape-codes.html) reports a directory, while OSC 7 carries a file URL; Dormouse's OSC 633 emitters likewise write the sanitized path verbatim.

## Shell-integration injection

**Why the mechanism cannot be uniform.** One env var guarantees a `PATH` binary is *found*, but no shell has an env var for *run our hook code on every prompt* — hence a per-shell mechanism, and hence the Channel column: an env-var channel is as reliable as the `PATH` prepend, while a `shellArgs` channel only fires for the launch shapes Dormouse recognizes.

**Why nothing may be written into the zsh dotfile directory.** It ships inside the signed macOS app bundle, and any file added to a bundle after signing invalidates the signature — Gatekeeper then reports the app "damaged" rather than naming the real problem. macOS `/etc/zshrc` sets `HISTFILE` while `ZDOTDIR` still points at our directory, so it lands inside it and has to be redirected rather than tolerated.

**Why bash injection keys on the launch args.** `--init-file` and login mode are mutually exclusive, so the script has to replace login-profile sourcing itself, which is only safe when the launch was a plain interactive/login shell — Git Bash's `--login -i` is why login flags stay in the allowed set, while anything with a specific `-c <cmd>` is a job, not a session.

**Why bash reads `E` back from history, and when it declines.** In the `DEBUG` trap `$BASH_COMMAND` is only the simple command about to run, so `cd web && pnpm dev` reported `cd web` and keyed on `cd`. The last history entry is the line only if reading it added one: ignorespace, ignoredups, `HISTIGNORE`, `set +o history` and `HISTSIZE` all leave the previous entry in place, and that entry often contains the current first command (` cd /` after `cd / && echo hi`). A count taken at the prompt cannot tell: `HISTCMD` reads 1 inside traps and `PROMPT_COMMAND` before bash 5.1, and erasedups renumbers. `fc -l` skips the current line by bash's own did-this-line-add-an-entry flag, which is exact; bash 3.2 leaves that flag stale while history is off, hence the history-on check. A line that added nothing is still the last entry when only ignoredups (or a multi-line command's joined entry) explains it; under ignoreboth a leading space could explain it too, so a repeat falls back. The containment check against `$BASH_COMMAND` exists for traps fired outside a fresh line — a hook appended after ours, a `bind -x` key on 3.2 — which would otherwise re-report the previous line; an aliased first command fails it too, and an entry spanning lines (a here-document) fails the listing parse, so both fall back. Measured on bash 3.2.57 (macOS and Linux), 4.4.23, 5.0.18, 5.1.16, 5.2.37 and 5.3.20, 2026-09.

**Why a `bind -x` key is recognized by `READLINE_LINE`.** The key's command runs through the same `DEBUG` trap while the prompt is armed, so it was reported as the command and spent the arming: the line it left, as fzf's Ctrl-R leaves the chosen command, ran with no `E`/`C` at all. From bash 4.0 `READLINE_LINE` is bound for exactly the key command's run and unbound after it. 3.2 binds nothing, and nothing else the trap can read differs from a submitted line — `BASH_SOURCE`, `BASH_LINENO`, `FUNCNAME`, `$-`, `BASH_SUBSHELL` — while its `READLINE_LINE` is an ordinary variable that a widget written for 4.x leaves set, which would silence every later line without the version check. Measured on bash 3.2.57 (macOS), 4.0.44, 4.4.23, 5.0.18, 5.2.37 and 5.3.20, 2026-09.

**Why the PowerShell dot-source is appended, not prepended.** A launch that already carries a startup command — the VS "Developer PowerShell" arrives as `-NoExit -Command "& { Import-Module … }"` — is setting up an environment our wrapper should install *after*, or the wrapper wraps a `prompt` that the startup command then replaces.

**Why PSReadLine matters.** PowerShell has no `preexec`, so the only hook that fires between submitting a command and running it is `PSConsoleHostReadLine`, which PSReadLine supplies; wrapping it is what makes the running command appear immediately, as it does under bash and zsh. The fallback reconstructs the `E`/`C`/`D` triple from the next prompt with the command line pulled from history, leaving the running command invisible until it finishes.

**Why the WSL detector prefers bash.** It has to decide without knowing the distro. Bash whenever it exists — including when detection returns nothing — integrates the common case, stepping aside for an explicitly configured zsh or fish login shell avoids replacing a shell the user chose, and the login-shell fallback covers a distro with no bash at all, e.g. Alpine.

**Why the emit-side filter is a security boundary and not tidiness.** A POSIX path component may hold any byte but `/` and NUL, and a command line anything at all, so an attacker who names a directory or a command controls bytes that can close the `633` sequence early. `OSC 9` is the most damaging thing to forge in the remainder the parser then trusts: an alert latches a ring, persists, is spoken aloud, and is pushed to the paired phone. The attack is invisible and durable — the injected bytes are consumed by the parser, so nothing appears on screen, and a poisoned directory re-fires for everyone who enters it, outliving the process that planted it.

## OSC-driven events

**What clearing on a prompt boundary buys.** Pending input no `commandStart` consumed is dropped instead of attaching to the next command, and a `user_input` run that never got an explicit finish returns the header to `<idle>` rather than a command that ended long ago.

**Why the tokenizer is dialect-free rather than shell-aware.** Matching `shellEscapePosix` exactly keeps POSIX escapes meaning what they meant while leaving a native Windows path with the separators the basename step splits on. The two halves disagreed once, about `~`: a path Dormouse itself had escaped rendered with a stray backslash in the pane header, hence `terminal-state.test.ts` → "command tokenizer dialects" pinning both directions character by character.

**Why a redirection's `&` and a comment are lexed.** bash now reports its whole history line rather than `$BASH_COMMAND`, which strips comments, and WATCHING keys a list's last command, so a redirection's bare `&` and a comment's words decided the key: `make 2>&1 | tee build.log` keyed on `1`, and `claude # fix auth; then deploy` on `deploy` (review, 2026-09-24).

**Why an unquoted Windows path with spaces stays split.** Which token ends the program name is undecidable without asking the filesystem, and the tokenizer has no filesystem.

**What the launcher-suffix rule prevents.** PATHEXT gives one program several spellings (`npm`, `npm.cmd`, `npm.exe`); keying the header, WATCHING rule row, and terminal context on the suffixed name would split one program into two rules and let the three disagree about which is running.

## Keystroke fallback

**Why the command is read off the screen, not reconstructed from keystrokes.** The rendered line is correct however the command arrived — typed, recalled from history, or pasted — and is independent of the race between shell output and idle detection.

**Why the shape is pre-seeded from replay.** On resume over a live PTY the shell will not re-emit its prompt, leaving the first command no shape to strip against — untitled until the next prompt. The replay ends at whatever was on screen: an idle prompt teaches a shape, anything else no-ops.

**Why synthesis is scoped to `user_input` while shape learning is not.** Shape learning is harmless for every shell and useful the moment integration is lost, but synthesizing finish/start transitions for a shell that emits its own boundaries would fight the authentic ones.

**Why alt-screen spans are dropped.** Fullscreen TUIs (vim, lazygit, less) render into the alt buffer, so a `$` painted there is the program's, not the user's prompt. The previous stateless scan ran after truncation: once enough output displaced the enter marker, a TUI could falsely end the command. `keeps long chunked alternate-screen output out of the prompt heuristic` in `lib/src/lib/terminal-state-store.test.ts` reproduces that failure.

**Why the heuristic reads `textData` rather than filtering for itself.** The protocol parser has already framed every string control on that chunk, so a separate scanner in front of the prompt detector re-derived a classification the parser threw away — and did it per character over 100% of PTY output, which measured 5.9 ms/MB on plain text. Projecting the answer the parser already has costs nothing on the wire (the field is omitted when it would equal `data`) and leaves one classifier instead of three.

**Why replay seeding still filters locally.** `pty:replay` reaches the webview as `visibleData`, which still carries the string controls the parser forwards, and it is one bounded pass during resume rather than the live stream — so a one-shot `TerminalControlStreamFilter` over a 64 KiB tail is proportionate there. The 1,024-character window is cut from its output; 64 KiB is ample runway to resync the control state.

**Why prompt filtering is stateful.** The keystroke fallback reads a rolling 1,024-character output tail. A stateless control stripper removes a complete `APC G`, SIXEL DCS, or IIP OSC, but a later PTY chunk begins with bare base64 after the introducer fell out of that window. Carrying only the string-control state across reads removes the payload without changing what xterm receives.

**Why boundary mode is needed, and why its trailing boundary must be trimmed.** Deleting a redraw's cursor move welds text never adjacent on screen: `building...\x1b[1;1HC:\Users\me>` reads as one line starting with `building`, which no anchored shape matches. But a boundary is not a real line break. A genuine trailing newline means nothing is painted on the current line yet — no prompt, and reading one as a prompt flips a running command back to idle. A trailing *boundary* means only that a control closed the line, which is what a prompt clearing to end-of-line after painting itself emits (`C:\Users\me>\x1b[K`); reading it as an empty last line would hide every such prompt.

**Why `isPaneOscDriven()` is exposed.** `dor ensure --restart` can only match a surface whose shell re-reports its command, so it must know whether this pane's command state came from real OSC boundaries or the heuristic.

## Header Derivation

**Why an absent `osc9` candidate makes the app title trustworthy.** The alert manager's `OSC 9` text and the pane's `osc9` candidate come off the same stream, so when both exist they share a timestamp and the staleness window applies. One with no matching candidate was injected without going through the parser and has no timestamp to judge; trusting it preserves the behavior that predates the staleness rule.

**Why app-sent titles are filtered.** Under Windows ConPTY the console title is relayed for every child process whether or not it chose one, so an `OSC 0`/`OSC 2` title is frequently just the child's image path (`C:\WINDOWS\system32\cmd.exe`, which pnpm's script shell broadcasts) — no command information, so letting it through replaces a correctly detected command label with noise. A title carrying arguments or prose did come from a program that chose it.

**Why the fail glyph lives in `primary` rather than only in the flag.** Plain-text title consumers — OS window titles, tab titles — render `primary` and nothing else, so a flag-only signal would lose the failure there; the flag exists alongside it so the pane header can color the glyph without re-parsing the string.
