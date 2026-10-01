# Transport and PTY Protocol — Rationale

> Informative companion to [transport.md](transport.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Paced input

Measured on macOS 27 with Claude Code 2.1.274 and Codex 0.154.0, 2026-09 (issue #679).

**One burst splits on macOS.** While the program has not drained its tty, a pty master write stops at 1022 bytes (`TTYHOG` − 2); node-pty retries the remainder, so a 1600-byte `dor send` reached Claude Code as reads of 1022 and 578 bytes. Linux queues about 4 KB, so the same burst arrives as one read there.

**Read size alone decides a paste in Claude Code.** Any read over 800 bytes is an unbracketed paste. Split as above, the pasted head was discarded when the tail carrying CR arrived: the prompt began mid-word at byte 1022, lost its `/simplify`, and the Enter did not submit. As one read (text and CR together, as Linux delivers it), the CR became part of a `[Pasted text]` and nothing submitted.

**Codex turns Enter inside a burst into a newline.** 300 bytes plus CR in one write did not submit; with the CR 20 ms later it did. After 512-byte runs 10 ms apart, a 10 ms gap before CR did not submit and 50 ms did; after 256-byte runs, 20–80 ms all submitted. 100 ms leaves margin for coarse timers (about 15.6 ms on Windows) and busier programs.

**Why 256 bytes and 10 ms.** Runs of that size arrived as typed text in both programs, including while Claude Code streamed a response, and 1600 bytes take about 70 ms. Timers cannot see the reader: a program that stalls for more than about 30 ms can still read several runs as one read over 800 bytes. 512-byte runs cross the threshold after one missed gap. Unpaced 256-byte writes merged into a paste. Every CR waits for the settle, so a CRLF file sent with `--stdin` pays 100 ms per line; LF is text.

**Bracketed paste was rejected.** Wrapping the text delivered all of it and submitted, but Claude Code collapses a paste over 800 bytes into a placeholder and then does not recognize a leading slash command (`/context …` went to the model as plain text); the same text paced ran the command. It would also stop a shell running `--stdin` scripts line by line.

**Why not the webview.** A hidden webview's timers are throttled to about once a second, which would stretch a paced send from milliseconds to minutes. The PTY owner's Node timers are not throttled, and it is the last hop before the kernel.

## Reconnection protocol

**The `<unnamed>` seed skip is lossy, deliberately.** Persistence cannot tell a deliberate `<unnamed>` pin from the default panel placeholder, so a user who pinned it gets the derived header back on reload — cheaper than seeding every default placeholder as a real user title.

`collectLivePtys` filtered the answer but finished on any `pty:list`. With two
Workspaces arriving in one window at once, the second arrival's list reached the
first collector, filtered to nothing, and resolved it as "the host holds no
PTYs" — so that Workspace cold-restored fresh shells at the saved cwds over the
ones still running. The 3 s timeout did the same thing on its own.

The retry is the same argument applied to the plain boot: the arrival path
refuses on `timedOut` because it knows those shells are running, but the boot
path has nothing else to fall back on and restores. Asking again costs 3 s only
in the case where the first ask genuinely got nothing, and a host that holds no
PTYs answers the second ask as fast as the first.

## Transferring a Workspace

The suppression is bounded and fails open because the two failures are not
symmetric: duplicated bytes are a cosmetic repeat the user can scroll past, and
a permanently silenced pane is a terminal they have to kill. The host's own
measurements and the ordering the guarantee rests on are
`docs/specs/standalone.rationale.md` → Transfer.

Release-without-kill is a separate verb rather than a flag on the closure path
because the closure path is reachable from an unmount and this must not be. The
two differ in exactly one line, and that line is the whole difference between
moving a Workspace and losing it.

## Message protocol

**What the broadcast buys.** Unambiguous settling is only half of it: the same fan-out lets a losing window forward a command to the broker window and receive the answer back (`docs/specs/vscode.md` → "Peer surfaces across windows").

**The per-store tax.** Each app-global store relayed webview↔host this way costs one `PlatformAdapter` push method, an on/off listener pair, two `AlertCommand` ops and an event, and a host coordinator with its own subscribe/unsubscribe. Two are worth paying that twice for the directness; at a third, the keyed channel + key→normalizer registry is cheaper than another copy of the plumbing.

## Retiring the transcripts already on disk

**The legacy blobs are real, not hypothetical.** Every pre-upgrade installation had a transcript-bearing snapshot in `workspaceState` or the standalone file store, so the drop-on-read in `readPersistedSession` and the orphan-temp sweep are live migration paths, not dead defensive code.

**Why standalone stopped deleting its snapshot at boot.** Deleting was right only while nothing read the store: once the app restores its windows, an unconditional boot delete is a data-loss bug, not a migration. What the delete uniquely covered — a `.json.tmp` no reader can see and no writer will ever overwrite — is exactly what the sweep still covers, and nothing else. Older debug snapshots outside the new subtree no longer enter the frontend read-and-save migration. Deleting them would also remove layouts that may belong to an installed build, so debug startup scrubs only the obsolete pane scrollback fields atomically and preserves other state.

## The governing rule

**Why the rule reversed for standalone.** The old reading — a quit is a deliberate ending, so end everything — was a claim about the *processes*, and users do not experience a window that way. The product call is that window state is the app's contract, as it is in VS Code: the layout comes back, the agents come back, and the transcripts never do. Dropping persisted scrollback is what made that affordable — a resumed agent renders the real conversation, which is more context than the transcript it replaces (`docs/compatible-agents.md` → "Cold restore").

**What made it safe to persist again.** The two objections to the old store were both about content, not about persistence: it wrote transcripts, and it wrote them into a WKWebView `localStorage` WAL that grew without bound (`docs/specs/standalone.md` → "Persistence", rationale). Both were already fixed — no writer accepts a transcript-bearing shape, and the blob rides a Rust file store — before the rule changed.

## Universal invariants

**VS Code scrollback outlives the process for repeat resumes.** Recovery capture runs before any kill (`docs/compatible-agents.md` → "Capture"), but a webview reopened over an exited pane still needs its transcript. The shared PTY core formerly kept a second buffer: VS Code never read it, and standalone's reader became unreachable when the adapter stopped persisting transcripts. Removing that duplicate leaves buffering with its actual consumer.

**Where a flat `scrollbackChars` bites.** The cap is reached first on exactly the long-running agent pane recovery exists for, so a caller treating buffer length as a stream position sees no growth on the pane it most needs to watch.

**The phantom-running symptoms of a spawn failure with no exit.** A running header that never clears, a `countRunningSessions` that never returns to zero, and therefore a quit confirmation on every window close. Reached whenever a persisted or selected shell binary is gone.

**What type-only ack matching did.** `interrupt` and `gracefulKillAll` time out on the teardown path, and the late ack from a timed-out call then resolved the *next* call of the same type the instant it was issued — so the second interrupt appeared to complete before the PTYs had seen it.
