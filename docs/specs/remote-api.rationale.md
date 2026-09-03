# Remote Surface API — Rationale

> Informative companion to [remote-api.md](remote-api.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Remote Surface API

**Why "replicate state" is load-bearing rather than a preference.** Per-surface streams are what make VR viable — each surface arrives as its own independently placeable stream, so a headset can hang them in space — and they are what make the phone cheap: one attached surface, one stream. A single desktop stream would give neither, and every staged item below the fold inherits the constraint.

## The provider seam

**Why `ptyId` is opaque under VS Code.** Two duplicated windows can cold-restore panes holding the same PTY id. A handle that carried that id verbatim would let one window's attach be routed to the other's terminal, moving the stream and both input methods onto a PTY the Client never asked for; a per-peer handle makes the collision unreachable.

## Envelope

**Why the clamp's upper bound is the security-relevant half.** A local resize is derived from element geometry and cannot be large, but `terminal.resize` carries a peer-supplied number straight into `term.resize` in the webview that owns the pane, and xterm bounds only the minimum before allocating `rows × cols` cells. Unbounded, one frame asking for a million by a million wedges every terminal in that window, and it is reachable by any authorized Client (`SECURITY.md` → "Remote Control", Trust boundary). `MAX_TERMINAL_DIMENSION` is 2000 because that is far past any real display — a 4K screen at an unreadably small font is on the order of 800 columns — while capping the worst a peer can request at a few million cells.

## Directory (the phone's picker)

**Why snapshots rather than deltas.** A directory is dozens of entries at most, so resending the whole listing on each coalesced change costs less than the delta protocol would. Deltas are an optimization there is no current reason to pay for.

**Why a collect carries a generation.** Collects overlap whenever something changes during a slow provider round trip, and they can settle in either order. Without a per-collect generation a stale answer — including a collect that timed out to an empty list — lands on the client after a fresher snapshot and blanks the picker until the next change.

**Why duplicate `surfaceId`s collapse instead of both being listed.** Two cold-restored windows can hold panes with identical ids, and two identical rows would make a picker keyed by `surfaceId` a lottery over which window an attach actually reaches. Collapsing to the local-tier-first answerer makes the row shown the surface an attach lands on.

## Attach is the resize

**Why a resize is a whole screen.** `SIGWINCH` makes full-screen TUIs repaint completely and shells redraw their prompt line, so the client's first screen arrives from the live stream alone and no snapshot transfer is needed at all. The same-size case has to be forced because xterm treats a resize to the current size as a no-op: no `SIGWINCH` is sent, and the client would stare at an empty screen until the next output.

## Attachment invariants

**Why an in-flight resolution is invalidated rather than allowed to finish.** The two resolve paths are wildly different lengths: a sibling window's pane is a round trip away while a local one settles on the next microtask. With one shared epoch the older, slower attach would land last and take the attachment, which is exactly backwards from last-attach-wins.

## Input authority and multiple viewers

**Why concurrent granted sessions need no arbitration.** Interleaved typing from two granted sessions is no worse than two keyboards plugged into one machine — and selfhost is single-user, so both keyboards belong to the same person.
