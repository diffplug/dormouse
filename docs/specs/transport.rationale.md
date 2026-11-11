# Transport and PTY Protocol — Rationale

> Informative companion to [transport.md](transport.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Graceful shutdown

SIGHUP, not SIGTERM, on POSIX (measured 2026-11-09, node-pty under the live checkout, macOS): an interactive bash and zsh ignore SIGTERM, so the stop waited out the full two-second timeout and acknowledged with every shell alive, and a closed window's shells ran on unseen until quit. Under SIGHUP zsh exited in 3 ms and bash in 4 ms. A PTY whose own process ignores SIGHUP is killed at the deadline instead; that is accepted, since the caller drops the ids next and nothing could reach it after. The SIGKILL reaches only that process: a descendant that ignores the hangup (`nohup`, a detached server) outlives the window as before. The exit then reaches the host before the acknowledgement: node-pty reports it when its master closes, which on Linux, with a child still holding the slave, waits for node-pty's own 200 ms fallback (211 ms measured on Ubuntu 24.04, 2026-11-10; 1 to 2 ms otherwise, and on macOS), so the wait is 500 ms. Every caller's own bound covers it: Rust allows the timeout plus 1.5 s, and VS Code's deactivate the timeout plus 1 s.

With node-pty 1.2.0-beta.15 on Windows (measured 2026-10-06), `kill('SIGTERM')` throws, including from a deferred callback if the terminal is not ready. The swallowed synchronous error left shutdown waiting out its deadline without stopping anything (#984). Argument-less `kill()` closes the bundled ConPTY; the native addon also calls `TerminateProcess` on the shell. A console-handler probe did not save its close marker, so this path is not a history-flush guarantee. Agent recovery already captures before this stage.

A second close before `onExit` crashed the Node process in the native test.

## PTY buffering

**Why a buffer outlives its process.** Recovery capture runs before any kill (`docs/compatible-agents.md` → "Capture"), but a webview reopened over an exited pane still needs its transcript, and a Workspace transfer replays an exited pane's since-mark tail.

## Output flow control

**Why.** xterm.js queues every write and parses it in 12 ms slices re-armed by a timer, and throws `write data discarded` once 50,000,000 chars wait unparsed (pinned 6.1.0-beta.337). With nothing pausing the PTY, a flood (`yes`, a runaway loop) or ordinary output into a window whose timers are throttled (a minimized standalone window on Windows or Linux, where `backgroundThrottling` is unsupported) queued without bound, then lost output and threw out of the adapter's listener once per chunk (audit finding `session-03`). The scheme is VS Code's own (`acknowledgeDataEvent`), with constants measured for this pipeline.

**Why after the parse.** The renderer can only acknowledge what it receives, the parse's `data`, and the parse strips OSCs: a raw count in `pty-core` would never be paid back. VS Code's node-pty runs in the pty-host child while its parse and `pty:data` are the extension host's, so the count lives there and the pause crosses the IPC.

**Why Rust acknowledges what it drops.** After a transfer mark Rust drops an id's output until the target's replay; a suppression no arrival claims fails open after `AWAITING_REPLAY_MAX` with no `requestInit` behind it, which would have left the PTY paused on output no window ever saw.

**The constants** (measured 2026-11-11, macOS 27 on Apple silicon, node-pty 1.2.0-beta.18, Node 24.22): the real `pty-core` and node-pty, the host counter, and a renderer child process parsing with real xterm over Node IPC (headless, so faster than a webview that also renders), with 0, 2 or 5 ms added each way. Median of three, MB/s of parsed output; `yes` is `y\n`, logs are 80-column lines:

| Batch / low / high (chars) | `yes`, +0 ms | logs, +0 ms | `yes`, +2 ms | logs, +2 ms | logs, +5 ms |
|---|---|---|---|---|---|
| unbounded (before) | 8.3 (7.7–17) | 95.8 | 26.7 | 100.3 | 103.9 |
| 5,000 / 5,000 / 100,000 (VS Code's) | 19.6 | 43.6 | — | — | — |
| 65,536 / 262,144 / 1,048,576 | 24.5 | 95.3 | — | — | 50.1 |
| 262,144 / 1,048,576 / 2,097,152 (chosen) | — | — | 26.4 | 98.3 | 83.9 |

The low watermark has to cover a resume's round trip at the parse rate, so VS Code's values starve a fast renderer; the chosen ones are within 4% at 2 ms each way and 19% at 5 ms, the pessimistic case. Unbounded, a `yes` flood ran slower, the renderer's event loop saturated with queued messages. A renderer that never acknowledges stops the PTY at the high watermark plus 900 chars (macOS reads are about 1 KB): about 4.2 MB per terminal at the worst. Ctrl+C on a 2 s `yes` flood took effect, everything before it parsed, in 48–77 ms, against 4–25 s unbounded with 93–677 million chars queued; on 80-column logs, 7–9 ms against 0.5–1.4 s. Ack messages: about 100 per second at 25 MB/s.

**Why resume when the process is gone.** node-pty reports no exit while its socket is paused: on POSIX it destroys the socket, unread tail and all, 200 ms after the child exits; with `useConptyDll` on Windows it reports the exit only when the socket closes. Measured on macOS (same date): with everything read before the pause, a child writing a tail and exiting lost it unless resumed. With output still unread in the kernel when the child exits, macOS holds the exit about 610 ms and then discards that output, with the pid still alive throughout, so the watch cannot see it; only the renderer catching up within that window saves it. Unmeasured on Linux and Windows.

**Why every stop resumes.** node-pty finishes a kill by reading: on Windows the ConPTY worker is disposed on the next data event, and a paused socket never delivers one.

## Paced input

Measured on macOS 27 with Claude Code 2.1.274 and Codex 0.154.0, 2026-09 (issue #679).

**One burst splits on macOS.** While the program has not drained its tty, a pty master write stops at 1022 bytes (`TTYHOG` − 2); node-pty retries the remainder, so a 1600-byte `dor send` reached Claude Code as reads of 1022 and 578 bytes. Linux queues about 4 KB, so the same burst arrives as one read there.

**Read size alone decides a paste in Claude Code.** Any read over 800 bytes is an unbracketed paste. Split as above, the pasted head was discarded when the tail carrying CR arrived: the prompt began mid-word at byte 1022, lost its `/simplify`, and the Enter did not submit. As one read (text and CR together, as Linux delivers it), the CR became part of a `[Pasted text]` and nothing submitted.

**Codex turns Enter inside a burst into a newline.** 300 bytes plus CR in one write did not submit; with the CR 20 ms later it did. After 512-byte runs 10 ms apart, a 10 ms gap before CR did not submit and 50 ms did; after 256-byte runs, 20–80 ms all submitted. 100 ms leaves margin for coarse timers (about 15.6 ms on Windows) and busier programs.

**Why 256 bytes and 10 ms.** Runs of that size arrived as typed text in both programs, including while Claude Code streamed a response, and 1600 bytes take about 70 ms. Timers cannot see the reader: a program that stalls for more than about 30 ms can still read several runs as one read over 800 bytes. 512-byte runs cross the threshold after one missed gap. Unpaced 256-byte writes merged into a paste. Every CR waits for the settle, so a CRLF file sent with `--stdin` pays 100 ms per line; LF is text.

**Bracketed paste was rejected.** Wrapping the text delivered all of it and submitted, but Claude Code collapses a paste over 800 bytes into a placeholder and then does not recognize a leading slash command (`/context …` went to the model as plain text); the same text paced ran the command. It would also stop a shell running `--stdin` scripts line by line.

**Why not the webview.** A hidden webview's timers are throttled to about once a second, which would stretch a paced send from milliseconds to minutes. The PTY owner's Node timers are not throttled, and it is the last hop before the kernel.

## iTerm2 identity

**Why claim to be iTerm2.** Shells, build systems and agent clients gate their richest escape output on a terminal they recognize, and iTerm2 is the identity that unlocks the largest set of the sequences Dormouse actually implements; the fail-inertly rule pays for the ones it also provokes.

**Why 3.6.6, and not newer.** Tools gate features on the version, not just the name: Claude Code 2.1.281 turns on `OSC 9;4` progress only at iTerm2 3.6.6 or later (its version check, read from the binary, 2026-09-23). Recorded the same day under each identity, Claude emitted no progress at 3.5.0; at 3.6.6 it ran one cycle per turn (the turn recorded in `lib/src/lib/alert-engagement.test.ts`) and set DECSET 2031 at startup. iTerm2's changelogs (read 2026-09-23): 3.6.6 (released 2025-11-17) added `OSC 9;4` progress bars, DSR 996/997 with DECSET 2031 dark-mode reporting — xterm.js 6.1's `colorSchemeQuery`, on by default — and `OSC 52` in its DA reply, which Dormouse does not claim and a DA reader only misses. A newer version only invites more sequences: 3.6.7's `OSC 8` `target=` (built 2026-02-19) happens to fail inertly, the link still opening, but 3.7.0 (built 2026-06-08) adds dual-mode `SGR 38:12` colors, which programs would then send and Dormouse mishandles.

**Why another terminal's identity is stripped.** A pane inherits the host's environment, and the host inherits whatever launched it. Fedora's `vte.sh` sees `VTE_VERSION` and emits an `OSC 777` notification after every command; `WT_SESSION`, `ConEmuANSI`, `TERM_FEATURES` and the Konsole and Ptyxis versions switch on cargo's `OSC 9;4` progress, so every build rang; `TMUX` / `STY` send tools to a multiplexer that is not there — Codex and Claude Code wrap their notifications in tmux's passthrough; and `CURSOR_TRACE_ID` makes Claude Code believe it runs in Cursor's terminal, which leaves it no notification channel (audit, 2026-09-23). `COLORFGBG` would contradict the background the OSC 11 answer reports. A host started from inside Claude Code hands every pane that session's markers: `CLAUDE_CODE_CHILD_SESSION` turns a pane claude's transcript saving off unless `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, so it prints no resume hint for shutdown capture, and `CLAUDE_CODE_MESSAGING_TOKEN` reaches every pane program (Claude Code 2.1.302, read from the binary, 2026-10-16).

**Why the AppImage launcher's environment is dropped.** The Linux AppImage's launcher (linuxdeploy's `AppRun` with its GTK hook, then the AppImageKit runtime) sets `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`, `PYTHONHOME`, `PYTHONDONTWRITEBYTECODE=1`, `GTK_THEME` (`Adwaita:light` or `:dark`) and the GTK, GIO and GObject module paths, and puts `$APPDIR` entries in front of `PATH`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR` and the GStreamer plugin paths (measured from the extracted v1.3.0 AppImage on Ubuntu 24.04, 2026-11-10). With them, `python3` failed at startup and `curl` died on a symbol lookup error, the bundle's older `libnghttp2` shadowing the system's; zsh also runs every external command with an exported `ARGV0` as its `argv[0]`. The sidecar drops them once at startup, so git, lsof, clipboard helpers and browser launches get the system's environment too, and every pane spawn applies the same scrub. The two fixed-value variables survive when they hold another value; the launcher overwrote the rest before the app started.

**Why `LC_TERMINAL` is set unconditionally.** Some shell integrations key off it rather than `TERM_PROGRAM`.

**Why `COLORTERM` is set even though it is not iTerm2's.** The PTY is spawned as `xterm-256color` with no other depth hint, so env-sniffing tools — `supports-color` and everything built on it — quantize RGB output to the nearest palette entry.

## Reconnection protocol

**The `<unnamed>` seed skip is lossy, deliberately.** Persistence cannot tell a deliberate `<unnamed>` pin from the default panel placeholder, so a user who pinned it gets the derived header back on reload — cheaper than seeding every default placeholder as a real user title.

`collectLivePtys` filtered the answer but finished on any `pty:list`. With two Workspaces arriving in one window at once, the second arrival's list reached the first collector, filtered to nothing, and resolved it as "the host holds no PTYs" — so that Workspace cold-restored fresh shells at the saved cwds over the ones still running. The 3 s timeout did the same thing on its own. A module-local token counter also restarted at `init-1` on reload, letting a delayed old reply satisfy the new webview's first collection (regression reproduced 2026-10-20).

The retry is the same argument applied to the plain boot: the arrival path refuses on `timedOut` because it knows those shells are running, but the boot path has nothing else to fall back on and restores. Asking again costs 3 s only in the case where the first ask genuinely got nothing, and a host that holds no PTYs answers the second ask as fast as the first.

## Report filtering on the input side

**Why replayed reports are dropped rather than forwarded.** Replayed scrollback routinely contains terminal-generated replies from a long-dead app — cursor-position reports, device attributes, focus events. Forwarding them into the freshly spawned shell corrupts whatever it was parsing, and the user sees garbage typed into a prompt they never touched.

## Replay-time mode-reset tail (Dormouse-emitted)

**Why a reset tail at all.** Saved scrollback can end mid-TUI with private modes still latched — mouse tracking, the alt-screen, a hidden cursor, application cursor keys. Replaying it verbatim re-applies those DECSETs with no process alive to ever DECRST them, leaving a restored pane unable to select text, showing an alt-screen frame nothing will ever repaint, or with no visible cursor at its new shell's prompt. A live exit used to skip the tail, so a crashed TUI's pane kept its frozen frame and its mouse tracking until a reload replayed it dead and reset it: the same Session looked different before and after the reload (decided 2026-10-16). The cost is the crashed program's last alt-screen frame, which the next reload discarded anyway.

The earlier list of private-mode resets missed insert mode, scroll margins, and kitty keyboard stacks (reproduced against the pinned xterm, 2026-10-20). A soft reset clears these without erasing retained text; the Windows keyboard arbiter resets its matching stack depth too. Alternate-screen exit and mouse resets remain explicit because xterm keeps those outside its soft reset.

## Transferring a Workspace

The suppression is bounded and fails open because the two failures are not symmetric: duplicated bytes are a cosmetic repeat the user can scroll past, and a permanently silenced pane is a terminal they have to kill. The host's own measurements and the ordering the guarantee rests on are `docs/specs/standalone.rationale.md` → Arrival queue.

Release-without-kill is a separate verb rather than a flag on the closure path because the closure path is reachable from an unmount and this must not be. The two differ in exactly one line, and that line is the whole difference between moving a Workspace and losing it.

**Why an app's modes have to travel.** An app sets them once, at startup, and has no signal that its terminal was rebuilt under it. Claude Code in a moved Workspace kept running with flags back at 0, so Shift+Enter arrived as a plain Enter and submitted the prompt until the app restarted. Kitty state replays as pushes rather than one set so that the app's later pops land where they would have, and so that the Windows arbiter, which counts only pushes and pops, turns win32-input-mode off in the arriving terminal.

**Why alternate-screen state may drop on the main screen.** Rewriting it means entering and leaving the alternate screen in the new terminal, for state only an app that left that screen without popping still holds. An app re-entering pushes again.

## Message protocol

**Why Windows needs two more reads.** Measured 2026-10-21 on Windows 11 through node-pty. In Git Bash, `node` runs as `winpty node.exe` (Git's alias under `TERM=xterm*`), and an MSYS exec replaces the Windows process, so `winpty.exe` named a parent that had exited and the walk from the pane never reached `node.exe`; MSYS `ps` keeps the exec'd process's parent and names its Windows pid. In WSL with `networkingMode=mirrored`, a `python3 -m http.server` on 127.0.0.1 answered HTTP from Windows, but neither `Get-NetTCPConnection` nor `netstat` listed it, so no Windows-side walk can find it; the pane's `DORMOUSE_SURFACE_ID` crosses in through `WSLENV`, and `grep -z` over `/proc/*/environ` finds its processes in one spawn. Both panes then reported their ports in one request in under a second, as did `wsl` typed into a PowerShell pane.

**Why one alert manager per host process, beside the PTYs.** Each standalone window used to run its own `AlertManager` in its webview, fed from events the sidecar had already parsed. Three failures followed (audit, 2026-09-23): WKWebView throttles a background window's timers, so the detector, deferral and await timers of the window a completion should summon the user back to ran late; a reload started an empty manager and a live resume seeds nothing, so every ring and TODO in the window vanished; and a Workspace transfer had to snapshot ring, episode, detector deadlines and deferred notification into the transfer content. VS Code never had these, because its manager lived in the extension host beside the PTYs and the parse; moving standalone's there made the two hosts one module.

**The per-store tax.** Each app-global store relayed webview↔host this way costs one `PlatformAdapter` push method, an on/off listener pair, two `AlertCommand` ops and an event, and a host coordinator with its own subscribe/unsubscribe. Two are worth paying that twice for the directness; at a third, the keyed channel + key→normalizer registry is cheaper than another copy of the plumbing.

## Surface ids

**Why an unparseable counter file is overwritten, but an unreadable or other-version one is not.** Every write is atomic, so a file this version cannot parse comes only from outside damage; refusing it would leave every launch on opaque ids until someone deleted the file by hand, while overwriting it from the host's disk scan (standalone) or its own counter and the webview's floor (VS Code) risks reusing only numbers no restored Surface holds. A read that fails (a Windows virus scanner's `EBUSY`) is usually transient, and another version's file may hold a mark this build cannot read; overwriting either could lower the mark under numbers already handed out (decided 2026-10-11).

## Persisted session types

**Why a reported directory is saved.** It is terminal-reported, the value splits, helpers, and Reopen already use, and it is saved only where the host's probe has no answer: every pane on Windows, where the probe resolves nothing (2026-11). A save that skips the probe (the post-kill quit flush, a Surface move) keeps the previous record first, because a shell without integration reports only its spawn directory, which would overwrite the probe's last good answer. Before, every Windows row was saved with `cwd: null`, so a relaunch opened every shell in the home directory and typed an auto-resumed agent's command there.

**What a cwd probe costs.** On macOS `getCwd` is an `lsof` subprocess in the sidecar, on every debounced save and every 30 s heartbeat; per pane, and per Workspace in a quit flush that fans out to every Wall at once, it would be N spawns on the sidecar's only event loop.

## Retiring the transcripts already on disk

**The legacy blobs are real, not hypothetical.** Every pre-upgrade installation had a transcript-bearing snapshot in `workspaceState` or the standalone file store.

**Why standalone stopped deleting every snapshot at boot.** Deleting was right only while nothing read the store: once the app restores its windows, an unconditional boot delete is a data-loss bug, not a migration; the boot delete that remains takes only another format's. What the unconditional delete uniquely covered — a `.json.tmp` no reader can see and no writer will ever overwrite — is exactly what the sweep still covers. Older debug snapshots sit outside the new subtree, and deleting them would remove layouts that may belong to an installed build, so debug startup sweeps only their orphaned temps. It once also stripped pane scrollback from them; that scrub was deleted 2026-11, since no current build reads those formats.

## The governing rule

**Why the rule reversed for standalone.** The old reading — a quit is a deliberate ending, so end everything — was a claim about the *processes*, and users do not experience a window that way. The product call is that window state is the app's contract, as it is in VS Code: the layout comes back, the agents come back, and the transcripts never do. Dropping persisted scrollback is what made that affordable — a resumed agent renders the real conversation, which is more context than the transcript it replaces (`docs/compatible-agents.md` → "Cold restore").

**What made it safe to persist again.** The two objections to the old store were both about content, not about persistence: it wrote transcripts, and it wrote them into a WKWebView `localStorage` WAL that grew without bound (`docs/specs/standalone.md` → "Persistence", rationale). Both were already fixed — no writer accepts a transcript-bearing shape, and the blob rides a Rust file store — before the rule changed.

## Port scan deadlines

**Why coalesce without queueing.** Independent callers (a Dev-Server Chip pass, a Tool-serving tick, `dor list --ports`, the terminal context panel) can land port requests in the same tick; one scan per microtask batch keeps that to one set of subprocesses. A queue behind the in-flight scan would make a request wait for two scans, past the per-request budget the formula grants. Budgeting the batch for its smallest request keeps each caller's own deadline true.

## Universal invariants

**Why no synchronous subprocess.** Measured on Windows, 2026-10-02: the installed 1.1.0 sidecar blocked its event loop for 1.7–2.3 seconds during PowerShell process/listener scans, and a real node-pty raw-echo probe measured 767–855 ms input delay during scans, versus 1 ms without. Tool discovery and dev-server chips request these in the background, so ordinary input waited behind decorative work; scheduling the request in webview idle time did not make the host's scan idle-safe, and batching limits subprocess work without keeping the loop free. The same blocking sat in helper busy checks (a Win32_Process scan), macOS cwd saves (`lsof` with no timeout) and WSL detection (`reg.exe`).

**Async spawns over a worker.** A per-scan worker thread kept stalls at 1 ms but covered ports only, and needed its own entry file in every bundle of `pty-core.js`. Async `execFile` covers every probe; on the same machine a full port scan (~900 ms) stalled the loop at most 13–21 ms, the spawns' own cost, against 880–950 ms synchronously (2026-10-02).

**Exempt synchronous reads.** Linux walks `/proc` with synchronous fs calls; they read kernel memory rather than wait on a child, and are unmeasured but expected in single-digit milliseconds. A dev server with thousands of fds is the case that would revisit it.

**Where a flat buffer length bites.** The cap is reached first on exactly the long-running agent pane recovery exists for, so a caller treating buffer length as a stream position sees no growth on the pane it most needs to watch.

**The phantom-running symptoms of a spawn failure with no exit.** A running header that never clears, a `countRunningSessions` that never returns to zero, and therefore a quit confirmation on every window close. Reached whenever a persisted or selected shell binary is gone.

**What type-only ack matching did.** `interrupt` and the graceful kill time out on the teardown path, and the late ack from a timed-out call then resolved the *next* call of the same type the instant it was issued — so the second interrupt appeared to complete before the PTYs had seen it.

**Why an empty interrupt list sends nothing.** A caller whose computed set comes out empty would otherwise send the blanket second press, which destroys codex's hint.
