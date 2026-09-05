# Transport and PTY Protocol — Rationale

> Informative companion to [transport.md](transport.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Adapter model

**What `persistsSession: false` actually saves.** The expensive half of a save is the record build, not the write: one `getCwd` round trip per pane (`docs/specs/standalone.md` → "Standalone persists no Session state", whose rationale prices it).

## Standalone browser-dev harness

**Why the bridge needs authentication at all.** Loopback is not an access control: any web page open in the developer's own browser reaches `127.0.0.1` as readily as the dev page does, and an unauthenticated bridge hands it arbitrary command execution as the developer (`docs/specs/security-local.md` → "Loopback Listeners").

**Why the token is digested before comparison.** `timingSafeEqual` throws on unequal-length inputs, so raw-string comparison turns a wrong-length guess into an exception rather than a refusal; hashing both sides to SHA-256 makes every comparison equal-length.

**Why the bridge token is not the `dor` control token.** The `dor` control-API `controlToken` is handed to every shell Dormouse spawns; the bridge's circle is smaller than "every terminal on the machine", so it mints its own per-run credential.

**How DNS rebinding defeats a loopback bind.** A hostile domain re-resolved to `127.0.0.1` arrives with its own name in `Host`; the browser treats the result as same-origin, so CORS never applies. Pinning `Host` is the check that survives it.

**What a CORS-*simple* endpoint costs.** A foreign page can POST with `mode: 'no-cors'` and, though it cannot read the reply, the request still executes — and executing is the whole risk here. `application/json` forces a preflight it cannot pass.

**Why the CORS origin is never `*`.** It was `*` once: the bridge's clipboard invokes were readable cross-origin under it — a foreign page could POST an invoke and read the reply.

**Why both loopback spellings are echoed.** `127.0.0.1:<port>` and `localhost:<port>` are the same dev page, and pinning one rejects a developer who typed the other with symptoms — blank terminal, console CORS errors — that do not point at the token gate.

**Agent workflows were unaffected by the gate.** The token reaches the page through the `VITE_DORMOUSE_BROWSER_DEV_HOST` env var the harness already sets, and `agent-browser` drives the Vite origin, never the bridge.

**Why the harness does not persist.** Persisting would restore panes across a reload the real app drops, so the harness would stop reproducing the cold-start behavior it exists to exercise — and would run the record build ("Adapter model") on a path production never takes.

## Reconnection protocol

**The `<unnamed>` seed skip is lossy, deliberately.** Persistence cannot tell a deliberate `<unnamed>` pin from the default panel placeholder, so a user who pinned it gets the derived header back on reload — cheaper than seeding every default placeholder as a real user title.

## Message protocol

**What the broadcast buys.** Unambiguous settling is only half of it: the same fan-out lets a losing window forward a command to the broker window and receive the answer back (`docs/specs/vscode.md` → "Peer surfaces across windows").

**The per-store tax.** Each app-global store relayed webview↔host this way costs one `PlatformAdapter` push method, an on/off listener pair, three message types, and a host coordinator with its own subscribe/unsubscribe. Two are worth paying that twice for the directness; at a third, the keyed channel + key→normalizer registry is cheaper than another copy of the plumbing.

## Persisted session types

**Why the recovery command stays off the session shape.** The webview has nothing to write back, so no save/restore cycle can carry a stale invocation past the destructive read in `takeRecoveryCommands`.

**Why each webview claims only its own pane ids.** Two containers resolve inside one activation; a claim-everything read would let whichever resolved first delete the other's commands. Per-id claiming also means a disposed-and-re-resolved view restores without re-running the agent — its entries were already taken.

**Why the rightmost match wins by position, not by pattern order.** An agent that redraws its hint with carriage returns leaves several candidates in the window; position is the only ordering that tracks which one the user can see, so ranking patterns against each other would sometimes surface a stale id.

**Why the invocation match tolerates prose.** Codex's real hint is prose on the same line — `To continue this session, run codex resume <id>` — so requiring the invocation to start a line, or to be followed by anything stronger than a word break, would miss the hint recovery exists for.

**Why an unterminated control swallows the rest of the window.** Otherwise a window title cut mid-sequence reads back as terminal output, and a tail ending `\x1b[38;5` surrenders `38;5` to the greedy id pattern; swallowing is the fail-closed direction. The inverse case — a payload whose *introducer* fell off the front of the window — is unrecoverable here, and grants no more than ordinary output already does.

**Why a bare C1 introducer counts.** The batch stripper honored the C1 *terminator* (`\x9c`) but only the 7-bit `ESC` *introducer*, so an emitter using 8-bit controls could get its payload promoted to visible text — the one place the codebase's grammar disagreed with itself, since both the streaming filter and `TerminalProtocolParser` frame the C1 forms. Unifying them means `stripTerminalControls` now swallows the tail after a stray `\x9f`, which can hide a resume command that follows it in the same window. That direction is the safer trade: a missed offer to resume is recoverable and visible, while an APC payload matched *as* a resume command puts attacker-chosen bytes into executable state. Resolved by making `stripTerminalControls` run `TerminalControlStreamFilter` rather than keeping a second regex copy of the grammar.

**Why "terminated" is xterm's definition, not ECMA-48's.** The renderer aborts a string control on CAN/SUB and on a bare ESC, so a stripper waiting for a formal ST would treat as payload what the terminal already treated as ended.

**Why the Fe range is not enough to match an escape.** `ESC 7` / `ESC 8` and `ESC c` have final bytes outside it, so a matcher keyed on the introducer alone strips the ESC and leaks the final byte into the text.

**Why boundary-mode stripping inverts the rule.** Observed in the wild: a stored `claude --resume <uuid>codex`. Deleting controls instead of replacing them with a newline welded two fragments never adjacent on screen into one id-shaped token, which then passed the id grammar. Erasures count too — `\x1b[2K` means the text before it on that line is gone — while SGR and charset designators are the only classes where the text either side really is contiguous.

## Retiring the transcripts already on disk

**The legacy blobs are real, not hypothetical.** Every pre-upgrade installation had a transcript-bearing snapshot in `workspaceState` or the standalone file store, so the drop-on-read in `readPersistedSession` and standalone's boot-time clear are live migration paths, not dead defensive code.

## The governing rule

**Why standalone persists nothing.** A clean quit has nothing to clear and a crash has nothing to recover, so the store earns no keep.

**Why standalone's write path was removed rather than written-then-ignored.** The blob it wrote was the transcript-bearing one, so leaving the writer in place would have kept minting exactly the bytes "Retiring the transcripts already on disk" exists to retire.

## Consuming it

**Why auto-run needs no confirmation prompt.** The id fails closed at both ends: agent session files are per-user and per-project directory, so an id cannot be planted to be resumed into, and the id grammar keeps shell punctuation out of what is executed. `claude --resume <id>` restores the conversation, lands at an idle prompt, and makes no request until the user types. It restores *more* context than the scrollback it replaces — the resumed agent renders the real conversation, not a transcript of it — which is what made dropping persisted scrollback affordable.

**The cold-activation cost, measured.** Claude ≈ 5 s to resume, codex ≈ 25 s with MCP servers (date not recorded). Multiplied by every agent pane in a Workspace and by how often Reload Window happens, that is what a future setting would trade against.

## PTY buffering

The former consume-on-read replay buffer duplicated scrollback during live
output. Its only reader chose it when a router first claimed a PTY, assuming
that ownership implied a first-ever reconstruction. Disposing a WebviewView
releases its PTYs without killing them; a replacement router therefore got only
output since the previous replay read, and a second replacement with no new
output got nothing. Every reconstructed xterm needs the same retained history,
so a separate replay buffer and ownership-based read choice serve no purpose.

## Universal invariants

**VS Code scrollback outlives the process for repeat resumes.** Recovery capture runs before any kill (`docs/specs/vscode.md` → "Capturing agent recovery"), but a webview reopened over an exited pane still needs its transcript. The shared PTY core formerly kept a second buffer: VS Code never read it, and standalone's reader became unreachable when the adapter stopped persisting transcripts. Removing that duplicate leaves buffering with its actual consumer.

**Where a flat `scrollbackChars` bites.** The cap is reached first on exactly the long-running agent pane recovery exists for, so a caller treating buffer length as a stream position sees no growth on the pane it most needs to watch.

**The phantom-running symptoms of a spawn failure with no exit.** A running header that never clears, a `countRunningSessions` that never returns to zero, and therefore a quit confirmation on every window close. Reached whenever a persisted or selected shell binary is gone.

**What type-only ack matching did.** `interrupt` and `gracefulKillAll` time out on the teardown path, and the late ack from a timed-out call then resolved the *next* call of the same type the instant it was issued — so the second interrupt appeared to complete before the PTYs had seen it.
