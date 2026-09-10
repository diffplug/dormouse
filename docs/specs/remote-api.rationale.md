# Remote Surface API — Rationale

> Informative companion to [remote-api.md](remote-api.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Remote Surface API

**Why "replicate state" is load-bearing rather than a preference.** Per-surface streams are what make VR viable — a headset can hang each one in space — and what make the phone cheap: one attached surface, one stream. A single desktop stream would give neither.

## The provider seam

**Why `ptyId` is opaque under VS Code.** Two duplicated windows can cold-restore panes holding the same PTY id. A handle that carried that id verbatim would let one window's attach be routed to the other's terminal, moving the stream and both input methods onto a PTY the Client never asked for.

In September 2026, both production installations use `createAskSurfaceProvider`: resolution selects a routing key and applies the requested size, while `streamPty` separately owns the subscription. The former `SurfaceHandle.release` was a no-op in that shared constructor; a test-only release counter suggested a second resource lifetime that neither host had.

## Direct path

**Why host candidates alone reach.** The shipped deployment is a tailnet: the Burrow's tailnet address is a host candidate the phone can route to, and the phone's own mDNS-obfuscated candidate is learned peer-reflexively from the first packet. A STUN server would buy a public reflexive candidate the deployment does not need, at the price of telling a third party both addresses.

**What a browser and the addon actually negotiate.** `scripts/direct-interop/run.mjs` is the only fixture that puts the two shipped stacks on one channel — the in-process suites link two fakes or run the addon against itself, and no CI job has a browser. Run on macOS 26.0 with Chromium and node-datachannel 0.33.2 (libdatachannel 0.24.3), 2026-09-10: the browser's whole offer was 587 characters against `MAX_DIRECT_SDP_LENGTH`'s 2 000, one host candidate on a machine with one usable interface; the association reported `maxMessageSize` 262 144 at both ends; and 65 535-, 4 096-, and 33-byte frames crossed browser→addon→browser byte for byte and in order.

**Why the SDP bound is measured rather than reasoned about.** 587 characters is 29% of the budget on a host with one interface, and each further candidate line costs roughly 80 more — so the headroom is real but it is a property of the machine, not of the code. A host with docker bridges, VMs, and several VPNs is the case that would spend it, and the failure there is silent by design: the attempt is skipped and the session stays relayed. Re-run the fixture on such a host before treating the bound as settled.

**Why DTLS is not part of the trust model.** The channel is encrypted twice — DTLS underneath, Noise inside — and only the inner one is load-bearing. The DTLS fingerprints are authentic because the SDP carrying them was decrypted inside an authorized session, so DTLS adds transport hygiene rather than a second authority; a peer that broke it would still face the promoted session's ciphers.

## Envelope

**Why the clamp's upper bound is the security-relevant half.** A local resize is derived from element geometry and cannot be large, but `terminal.resize` carries a peer-supplied number straight into `term.resize` in the webview that owns the pane, and xterm bounds only the minimum before allocating `rows × cols` cells. Unbounded, one frame asking for a million by a million wedges every terminal in that window, reachable by any authorized Client (`docs/specs/security-remote.md` → "Trust boundary"). `MAX_TERMINAL_DIMENSION` is 2000 — far past any real display, since a 4K screen at an unreadably small font is on the order of 800 columns — while capping the worst a peer can request at a few million cells.

## Directory (the phone's picker)

**Why snapshots rather than deltas.** A directory is dozens of entries at most, so resending the whole listing on each coalesced change costs less than the delta protocol would.

**Why a collect carries a generation.** Collects overlap whenever something changes during a slow provider round trip, and they can settle in either order — so without one the stale answer lands last and blanks the picker until the next change.

**Why duplicate `surfaceId`s collapse instead of both being listed.** The same cold-restore id collision as §The provider seam, one level up: two identical rows would make a picker keyed by `surfaceId` a lottery over which window an attach actually reaches.

## Terminal surfaces

**Why the owner's xterm answers and a mirror does not.** The answers are renderer-dependent: cell size, window pixel geometry, and XTSMGRAPHICS canvas limits are all properties of the renderer that produces them, and DA1 advertises what that renderer's addons can decode. The Burrow cannot answer them itself — a headless xterm in Node cannot host ImageAddon, which decodes images through the browser's own image pipeline — so the answer has to come from a renderer, and attach-is-the-resize keeps the owner's xterm a faithful model at the viewer's size, which makes it the right one. Letting both answer writes the reply twice into the PTY's input, and each further viewer adds another copy.

**Why the pair travels rather than being re-derived on the Client.** The Burrow has already computed it — the parser produces both projections from one pass — so sending it costs nothing on an ordinary chunk, where the two are identical and `text` is omitted. Re-deriving it on the Client would mean a second string-control state machine, whose framing has to stay identical to the Burrow's forever, and one that begins mid-sequence for a stream that starts inside a multi-megabyte image. Making omission mean "equal" rather than "absent" is what lets the fallback `textData ?? data` stay correct: a producer that simply forgot to project would otherwise be indistinguishable from one saying the two agree.

**Why this surfaced with inline images.** Duplicate replies were always possible — xterm core answers DA1, DA2, DSR/CPR, and XTVERSION — but a program asks those once at startup, before a phone is usually attached. ImageAddon's kitty handler replies `APC G i=<n>;OK ST` on *every* transmit unless the sender passes `q>=1`, so with a phone attached each image displayed on the laptop echoed a second `OK` into the shell's input a relay latency later, as visible junk on the prompt line.

## Attach is the resize

In September 2026, the Viewer-local 60ms restoration timer could overwrite a later local or other-Viewer resize, because neither writer touched the first Viewer's timer. Cancelling it on detach also stranded the PTY one row below its xterm. Moving restoration to the shared PTY owner makes all size writers cancel it and lets a detached Viewer's temporary resize complete.

**Why a resize is a whole screen.** `SIGWINCH` makes full-screen TUIs repaint completely and shells redraw their prompt line, so the client's first screen arrives from the live stream alone and no snapshot transfer is needed. The same-size case has to be forced because xterm sends no `SIGWINCH` for a resize to the current size, leaving the client staring at an empty screen until the next output.

## Attachment invariants

**Why an in-flight resolution is invalidated rather than allowed to finish.** The two resolve paths differ by orders of magnitude: a sibling window's pane is a round trip away, a local one settles on the next microtask. With one shared epoch the older, slower attach would land last and take the attachment.

## Input authority and multiple viewers

**Why concurrent granted sessions need no arbitration.** Interleaved typing from two granted sessions is no worse than two keyboards plugged into one machine — and selfhost is single-user, so both keyboards belong to the same person.
