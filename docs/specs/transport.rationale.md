# Transport and PTY Protocol — Rationale

> Informative companion to [transport.md](transport.md): the evidence, symptoms, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Standalone browser-dev harness

**Why the CORS origin is never `*`.** It was `*` once, and the bridge's clipboard invokes were readable cross-origin under it — a foreign page could POST an invoke and read the reply.

**Why both loopback spellings are echoed.** `127.0.0.1:<port>` and `localhost:<port>` are the same dev page, and pinning one rejects a developer who typed the other with symptoms — blank terminal, console CORS errors — that do not point at the token gate as the cause.

**Agent workflows were unaffected by the gate.** The token reaches the page through the `VITE_DORMOUSE_BROWSER_DEV_HOST` env var the harness already sets, and `agent-browser` drives the Vite origin, never the bridge — so adding authentication cost the agent harness nothing.

## Reconnection protocol

**The `<unnamed>` seed skip is lossy, deliberately.** Persistence cannot tell a deliberate `<unnamed>` pin from the default panel placeholder, so a user who explicitly pinned `<unnamed>` sees it revert to the derived header on reload. Losing that pin is cheaper than seeding every default placeholder as a real user title.

## Message protocol

**The per-store tax.** Each app-global store relayed webview↔host this way spends one `PlatformAdapter` push method plus an on/off listener pair, three message types, and a host coordinator with its own subscribe/unsubscribe. Two stores are worth paying it twice for the directness; a third is where the keyed-channel + key→normalizer registry becomes cheaper than another copy of the same plumbing.

## Persisted session types

**Why the invocation match tolerates prose.** Codex's real hint is prose on the same line — `To continue this session, run codex resume <id>` — so requiring the invocation to start a line, or to be followed by anything stronger than a word break, would miss the hint that recovery exists for. The prose-tolerant match is load-bearing rather than hypothetical.

**Why boundary-mode stripping inverts the rule.** Observed in the wild: a stored `claude --resume <uuid>codex`, welded across a redraw seam. Deleting the controls instead of replacing them with a newline welded two fragments that were never adjacent on screen into one id-shaped token, which then passed the id grammar.

## Retiring the transcripts already on disk

**The legacy blobs are real, not hypothetical.** Every pre-upgrade installation had a transcript-bearing snapshot sitting in `workspaceState` or the standalone file store, so the drop-on-read in `readPersistedSession` and standalone's boot-time clear are live migration paths rather than dead defensive code.

## The governing rule

**Why standalone's write path was removed rather than written-then-ignored.** The blob it wrote was the transcript-bearing one, so leaving the writer in place would have kept minting exactly the bytes "Retiring the transcripts already on disk" exists to retire — a store that is never read still has to be a store that is never written.

## Consuming it

**Why auto-run needs no confirmation prompt.** The invocation is a known label plus a validated id that fails closed: agent session files are per-user and per-project directory, so an id cannot be planted to be resumed into, and the id grammar keeps shell punctuation out of what is executed. `claude --resume <id>` restores the conversation, lands at an idle prompt, and makes no request until the user types. It also restores *more* context than the scrollback it replaces, since the resumed agent renders the real conversation rather than a transcript of it — which is what made dropping persisted scrollback affordable in the first place.

**The cold-activation cost, measured.** Claude ≈ 5 s to resume, codex ≈ 25 s with MCP servers (date not recorded). Multiplied by every agent pane in a Workspace and by how often Reload Window happens, that is the number a future setting would be trading against.

## Universal invariants

**Recovery capture no longer depends on scrollback surviving PTY exit.** It runs *before* any kill now (`docs/specs/vscode.md` → "Capturing agent recovery"). The invariant outlived that change because the final flush — reading a pane whose shell has just exited — still needs it.

**The phantom-running symptoms of a spawn failure with no exit.** A running header that never clears, a `countRunningSessions` that never returns to zero, and therefore a quit confirmation on every attempt to close the window.

**What type-only ack matching did.** `interrupt` and `gracefulKillAll` time out on the teardown path, and the late ack from a timed-out call then resolved the *next* call of the same type the instant it was issued — so the second interrupt appeared to complete before the PTYs had seen it.
