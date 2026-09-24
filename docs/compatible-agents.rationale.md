# Compatible agents — Rationale

> Informative companion to [compatible-agents.md](compatible-agents.md), keyed by its headings.

## Capture

**Why `^C` and not a signal.** SIGTERM to the pty leader is inert against both claude and codex, and the foreground-process-group signal that does reach claude leaves codex silent (2026-08). `^C` is the one gesture both agents answer; it needs no `tcgetpgrp` and no master fd node-pty does not expose, takes the same path on ConPTY, and leaves the shell alive.

**Why every live PTY is interrupted.** Gating on "is this pane running an agent" would need per-pane foreground-command knowledge the host does not have, and every one of these processes is killed seconds later regardless.

**Why the clocks start at the ack.** The ~600 ms fallback and the ~200 ms silence window are statements about the agent, not about the round trip; measuring from step entry folds the interrupt's own latency into the window and shortens it by an amount that varies with load.

**Why the ask gate keys on an English UI string.** Claude's `Press Ctrl-C again` and Cursor's `Press Ctrl+C again` (supplied macOS exit excerpt, Cursor 2026.09.23-86fc751) could change. That failure loses recovery for that shutdown, where a mistimed second press destroys Codex's hint every time.

**Two settle-on-quiet heuristics died on the same fact.** Codex says nothing for ~250 ms and then prints its entire shutdown at once, so a poll that treats silence as completion exits before codex has spoken; both attempts to settle early on quiet lost the hint that way. Polling to the ceiling instead costs nothing, the record being written the moment each command is found.

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

Rows 1–2 are why a blanket second press is wrong; `Press Ctrl-C again` was absent from every codex cell, so an ask-gated second press can only ever serve the agents that ask (claude, and Cursor's `Ctrl+C` spelling). The 262 ms idle case leaves the retry set before the ~600 ms fallback fires. Confirmed end to end in a real pane: fallback press at +625 ms, hint at +789 ms, applied on the next activation.

**Additional CLI probes** (macOS, 2026-09-24). The production capture function ran against native PTYs in disposable conversations, then launched each captured command in a fresh process. Copilot 1.0.88 captured at 659 ms while idle and 697 ms with unsent input; Antigravity 1.2.10 at 83/81 ms; Cursor 2026.09.23-86fc751 at 82/83 ms. Each restored the test reply and retained the same conversation ID through the second capture. These probes exercised shared capture and agent resume, not a complete app restart. Warp v0.2026.09.16.08.27.stable_02 stayed on its startup animation and yielded no hint; its fixture uses the supplied real exit excerpt, and its installed help confirms `--resume <RESUME>`.

## Detection

**Why the rightmost match wins by position, not by pattern order.** An agent that redraws its hint with carriage returns leaves several candidates in the window; position is the only ordering that tracks which one the user can see, so ranking patterns against each other would sometimes surface a stale id.

**Why the invocation match tolerates prose.** Codex's real hint is prose on the same line — `To continue this session, run codex resume <id>` — so requiring the invocation to start a line, or to be followed by anything stronger than a word break, would miss the hint recovery exists for.

**Why capture waits for a separator.** A PTY read can end inside an ID, and a 40 ms capture poll between reads previously accepted that prefix permanently. The six recorded agent exit fixtures all follow the ID with CRLF (2026-09); waiting for that separator preserves them without waiting for the shell prompt or stream closure. Punctuation and completed cursor-control boundaries still delimit hints. An incomplete trailing CSI or ESC sequence cannot supply that proof: it may finish as styling that joins the next text to the same ID. The split-read regression tests cover every ID position, including the cut just before its separator.

**Why an unterminated control swallows the rest of the window.** Otherwise a window title cut mid-sequence reads back as terminal output, and a tail ending `\x1b[38;5` surrenders `38;5` to the greedy id pattern; swallowing is the fail-closed direction. The inverse case — a payload whose *introducer* fell off the front of the window — is unrecoverable here, and grants no more than ordinary output already does.

**Why a bare C1 introducer counts.** The batch stripper honored the C1 *terminator* (`\x9c`) but only the 7-bit `ESC` *introducer*, so an emitter using 8-bit controls could get its payload promoted to visible text — the one place the codebase's grammar disagreed with itself, since both the streaming filter and `TerminalProtocolParser` frame the C1 forms. Unifying them means `stripTerminalControls` now swallows the tail after a stray `\x9f`, which can hide a resume command that follows it in the same window. That direction is the safer trade: a missed offer to resume is recoverable and visible, while an APC payload matched *as* a resume command puts attacker-chosen bytes into executable state. Resolved by making `stripTerminalControls` run `TerminalControlStreamFilter` rather than keeping a second regex copy of the grammar.

**Why "terminated" is xterm's definition, not ECMA-48's.** The renderer aborts a string control on CAN/SUB and on a bare ESC, so a stripper waiting for a formal ST would treat as payload what the terminal already treated as ended.

**Why the Fe range is not enough to match an escape.** `ESC 7` / `ESC 8` and `ESC c` have final bytes outside it, so a matcher keyed on the introducer alone strips the ESC and leaks the final byte into the text.

**Why boundary-mode stripping inverts the rule.** Observed in the wild: a stored `claude --resume <uuid>codex`. Deleting controls instead of replacing them with a newline welded two fragments never adjacent on screen into one id-shaped token, which then passed the id grammar. Erasures count too — `\x1b[2K` means the text before it on that line is gone — while SGR and charset designators are the only classes where the text either side really is contiguous.

## Recovery record

**Why the recovery command stays off the session shape.** The webview has nothing to write back, so no save/restore cycle can carry a stale invocation past the destructive read in `takeRecoveryCommands`.

**Why capture clears once per process.** A run that never opens a Dormouse view may leave the old record unclaimed. Clearing it before capture prevents an empty teardown from carrying it forward; merging later captures preserves other standalone Windows.

**Why each webview claims only its own pane ids.** Two containers resolve inside one activation; a claim-everything read would let whichever resolved first delete the other's commands. Per-id claiming also means a disposed-and-re-resolved view restores without re-running the agent — its entries were already taken.

## Cold restore

**Why auto-run needs no confirmation prompt.** The detector rebuilds a known command and restricts the id grammar, excluding shell punctuation from the captured argument. `claude --resume <id>` restores the conversation, lands at an idle prompt, and makes no request until the user types. It restores *more* context than the scrollback it replaces — the resumed agent renders the real conversation, not a transcript of it — which is what made dropping persisted scrollback affordable.

**The cold-activation cost, measured.** Claude ≈ 5 s to resume, codex ≈ 25 s with MCP servers (date not recorded). Multiplied by every agent pane in a Workspace and by how often Reload Window happens, that is what a future setting would trade against.

