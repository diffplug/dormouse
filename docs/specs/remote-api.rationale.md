# Remote Surface API — Rationale

> Informative companion to [remote-api.md](remote-api.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Remote Surface API

**Why "replicate state" is load-bearing rather than a preference.** Per-surface streams are what make VR viable — a headset can hang each one in space — and what make the phone cheap: one attached surface, one stream. A single desktop stream would give neither.

## The provider seam

**Why `ptyId` is opaque under VS Code.** Two duplicated windows can cold-restore panes holding the same PTY id. A handle that carried that id verbatim would let one window's attach be routed to the other's terminal, moving the stream and both input methods onto a PTY the Client never asked for.

In September 2026, both production installations use `createAskSurfaceProvider`: resolution selects a routing key and applies the requested size, while `streamPty` separately owns the subscription. The former `SurfaceHandle.release` was a no-op in that shared constructor; a test-only release counter suggested a second resource lifetime that neither host had.

## Transport

**Why the goodbye exists.** Before it, a Burrow that disposed a relayed session told the Client nothing: no Burrow→Relay frame drops a client, the Client's requests carry no timeout, and its keepalives keep its own idle clock fresh, so a relayed phone whose session was taken back froze with every keystroke dropped until it was reloaded. A direct session already learned of it, from its channel closing. The goodbye is a control message rather than a protocol-v1 event so it reaches a Client below the remote-api layer, where burrow loss is reported.

**Why a switched channel waits for the goodbye.** A channel closed in the tick that sent the goodbye takes the association down with whatever was still queued or buffered — `RTCPeerConnection.close()` flushes nothing — so behind a burst of output the goodbye was dropped (review, 2026-09) and the phone read channel loss: Pocket's "connection lost" rather than "The computer ended this session", a one-time phone still connecting `ONE_TIME_DIRECT_FAILED_MESSAGE` rather than its ended copy. The wait is bounded because a goodbye stuck behind that much output only costs the phone the wording; the relay needs none, since its send lands on the socket before the dispose.

## Direct path

**What a browser and the addon actually negotiate.** `scripts/direct-interop/run.mjs` is the only fixture that puts the two shipped stacks on one channel — the in-process suites link two fakes or run the addon against itself, and no CI job has a browser. Run on macOS 26.0 with Chromium and node-datachannel 0.33.2 (libdatachannel 0.24.3), 2026-09-10: the browser's whole offer was 587 characters against `MAX_DIRECT_SDP_LENGTH`'s 2 000, one host candidate on a machine with one usable interface; the association reported `maxMessageSize` 262 144 at both ends; and 65 535-, 4 096-, and 33-byte frames crossed browser→addon→browser byte for byte and in order.

**Why the SDP bound is measured rather than reasoned about.** 587 characters is 29% of the budget on a host with one interface, and each further candidate line costs roughly 80 more — so the headroom is real but it is a property of the machine, not of the code. A host with docker bridges, VMs, and several VPNs is the case that would spend it, and the failure there is silent by design: the attempt is skipped and the session stays relayed. Re-run the fixture on such a host before treating the bound as settled.

**Why the answer cannot outgrow its signal** *(libjuice 1.7.2 source, read 2026-09-30)*. libjuice gathers a host candidate for every non-loopback, non-link-local address, skipping only `docker0` by name, keeps at most 14 (`MAX_HOST_CANDIDATES_COUNT`), and adds at most two srflx. At the longest line forms (88 characters per host, 111 for an IPv6 srflx) that is ~1,932 characters against `MAX_DIRECT_SDP_LENGTH`'s 2,000. The bound is libjuice's, not Dormouse's: re-check it whenever `node-datachannel` moves libjuice.

**Why gathering settles a grace after the first srflx** *(2026-09-30, macOS 27, HeadlessChrome 150 against `node-datachannel` 0.33.4 / libjuice 1.7.2, `scripts/direct-interop/run.mjs --stun`)*. Through Cloudflare STUN, Chrome's srflx arrived 21–46 ms into gathering, but gathering never completed inside the 3 s cap: Chrome also sends a binding from its IPv6 socket to Cloudflare's AAAA record, which on a network with no IPv6 default route goes unanswered until Chrome gives up at 39.9 s (Cloudflare's IPv4 address as a literal completed in 128 ms). So every offer waited the whole cap, opening at 3.13–3.15 s; and since the one-time page always gathers through STUN, Local networks did too (3.08 s, against 0.22 s without STUN). Settling 500 ms after the first srflx sent Chrome's offer at 523–548 ms and opened at 0.64–0.73 s (Local networks: 0.59 s). The Burrow's libjuice completes long before any grace, and with STUN blackholed both ends still wait out the cap: `remote-network.rationale.md` -> "Anywhere".
- **Why 500 ms.** A second family's srflx — for an mDNS-hiding phone, the only statement of its IPv6 address — is requested alongside the first, so it trails by a round-trip difference; 500 ms also covers one lost request, which libwebrtc first retransmits at 250 ms. A later one, such as a cold second radio's, is dropped, and the first family's path remains.
- **Why not a shorter cap.** A cold cellular radio or one lost packet can push the only srflx past 1–1.5 s, and a one-time session has no relay to fall back to. The grace changes nothing where gathering completes, and shortens only a wait whose srflx is already in hand.

**Why the answerer's reliability check is documented as reaching nothing on the Burrow.** Measured against node-datachannel 0.33.2, 2026-09-10: an offerer creating `{ordered: false, maxRetransmits: 0}` reaches the polyfill's answerer as `ordered: true, maxRetransmits: null, maxPacketLifeTime: null`, because `RTCPeerConnection` builds every incoming channel as `new RTCDataChannel(channel)` with no options and the constructor defaults them. A browser answerer reports what was negotiated, so the check bites there. Reading them some other way would mean parsing the offer's DCEP parameters, which neither the polyfill nor the addon exposes — so the limit is stated rather than closed, and the behaviour is pinned so an addon that starts reporting them is noticed rather than silently upgrading a documented gap into an enforced rule.

**Why the message-limit check stays at open despite being per-direction.** Neither stack has a number before the association is up: measured against node-datachannel 0.33.2, 2026-09-10, `sctp` is a transport object from construction but its `maxMessageSize` reads null after `setLocalDescription` and `setRemoteDescription` at both ends, and 262 144 once the channel opens. So there is no earlier moment at which the number exists, and no way for a refusing end to decline before its peer may have switched. Both shipped stacks advertise 262 144, so the asymmetric case needs a peer that advertises under 65 535; the symmetric case abandons at both ends and stays relayed.

**Why DTLS is not part of the trust model.** The channel is encrypted twice — DTLS underneath, Noise inside — and only the inner one is load-bearing. The DTLS fingerprints are authentic because the SDP carrying them was decrypted inside an authorized session, so DTLS adds transport hygiene rather than a second authority; a peer that broke it would still face the promoted session's ciphers.

## Envelope

**Why the clamp's upper bound is the security-relevant half.** A local resize is derived from element geometry and cannot be large, but `terminal.resize` carries a peer-supplied number straight into `term.resize` in the webview that owns the pane, and xterm bounds only the minimum before allocating `rows × cols` cells. Unbounded, one frame asking for a million by a million wedges every terminal in that window, reachable by any authorized Client (`docs/specs/security-remote.md` → "Trust boundary"). `MAX_TERMINAL_DIMENSION` is 2000 — far past any real display, since a 4K screen at an unreadably small font is on the order of 800 columns — while capping the worst a peer can request at a few million cells.

## Directory (the phone's picker)

**Why snapshots rather than deltas.** A directory is dozens of entries at most, so resending the whole listing on each coalesced change costs less than the delta protocol would.

**Why a collect carries a generation.** Collects overlap whenever something changes during a slow provider round trip, and they can settle in either order — so without one the stale answer lands last and blanks the picker until the next change.

**Why duplicate `surfaceId`s collapse instead of both being listed.** The same cold-restore id collision as §The provider seam, one level up: two identical rows would make a picker keyed by `surfaceId` a lottery over which window an attach actually reaches.

**Why `workspace` is withheld where refs are strip positions.** Every answerer's entries meet in one listing. VS Code's webviews each call themselves `workspace:1` "Workspace 1", so naming them would file every window's terminals under one header; withheld, the Client lists them flat, as before. Standalone's refs come from one application-wide counter, so they stay distinct across its Windows.

**Why entry order carries the Workspace order.** Each Window answers with entries only — the peer answer stays one `DirectoryEntry` per pane across builds (`docs/specs/vscode.md` -> "Peer surfaces") — so sending entries in strip order gives the Client the Burrow's order without a second shape on the ask bridge.

**Why a late answer invalidates instead of being dropped.** It arrives after the Burrow has already rendered a directory missing whatever that answerer owns — an empty picker on a machine that does have terminals — and nothing can re-open a settled request. Without the invalidation an idle machine has no other reason to re-collect, so the phone's picker stays wrong indefinitely.

## Terminal surfaces

**Why the owner's xterm answers and a mirror does not.** The answers are renderer-dependent: cell size, window pixel geometry, and XTSMGRAPHICS canvas limits are all properties of the renderer that produces them, and DA1 advertises what that renderer's addons can decode. The Burrow cannot answer them itself — a headless xterm in Node cannot host ImageAddon, which decodes images through the browser's own image pipeline — so the answer has to come from a renderer, and attach-is-the-resize keeps the owner's xterm a faithful model at the viewer's size, which makes it the right one. Letting both answer writes the reply twice into the PTY's input, and each further viewer adds another copy.

**Why the pair travels rather than being re-derived on the Client.** The Burrow has already computed it — the parser produces both projections from one pass — so sending it costs nothing on an ordinary chunk, where the two are identical and `text` is omitted. Re-deriving it on the Client would mean a second string-control state machine, whose framing has to stay identical to the Burrow's forever, and one that begins mid-sequence for a stream that starts inside a multi-megabyte image. Making omission mean "equal" rather than "absent" is what lets the fallback `textData ?? data` stay correct: a producer that simply forgot to project would otherwise be indistinguishable from one saying the two agree.

**Why this surfaced with inline images.** Duplicate replies were always possible — xterm core answers DA1, DA2, DSR/CPR, and XTVERSION — but a program asks those once at startup, before a phone is usually attached. ImageAddon's kitty handler replies `APC G i=<n>;OK ST` on *every* transmit unless the sender passes `q>=1`, so with a phone attached each image displayed on the laptop echoed a second `OK` into the shell's input a relay latency later, as visible junk on the prompt line.

## Attach is the resize

In September 2026, the Viewer-local 60ms restoration timer could overwrite a later local or other-Viewer resize, because neither writer touched the first Viewer's timer. Cancelling it on detach also stranded the PTY one row below its xterm. Moving restoration to the shared PTY owner makes all size writers cancel it and lets a detached Viewer's temporary resize complete.

**Why a resize is a whole screen.** `SIGWINCH` makes full-screen TUIs repaint completely and shells redraw their prompt line, so the client's first screen arrives from the live stream alone and no snapshot transfer is needed. The same-size case has to be forced because xterm sends no `SIGWINCH` for a resize to the current size, leaving the client staring at an empty screen until the next output.

## Attachment invariants

**Why an in-flight resolution is invalidated rather than allowed to finish.** The two resolve paths differ by orders of magnitude: a sibling window's pane is a round trip away, a local one settles on the next microtask. With one shared epoch the older, slower attach would land last and take the attachment.

## Size authority: last-attach-wins

**Why a held pane does not re-fit.** A one-time connection run end to end (standalone harness, phone page in Chrome, 2026-09) left the laptop pane at the phone's grid (53×28) in its top-left with the rest empty, unexplained, and still at that size after the phone left. A local refit that took the size back while the phone was attached would re-wrap every line on the phone, which is never told (`terminal.resize` is staged), so a held pane keeps the phone's grid and explains itself with the strip instead; focus and keystrokes are not taken as a request for the size for the same reason.

**Why Take back ends the session.** Chosen by the product owner (2026-09) over re-sizing the phone to the laptop's grid: the phone never resizes, so there is no protocol-v1 event and no phone-side strip, and the person at the laptop — who owns every terminal — gets their pane back in one click. A Pocket session ended this way is not an unpairing; the phone reconnects, without a prompt while the Burrow's presence window is open. With two viewers on a pane it ends both (product owner, 2026-09): Take back means the laptop has the size again, which no remaining viewer can share.

**Why a hold names its service instance.** A hold is released only by the session that took it, and a VS Code broker window that closes, or a sidecar that restarts, takes its sessions with it: no release ever arrives, and surviving webviews kept their strips — and their phone-sized panes — until someone clicked Take back (review, 2026-09). Only the instance that replaced it can say so, and saying "I am a different service" needs no list of what the old one held.

**Why a pane keeps a hold per holder.** With one hold per pane (review of the first cut, 2026-09), a second viewer's attach replaced the first's, so the second leaving re-fit the pane under the first phone still attached, and Take back ended only the second.

**Why each hold records its size.** With a hold per holder but no size (review, 2026-09), phone A attached at 51×14, phone B at 40×20, and B leaving left the pane at B's grid under a strip naming A — A's PTY running at a grid A never asked for until A resized. Nothing else carries A's size back: the phone is never told of a resize, and a local re-fit would re-wrap A's screen.

**Why a release names a lease as well as a holder.** A session's own attachments overlap: re-attaching the pane it already holds, or an attach superseded by one to the same pane, sends the earlier attachment's release after the later one took the hold. With the holder alone that release would free the newer hold and re-fit the pane under a phone still attached.

## Input authority and multiple viewers

**Why concurrent granted sessions need no arbitration.** Interleaved typing from two granted sessions is no worse than two keyboards plugged into one machine — and selfhost is single-user, so both keyboards belong to the same person.
