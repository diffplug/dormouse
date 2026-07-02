# Remote Surface API

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

# Terminology

Reuses the existing surface model (`dor/src/protocol.ts`,
`dor/src/commands/types.ts`):

* **Surface** — the unit of content: `terminal`, `agent-browser`, or `iframe`.
  Identified by `surfaceId`; carries `ref`, `paneRef`, `title`, `focused`,
  `indexInPane`, `selectedInPane`.
* **Pane** — a tile on the wall holding one or more surfaces (one selected).
  The phone's picker lists panes; attaching to a pane means attaching to its
  selected surface.
* **Wall** — the full layout tree (workspaces → windows → panes) plus geometry.
  Only VR consumes this.
* **Viewer** — one connected Client session. Multiple viewers may coexist; the
  Host UI shows who is connected.

---

# Transport

## Channels

An authorized session (the output of `authorizeConnection`) is bound to:

1. **Control channel** — ordered, reliable, JSON messages. Carries requests,
   responses, and event subscriptions. WebSocket relayed by the Server, or a
   WebRTC data channel once rendezvous completes (the Server signals; per the
   security model it is never trusted with authorization).
2. **Media channels** — per-attached-surface streams. Terminal data rides the
   control channel (it is small and ordering matters). Browser screencasts
   prefer an unreliable/unordered channel (WebRTC data channel or video track)
   so a dropped frame is skipped, not queued behind.

Every channel carries the `sessionId` issued at connection time. Future
hardening (see the security model's PRF section): pin the WebRTC DTLS
fingerprint inside the device-key-signed connect payload so even the signaling
Server cannot man-in-the-middle the media path.

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
  /** What the client can render / wants to do. */
  capabilities: {
    screencast: ReadonlyArray<'jpeg' | 'webp'>;
    input: boolean;              // false = observe-only client
    wall: boolean;               // wants wall.watch (VR)
  };
}

// host → client
interface HostHello {
  protocolVersion: 1;
  hostId: string;
  /** What this session is allowed to do; see Input authority. */
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
  type: 'terminal' | 'agent-browser' | 'iframe';
  title: string;                // derived title, same one the wall header shows
  focused: boolean;             // focused on the host
  // Terminal-only, from the existing semantic-event model (terminal-state.ts):
  activity?: 'unknown' | 'prompt' | 'editing' | 'running' | 'finished';
  exitCode?: number;
  cwd?: string;
  // Browser-only:
  url?: string;
  /** The pane is ringing/alerting on the host (alert-manager). */
  attention: boolean;
}

// events on the subscription
type DirectoryEvent =
  | { event: 'directory.snapshot'; data: { entries: DirectoryEntry[] } }
  | { event: 'directory.upsert';   data: { entry: DirectoryEntry } }
  | { event: 'directory.remove';   data: { paneRef: string } };
```

Thumbnails are requested separately (`directory.thumbnail { paneRef }` →
single downscaled frame / terminal screen render) so the picker stays cheap on
cellular and thumbnails are fetched only for what is on screen.

---

# Attaching to a surface

`surface.attach { surfaceId }` opens the surface's stream;
`surface.detach { surfaceId }` closes it. The phone holds one attachment; VR
holds one per visible panel. Attachment is view-state only — it never changes
what runs on the Host.

## Terminal surfaces

Replicated, not screencast: the client renders its own xterm from the same
data the host UI consumes.

```ts
// host → client, once per attach
interface TerminalAttachSnapshot {
  cols: number; rows: number;
  /** Serialized screen + scrollback tail, ready to feed the renderer. */
  screenState: string;
  scrollbackLines: number;      // how much history the snapshot carries
}

// then a stream of:
type TerminalEvent =
  | { event: 'terminal.data';     data: { bytes: string /* base64 */ } }
  | { event: 'terminal.resize';   data: { cols: number; rows: number } }
  | { event: 'terminal.semantic'; data: TerminalSemanticEvent }  // cwd/activity/title, as today
  | { event: 'terminal.closed';   data: { exitCode?: number } };

// client → host (requires the input grant)
type TerminalInput =
  | { method: 'terminal.write';  params: { surfaceId: string; bytes: string } }
  | { method: 'terminal.resize'; params: { surfaceId: string; cols: number; rows: number } };
```

**Resize authority.** A terminal has one size; the Host owns it by default and
remote viewers reflow/scale to fit (the mobile UI already renders at foreign
sizes). A viewer with the input grant may request `terminal.resize`; the Host
applies it only when no local view is displaying the pane, or when the session
holds the wall lease (see VR below). This avoids two screens fighting over
`SIGWINCH`.

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
  | { method: 'browser.key';     params: { surfaceId: string; text?: string; key?: string; modifiers?: number } }
  | { method: 'browser.navigate'; params: { surfaceId: string; url: string } };
```

Quality adapts per attachment (`browser.quality { surfaceId, maxFps,
maxDimension, quality }`): the phone asks for less than a headset does, and a
background VR panel asks for less than the one being looked at.

## Iframe surfaces

Not streamable in v1 — the pane is a live DOM pointed at a Host-local URL.
Remote viewers get a placeholder card (title + URL) in the directory and wall.
Future: tunnel the existing iframe-proxy (`lib/src/host/iframe-proxy.ts`)
through the session so remote clients can load the same proxied URL; or fall
back to rendering the page in agent-browser and screencasting it.

---

# Input authority

Layered, consistent with "the Host is the final authority":

1. **Pairing-time**: the ACL record's approval can carry a standing grant
   (observe-only vs interactive) chosen in the Host's approval UI.
2. **Session-time**: `HostHello.grants` reports what this session actually
   got; a client that asked for input may still receive `input: false`.
3. **Always**: the Host UI shows connected viewers and can revoke a grant or
   kill the session live; in-flight input is dropped the moment it does.

Destructive layout operations (`surface.kill`) additionally require the
`layout` grant and are confirmed on the Host the same way local kills are
(KillConfirm), unless the Host user has opted that session into unattended
control.

---

# The wall (VR)

VR does not stream the desktop; it *is* the desktop. The headset runs the same
web UI (`lib`) against remote data sources instead of local ones.

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

A VR session may request `wall.lease`. Holding the lease means the headset is
the primary display: it wins resize authority for the terminals it displays,
and the Host UI may dim to a "being driven remotely" state. One lease at a
time; the Host user can always reclaim it locally. Phones never need it.

---

# Multi-viewer semantics

* Any number of observe-only viewers; streams fan out per attachment.
* Input is not locked to one viewer — grants are per-session, and interleaved
  typing is no worse than two keyboards on one machine. The wall lease is the
  only exclusive resource (sizing/primary-display).
* Every viewer is visible on the Host (label from the ACL record, e.g.
  `iPhone Safari`), with per-viewer disconnect.

---

# QoS notes (phone-first)

* Terminal output is already coalesced host-side; the remote stream reuses
  that batching and adds a per-session byte budget with tail-drop + resync
  (send a fresh `TerminalAttachSnapshot`) rather than unbounded buffering on a
  bad link.
* Screencast frames are droppable by design; only the newest frame matters.
* The directory is metadata-only; thumbnails are pull, not push.
* Detach on backgrounding: when the phone app/PWA loses visibility, the client
  detaches streams but keeps the control channel; reattach is one message.

---

# Open questions

* **Transport v1**: start WebSocket-relay-only (simplest, works everywhere,
  Server sees only ciphertext if we add app-layer encryption) and add WebRTC
  later, or bite off WebRTC rendezvous immediately for latency?
* **Terminal snapshot format**: serialize the emulator state (fast attach,
  version-coupled) vs replay a scrollback tail of raw PTY bytes (simple,
  renderer-agnostic, slower for huge scrollback)?
* **Browser media**: screencast frames over a data channel are simple and
  match agent-browser today; a WebRTC video track would be smoother for VR.
  Possibly phone=frames, VR=track, negotiated in the hello.
* **Iframe surfaces**: how much of the iframe-proxy is safe to expose through
  the tunnel (it can reach Host-local services)? May need its own grant.
* **Audio**: browser surfaces can produce audio; VR will want it (spatial,
  per-panel). Out of scope for v1.
