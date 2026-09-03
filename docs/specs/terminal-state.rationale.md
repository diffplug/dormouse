# Terminal CWD and Command State — Rationale

> Informative companion to [terminal-state.md](terminal-state.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Supported OSC Inputs

**Why a non-Windows path on `osc9_9` is `unknown` rather than `posix`.** The channel is a Windows-ism — Windows Terminal and ConEmu emit it — so a lone `/foo` arriving on it is not evidence of a POSIX shell. Guessing `posix` would let two genuinely different locations collide on the `scheme|host|pathKind|path` grouping key.

**What the CWD bound and control-character strip protect.** A CWD is attacker-influenceable (a directory name may hold any byte but `/` and NUL), it is retained per Session, rendered in the pane header, and used as a grouping key. Unbounded or control-bearing text therefore reaches both the UI and a map key, not just a log line.

## OSC-driven events

**What clearing on a prompt boundary buys.** Two loose ends close at once: pending input that no `commandStart` ever consumed is dropped instead of attaching itself to the next command, and a `user_input` run that never got an explicit finish returns the header to `<idle>` rather than showing a command that ended long ago.

**Why the tokenizer is dialect-free rather than shell-aware.** Reading `\` as exactly the set `shellEscapePosix` writes keeps POSIX escapes meaning what they meant while leaving a native Windows program path with the separators the basename step splits on. The two halves disagreed once, about `~`, and a path Dormouse itself had escaped rendered with a stray backslash in the pane header — which is why `terminal-state.test.ts` → "command tokenizer dialects" pins both directions character by character.

**Why an unquoted Windows path with spaces stays split.** Which token ends the program name is undecidable without asking the filesystem, and the tokenizer has no filesystem.

**What the launcher-suffix rule prevents.** PATHEXT gives one program several spellings (`npm`, `npm.cmd`, `npm.exe`). Keying the header, the WATCHING rule row, and the bell tooltip on the suffixed name would let those spellings become two rules for one program, and would let the three disagree about which program is running.

## Keystroke fallback

**Why the command is read off the rendered line rather than reconstructed from keystrokes.** The rendered line is correct however the command arrived — typed, recalled from history, or pasted — and is independent of the race between shell output and idle detection. It also survives command-internal terminators (`dir > out.txt`), which sit after the prompt's own terminator occurrence and so fall on the command side of the split.

**Why the shape is pre-seeded from restored scrollback.** On reconnect to a live PTY the shell will not re-emit its prompt, so without a seed the first command after a restore has no shape to strip against and goes untitled until the next prompt. The scrollback ends at whatever was on screen: an idle prompt teaches a shape, anything else no-ops.

**Why synthesis is scoped to `user_input` while shape learning is not.** Shape learning is harmless for every shell and useful the moment integration is lost, but synthesizing finish/start transitions for a shell that emits its own boundaries would fight the authentic ones.

**Why alt-screen spans are dropped.** Fullscreen TUIs (vim, lazygit, less) render into the alt buffer, so a `$` painted there is the program's, not the user's prompt.

**Why boundary mode is needed, and why its trailing boundary must be trimmed.** Deleting a redraw's cursor move welds text that was never adjacent on screen: `building...\x1b[1;1HC:\Users\me>` would read as one line starting with `building`, and no anchored shape would match it. But a boundary is not a real line break. A genuine trailing newline means nothing is painted on the current line yet — no prompt — and a false positive there flips a running command back to idle. A trailing *boundary* means only that a control closed the line, which is exactly what a prompt that clears to end-of-line after painting itself (`C:\Users\me>\x1b[K`) emits; reading that as an empty last line would hide every such prompt.

**Why `isPaneOscDriven()` is exposed at all.** `dor ensure --restart` can only match a surface whose shell re-reports its command, so it needs to know whether this pane's command state came from real OSC boundaries or from the heuristic.

## Header Derivation

**Why an absent `osc9` candidate makes the app title trustworthy.** The alert manager's `OSC 9` text and the pane's `osc9` title candidate come off the same stream, so when both exist they share a timestamp and the staleness window applies. A notification with no matching candidate was injected without going through the parser, and has no timestamp to judge — trusting it preserves the behavior that predates the staleness rule.

**Why app-sent titles are filtered.** Under Windows ConPTY the console title is relayed for every child process whether or not it chose one, so an `OSC 0`/`OSC 2` title is frequently just the child's image path (`C:\WINDOWS\system32\cmd.exe`, which pnpm's script shell broadcasts). A bare executable path or shell name carries no command information, so letting it through would replace a correctly detected command label with noise. Titles carrying arguments or prose did come from a program that chose them.

**Why the fail glyph lives in `primary` rather than only in the flag.** Plain-text title consumers — OS window titles, tab titles — render `primary` and nothing else, so a flag-only signal would lose the failure there. The structured flag exists alongside it so the pane header can color the glyph without re-parsing the string.
