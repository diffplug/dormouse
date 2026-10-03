# Compatible agents — Rationale

> Informative companion to [compatible-agents.md](compatible-agents.md), keyed by its headings.

## Capture

**Why `^C` and not a signal.** SIGTERM to the pty leader is inert against both claude and codex, and the foreground-process-group signal that does reach claude leaves codex silent (2026-08). `^C` is the one gesture both agents answer; it needs no `tcgetpgrp` and no master fd node-pty does not expose, takes the same path on ConPTY, and leaves the shell alive.

**Why every live PTY is interrupted.** Gating on "is this pane running an agent" would need per-pane foreground-command knowledge the host does not have, and every one of these processes is killed seconds later regardless.

**Why the clocks start at the ack.** The fallback and silence windows are statements about the agent, not about the round trip; measuring from step entry folds the interrupt's own latency into the window and shortens it by an amount that varies with load.

**Why the ask gate keys on an English UI string.** Claude's `Press Ctrl-C again`, Cursor's `Press Ctrl+C again` (supplied macOS exit excerpt, Cursor 2026.09.23-86fc751) and Copilot's `ctrl+c again to exit` could change. That failure loses recovery for that shutdown, where a mistimed second press destroys Codex's hint every time.

**Why a third press, and only on an ask** (Claude 2.1.288, Copilot 1.0.88, Antigravity 1.2.13, Pi 1.0.0, macOS, 2026-10-03). Mid-turn, the first `^C` only cancels the turn: Claude prints `Interrupted`, asks `Press Ctrl-C again to exit` after the second press and prints its hint about 12 ms after the third; Copilot asks `ctrl+c again to exit` after the second; Antigravity likewise. With two presses, all three lost the conversation in a live restart and a 12-agent harness run. A third press is reserved for a pane that asks after its latest press and has then gone quiet, so a program that never asks still gets at most two presses, and an exit that repeats its ask above its hint (Cursor) is not cut off mid-print; counting only output after that press keeps a slow exit from seeing the previous press's ask.

**Why repainting does not hold the quiet gate.** After a cancel Claude requests the cursor position (`ESC[?6n`) every ~203 ms, and Pi redraws its `Working` spinner in place every ~82 ms (Pi's `^C` never cancels a turn). Counted as output, both kept the pane from ever being quiet for 200 ms, so neither got its second press; Pi then needs two presses under 500 ms apart. Only a line feed or text written without repositioning the cursor now counts as a print in flight. A program that only repaints can therefore receive its second press where it previously got one.

**Two settle-on-quiet heuristics died on the same fact.** Codex says nothing for ~250 ms and then prints its entire shutdown at once, so a poll that treats silence as completion exits before codex has spoken; both attempts to settle early on quiet lost the hint that way. Polling to the ceiling instead costs nothing, the record being written the moment each command is found.

**Why the capture widens every pane first** (Copilot 1.0.88, macOS, 2026-10-03). Copilot lays its exit summary out for the pane and hard-wraps the `Resume` line below about 74 columns, so in a 40-column split the hint read `copilot --resume=ab5`, the rest of the id two lines down. Minimized panes and unshown Workspaces were also 2 columns wide (fixed separately), where Copilot printed no hint at all. Resizing to 250x50 before the first press makes every agent lay its hint out on one line; the PTYs die right after the capture. The marks wait at least 80 ms after the resize, and up to 200 ms while output is still arriving, because a full-screen program answers it by redrawing what it shows, which can include an old hint; a redraw that starts later still lands in the scan. A resize that throws (a PTY exiting at that moment) is logged and skipped.

**Why widening the scan is not a free optimisation.** Scanning the whole buffer let a stale hint or an old launch echo win. The narrow scan also fails in the safe direction: buffer eviction can only discard fresh output, never promote stale output as fresh.

**Where a missing hint comes from.** A Dormouse launched from inside a Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION`, which disables transcript saving in claude, so it legitimately prints nothing to record.

**The timing measurements** (real pty, codex, 2026-08). Codex is the constraining case because its `^C` is consumed by the input line first:

| State when interrupted | Gesture | Hint | At |
| --- | --- | --- | --- |
| idle after a pause | one `^C` | yes | 262 ms |
| idle after a pause | two `^C`, 150 ms apart | **no** | — |
| idle after a pause | `^C`, 800 ms, `^C` | yes | 855 ms |
| unsent text in the input | one `^C` | **no** | — |
| unsent text in the input | two `^C`, 150 ms apart | yes | 464 ms |
| unsent text in the input | `^C`, 800 ms, `^C` | yes | 1061 ms |
| freshly launched, no conversation | one `^C` | no — correctly, nothing to resume | — |

Rows 1–2 are why a blanket second press is wrong; `Press Ctrl-C again` was absent from every codex cell, so an ask-gated second press can only ever serve the agents that ask (claude, and Cursor's `Ctrl+C` spelling). The 262 ms idle case leaves the retry set before the current 400 ms fallback fires. An earlier real-pane confirmation used the former 600 ms fallback: second press at +625 ms, hint at +789 ms, applied on the next activation (2026-08).

**Additional CLI probes** (macOS, 2026-09-24). The production capture function ran against native PTYs in disposable conversations, then launched each captured command in a fresh process. Copilot 1.0.88 captured at 659 ms while idle and 697 ms with unsent input; Antigravity 1.2.10 at 83/81 ms; Cursor 2026.09.23-86fc751 at 82/83 ms. Each restored the test reply and retained the same conversation ID through the second capture. These probes exercised shared capture and agent resume, not a complete app restart. Warp v0.2026.09.16.08.27.stable_02 stayed on its startup animation and yielded no hint; its fixture uses the supplied real exit excerpt, and its installed help confirms `--resume <RESUME>`.

**Pi's double-press window** (installed Pi 1.0.0, macOS, 2026-10-01). `InteractiveMode.handleCtrlC` clears the editor on the first press and calls shutdown only when the next press arrives within 500 ms. It prints no request for the second press. The previous 600 ms fallback therefore missed that window. The fallback is now 400 ms, still beyond Codex's measured 262 ms one-press exit, retaining the separate 200 ms quiet gate. This is a shared fallback; a busy pane can still defer the retry beyond Pi's window. Native PTY probes captured the same conversation with the second press at 416 ms while idle and 413 ms with unsent text; a fresh process rendered the persisted test reply. The probes used an isolated session store with synthetic messages and no model requests, and exercised shared capture and Pi resume rather than a full app restart. The supplied exit excerpt verifies `pi --session <uuid>` followed by a shell prompt on the same line; attention watching has not been verified.

**Codex with the 400 ms fallback** (Codex CLI 0.159.3, macOS, 2026-10-01). Native PTY probes resumed a disposable conversation containing a literal test reply, waited 1.5 seconds after the assistant reply rendered, then ran the production capture machine. Five idle runs printed the hint at 265, 202, 209, 192, and 209 ms, each with one press; a separate one-press control yielded at 203 ms. With unsent input, the fallback press arrived at 413 ms and the hint at 680 ms. Every capture retained the exact conversation ID, and each fresh process rendered the saved reply. These runs used `--no-daemon`, `--no-alt-screen`, and disabled MCP servers; they did not test heavy load, other platforms, or a complete app restart. The slowest idle run left 135 ms before the fallback, so this evidence is not a bound on shutdown latency under load.

## Detection

**Why the rightmost match wins by position, not by pattern order.** An agent that redraws its hint with carriage returns leaves several candidates in the window; position is the only ordering that tracks which one the user can see, so ranking patterns against each other would sometimes surface a stale id.

**Why a wrong-shaped id is skipped, not taken.** Codex 0.160 (2026-10) prints `Or run codex resume and select <thread name>.` after its id line, so the rightmost match was `codex resume and`, and cold restore ran it. Copilot 1.0.88 hard-wraps its hint to the pane width (below about 74 columns), so a separator follows a fragment of the id (`copilot --resume=ab5`); Copilot resumes by prefix, so a long fragment found the conversation and a short one opened a new one. Every registered agent prints a UUID, so a terminated token of another shape names no conversation and the scan moves to an older hint. A token still at the buffer end keeps holding the scan, as before.

**Why the invocation match tolerates prose.** Codex's real hint is prose on the same line — `To continue this session, run codex resume <id>` — so requiring the invocation to start a line, or to be followed by anything stronger than a word break, would miss the hint recovery exists for.

**Why capture waits for a separator.** A PTY read can end inside an ID, and a 40 ms capture poll between reads previously accepted that prefix permanently. The six recorded agent exit fixtures all follow the ID with CRLF (2026-09); waiting for that separator preserves them without waiting for the shell prompt or stream closure. Punctuation and completed cursor-control boundaries still delimit hints. An incomplete trailing CSI or ESC sequence cannot supply that proof: it may finish as styling that joins the next text to the same ID. The split-read regression tests cover every ID position, including the cut just before its separator.

**Why an unterminated control swallows the rest of the window.** Otherwise a window title cut mid-sequence reads back as terminal output, and a tail ending `\x1b[38;5` surrenders `38;5` to the greedy id pattern; swallowing is the fail-closed direction. The inverse case — a payload whose *introducer* fell off the front of the window — is unrecoverable here, and grants no more than ordinary output already does.

**Why a bare C1 introducer counts.** The batch stripper honored the C1 *terminator* (`\x9c`) but only the 7-bit `ESC` *introducer*, so an emitter using 8-bit controls could get its payload promoted to visible text — the one place the codebase's grammar disagreed with itself, since both the streaming filter and `TerminalProtocolParser` frame the C1 forms. Unifying them means `stripTerminalControls` now swallows the tail after a stray `\x9f`, which can hide a resume command that follows it in the same window. That direction is the safer trade: a missed offer to resume is recoverable and visible, while an APC payload matched *as* a resume command puts attacker-chosen bytes into executable state. Resolved by making `stripTerminalControls` run `TerminalControlStreamFilter` rather than keeping a second regex copy of the grammar.

**Why "terminated" is xterm's definition, not ECMA-48's.** The renderer aborts a string control on CAN/SUB and on a bare ESC, so a stripper waiting for a formal ST would treat as payload what the terminal already treated as ended.

**Why the Fe range is not enough to match an escape.** `ESC 7` / `ESC 8` and `ESC c` have final bytes outside it, so a matcher keyed on the introducer alone strips the ESC and leaks the final byte into the text.

**Why boundary-mode stripping inverts the rule.** Observed in the wild: a stored `claude --resume <uuid>codex`. Deleting controls instead of replacing them with a newline welded two fragments never adjacent on screen into one id-shaped token, which then passed the id grammar. Erasures count too — `\x1b[2K` means the text before it on that line is gone. Among the non-string ESC/CSI presentation sequences, SGR and charset designators leave the surrounding text contiguous. String payloads are removed by the earlier framing pass; this policy does not imply that every string protocol leaves the cursor unchanged.

## Recovery record

**Why the recovery command stays off the session shape.** The webview has nothing to write back, so no save/restore cycle can carry a stale invocation past the destructive read in `takeRecoveryCommands`.

**Why capture clears once per process.** A run that never opens a Dormouse view may leave the old record unclaimed. Clearing it before capture prevents an empty teardown from carrying it forward; merging later captures preserves other standalone Windows.

**Why each webview claims only its own pane ids.** Two containers resolve inside one activation; a claim-everything read would let whichever resolved first delete the other's commands. Per-id claiming also means a disposed-and-re-resolved view restores without re-running the agent — its entries were already taken.

## Cold restore

**Why auto-run needs no confirmation prompt.** The detector rebuilds a known command and restricts the id grammar, excluding shell punctuation from the captured argument. `claude --resume <id>` restores the conversation, lands at an idle prompt, and makes no request until the user types. It restores *more* context than the scrollback it replaces — the resumed agent renders the real conversation, not a transcript of it — which is what made dropping persisted scrollback affordable.

**The cold-activation cost, measured.** Claude ≈ 5 s to resume, codex ≈ 25 s with MCP servers (date not recorded). Multiplied by every agent pane in a Workspace and by how often Reload Window happens, that is what a future setting would trade against.

