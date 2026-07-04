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

Design principle, and a standing constraint on everything staged below:
**replicate state, don't stream a desktop.** Terminals are sent as PTY data and
rendered client-side (the Client already ships the terminal renderer); browser
surfaces will be sent as per-surface screencasts. This is what makes VR viable —
each surface arrives as its own independently placeable stream — and it makes
the phone cheap: one attached surface costs one stream.

## v1 scope

**Scope: protocol-v1** — the smallest protocol that lets a phone **sign in,
pick a pane, see it live, and type into it**. This is the shipped protocol;
source of truth is `server-lib-common/src/remote/wire.ts` (the fixed wire
contract) and `lib/src/remote/host/remote-api.ts` (the Host implementation):

* Hello (version + viewer kind)
* `directory.watch`, snapshot-only (no deltas, no thumbnails), terminal
  entries only
* `surface.attach` / `surface.detach`, one attachment per session
* Terminal: attach-is-the-resize, live data + semantic events,
  `terminal.write`/`terminal.resize`, last-attach-wins size authority
* One implicit grant: every paired session has full input (selfhost is
  single-user), no layout operations

Everything else — including browser-surface remoting — is staged in
[Future](#future). Each staged item is additive — a new method, event, or
optional field — so nothing in the shipped protocol changes shape when it
lands.

## Terminology

`docs/specs/glossary.md` is canonical for **Pane** and **Surface**; the wire
shapes reuse the existing surface model (`dor/src/protocol.ts`,
`dor/src/commands/types.ts`). Remote-specific usage:

* **Surface** — identified on the wire by `surfaceId`.
* **Pane** — the phone's picker lists panes; attaching to a pane means
  attaching to its selected surface.
* **Viewer** — one connected Client session. Multiple viewers may coexist.
* **Window** — the Host's full layout tree (its Workspaces, their Panes and
  Surfaces) plus geometry, consumed only by VR (future; see
  [Future](#future)). The glossary reserves **Wall** for the renderer of a
  single Workspace, so the VR subscription replicates the *Window*.

## Transport

### Channels

Transport is **WebSocket relay only**: one WebSocket per session, relayed
through the Server, bound to the `sessionId` issued by `authorizeConnection`.
Control messages ride the socket as JSON; terminal data rides here too (it is
small and ordering matters). Media channels arrive with browser surfaces
(future).

### Server deployment modes

The Server always ships in two modes; the remote API and the security model
are identical in both — the modes differ only in how accounts come to exist.

* **Selfhost** — an env-var sets a setup password; presenting it allows the
  system's only user to create their account and register the first passkey.
  Sign-in from then on is passkey-only. No database: accounts, passkey
  credentials, and revocation state live in local files. Shipped
  (`docs/specs/server.md`). Selfhost is not a stepping stone: it remains a
  supported mode alongside SaaS permanently.
* **SaaS multitenant** — anyone can create an account with email + passkey.
  Future (deployment plumbing staged in `docs/specs/pocket-app.md`
  `## Future`).

### Envelope

Same shape as the dor control protocol — requests correlated by `requestId`,
events correlated by `subId`:

```ts
interface RemoteRequest  { requestId: string; method: string; params?: object }
interface RemoteResponse { requestId: string; ok: boolean; result?: object; error?: string }
interface RemoteEvent    { subId: string; event: string; data: object }
```

### Hello

First exchange on the control channel; establishes version and viewer kind so
the protocol can grow without breaking older Pockets.

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
  // From the existing semantic-event model (terminal-state.ts):
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

Snapshot-only, deliberately: a directory is dozens of entries at most, so on
any change the Host coalesces (150ms window, `DIRECTORY_DEBOUNCE_MS`) and
resends the whole thing. Delta events are a future optimization there is no
current reason to pay for.

The picker renders from titles, activity, and the `ringing`/`hasTODO` badges;
thumbnails are staged (see [Future](#future)). Browser panes are not listed;
iframe surfaces additionally refuse attachment by design (see
[Future](#future) for browser remoting — iframe surfaces are not on the
critical path even there).

`alive` reflects real PTY-process liveness: it is `true` while the pane's
process is running and `false` once that process has exited. Dormouse keeps an
exited pane open in the Host registry (rendering "[Process exited with code N]")
until the user closes it, so such a surface is still *listed* but reports
`alive: false` — the phone's picker uses this to stop offering a dead pane as
attachable (attaching would transfer nothing).

This is distinct from `exitCode`, which is the last finished command's
shell-integration semantic status, not PTY lifetime. A pane can report
`alive: true` with an `exitCode` set (a command finished but the shell lives on),
and a pane reporting `alive: false` may carry no `exitCode` at all.

## Attaching to a surface

`surface.attach { surfaceId, cols, rows }` opens the surface's stream;
`surface.detach { surfaceId }` closes it. One attachment per session (the
phone's model); lifting that cap for VR is future work. Attachment is
view-state only with one deliberate exception: attaching to a terminal takes
size authority.

### Terminal surfaces

Replicated, not screencast: the client renders its own xterm from the same
data the host UI consumes.

#### Attach is the resize

The remote is virtually always a different size than the Host, and a resize is
exactly what makes a terminal paint itself — so attach carries the client's
dimensions and there is no snapshot transfer:

1. Client attaches with `{ cols, rows }`.
2. Host resizes the PTY through the existing xterm resize path
   (last-attach-wins; see Size authority). `SIGWINCH` makes full-screen TUIs
   repaint completely and shells redraw their prompt line, filling the
   client's screen from the live stream alone.
3. If the requested size equals the current size, `terminal.resize` would be a
   no-op, so the Host bounces the PTY's rows to force one SIGWINCH-driven
   repaint (`FORCE_REPAINT_BOUNCE_MS`).

Normal-screen history does not regenerate on resize; it is deliberately absent
from the shipped protocol (see [Future](#future): in-flight replay, then
semantic scrollback).

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
The attachment is bound to the terminal selected at `surface.attach` time:
after a Host-side pane swap moves that terminal to another pane, the remote
stream, `terminal.write`, and `terminal.resize` keep targeting the same PTY
rather than re-resolving the old `surfaceId` through the current registry slot.
When that PTY exits, the Host emits `terminal.closed` and then drops the
attachment, so a later `terminal.write`/`terminal.resize` for the surface is
rejected ("surface is not attached") instead of acting on the disposed terminal.

#### Size authority: last-attach-wins

A terminal has one size, and the most recent size writer owns it: attaching
with dimensions and `terminal.resize` both take authority, and the Host user
interacting with the pane locally reclaims it. The Host-side **"tethering to
\<device\>"** display that greys out other displays of a tethered pane is
staged — see [Future](#future); today the authority semantics hold at the PTY
level without the dedicated display.

## Input authority

Deliberately flat: selfhost is single-user, so every paired session is the
owner and gets full input (`grants: { input: true, layout: false }`). No
session gets layout operations. Graded grants, Host-side viewer visibility,
and layout mutations are staged — see [Future](#future).

## Multi-viewer semantics

Concurrent sessions need no special machinery: attach state is per-session,
streams fan out per attachment, and terminal size is last-attach-wins.
Interleaved typing from two granted sessions is no worse than two keyboards on
one machine; the window lease (future) is the only exclusive resource. Showing
connected viewers on the Host UI (label from the ACL record, e.g. `iPhone
Safari`) with per-viewer disconnect is staged with the tethering display — see
[Future](#future).

## Future

Staged in likely order of arrival. Each item is additive — a new method,
event, or optional field — so nothing in protocol-v1 changes shape when it
lands.

### 1. Browser surfaces (`agent-browser`)

Browser remoting was specified alongside protocol-v1 but the shipped slice is
terminal-only, so it is now the first staged item. The existing screencast
path (`docs/specs/dor-browser.md`), made remote:

* The client hello gains the reserved `capabilities` field
  (what the client can render — screencast formats, window support):
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
