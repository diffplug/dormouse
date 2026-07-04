# Remote Surface API

> See `docs/specs/glossary.md` for the canonical Pane / Surface / Session model; this spec uses that vocabulary and adds only remote-specific terms (Viewer, and the wire-level `DirectoryEntry` projection of a pane).

This spec sketches the API a Client uses to view and control a Host's surfaces
after a session has been authorized by the
[remote security model](./remote-security-model.md). Nothing here weakens that
model: every message below travels inside one authorized session, and the Host
can terminate the session (and every stream in it) at any time.

Two consumers, one protocol:

* **Phone (Dormouse Pocket)** — the user sees a directory of the Host's active
  panes (terminal and browser), picks one, and views/controls just that one.
* **VR headset** — the client runs the entire Dormouse UI remotely: the full
  wall layout, every surface live at once, each rendered as its own panel in
  space.

The phone is not a different API — it is a shallow consumer of the same one.

| Capability            | Phone            | VR               |
| --------------------- | ---------------- | ---------------- |
| `directory.watch`     | yes (the picker) | optional         |
| `surface.attach`      | one at a time    | many at once     |
| `wall.watch` (layout) | no               | yes              |
| Layout mutations      | no               | yes              |
| Input                 | to attached pane | to any surface   |

Design principle: **replicate state, don't stream a desktop.** Terminals are
sent as PTY data and rendered client-side (the Client already ships the
terminal renderer); browser surfaces are sent as per-surface screencasts. This
is what makes VR viable — each surface arrives as its own independently
placeable, independently sized stream — and it makes the phone cheap: one
attached surface costs one stream.

---

# v1 scope

v1 is the smallest protocol that lets a phone **sign in, pick a pane, see it
live, and type into it** — the phone column of the table above, and only it:

* Hello (version + capabilities)
* `directory.watch`, snapshot-only (no deltas, no thumbnails)
* `surface.attach` / `surface.detach`, one attachment per session
* Terminal: attach-is-the-resize, live data + semantic events,
  `terminal.write`/`terminal.resize`, last-attach-wins tethering
* Browser: screencast frames at Host-chosen fixed quality, pointer + key input
* One implicit grant: every paired session has full input (selfhost is
  single-user), no layout operations

Everything else is future work, staged in likely order of arrival:

1. **In-flight command replay** — first follow-up after v1 (see Terminal)
2. **Semantic command scrollback** — v2 (see Terminal)
3. **Directory thumbnails**
4. **Graded grants + layout mutations** (observe-only viewers, remote
   split/kill with Host-side confirm)
5. **The wall: VR** (`wall.watch`, multi-attach, wall lease)
6. **WebRTC transport + app-layer encryption**
7. **Audio**

Each future item is additive — a new method, event, or optional field — so
nothing in the v1 protocol changes shape when it lands.

---

# Terminology

`docs/specs/glossary.md` is canonical for **Pane** and **Surface**; the wire
shapes reuse the existing surface model (`dor/src/protocol.ts`,
`dor/src/commands/types.ts`). Remote-specific usage:

* **Surface** — identified on the wire by `surfaceId`; carries `ref`,
  `paneRef`, `title`, `focused`, `indexInPane`, `selectedInPane`.
* **Pane** — the phone's picker lists panes; attaching to a pane means
  attaching to its selected surface.
* **Wall** — the full layout tree (workspaces → windows → panes) plus geometry.
  Only VR consumes this.
* **Viewer** — one connected Client session. Multiple viewers may coexist; the
  Host UI shows who is connected.

---

# Transport

## Channels

v1 transport is **WebSocket relay only**: one WebSocket per session, relayed
through the Server, bound to the `sessionId` issued by `authorizeConnection`.
Control messages and media frames share the socket:

* **Control** — requests, responses, and event subscriptions. Terminal data
  rides here too (it is small and ordering matters).
* **Media** — browser screencast frames. A dropped frame must be skipped, not
  queued behind: the Host keeps at most the newest frame per attachment and
  sends it only when the socket drains, so a slow link degrades to a lower
  frame rate instead of growing a buffer.

Future upgrades, none of which change the API surface: WebRTC rendezvous for
latency (the Server signals but, per the security model, is never trusted with
authorization — pin the DTLS fingerprint inside the device-key-signed connect
payload), and app-layer encryption so the relaying Server sees only
ciphertext.

## Server deployment modes

The Server always ships in two modes; the remote API and the security model
are identical in both — the modes differ only in how accounts come to exist.

* **Selfhost** — an env-var sets a setup password; presenting it allows the
  system's only user to create their account and register the first passkey.
  Sign-in from then on is passkey-only. No database: accounts, passkey
  credentials, and revocation state live in local files.
* **SaaS multitenant** — anyone can create an account with email + passkey.

v1 ships selfhost only. Selfhost is not a stepping stone: it remains a
supported mode alongside SaaS permanently.

## Envelope

Same shape as the dor control protocol — requests correlated by `requestId`,
events correlated by `subId`:

```ts
interface RemoteRequest  { requestId: string; method: string; params?: object }
interface RemoteResponse { requestId: string; ok: boolean; result?: object; error?: string }
interface RemoteEvent    { subId: string; event: string; data: object }
```

## Hello

First exchange on the control channel; establishes version and capabilities so
the protocol can grow without breaking older Pockets.

```ts
// client → host
interface ClientHello {
  protocolVersion: 1;
  viewer: 'phone' | 'vr' | 'desktop';
  /** What the client can render / wants to do. v1 phones send
   *  { screencast: ['jpeg'], input: true, wall: false }. */
  capabilities: {
    screencast: ReadonlyArray<'jpeg' | 'webp'>;
    input: boolean;
    wall: boolean;
  };
}

// host → client
interface HostHello {
  protocolVersion: 1;
  hostId: string;
  /** v1: always { input: true, layout: false } — selfhost is single-user, so
   *  every paired session is the owner. Graded grants are future work. */
  grants: { input: boolean; layout: boolean };
}
```

---

# Directory (the phone's picker)

`directory.watch` subscribes to a live, lightweight listing of every pane —
enough to render the picker and know which pane wants attention, without
attaching to anything.

```ts
interface DirectoryEntry {
  paneRef: string;
  surfaceId: string;            // the selected surface in the pane
  type: 'terminal' | 'agent-browser';  // iframe surfaces are not listed (unsupported)
  title: string;                // derived title, same one the wall header shows
  focused: boolean;             // focused on the host
  // Terminal-only, from the existing semantic-event model (terminal-state.ts):
  activity?: 'unknown' | 'prompt' | 'editing' | 'running' | 'finished';
  exitCode?: number;
  cwd?: string;
  // Browser-only:
  url?: string;
  /** The pane's alert is ringing on the host (alert-manager). */
  ringing: boolean;
  /** The pane has an outstanding TODO waiting for the user. */
  hasTODO: boolean;
}

type DirectoryEvent =
  | { event: 'directory.snapshot'; data: { entries: DirectoryEntry[] } };
```

Snapshot-only, deliberately: a directory is dozens of entries at most, so on
any change the Host coalesces and resends the whole thing. Delta events are a
future optimization there is no current reason to pay for.

Thumbnails are future work; in v1 the picker renders from titles, activity,
and the `ringing`/`hasTODO` badges.

Terminal directory `exitCode` is the last finished command's semantic status,
not PTY lifetime. A listed terminal is still a live Host registry surface until
its attachment emits `terminal.closed`.

---

# Attaching to a surface

`surface.attach { surfaceId, ... }` opens the surface's stream (terminals add
their dimensions — see below); `surface.detach { surfaceId }` closes it. v1
allows one attachment per session (the phone's model); lifting that cap for VR
is future work. Attachment is view-state only with one deliberate exception:
attaching to a terminal takes size authority.

## Terminal surfaces

Replicated, not screencast: the client renders its own xterm from the same
data the host UI consumes.

### Attach is the resize (v1)

The remote is virtually always a different size than the Host, and a resize is
exactly what makes a terminal paint itself — so attach carries the client's
dimensions and there is no snapshot transfer:

1. Client attaches with `{ cols, rows }`.
2. Host resizes the PTY (last-attach-wins; see Size authority). `SIGWINCH`
   makes full-screen TUIs repaint completely and shells redraw their prompt
   line, filling the client's screen from the live stream alone.
3. If the requested size happens to equal the current size, the Host forces
   the repaint anyway: `SIGWINCH` alone first (most TUIs refetch size and
   repaint), then a quick rows±1 bounce if no output follows.

Normal-screen history does not regenerate on resize; it is deliberately absent
from v1 (see Future work below).

```ts
// client → host
{ method: 'surface.attach', params: { surfaceId: string, cols: number, rows: number } }

// host → client, the attach result
interface TerminalAttachResult {
  cols: number; rows: number;     // the size the PTY now has
  // Reserved: `inflight` (in-flight replay) and `blocks` (semantic
  // scrollback) land here additively — see Future work.
}

// then a stream of:
type TerminalEvent =
  | { event: 'terminal.data';     data: { bytes: string /* base64 */ } }
  | { event: 'terminal.resize';   data: { cols: number; rows: number } }   // another display took authority
  | { event: 'terminal.semantic'; data: TerminalSemanticEvent }  // cwd/activity/title, as today
  | { event: 'terminal.closed';   data: { exitCode?: number } };

// client → host (requires the input grant)
type TerminalInput =
  | { method: 'terminal.write';  params: { surfaceId: string; bytes: string } }
  | { method: 'terminal.resize'; params: { surfaceId: string; cols: number; rows: number } };
```

`terminal.write` and `terminal.resize` are valid only for the session's current
attachment. A stale request for a detached surface, or a request for a
background surface listed in the directory but not attached by this session, is
rejected and must not reach the PTY or change its size.

### Size authority: last-attach-wins

A terminal has one size, and the most recent size writer owns it: attaching
with dimensions and `terminal.resize` both take authority, and the Host user
interacting with the pane locally reclaims it. Every other display of that
pane — the Host's wall pane, other attached viewers — greys out and shows only
**"tethering to \<device\>"** (the ACL record's label, e.g. `iPhone Safari`)
instead of fighting over `SIGWINCH`. Interacting with a tethered pane is how a
display takes it back.

### Future work: in-flight replay, then semantic scrollback

**In-flight replay (first follow-up after v1).** The most common reason to
open a pane on the phone is a command that is still running — "is my build
done?" — and a resize repaint shows nothing for a command quietly writing a
log. (Dormouse's primary workload, agent TUIs, do repaint on resize — which is
what makes this deferrable at all.) The Host retains the output of the current
command from its `commandStart` boundary (OSC 133/633, with the existing
keystroke-heuristic fallback), tail-capped to a fixed byte budget, dropped at
the next prompt; attach replays it via the reserved `inflight` field:

```ts
inflight?: {
  commandLine: string | null;
  startedAt: number;
  bytes: string;                // base64, tail-capped
  truncated: boolean;
}
```

**Semantic command scrollback (v2).** History arrives as structure the Host
already extracts, not as emulator state: OSC 133/633 segmentation gives
per-command boundaries, alt-screen spans are already tracked and stripped, and
the in-flight buffer is the same capture mechanism retained for K commands
instead of one:

```ts
interface CommandBlock {
  commandLine: string | null;
  cwd: string | null;
  exitCode: number | null;      // null while still running
  startedAt: number;
  finishedAt: number | null;
  bytes: string;                // output, tail-capped, alt-screen spans stripped
  truncated: boolean;
}
```

Attach then also delivers recent blocks, and the client renders them at its
own width — collapsible cards on the phone, panels in VR — rather than
replaying a fixed-width terminal. Additive by construction: a `blocks` field
on `TerminalAttachResult` plus a `terminal.block` event.

## Browser surfaces (`agent-browser`)

The existing screencast path, made remote:

```ts
type BrowserEvent =
  | { event: 'browser.frame'; data: { format: 'jpeg' | 'webp'; width: number; height: number; bytes: string } }
  | { event: 'browser.tab';   data: AgentBrowserTab }   // title/url/active changes
  | { event: 'browser.closed'; data: {} };

// client → host (requires the input grant); coordinates in frame space,
// the host maps them through the screencast scale into CDP input.
type BrowserInput =
  | { method: 'browser.pointer'; params: { surfaceId: string; kind: 'tap' | 'down' | 'move' | 'up' | 'scroll'; x: number; y: number; dx?: number; dy?: number } }
  | { method: 'browser.key';     params: { surfaceId: string; text?: string; key?: string; modifiers?: number } };
```

In v1 the Host picks fixed, phone-appropriate screencast parameters (JPEG,
capped dimension and frame rate). Per-attachment quality negotiation
(`browser.quality`) and remote navigation (`browser.navigate`) are future
work — a phone can drive the page's own UI in the meantime.

## Iframe surfaces

Not supported. Iframe surfaces are omitted from the directory and refuse
attachment; wall snapshots still list them (the layout must be truthful) and
VR renders an inert placeholder. Nothing else in the protocol assumes they
exist, so support can be added cleanly later — it is not on the critical path.

---

# Input authority

v1 is deliberately flat: selfhost is single-user, so every paired session is
the owner and gets full input (`grants: { input: true, layout: false }`). No
session gets layout operations. The Host UI still shows connected viewers and
can kill any session live; in-flight input is dropped the moment it does.

Future work — graded grants, layered so "the Host is the final authority"
holds at every step:

1. **Pairing-time**: the ACL record's approval carries a standing grant
   (observe-only vs interactive) chosen in the Host's approval UI.
2. **Session-time**: `HostHello.grants` reports what the session actually got.
3. **Layout**: destructive operations (`surface.kill`) require the `layout`
   grant and are confirmed on the Host the same way local kills are
   (KillConfirm), unless the Host user opts a session into unattended control.

---

# The wall (VR) — future work

Nothing in this section is v1. VR does not stream the desktop; it *is* the
desktop: the headset runs the same web UI (`lib`) against remote data sources
instead of local ones.

## Layout replication

`wall.watch` subscribes to the layout tree plus geometry:

```ts
interface WallSnapshot {
  workspaces: Array<{
    ref: string; name: string;
    windows: Array<{
      ref: string;
      panes: Array<{
        paneRef: string;
        /** Normalized rect within the window, for initial spatial placement. */
        rect: { x: number; y: number; w: number; h: number };
        surfaces: Surface[];      // the existing Surface shape
      }>;
    }>;
  }>;
  focusedSurfaceId: string | null;
}

type WallEvent =
  | { event: 'wall.snapshot'; data: WallSnapshot }
  | { event: 'wall.changed';  data: WallSnapshot };  // coalesced; layouts are small
```

The rects seed VR placement; after that the headset owns spatial arrangement
locally (a VR user re-hanging panels in space is presentation, not layout, and
does not round-trip to the Host).

## Layout mutations

The existing `surface.*` control vocabulary, carried over the session
(requires the `layout` grant):

```
surface.split    surface.ensure    surface.send
surface.kill     surface.read      surface.focus
```

These are the same methods the dor CLI speaks today; the remote API reuses
their request/response shapes so the Host dispatches both through one handler.

## Wall lease

A VR session may request `wall.lease`, declaring itself the primary display.
Sizing needs no lease — last-attach-wins already hands VR the panes it
displays — so the lease is presentational: the Host UI tethers wholesale
("tethering to \<device\>") instead of pane by pane, and panes created on the
Host while the lease is held open tethered to the leaseholder. One lease at a
time; the Host user can always reclaim it locally. Phones never need it.

---

# Multi-viewer semantics

Concurrent sessions need no special machinery in v1: attach state is
per-session, streams fan out per attachment, and terminal size is
last-attach-wins with the tether display resolving contention. Every viewer is
visible on the Host (label from the ACL record, e.g. `iPhone Safari`), with
per-viewer disconnect. Interleaved typing from two granted sessions is no
worse than two keyboards on one machine; the wall lease (future) is the only
exclusive resource.

---

# QoS notes (phone-first)

* Terminal output is already coalesced host-side; the remote stream reuses
  that batching and adds a per-session byte budget with tail-drop + resync
  (an implicit re-attach: repaint via resize) rather than unbounded buffering
  on a bad link.
* Screencast frames are droppable by design; only the newest frame matters.
* The directory is metadata-only.
* Detach on backgrounding: when the phone app/PWA loses visibility, the client
  detaches streams but keeps the control channel; reattach is one message.

---

# Open questions

* **Browser media**: screencast frames over the WebSocket are v1; when WebRTC
  arrives, a video track would be smoother for VR. Possibly phone=frames,
  VR=track, negotiated in the hello.
* **Audio**: browser surfaces can produce audio; VR will want it (spatial,
  per-panel). Out of scope for v1.
