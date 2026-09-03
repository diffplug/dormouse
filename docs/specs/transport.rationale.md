# Transport and PTY Protocol — Rationale

> Informative companion to [transport.md](transport.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Adapter model

**What `persistsSession: false` actually saves.** The expensive half of a save is not the write but the record build, which costs one `getCwd` round trip per pane. Skipping the build rather than the write is what makes the flag worth having (`docs/specs/standalone.md` → "Standalone persists no Session state", whose rationale prices the round trip).

## Standalone browser-dev harness

**Why the bridge needs authentication at all.** Loopback is not an access control: the threat is a web page open in the developer's own browser, which reaches `127.0.0.1` as readily as the dev page does. Since the bridge dispatches `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env`, an unauthenticated one is arbitrary command execution as the developer (`SECURITY.md` → "Loopback Listeners").

**Why the token is digested before comparison.** `timingSafeEqual` throws on unequal-length inputs, so comparing the raw strings would turn a wrong-length guess into an exception rather than a refusal. Hashing both sides to SHA-256 first makes every comparison equal-length.

**Why the bridge token is not the `dor` control token.** The `dor` control-API `controlToken` is handed to every shell Dormouse spawns; the bridge's circle is smaller, so it mints its own per-run credential rather than sharing one that every terminal on the machine already holds.

**How DNS rebinding defeats a loopback bind.** A hostile domain re-resolved to `127.0.0.1` arrives with its own name in `Host`, and the browser treats the result as same-origin, so CORS never applies. Pinning `Host` to the two loopback spellings is the check that survives it.

**What a CORS-*simple* endpoint costs.** Without a required non-simple content type, a foreign page can POST with `mode: 'no-cors'` and — though it cannot read the reply — the request still executes, and executing is the whole risk here. Requiring `application/json` forces a preflight the page cannot pass.

**Why the CORS origin is never `*`.** It was `*` once, and the bridge's clipboard invokes were readable cross-origin under it — a foreign page could POST an invoke and read the reply.

**Why both loopback spellings are echoed.** `127.0.0.1:<port>` and `localhost:<port>` are the same dev page, and pinning one rejects a developer who typed the other with symptoms — blank terminal, console CORS errors — that do not point at the token gate as the cause.

**Agent workflows were unaffected by the gate.** The token reaches the page through the `VITE_DORMOUSE_BROWSER_DEV_HOST` env var the harness already sets, and `agent-browser` drives the Vite origin, never the bridge — so adding authentication cost the agent harness nothing.

**Why the harness must not persist.** Persisting would restore panes across a reload the real app drops, so the harness would stop reproducing the cold-start behavior it exists to exercise. The second cost is cheaper but real: a harness that persisted would run the record build — and its per-pane `getCwd` round trip — on a path production never takes.

## Reconnection protocol

**The `<unnamed>` seed skip is lossy, deliberately.** Persistence cannot tell a deliberate `<unnamed>` pin from the default panel placeholder, so a user who explicitly pinned `<unnamed>` sees it revert to the derived header on reload. Losing that pin is cheaper than seeding every default placeholder as a real user title.

## Message protocol

**Why a globally unique `rhId` is what lets VS Code broadcast.** Because only the adapter that minted an `rhId` can settle it, a result may be fanned out to every webview in the window without ambiguity — and that fan-out is also what lets a losing window forward a command to the broker window and receive the answer back (`docs/specs/vscode.md` → "Peer surfaces across windows").

**The per-store tax.** Each app-global store relayed webview↔host this way spends one `PlatformAdapter` push method plus an on/off listener pair, three message types, and a host coordinator with its own subscribe/unsubscribe. Two stores are worth paying it twice for the directness; a third is where the keyed-channel + key→normalizer registry becomes cheaper than another copy of the same plumbing.

## Persisted session types

**Why the recovery command stays off the session shape.** Keeping it out of `PersistedPane` makes the one-shot guarantee structural rather than procedural: the webview has nothing to write back, so no save/restore cycle can carry a stale invocation past the destructive read in `takeRecoveryCommands`.

**Why each webview claims only its own pane ids.** Two containers resolve inside one activation, and a claim-everything read would let whichever resolved first delete the other's commands. Per-id claiming also means a view that is disposed and re-resolved restores without re-running the agent, because its entries were already taken.

**Why the rightmost match wins by position, not by pattern order.** An agent that redraws its hint with carriage returns leaves several candidates in the window; position is the only ordering that tracks which one the user can actually see, so ranking patterns against each other would sometimes surface a stale id.

**Why the invocation match tolerates prose.** Codex's real hint is prose on the same line — `To continue this session, run codex resume <id>` — so requiring the invocation to start a line, or to be followed by anything stronger than a word break, would miss the hint that recovery exists for. The prose-tolerant match is load-bearing rather than hypothetical.

**Why an unterminated control swallows the rest of the window.** A window title cut mid-sequence must not read back as terminal output, and a tail ending `\x1b[38;5` must not surrender `38;5` to the greedy id pattern. Swallowing is the fail-closed direction: the payload of a control the window truncated is never handed to the matcher. The inverse case — a payload whose *introducer* fell off the front of the window — is unrecoverable here, and grants no more than ordinary output already does.

**Why "terminated" is xterm's definition, not ECMA-48's.** The renderer aborts a string control on CAN/SUB and on a bare ESC, so a stripper that waited for a formal ST would treat as payload what the terminal already treated as ended.

**Why the Fe range is not enough to match an escape.** `ESC 7` / `ESC 8` and `ESC c` have final bytes outside the Fe range, so a matcher keyed on the introducer alone strips the ESC and leaks the final byte into the text.

**Why boundary-mode stripping inverts the rule.** Observed in the wild: a stored `claude --resume <uuid>codex`, welded across a redraw seam. Deleting the controls instead of replacing them with a newline welded two fragments that were never adjacent on screen into one id-shaped token, which then passed the id grammar. Erasures count too — `\x1b[2K` means the text before it on that line is gone — while SGR and charset designators are the only classes where the text either side really is contiguous.

## Retiring the transcripts already on disk

**The legacy blobs are real, not hypothetical.** Every pre-upgrade installation had a transcript-bearing snapshot sitting in `workspaceState` or the standalone file store, so the drop-on-read in `readPersistedSession` and standalone's boot-time clear are live migration paths rather than dead defensive code.

## The governing rule

**Why standalone persists nothing.** A clean quit has nothing to clear and a crash has nothing to recover, so the store earns no keep.

**Why standalone's write path was removed rather than written-then-ignored.** The blob it wrote was the transcript-bearing one, so leaving the writer in place would have kept minting exactly the bytes "Retiring the transcripts already on disk" exists to retire — a store that is never read still has to be a store that is never written.

## Consuming it

**Why auto-run needs no confirmation prompt.** The invocation is a known label plus a validated id that fails closed: agent session files are per-user and per-project directory, so an id cannot be planted to be resumed into, and the id grammar keeps shell punctuation out of what is executed. `claude --resume <id>` restores the conversation, lands at an idle prompt, and makes no request until the user types. It also restores *more* context than the scrollback it replaces, since the resumed agent renders the real conversation rather than a transcript of it — which is what made dropping persisted scrollback affordable in the first place.

**The cold-activation cost, measured.** Claude ≈ 5 s to resume, codex ≈ 25 s with MCP servers (date not recorded). Multiplied by every agent pane in a Workspace and by how often Reload Window happens, that is the number a future setting would be trading against.

## Universal invariants

**Recovery capture no longer depends on scrollback surviving PTY exit.** It runs *before* any kill now (`docs/specs/vscode.md` → "Capturing agent recovery"). The invariant outlived that change because the final flush — reading a pane whose shell has just exited — still needs it.

**Where a flat `scrollbackChars` bites.** The buffer cap is reached first on exactly the long-running agent pane recovery exists for, so a caller that treated buffer length as a stream position would see no growth on the pane it most needs to watch.

**The phantom-running symptoms of a spawn failure with no exit.** A running header that never clears, a `countRunningSessions` that never returns to zero, and therefore a quit confirmation on every attempt to close the window. Reached whenever a persisted or selected shell binary is gone.

**What type-only ack matching did.** `interrupt` and `gracefulKillAll` time out on the teardown path, and the late ack from a timed-out call then resolved the *next* call of the same type the instant it was issued — so the second interrupt appeared to complete before the PTYs had seen it.
