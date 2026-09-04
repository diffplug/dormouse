# Terminal CWD and Command State — Rationale

> Informative companion to [terminal-state.md](terminal-state.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Supported OSC Inputs

**Why a non-Windows path on `osc9_9` is `unknown`, not `posix`.** The channel is a Windows-ism (Windows Terminal, ConEmu), so a lone `/foo` on it is no evidence of a POSIX shell; guessing `posix` would collide two genuinely different locations on the `scheme|host|pathKind|path` grouping key.

**What the CWD bound and control-character strip protect.** A directory name may hold any byte but `/` and NUL, and the CWD it produces is retained per Session, rendered in the pane header, and used as a grouping key — so unbounded or control-bearing text reaches the UI and a map key, not just a log line.

## OSC-driven events

**What clearing on a prompt boundary buys.** Pending input no `commandStart` consumed is dropped instead of attaching to the next command, and a `user_input` run that never got an explicit finish returns the header to `<idle>` rather than a command that ended long ago.

**Why the tokenizer is dialect-free rather than shell-aware.** Matching `shellEscapePosix` exactly keeps POSIX escapes meaning what they meant while leaving a native Windows path with the separators the basename step splits on. The two halves disagreed once, about `~`: a path Dormouse itself had escaped rendered with a stray backslash in the pane header, hence `terminal-state.test.ts` → "command tokenizer dialects" pinning both directions character by character.

**Why an unquoted Windows path with spaces stays split.** Which token ends the program name is undecidable without asking the filesystem, and the tokenizer has no filesystem.

**What the launcher-suffix rule prevents.** PATHEXT gives one program several spellings (`npm`, `npm.cmd`, `npm.exe`); keying the header, WATCHING rule row, and bell tooltip on the suffixed name would split one program into two rules and let the three disagree about which is running.

## Keystroke fallback

**Why the command is read off the screen, not reconstructed from keystrokes.** The rendered line is correct however the command arrived — typed, recalled from history, or pasted — and is independent of the race between shell output and idle detection.

**Why the shape is pre-seeded from restored scrollback.** On reconnect to a live PTY the shell will not re-emit its prompt, leaving the first command after a restore no shape to strip against — untitled until the next prompt. The scrollback ends at whatever was on screen: an idle prompt teaches a shape, anything else no-ops.

**Why synthesis is scoped to `user_input` while shape learning is not.** Shape learning is harmless for every shell and useful the moment integration is lost, but synthesizing finish/start transitions for a shell that emits its own boundaries would fight the authentic ones.

**Why alt-screen spans are dropped.** Fullscreen TUIs (vim, lazygit, less) render into the alt buffer, so a `$` painted there is the program's, not the user's prompt.

**Why the heuristic reads `textData` rather than filtering for itself.** The protocol parser has already framed every string control on that chunk, so a separate scanner in front of the prompt detector re-derived a classification the parser threw away — and did it per character over 100% of PTY output, which measured 5.9 ms/MB on plain text. Projecting the answer the parser already has costs nothing on the wire (the field is omitted when it would equal `data`) and leaves one classifier instead of three.

**Why replay seeding still filters locally.** `pty:replay` reaches the webview as `visibleData`, which still carries the string controls the parser forwards, and it is one bounded pass at restore rather than the live stream — so a one-shot `TerminalControlStreamFilter` over a 64 KiB tail is proportionate there. The 1,024-character window is cut from its output; 64 KiB is ample runway to resync the control state.

**Why boundary mode is needed, and why its trailing boundary must be trimmed.** Deleting a redraw's cursor move welds text never adjacent on screen: `building...\x1b[1;1HC:\Users\me>` reads as one line starting with `building`, which no anchored shape matches. But a boundary is not a real line break. A genuine trailing newline means nothing is painted on the current line yet — no prompt, and reading one as a prompt flips a running command back to idle. A trailing *boundary* means only that a control closed the line, which is what a prompt clearing to end-of-line after painting itself emits (`C:\Users\me>\x1b[K`); reading it as an empty last line would hide every such prompt.

**Why `isPaneOscDriven()` is exposed.** `dor ensure --restart` can only match a surface whose shell re-reports its command, so it must know whether this pane's command state came from real OSC boundaries or the heuristic.

## Header Derivation

**Why an absent `osc9` candidate makes the app title trustworthy.** The alert manager's `OSC 9` text and the pane's `osc9` candidate come off the same stream, so when both exist they share a timestamp and the staleness window applies. One with no matching candidate was injected without going through the parser and has no timestamp to judge; trusting it preserves the behavior that predates the staleness rule.

**Why app-sent titles are filtered.** Under Windows ConPTY the console title is relayed for every child process whether or not it chose one, so an `OSC 0`/`OSC 2` title is frequently just the child's image path (`C:\WINDOWS\system32\cmd.exe`, which pnpm's script shell broadcasts) — no command information, so letting it through replaces a correctly detected command label with noise. A title carrying arguments or prose did come from a program that chose it.

**Why the fail glyph lives in `primary` rather than only in the flag.** Plain-text title consumers — OS window titles, tab titles — render `primary` and nothing else, so a flag-only signal would lose the failure there; the flag exists alongside it so the pane header can color the glyph without re-parsing the string.
