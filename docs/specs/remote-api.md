# Remote Surface API

> See `docs/specs/glossary.md` for the canonical Pane / Surface / Session model; this spec uses that vocabulary and adds only remote-specific terms (Viewer, and the wire-level `DirectoryEntry` projection of a pane).

The API a Client uses to view and control a Host's surfaces after a session has
been authorized by the [remote security model](./remote-security-model.md).
Nothing here weakens that model: every message below travels inside one
authorized session, and the Host can terminate the session (and every stream in
it) at any time.

The protocol is designed for two consumers at different consumption depths —
one protocol, not two:

* **Phone (Dormouse Pocket)** — the user sees a directory of the Host's active
  panes, picks one, and views/controls just that one. Shipped.
* **VR headset** — the client runs the entire Dormouse UI remotely: the Host's
  whole Window — every Workspace's layout, every surface live at once. Future —
  see [Future](#future).

| Capability              | Phone            | VR (future)      |
| ----------------------- | ---------------- | ---------------- |
| `directory.watch`       | yes (the picker) | optional         |
| `surface.attach`        | one at a time    | many at once     |
| `window.watch` (layout) | no               | yes              |
| Layout mutations        | no               | yes              |
| Input                   | to attached pane | to any surface   |

**Replicate state, don't stream a desktop** — the design principle, and a
standing constraint on everything staged below. Terminals are sent as PTY data
and rendered client-side; browser surfaces will be sent as per-surface
screencasts. This is what makes VR viable — each surface arrives as its own
independently placeable stream — and it makes the phone cheap: one attached
surface, one stream.

## v1 scope

**Scope: protocol-v1** — the smallest protocol that lets a phone **sign in,
pick a pane, see it live, and type into it**. This is the shipped protocol;
source of truth is `server-lib-common/src/remote/wire.ts` (the fixed wire
contract) and `lib/src/remote/host/remote-api.ts` (the Host implementation):

* Hello (version + viewer kind)
* `directory.watch`, snapshot-only (no deltas, no thumbnails), terminal
  entries only
* `surface.attach` / `surface.detach`, one attachment per session
* Terminal: attach-is-the-resize, live data,
  `terminal.write`/`terminal.resize`, last-attach-wins size authority
* One implicit grant: every paired session has full input (selfhost is
  single-user), no layout operations

Everything else — including browser-surface remoting — is staged in
[Future](#future).

### The provider seam

**The Host runs in the process that owns the PTYs, never a webview**
(`docs/specs/server.md` → "Host side"). Within it, `RemoteApiSession` speaks this
protocol and nothing else: surface ids, PTY ids, sizes, and bytes. *Where* a
named surface lives — this window's webviews, another window's, another
process's — is a deployment fact rather than a protocol concept, so every
environment-specific answer sits behind `HostSurfaceProvider`
(`lib/src/remote/host/host-surface-provider.ts`): `collectDirectory` /
`watchDirectory`, `resolveSurface` returning a `SurfaceHandle`, and `writePty` /
`resizePty` / `streamPty`. The session therefore imports no platform adapter, no
store, and no `document`, and both installations share the ask-backed half
(`lib/src/host/remote/ask-surface-provider.ts`) so an attach cannot be answered
differently in one host than the other.

`SurfaceHandle.ptyId` is a provider-local routing key, not necessarily the PTY
process's own id: the VS Code provider mints an opaque per-peer handle so a
cold-restored id collision between duplicated windows cannot move an
attachment's stream or input to another window.

## Terminology

The wire shapes reuse the existing surface model (`dor/src/protocol.ts`,
`dor/src/commands/types.ts`): a Surface is named on the wire by `surfaceId`, and
the picker lists Panes, so attaching to a Pane means attaching to its selected
Surface. Remote-only vocabulary:

* **Viewer** — one connected Client session. Multiple viewers may coexist.
* **Window** — the Host's full layout tree plus geometry, consumed only by VR
  ([Future](#future)). The glossary reserves **Wall** for the renderer of a
  single Workspace, so the VR subscription replicates the *Window*.

## Transport

**WebSocket relay only** (`docs/specs/server.md` → "Relay"): the Client holds one
WebSocket to the Server for the whole session; the Host multiplexes every session
over its single relay socket, keyed by the relay-assigned `clientId` (the Client
never sees or sends it). Control messages and terminal data both ride it as JSON
— terminal data is small and ordering matters. Media channels arrive with browser
surfaces (future). The API and the security model are identical in the Server's
selfhost and (future) SaaS modes; only how accounts come to exist differs.

A `RemoteApiSession` is created lazily on the first message after an allowed
`connect2` decision, and disposed both when the Client disconnects and on any
fresh authorization attempt — so a re-authorizing client can never inherit the
previous session's attachment. Source of truth: `RemoteHost` in
`lib/src/remote/host/remote-host.ts`.

### Envelope

Same shape as the dor control protocol — requests correlated by `requestId`,
events by `subId`:

```ts
interface RemoteRequest  { requestId: string; method: string; params?: unknown }
interface RemoteResponse { requestId: string; ok: boolean; result?: unknown; error?: string }
interface RemoteEventMsg { subId: string; event: string; data: unknown }
```

A subscribing method (`directory.watch`, `surface.attach`) opens its stream under
the *request's own id* — the Host reuses `requestId` as the `subId` — so the
Client can install its event handler before sending and never race a snapshot or
a first data frame. The six methods and three events are named constants
(`REMOTE_METHODS`, `REMOTE_EVENTS`); events are dispatched by name, so a future
event lands additively and an old client ignores what it does not know.

**Every peer-supplied `cols`/`rows` passes through `clampTerminalDimension`** —
1 … `MAX_TERMINAL_DIMENSION` (2000), falling back to the current size when absent
or non-finite — on the Host, in the webview responder that drives the real xterm,
and in the Client adapter. The upper bound is the security-relevant half: a local
resize comes from element geometry and cannot be large, but `terminal.resize`
carries a peer-supplied number straight into `term.resize`, which bounds only the
minimum before allocating `rows × cols` cells.

### Hello

First exchange on the control channel; establishes version and viewer kind so
the protocol can grow without breaking older Pockets. The Host does not *gate*
other methods on it — authorization already happened at connect time, so
skipping hello grants nothing.

```ts
// client → host
interface HelloParams {
  protocolVersion: 1;
  viewer: 'phone' | 'vr' | 'desktop';
}

// host → client
interface HelloResult {
  protocolVersion: 1;
  hostId: string;
  /** Always { input: true, layout: false } today — selfhost is single-user, so
   *  every paired session is the owner. Graded grants are future work. */
  grants: { input: boolean; layout: boolean };
}
```

Reserved: a `capabilities` field on the client hello (what the client can
render — screencast formats, window support) lands additively when browser
surfaces arrive; see [Future](#future).

## Directory (the phone's picker)

`directory.watch` subscribes to a live, lightweight listing of every pane —
enough to render the picker and know which pane wants attention, without
attaching to anything.

```ts
/** Terminal-only today: no browser entries. */
interface DirectoryEntry {
  paneRef: string;
  surfaceId: string;            // the selected surface in the pane
  type: 'terminal';
  title: string;                // derived title, same one the Wall's pane header shows
  focused: boolean;             // focused on the host
  // From the existing semantic-event model (docs/specs/terminal-state.md):
  activity?: 'unknown' | 'prompt' | 'editing' | 'running' | 'finished';
  exitCode?: number;
  alive: boolean;               // the PTY process is still alive (see below)
  cwd?: string;
  /** The pane's alert is ringing on the host (alert-manager). */
  ringing: boolean;
  /** The pane has an outstanding TODO waiting for the user. */
  hasTODO: boolean;
}

type DirectoryEvent =
  | { event: 'directory.snapshot'; data: { entries: DirectoryEntry[] } };
```

Snapshot-only: a directory is dozens of entries at most, so on any change the
Host coalesces (150ms window, `DIRECTORY_DEBOUNCE_MS`) and resends the whole
thing. Delta events are a future optimization there is no current reason to
pay for.

**One snapshot per collect.** The provider answers for every surface the Host can
reach, so no subset is known sooner than the rest. A collect is dropped rather
than sent if its subscription was replaced or torn down, or if it is no longer
the newest: collects overlap whenever something changes during a slow round trip
and can settle in either order, so a per-collect generation (the same shape as
the per-attach one) keeps a stale answer — including one that timed out to an
empty list — from blanking the picker until the next change. A collection that
rejects emits nothing, leaves the last good snapshot standing, and is contained
inside the session; the next invalidation or `directory.watch` retries it.

**Duplicate `surfaceId`s collapse to the first answerer.** Two cold-restored
windows can hold panes with identical ids, and two identical rows would make a
picker keyed by `surfaceId` a lottery over which window an attach reaches;
answerers arrive local-tier-first, the same owner an attach's read-only resolve
probe selects, so the row shown is the surface attached.

Invalidation reaches the session through `watchDirectory`: webviews announce that
their pane state, activity, or focus changed, and membership changes (a webview
attaching or disposing, a peer window joining or dropping) invalidate
unconditionally. Both feed the same coalescer, which re-collects from every
answerer before sending the replacement snapshot.

The picker renders from titles, activity, and the `ringing`/`hasTODO` badges;
thumbnails are staged. **Browser and iframe surfaces are neither listed nor
attachable** — they never enter the xterm registry the directory is collected
from, so `surface.attach` cannot resolve them either (see [Future](#future) for
browser remoting; iframe surfaces are not on the critical path even there).

`alive` is real PTY-process liveness. Dormouse keeps an exited pane open in the
Host registry (rendering "[Process exited with code N]") until the user closes
it, so such a surface is still *listed* but reports `alive: false` — the phone's
picker uses this to stop offering a dead pane as attachable (attaching would
transfer nothing). Distinct from `exitCode`, which is the last finished command's
shell-integration status, not process lifetime: a pane can report `alive: true`
with an `exitCode` set (a command finished, the shell lives on), and one
reporting `alive: false` may carry no `exitCode` at all.

## Attaching to a surface

`surface.attach { surfaceId, cols, rows }` opens the surface's stream;
`surface.detach { surfaceId }` closes it. Detach names its surface so a stale
detach cannot kill a newer attachment; detaching anything that is not the
current attachment is an idempotent no-op. One attachment per session (the
phone's model); lifting that cap for VR is future work. Attachment is
view-state only with one exception: attaching to a terminal takes size
authority.

### Terminal surfaces

Replicated, not screencast: the client renders its own xterm from the same data
the host UI consumes. That means the *processed* stream — protocol sequences
already parsed and stripped, with every generated response discarded, so the
phone never answers a query the laptop's own xterm already answered
([terminal-escapes.md](./terminal-escapes.md)).

#### Attach is the resize

The remote is virtually always a different size than the Host, and a resize is
exactly what makes a terminal paint itself — so attach carries the client's
dimensions and there is no snapshot transfer:

1. Client attaches with `{ cols, rows }`.
2. Host resizes through the owning xterm's resize path (last-attach-wins). The
   resulting `SIGWINCH` makes full-screen TUIs repaint completely and shells
   redraw their prompt line, filling the client's screen from the live stream
   alone.
3. If the requested size equals the current size, that resize would be a no-op,
   so the Host bounces rows on the **PTY only** — leaving the already-correct
   owning xterm untouched — and restores them `FORCE_REPAINT_BOUNCE_MS` later.
   The bounce goes down, except from a 1-row surface, where `rows - 1` would
   itself be a no-op that fires no `SIGWINCH`.

Normal-screen history does not regenerate on resize, and is absent from the
shipped protocol (see [Future](#future): in-flight replay, then semantic
scrollback).

```ts
// client → host
{ method: 'surface.attach', params: { surfaceId: string, cols: number, rows: number } }

// host → client, the attach result
interface TerminalAttachResult {
  cols: number; rows: number;     // the size the PTY now has
  // Reserved: `inflight` (in-flight replay) and `blocks` (semantic
  // scrollback) land here additively — see Future.
}

// then a stream of:
type TerminalEvent =
  | { event: 'terminal.data';     data: { bytes: string /* base64url */ } }
  | { event: 'terminal.closed';   data: { exitCode?: number } };
```

These two are the whole v1 stream. A viewer is not notified when another
display takes size authority, and semantic state (activity/cwd/title) reaches
the client only through `directory.snapshot` — the host→client
`terminal.resize` and `terminal.semantic` events are staged in
[Future](#future) (item 5).

```ts
// client → host (requires the input grant)
type TerminalInput =
  | { method: 'terminal.write';  params: { surfaceId: string; bytes: string } }
  | { method: 'terminal.resize'; params: { surfaceId: string; cols: number; rows: number } };
```

#### Attachment invariants

Source of truth: `RemoteApiSession.#attach` / `#beginAttach` in
`lib/src/remote/host/remote-api.ts`, `HostSurfaceProvider.streamPty`, and the
peer `subscribe` / `subscribed` frames in `vscode-ext/src/peer-link.ts`.

* **Only the current attachment is writable.** A `terminal.write`/`terminal.resize`
  for a detached surface, or for a background surface listed in the directory but
  not attached by this session, is rejected and must not reach the PTY or change
  its size.
* **The attachment is pinned to a terminal, not to a registry slot.** It is bound
  to the terminal resolved at `surface.attach` time, so after a Host-side pane
  swap moves that terminal to another pane, the stream and both input methods
  keep targeting the same PTY rather than re-resolving `surfaceId`.
* **Exit drops the attachment.** On PTY exit the Host emits `terminal.closed` and
  *then* drops the attachment, so a later write/resize is rejected ("surface is
  not attached") instead of acting on the disposed terminal.
* **A late resolution never becomes an attachment.** Disposing the Viewer, and any
  newer `surface.attach`, invalidate an in-flight surface resolution; a handle
  that arrives afterwards is released immediately. This is what keeps
  last-attach-wins true when two resolutions take different lengths of time — a
  sibling window's pane is a round trip away while a local one resolves at once,
  so without it the older, slower attach would land last and win.
* **Every attach is answered.** A superseded attach gets an error rather than
  being left pending, since the Client holds the request open — and its event
  subscription with it — until it is answered. A disposed session is the one
  exception: no transport left to answer on.
* **The result promises a size already applied.** Provider resolution and resize
  cross process/window boundaries, so an attach is not acknowledged until its
  required resize settles. Rejected resolution, attach resize, and
  `terminal.resize` come back as protocol errors, contained inside the session
  rather than becoming unhandled Host-process rejections.
* **Subscription and liveness are atomic.** The stream is subscribed before the
  resize settles (some PTYs repaint synchronously), so a PTY that died while
  `resolveSurface` was in flight must still be observed: every production
  provider replays the recorded exit before the subscription is usable — local
  ones synchronously, a VS Code peer by acknowledging on the same ordered socket
  *after* any replay, which the session waits for before resizing or
  acknowledging. Either way the attachment is torn down first, the attach is
  answered `surface closed while attaching`, and the buffered `terminal.closed`
  is dropped rather than flushed — the Client never gets the subscription it
  would have arrived on.

#### Size authority: last-attach-wins

A terminal has one size, and the most recent size writer owns it: attaching
with dimensions and `terminal.resize` both take authority, and the Host user
interacting with the pane locally reclaims it. **There is no remote detach at
the surface owner** — the Host stops streaming on its side and the pane keeps
whatever size it was left at, which is what last-attach-wins means. The
Host-side **"tethering to \<device\>"** display that greys out other displays of
a tethered pane is staged — see [Future](#future); today the authority semantics
hold at the PTY level without the dedicated display.

## Input authority and multiple viewers

**Input authority is flat**: selfhost is single-user, so every paired session
is the owner and gets full input (`grants: { input: true, layout: false }`),
and no session gets layout operations.

Concurrent sessions then need no special machinery: attach state is per-session,
streams fan out per attachment (one PTY subscription, one sink per attachment),
and terminal size is last-attach-wins. Interleaved typing from two granted
sessions is no worse than two keyboards on one machine; the window lease (future)
is the only exclusive resource.

Graded grants, layout mutations, and showing connected viewers on the Host UI
with per-viewer disconnect are all staged — see [Future](#future).

## Future

Staged in likely order of arrival. Each item is additive — a new method,
event, or optional field — so nothing in protocol-v1 changes shape when it
lands.

### 1. Browser surfaces (`agent-browser`)

Browser remoting was specified alongside protocol-v1 but the shipped slice is
terminal-only, so it is now the first staged item. The existing screencast
path (`docs/specs/dor-browser.md`), made remote:

* The client hello gains the reserved `capabilities` field:
  `{ screencast: ['jpeg' | 'webp'], input: boolean, window: boolean }`.
* `DirectoryEntry` gains browser entries — `type: 'browser'` (the canonical
  component-level kind, `docs/specs/glossary.md` Naming conventions) plus a
  browser-only `url` field.
* Media frames share the WebSocket with control messages. A dropped frame must
  be skipped, not queued behind: the Host keeps at most the newest frame per
  attachment and sends it only when the socket drains, so a slow link degrades
  to a lower frame rate instead of growing a buffer.

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

The Host picks fixed, phone-appropriate screencast parameters (JPEG, capped
dimension and frame rate) at first; per-attachment quality negotiation
(`browser.quality`) and remote navigation (`browser.navigate`) come after — a
phone can drive the page's own UI in the meantime.

Iframe surfaces stay unsupported even here: omitted from the directory,
refusing attachment; Window snapshots still list them (the layout must be
truthful) and VR renders an inert placeholder. Nothing else in the protocol
assumes they exist, so support can be added cleanly later.

### 2. In-flight command replay

The first terminal follow-up. The most common reason to open a pane on the
phone is a command that is still running — "is my build done?" — and a resize
repaint shows nothing for a command quietly writing a log. (Dormouse's primary
workload, agent TUIs, do repaint on resize — which is what makes this
deferrable at all.) The Host retains the output of the current command from
its `commandStart` boundary (OSC 133/633, with the existing
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

### 3. Semantic command scrollback

History arrives as structure the Host already extracts, not as emulator
state: OSC 133/633 segmentation gives per-command boundaries, alt-screen spans
are already tracked and stripped, and the in-flight buffer is the same capture
mechanism retained for K commands instead of one:

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

### 4. Directory thumbnails

### 5. Tethering display and viewer visibility

While a remote session holds size authority, every other display of that pane
— the pane in the Host's own Wall, other attached viewers — greys out and shows only
**"tethering to \<device\>"** (the ACL record's label, e.g. `iPhone Safari`)
instead of fighting over `SIGWINCH`. Interacting with a tethered pane is how a
display takes authority back. Alongside it: the Host UI shows connected
viewers (label from the ACL record) with per-viewer disconnect, and in-flight
input is dropped the moment a session is killed.

The wire half, landing additively as new event names:

```ts
// host → client: another display took size authority over your attachment
{ event: 'terminal.resize';   data: { cols: number; rows: number } }
// host → client: live cwd/activity/title for the attached pane
{ event: 'terminal.semantic'; data: TerminalSemanticEvent }
```

`terminal.resize` is what lets an attached viewer show its own tether state
instead of rendering garbled wrap until re-attach; `terminal.semantic` frees
the attached pane's header from the coalesced `directory.snapshot` cadence.

### 6. Graded grants and layout mutations

Layered so "the Host is the final authority" holds at every step:

1. **Pairing-time**: the ACL record's approval carries a standing grant
   (observe-only vs interactive) chosen in the Host's approval UI.
2. **Session-time**: the hello's `grants` reports what the session actually
   got.
3. **Layout**: destructive operations (`surface.kill`) require the `layout`
   grant and are confirmed on the Host the same way local kills are
   (KillConfirm), unless the Host user opts a session into unattended control.

### 7. The Window (VR)

VR does not stream the desktop; it *is* the desktop: the headset runs the same
web UI (`lib`) against remote data sources instead of local ones.

`window.watch` subscribes to the Host Window's layout tree plus geometry. A
session connects to one Host, hence one Window, so the snapshot follows the
glossary containment directly (`Window ⊃ Workspace ⊃ Pane ⊃ Surface`):

```ts
interface WindowSnapshot {
  workspaces: Array<{
    ref: string; name: string;
    panes: Array<{
      paneRef: string;
      /** Normalized rect within the Workspace's Wall, for initial spatial placement. */
      rect: { x: number; y: number; w: number; h: number };
      surfaces: Surface[];      // the existing Surface shape
    }>;
  }>;
  /** Which Workspace the Host has mounted locally. */
  activeWorkspaceRef: string;
  focusedSurfaceId: string | null;
}

type WindowEvent =
  | { event: 'window.snapshot'; data: WindowSnapshot }
  | { event: 'window.changed';  data: WindowSnapshot };  // coalesced; layouts are small
```

The rects seed VR placement; after that the headset owns spatial arrangement
locally (a VR user re-hanging panels in space is presentation, not layout, and
does not round-trip to the Host).

**Layout mutations** reuse the existing `surface.*` control vocabulary,
carried over the session (requires the `layout` grant):

```
surface.split    surface.ensure    surface.send
surface.kill     surface.read      surface.focus
```

These are the same methods the dor CLI speaks today; the remote API reuses
their request/response shapes so the Host dispatches both through one handler.

**Window lease.** A VR session may request `window.lease`, declaring itself
the primary display. Sizing needs no lease — last-attach-wins already hands VR
the panes it displays — so the lease is presentational: the Host UI tethers
wholesale ("tethering to \<device\>") instead of pane by pane, and panes
created on the Host while the lease is held open tethered to the leaseholder.
One lease at a time; the Host user can always reclaim it locally. Phones never
need it.

### 8. WebRTC transport and app-layer encryption

Neither changes the API surface: WebRTC rendezvous for latency (the Server
signals but, per the security model, is never trusted with authorization — pin
the DTLS fingerprint inside the device-key-signed connect payload), and
app-layer encryption so the relaying Server sees only ciphertext.

### 9. Audio

Browser surfaces can produce audio; VR will want it (spatial, per-panel).

### QoS hardening (phone-first, orthogonal to the stages above)

* Terminal output is already coalesced host-side; the remote stream should add
  a per-session byte budget with tail-drop + resync (an implicit re-attach:
  repaint via resize) rather than unbounded buffering on a bad link.
* Detach on backgrounding: when the phone app/PWA loses visibility, the client
  detaches streams but keeps the control channel; reattach is one message.

### Open questions

* **Browser media**: screencast frames over the WebSocket first; when WebRTC
  arrives, a video track would be smoother for VR. Possibly phone=frames,
  VR=track, negotiated in the hello.
