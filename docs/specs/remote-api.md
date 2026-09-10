# Remote Surface API

> See `docs/specs/glossary.md` for the canonical Pane / Surface / Session model; this spec uses that vocabulary and adds only remote-specific terms (Viewer, and the wire-level `DirectoryEntry` projection of a pane).
> Owns the protocol a Client speaks to view and control a Burrow's surfaces. [remote-security-model.md](./remote-security-model.md) owns authorization; `docs/specs/relay.md` owns the relay and framing underneath.

**Every message below travels inside one authorized session, and the Burrow may terminate that session — and every stream in it — at any time.**

One protocol, two consumption depths: the **phone** (Dormouse Pocket) shipped, a **VR headset** staged ([Future](#future)).

| Capability              | Phone            | VR (future)      |
| ----------------------- | ---------------- | ---------------- |
| `directory.watch`       | yes (the picker) | optional         |
| `surface.attach`        | one at a time    | many at once     |
| `window.watch` (layout) | no               | yes              |
| Layout mutations        | no               | yes              |
| Input                   | to attached pane | to any surface   |

**Replicate state, never stream a desktop** — a standing constraint on everything staged below: terminals travel as PTY data rendered client-side, browser surfaces as per-surface screencasts, each its own placeable stream. (rationale)

## v1 scope

**Scope: protocol-v1** — the shipped protocol, the smallest that lets a phone **sign in, pick a pane, see it live, and type into it**:

* Hello (version + viewer kind)
* `directory.watch`, snapshot-only (no deltas, no thumbnails), terminal entries only
* `surface.attach` / `surface.detach`, one attachment per session
* Terminal: attach-is-the-resize, live data, `terminal.write` / `terminal.resize`, last-attach-wins size authority
* One implicit grant: every paired session has full input (selfhost is single-user), no layout operations

Everything else, browser-surface remoting included, is staged in [Future](#future).

Source of truth: `remote-lib-common/src/remote/wire.ts` (the fixed wire contract — every wire type and shared constant named below), `RemoteApiSession` in `lib/src/remote/burrow/remote-api.ts` (the Burrow implementation, and the timing constants named below).

### The provider seam

**The Burrow runs in the process that owns the PTYs, never a webview** (`docs/specs/relay.md` → "Burrow side"). Within it, `RemoteApiSession` speaks this protocol and nothing else: surface ids, PTY ids, sizes, bytes.

**Every environment-specific answer sits behind `BurrowSurfaceProvider`** — `collectDirectory` / `watchDirectory`, `resolveSurface` returning a `SurfaceHandle`, `writePty` / `resizePty` / `streamPty` — because *where* a named surface lives is a deployment fact, not a protocol concept. **The session imports no platform adapter, no store, and no `document`**, and both installations share the ask-backed half, so an attach cannot be answered differently in one burrow than the other.

**`SurfaceHandle.ptyId` is a provider-local routing key**, not necessarily the PTY process's own id — the VS Code provider mints an opaque per-peer handle. (rationale)

**Keep stream ownership on `PtyStream`**: resolving a `SurfaceHandle` creates no subscription; `streamPty` starts it and `PtyStream.stop` ends it. (rationale)

Source of truth: `BurrowSurfaceProvider` in `lib/src/remote/burrow/burrow-surface-provider.ts`, `lib/src/host/remote/ask-surface-provider.ts`.

## Terminology

A Surface is named on the wire by `surfaceId`; the picker lists Panes, so attaching to a Pane means attaching to its selected Surface. Remote-only vocabulary:

* **Viewer** — one connected Client session. Multiple viewers may coexist.

Source of truth: the surface model the wire shapes reuse — `dor/src/protocol.ts`, `dor/src/commands/types.ts`.

## Transport

**Every message below is JSON, carried as one length-prefixed application message on one authorized Noise session** that the WebSocket relay pipes without decoding, the Burrow multiplexing every session over its single relay socket (`docs/specs/relay.md` → "Routing", "E2E framing"). **Terminal data rides that same stream** — it is small and ordering matters; media channels arrive with browser surfaces ([Future](#future)). **The API and the security model are identical in selfhost and (future) SaaS modes**, where only account creation differs (`docs/specs/relay.md` → Future).

**A `RemoteApiSession` exists only for an authorized session.** Created at promotion — presence proof and ACL conjunction both passed ([remote-security-model.md](./remote-security-model.md) → Connection) — and disposed when the Client disconnects, when the Burrow reaps the session, and by any promotion that replaces it, so **a re-authorizing Client can never inherit the previous session's attachment**.

Source of truth: `BurrowRuntime.#promoteConnection` in `lib/src/remote/burrow/burrow-runtime.ts`.

### Direct path

After authorization the same Noise session moves off the Relay onto a WebRTC
data channel. **The presence protocol is inherited unchanged and the Relay is
never trusted with authorization.** **The standalone Burrow answers**, over
`node-datachannel`'s W3C polyfill in the sidecar — **loaded at the first offer,
never at boot**, a load failure declining from then on
([standalone.md](./standalone.md) → "Burrow service"). **VS Code declines**: it
carries no addon ([Future](#future)).

**Every signal rides inside the session**, as one of four control messages
([relay.md](./relay.md) → E2E framing) on the established session over the relay
path: `direct-offer` (Client→Burrow, SDP), `direct-answer` (Burrow→Client, SDP),
`direct-decline` (Burrow→Client), `direct-switch` (either direction) — each
`{ v: 1, t }` with exact keys and no other field. **The Relay never sees an SDP,
a candidate, or that a direct path exists.** **An unknown control shape on an
established session is ignored, never a session failure**, so a peer without
this stack simply stays relayed.

**The Client offers once, after `ConnectionOutcomeV1 { ok: true }`, and never
retries**; it is always the offerer and creates the one ordered, reliable data
channel (`dormouse`, `arraybuffer`). **The Burrow answers at most one offer per
session**, and declines where it has no peer to build. **Each side sends its
whole description only after ICE gathering completes** — no trickle — bounded by
`DIRECT_GATHER_TIMEOUT_MS`, past which what it has is what travels. **An SDP
over `MAX_DIRECT_SDP_LENGTH` is never sent**: the Client skips the offer, the
Burrow declines. That bound derives from `CONTROL_PAYLOAD_SIZE`, so a maximal
signal always fits one control body.

**No ICE servers.** `iceServers: []` at both ends, host candidates only.
**Never a public STUN or TURN default** — it would hand a third party the user's
address. (rationale)

**Every byte on the channel is a Noise transport message of the promoted
session**: one message per channel frame, raw bytes, the same two `CipherState`s
and counters. **Every inbound channel frame is bounded at
`NOISE_MAX_MESSAGE_LENGTH` before decryption**, and a frame over it — or a
non-binary channel message — disposes the session. (rationale)

**Cutover preserves order per direction:**

* A sender's `direct-switch` is its **last** message on the relay path; every
  later message, keepalives included, goes on the channel.
* A receiver processes relay frames until it decrypts `direct-switch`, holding
  channel frames meanwhile — at most `MAX_DIRECT_PENDING_FRAMES` /
  `MAX_DIRECT_PENDING_BYTES`, **overflow disposing the session** — then drains
  them in arrival order through the same decrypt path.
* **After inbound has switched, a relay `transport` frame disposes the
  session**, refused before any decrypt.
* **After either direction has switched, the channel closing or erroring
  disposes the session**: the Client reports burrow loss exactly as a
  `burrow-gone`, the Burrow disposes the established entry. **Before any switch
  a channel failure only abandons the attempt** — including a channel not open
  by `DIRECT_SETUP_TIMEOUT_MS` — and the session stays relayed.
* **A `direct-switch` arriving at an end that has abandoned its channel ends the
  session** too: nothing that peer sends can arrive, and the alternative is a
  session whose every request hangs unanswered.

**The Relay stays the lifecycle authority.** `client-gone`, `burrow-gone`, and
either relay socket closing dispose the session, channel included, exactly as
they do relayed; the idle deadline, keepalives, and every Burrow bound are
path-agnostic — a keepalive decrypted off the channel refreshes the deadline
like any other ([remote-security-model.md](./remote-security-model.md) → Burrow
bounds).

**One peer connection per session**, created at the offer, closed on every
disposal path, never existing before promotion. **Both ends build it through an
injected factory** — `PocketClientDeps.createDirectPeer`,
`BurrowOptions.createDirectPeer`, threaded through `BurrowServiceOptions` —
`null` where a runtime has none, so neither end reaches a WebRTC global.
**Pocket shows which path carries the session**
([pocket-app.md](./pocket-app.md)).

Source of truth: `remote-lib-common/src/security/direct-path.ts` (the signals,
their guard, the constants, and the `DirectCutover` both ends run),
`lib/src/remote/direct/direct-peer.ts` (`DirectPeerLike` and the negotiation),
`PocketClient.#offerDirect` in `lib/src/remote/client/pocket-client.ts`,
`BurrowRuntime.#answerDirect` in `lib/src/remote/burrow/burrow-runtime.ts`;
pinned by `remote-lib-common/test/direct-path.test.mjs`,
`lib/src/remote/direct/direct-peer.test.ts`, and the end-to-end cases in
`lib/src/remote/client/pocket-client.test.ts` and
`lib/src/remote/burrow/burrow-bounds.test.ts`.

### Envelope

Requests are correlated by `requestId`, events by `subId` (`RemoteRequest`, `RemoteResponse`, `RemoteEventMsg`).

**A subscribing method (`directory.watch`, `surface.attach`) opens its stream under the request's own id** — `requestId` reused as the `subId` — so the Client installs its handler before sending and never races a snapshot or a first data frame. **The six methods and three events are named constants** (`REMOTE_METHODS`, `REMOTE_EVENTS`) dispatched by name, so a future event lands additively and an old client ignores what it does not know.

**Every peer-supplied `cols`/`rows` passes through `clampTerminalDimension`** — 1 … `MAX_TERMINAL_DIMENSION` (2000), falling back to the current size when absent or non-finite — on the Burrow, in the webview responder driving the real xterm, and in the Client adapter. The upper bound is the security-relevant half. (rationale)

### Hello

First exchange on the control channel; establishes version and viewer kind so the protocol can grow without breaking older Pockets. **The Burrow does not *gate* other methods on it** — authorization already happened at connect time, so skipping hello grants nothing. `HelloParams` / `HelloResult`: protocol v1 and a phone/VR/desktop viewer go Client→Burrow; protocol v1, Burrow id, and the flat `grants` ([Input authority](#input-authority-and-multiple-viewers)) return.

Reserved: a `capabilities` field on the client hello (what the client can render — screencast formats, window support) lands additively when browser surfaces arrive; see [Future](#future).

## Directory (the phone's picker)

`directory.watch` subscribes to a live, lightweight listing of every pane — enough to render the picker and know which pane wants attention, without attaching. `DirectoryEntry` / `DirectorySnapshot` carry the terminal-only payload: identity, derived title, focus, semantic state, PTY liveness, and the `ringing` / `hasTODO` badges. Nothing else — thumbnails are staged.

**Snapshot-only, never deltas**: on any change the Burrow coalesces (150ms window, `DIRECTORY_DEBOUNCE_MS`) and resends the whole listing. (rationale)

**One snapshot per collect** — the provider answers for every surface the Burrow can reach, so no subset is known sooner. **A collect is dropped unless it is still the newest and its subscription neither replaced nor torn down**, a per-collect generation of the same shape as the per-attach one keeping a stale answer — an empty timed-out one included — from blanking the picker (rationale). **A collection that rejects emits nothing** and leaves the last good snapshot standing, contained inside the session; the next invalidation or `directory.watch` retries it.

**Duplicate `surfaceId`s collapse to the first answerer** — answerers arrive local-tier-first, the same owner an attach's read-only resolve probe selects, so the row shown is the surface attached. (rationale)

**Invalidation reaches the session through `watchDirectory`**, and both sources feed the same coalescer: changed pane state, activity, or focus announced by a webview, plus membership changes (a webview attaching or disposing, a peer window joining or dropping) which invalidate unconditionally.

**A late answer — one for an ask that already settled — invalidates the directory rather than being dropped**: only the next collect repairs a snapshot missing what it names. Each burrow's ask bridge applies it (`docs/specs/standalone.md`, `docs/specs/vscode.md`).

**Browser and iframe surfaces are neither listed nor attachable** — they never enter the xterm registry the directory collects from, so `surface.attach` cannot resolve them either. ([Future](#future) stages browser remoting; iframes stay unsupported even there.)

**`alive` is real PTY-process liveness**, distinct from `exitCode` — the last finished command's shell-integration status: a pane may report `alive: true` with an `exitCode` set, or `alive: false` with none. **An exited pane stays listed at `alive: false`**, since Dormouse keeps it open until the user closes it, and the picker stops offering it — attaching would transfer nothing.

Source of truth: `RemoteApiSession.#emitDirectory` in `lib/src/remote/burrow/remote-api.ts` (coalesce + generation), `lib/src/remote/burrow/directory-collect.ts` (the entry mapping), and the collapse in `lib/src/host/remote/ask-surface-provider.ts`.

## Attaching to a surface

`surface.attach { surfaceId, cols, rows }` opens the surface's stream; `surface.detach { surfaceId }` closes it. **Detach names its surface** so a stale detach cannot kill a newer attachment; **detaching anything that is not the current attachment is an idempotent no-op**. One attachment per session ([Future](#future) lifts the cap for VR). **Attachment is view-state only, with one exception**: attaching to a terminal takes size authority.

### Terminal surfaces

Replicated, not screencast: the client renders its own xterm from the same data the burrow UI consumes. **That is the *processed* stream** — Dormouse-owned sequences parsed, stripped, and answered at the Burrow; renderer-owned ones remain, and every renderer parses them for itself ([terminal-escapes.md](./terminal-escapes.md)).

**The Burrow discards terminal reports arriving from a remote session** — the owner's xterm is the sole reply authority for renderer-owned queries (device attributes, DSR/CPR, window ops, XTSMGRAPHICS, cell size, kitty graphics responses). **A mirror renders and may take size authority, but never answers.** (rationale) The Client drops the same chunks rather than spending the relay on them. Pinned by `inputIsReplayTerminalReport` in `lib/src/lib/terminal-report-filter.ts`, which requires every token of a chunk to be a report shape, so keystrokes and pastes never match.

**The unit of processed output is a projection pair, never a bare string.** `terminal.data` carries `bytes` — the renderer projection — and `text`, the same chunk with string-control payloads removed for a consumer reading it as text; **`text` omitted means identical to `bytes`, present is authoritative, empty included** (rationale). Additive on protocol-v1. The same pair crosses every Burrow seam as `ProcessedPtyChunk` and arrives as `PtyDataDetail`, so a Client's prompt heuristic reads what the Burrow's own does rather than image base64.

**One `terminal.data` never approaches the 1 MiB application-message cap**: the owner bounds what it feeds the parser, so **both** projections plus their framing stay inside `MAX_APP_MESSAGE_LENGTH` without a rechunker on this path ([terminal-escapes.md](./terminal-escapes.md) → "Parsing location"). **A message over the cap is dropped, not truncated**, so the bound is the only thing between an unusually large PTY read and a Client losing a chunk mid-stream.

Source of truth: `TerminalDataEvent` in `remote-lib-common/src/remote/wire.ts`, `ProcessedPtyChunk` in `lib/src/lib/processed-pty-stream.ts`, `PtyDataDetail` in `lib/src/lib/platform/types.ts`.

#### Attach is the resize

**Attach carries the client's dimensions, and there is no snapshot transfer** (rationale):

1. Client attaches with `{ cols, rows }`.
2. Burrow resizes through the owning xterm's resize path (last-attach-wins); the resulting `SIGWINCH` repaint is what fills the client's screen. (rationale)
3. **If the requested size equals the current size**, the Burrow requests an owner-managed **PTY-only** repaint. The owner bounces rows down (up from one row), then restores them after 60ms (`FORCE_REPAINT_BOUNCE_MS`); the xterm stays at the requested size.

**Must cancel restoration on every later PTY resize or repaint, exit, kill, or replacement.** Local and other-Viewer size writers share that owner. Detach/disposal leave restoration running. (rationale)

Source of truth: `resize` in `standalone/sidecar/pty-core.js`, shared by both hosts and pinned by `standalone/sidecar/pty-core.test.js`; the Burrow→owner `repaint` flag travels through `lib/src/host/remote/sidecar-entry.ts` or `vscode-ext/src/burrow.ts` → `vscode-ext/src/peer-link.ts` → `vscode-ext/src/pty-manager.ts` → `vscode-ext/src/pty-host.js`.

**Normal-screen history does not regenerate on resize** and is absent from the shipped protocol (see [Future](#future): in-flight replay, then semantic scrollback).

Payloads: `AttachParams`, `TerminalAttachResult`, `TerminalDataEvent`, `TerminalClosedEvent`, `TerminalWriteParams`, `TerminalResizeParams`. PTY bytes are base64url.

`terminal.data` and `terminal.closed` are the whole v1 stream: **a viewer is not notified when another display takes size authority**, and semantic state (activity/cwd/title) reaches the client only through `directory.snapshot`. The burrow→client `terminal.resize` and `terminal.semantic` events are staged in [Future](#future) (item 5).

#### Attachment invariants

* **Only the current attachment is writable.** A `terminal.write` / `terminal.resize` for a detached surface — or a background one listed in the directory but not attached by this session — is rejected, reaching neither the PTY nor its size.
* **The attachment is pinned to a terminal, not a registry slot** — bound to the terminal resolved at `surface.attach`, so a Burrow-side pane swap leaves the stream and both input methods on the same PTY, never re-resolving `surfaceId`.
* **Exit drops the attachment.** The Burrow emits `terminal.closed` and *then* drops it, so a later write/resize is rejected ("surface is not attached") rather than reaching the disposed terminal.
* **A late resolution never becomes an attachment.** Disposing the Viewer, and any newer `surface.attach`, invalidate an in-flight resolution; a handle arriving afterwards is ignored without subscribing or replacing the current attachment. (rationale)
* **Every attach is answered** — a superseded one with an error, never left pending, since the Client holds the request and its event subscription open until answered. Sole exception: a disposed session has no transport to answer on.
* **Must acknowledge only a size the owner reports applied.** Missing resize answers, rejected resolution or resize, and synchronous attach-start failures are protocol errors contained inside the session.
* **Subscription and liveness are atomic.** The stream is subscribed before the resize settles (some PTYs repaint synchronously), so **a PTY that died while `resolveSurface` was in flight must still be observed**: every production provider replays the recorded exit before the subscription is usable — local ones synchronously, a VS Code peer by acknowledging on the same ordered socket *after* any replay, which the session awaits before resizing or answering. The attachment is then torn down first, the attach answered `surface closed while attaching`, and the buffered `terminal.closed` dropped rather than flushed — the Client never gets the subscription it would have arrived on.

Source of truth: `RemoteApiSession.#attach` / `#beginAttach` in `lib/src/remote/burrow/remote-api.ts`, pinned by `lib/src/remote/burrow/remote-api.test.ts`; the peer `subscribe` / `subscribed` frames in `vscode-ext/src/peer-link.ts`.

#### Size authority: last-attach-wins

A terminal has one size, and **the most recent size writer owns it**: attaching with dimensions and `terminal.resize` both take authority, and the Burrow user interacting with the pane locally reclaims it. **There is no remote detach at the surface owner** — the Burrow stops streaming on its side and the pane keeps whatever size it was left at. Authority holds at the PTY level today; the Burrow-side tethering display is staged ([Future](#future) item 5).

## Input authority and multiple viewers

**Input authority is flat**: selfhost is single-user, so every paired session is the owner and gets full input (`grants: { input: true, layout: false }`), and no session gets layout operations.

Concurrency then needs no arbitration: attach state is per-session and streams fan out per attachment, one PTY subscription and one sink each (rationale). The window lease ([Future](#future)) is the only exclusive resource.

Graded grants, layout mutations, and connected-viewer display with per-viewer disconnect are staged ([Future](#future) items 5–6).

Reserved: For [Future](#future) items 2–3, clients must tolerate additive optional `inflight` and `blocks` fields on `TerminalAttachResult`.

## Future

### 1. Browser surfaces (`agent-browser`)

The existing screencast path (`docs/specs/dor-browser.md`), made remote:

* The client hello gains the reserved `capabilities` field: `{ screencast: ['jpeg' | 'webp'], input: boolean, window: boolean }`.
* `DirectoryEntry` gains browser entries — `type: 'browser'` (the canonical component-level kind, `docs/specs/glossary.md` Naming conventions) plus a browser-only `url` field.
* Media frames share the WebSocket with control messages. **A dropped frame is skipped, never queued behind**: the Burrow keeps only the newest frame per attachment and sends it when the socket drains, so a slow link degrades to a lower frame rate instead of a growing buffer.

```ts
type BrowserEvent =
  | { event: 'browser.frame'; data: { format: 'jpeg' | 'webp'; width: number; height: number; bytes: string } }
  | { event: 'browser.tab';   data: AgentBrowserTab }   // title/url/active changes
  | { event: 'browser.closed'; data: {} };

// client → burrow (requires the input grant); coordinates in frame space,
// the burrow maps them through the screencast scale into CDP input.
type BrowserInput =
  | { method: 'browser.pointer'; params: { surfaceId: string; kind: 'tap' | 'down' | 'move' | 'up' | 'scroll'; x: number; y: number; dx?: number; dy?: number } }
  | { method: 'browser.key';     params: { surfaceId: string; text?: string; key?: string; modifiers?: number } };
```

Fixed, phone-appropriate screencast parameters (JPEG, capped dimension and frame rate) first; quality negotiation (`browser.quality`) and remote navigation (`browser.navigate`) after — a phone can drive the page's own UI meanwhile.

Iframe surfaces stay unsupported even here: omitted from the directory, refusing attachment. Window snapshots still list them (the layout must be truthful) and VR renders an inert placeholder. Nothing else in the protocol assumes they exist.

### 2. In-flight command replay

A command still running — "is my build done?" — is the commonest reason to open a pane on the phone, and a resize repaint shows nothing for one quietly writing a log; agent TUIs, the primary workload, do repaint, which is what makes this deferrable. The Burrow retains the current command's output from its `commandStart` boundary (OSC 133/633, with the existing keystroke-heuristic fallback), tail-capped to a fixed byte budget, dropped at the next prompt; attach replays it via the reserved `inflight` field:

```ts
inflight?: {
  commandLine: string | null;
  startedAt: number;
  bytes: string;                // base64, tail-capped
  truncated: boolean;
}
```

### 3. Semantic command scrollback

History arrives as structure the Burrow already extracts, not emulator state: OSC 133/633 segmentation gives per-command boundaries, alt-screen spans are already tracked and stripped, and the in-flight buffer is the same capture retained for K commands instead of one:

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

Attach also delivers recent blocks, rendered at the client's own width — collapsible cards on the phone, panels in VR — rather than replaying a fixed-width terminal. A `blocks` field on `TerminalAttachResult` plus a `terminal.block` event.

### 4. Directory thumbnails

### 5. Tethering display and viewer visibility

While a remote session holds size authority, every other display of that pane — the Burrow's own Wall, other attached viewers — greys out and shows only **"tethering to \<device\>"** (the ACL record's label, e.g. `iPhone Safari`) instead of fighting over `SIGWINCH`; interacting with it takes authority back. Alongside: the Burrow UI lists connected viewers with per-viewer disconnect, and in-flight input is dropped the moment a session is killed.

The wire half, as new event names:

```ts
// burrow → client: another display took size authority over your attachment
{ event: 'terminal.resize';   data: { cols: number; rows: number } }
// burrow → client: live cwd/activity/title for the attached pane
{ event: 'terminal.semantic'; data: TerminalSemanticEvent }
```

`terminal.resize` lets an attached viewer show its own tether state instead of rendering garbled wrap until re-attach; `terminal.semantic` frees the attached pane's header from the coalesced `directory.snapshot` cadence.

### 6. Graded grants and layout mutations

Layered so "the Burrow is the final authority" holds at every step:

1. **Pairing-time**: the ACL record's approval carries a standing grant (observe-only vs interactive) chosen in the Burrow's approval UI.
2. **Session-time**: the hello's `grants` reports what the session actually got.
3. **Layout**: destructive operations (`surface.kill`) require the `layout` grant and are confirmed on the Burrow the same way local kills are (KillConfirm), unless the Burrow user opts a session into unattended control.

### 7. The Window (VR)

VR does not stream the desktop; it *is* the desktop — the headset runs the same web UI (`lib`) against remote data sources instead of local ones.

`window.watch { windowRef }` subscribes to one Window's layout tree plus geometry. One authorized session addresses one Burrow, which may expose several Windows (VS Code). Window discovery and selection precede the watch; its target and every snapshot carry an explicit Burrow-scoped Window identity. Each snapshot follows the glossary containment (`Window ⊃ Workspace ⊃ Pane ⊃ Surface`):

```ts
interface WindowSnapshot {
  windowRef: string;
  workspaces: Array<{
    ref: string; name: string;
    panes: Array<{
      paneRef: string;
      /** Normalized rect within the Workspace's Wall, for initial spatial placement. */
      rect: { x: number; y: number; w: number; h: number };
      surfaces: Surface[];      // the existing Surface shape
    }>;
  }>;
  /** Which Workspace the Burrow has mounted locally. */
  activeWorkspaceRef: string;
  focusedSurfaceId: string | null;
}

type WindowEvent =
  | { event: 'window.snapshot'; data: WindowSnapshot }
  | { event: 'window.changed';  data: WindowSnapshot };  // coalesced; layouts are small
```

The rects seed VR placement; the headset then owns spatial arrangement locally — re-hanging panels in space is presentation, not layout, and does not round-trip.

**Layout mutations** reuse the existing `surface.*` control vocabulary over the session (requires the `layout` grant):

```
surface.split    surface.ensure    surface.send
surface.kill     surface.read      surface.focus
```

These are the methods the dor CLI speaks today; the remote API reuses their request/response shapes so one Burrow handler dispatches both.

**Window lease.** A VR session may request `window.lease { windowRef }`, declaring itself that Window's primary display. Sizing needs no lease — last-attach-wins already hands VR the panes it displays — so the lease is presentational: that Window tethers wholesale instead of pane by pane, and panes created in it while the lease is held open tethered to the leaseholder. One lease per Window; the Burrow user can always reclaim it locally. Phones never need it.

### 8. Direct path (WebRTC)

**Scope: direct-path** — latency. The shipped half is [Transport → Direct path](#direct-path), which Pocket and the standalone Burrow speak today. What remains, in staged order:

1. **VS Code Burrow** — platform-targeted VSIX builds carrying the addon per target (`docs/specs/deploy.md`).
2. **Dogfood** across a tailnet, keystroke round-trip measured relayed and direct into the rationale.

Relay-supplied ICE servers are unstaged (SaaS), as is a session surviving relay loss.

### 9. Audio

Browser surfaces can produce audio; VR will want it (spatial, per-panel).

### QoS hardening (phone-first, orthogonal to the stages above)

* Terminal output is already coalesced burrow-side; the remote stream should add a per-session byte budget with tail-drop + resync (an implicit re-attach: repaint via resize) rather than unbounded buffering on a bad link.
* Detach on backgrounding: when the phone app/PWA loses visibility, the client detaches streams but keeps the control channel; reattach is one message.

### Open questions

* **Browser media**: screencast frames over the WebSocket first; once the direct path ships, a video track would be smoother for VR. Possibly phone=frames, VR=track, negotiated in the hello.
