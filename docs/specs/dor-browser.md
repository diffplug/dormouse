# Dor Browser Surface

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary
> (a browser pane is a **browser Surface**), and `docs/specs/dor-cli.md` for the
> shared `dor` CLI, surface handle model, and host control plumbing this surface
> builds on.
> Owns the browser Surface end to end — params, chrome, both renderers, the
> iframe proxy boundary. Evidence behind the rules:
> [dor-browser.rationale.md](dor-browser.rationale.md).

Dormouse has one body component for web content: `BrowserPanel`, persisted as
`surfaceType: 'browser'` with a swappable `renderMode`.

Entry points:

- `dor ab ...` / `dor agent-browser ...` forwards to the user's own
  `agent-browser` binary and binds that session to a browser pane; typical
  navigation is `dor ab open <url>`.
- `dor iframe <url>` opens an absolute `http://` or `https://` URL in the iframe
  renderer. The proxy instruments only `http://` upstreams; the CLI accepts
  `https://` but the pane shows it as an unproxyable scheme.

Both accept, wherever they take a URL, a schemeless `host:port` (defaulted to
`http://`, including the `:port` localhost shorthand) or a terminal Surface
handle resolved to the dev server it owns (`docs/specs/dor-cli.md` → Browser Open
Target Resolution).

Two independent axes define a browser pane: its **target** (today always a bare
URL — process-backed targets belong to the **dor-tools** scope,
`docs/specs/dor-tool.md`) and its **render** mode (`ab-screencast`, `ab-popout`,
`iframe`). **Render is a pane parameter, never a separate surface kind**: `dor
list` reports every browser pane as `kind: "browser"` and puts the renderer in a
separate `render_mode` field, computed from the persisted `renderMode` rather
than stored on the row.

Source of truth: `lib/src/components/wall/BrowserPanel.tsx`,
`lib/src/components/wall/browser-surface.ts` (`resolveRenderMode`,
`surfaceKindFromParams`), `lib/src/components/wall/LathHost.tsx`
(`BODY_COMPONENTS`), `lib/src/components/Wall.tsx`
(`surfaceRenderModeFromParams`, `createContentSurface`).

## Canonical Params

The persisted `BrowserPanelParams` are flat; their canonical shape lives in
`lib/src/components/wall/BrowserPanel.tsx`.

Invariants:

- **`renderMode` is canonical**, and an absent one resolves to `iframe` (the
  engine-less embed), never to a live agent-browser.
- **`url` is the canonical target** across render swaps and relaunches.
  Agent-browser mirrors the newest non-blank active tab URL into params; iframe
  persists only navigations initiated by Dormouse chrome.
- **Agent-browser session state is flat** (`session`, `wsPort`, `binaryPath`,
  `syncEngaged`, `key`), never nested. Pop-out is not a param: it derives from
  `renderMode` once, at controller construction.
- **Never move a browser Surface's DOM, and never let a minimize unmount it.**
  Lath's leaf div is never re-parented, so an embedded `<iframe>` never reloads
  and the screencast canvas never moves mid-click (which would break click
  synthesis); minimizing **parks** the leaf, so the same document comes back on
  reattach with scroll, form, and script state intact
  (`docs/specs/tiling-engine.md` → "Parked leaves"). A restart is still a cold
  load: only `url` persists.

Source of truth: `BrowserPanel.tsx`, `browser-surface.ts`, `Wall.tsx`
(`replaceSurface`), `agent-browser-surface-controller.ts`
(`rememberRestorableUrl`, URL mirror), `IframePanel.tsx` (`applyFrameUrl`).

## Placement And Lifetime

**Both CLI entry points share one placement rule**
(`Wall.tsx:createContentSurface`): replace an untouched *terminal* caller in
place, otherwise split next to the reference surface. **Never replace a reference
that already has a browser** — web content is not destroyed to make room. A
replacement preserves the target Surface's `surface:N` ref and transfers it to
the new browser Surface id. `dor iframe` also accepts `--surface`, `--minimize`,
and `--json`.

**Both open focus-neutrally** (like `dor ensure`): the surface renders in the
background and the caller keeps focus. The one exception — replacing the pane the
user is currently selected on moves selection to the replacement, which would
otherwise dangle on the removed panel — is `docs/specs/layout.md` corner case #6,
reached through `createContentSurface`'s `focusNeutral` and the shared
`settleAddSelection` helper.

Surface lifetime owns backing resources:

- **Minimizing parks the pane**: it stays mounted and connected but invisible,
  and `useSurfaceVisibility` reports it hidden, so a doored `ab-screencast` stops
  pulling frames while its daemon and socket stay up. Killing a doored browser
  pane unparks it, so the parked DOM dies with the Surface.
- **Killing an agent-browser-rendered pane — or swapping away from that renderer
  — must mark the session closed, run `agent-browser close` through
  `closeAgentBrowserSession`, then dispose the surface controller**
  (`disposeAgentBrowserSurfaceController`), releasing the connection, screenshot
  loop, CDP observer, timers, and screen registration.
- A popped-out window closing normally auto-reverts to headless; **the
  closed-session mark keeps a Dormouse-initiated kill/swap from resurrecting it**.
- Iframe proxy grants are reclaimed by the proxy idle sweep, not by an immediate
  per-surface teardown hook.

Source of truth: `Wall.tsx` (`killPaneImmediately`, `closeAgentBrowserSession`,
`replaceSurface`), `lib/src/components/wall/agent-browser-sessions.ts`,
`lib/src/components/wall/agent-browser-surface-controller.ts`,
`lib/src/host/iframe-proxy.ts` (`GRANT_IDLE_TTL_MS`, `MAX_GRANTS`).

## Browser Chrome

Browser chrome is keyed by presence of a screen controller. Agent-browser panels
register one and iframe panels register one unconditionally, so `dor iframe` gets
the same header on every host; render swapping from iframe to agent-browser is
gated separately by host capabilities.

Header contract:

- Far-left chip opens the Display modal and reflects the render backend:
  `iframe` frame glyph, `ab-popout` external-window glyph, `ab-screencast`
  link/lock depending on whether viewport CSS size matches pane CSS size.
- Primary text is URL-oriented: host+path, query omitted in the live header (an
  iframe surface's persisted *title* keeps it). HTML title is tooltip/secondary
  state. Behind a dev-server chip the URL collapses to the path alone — the chip
  already shows host:port.
- Clicking the URL opens an inline editor — the same `InlineEditInput` as pane
  rename (`docs/specs/layout.md` → "Inline rename"), pre-filled with the full URL
  and pre-selected, except that blur discards like a browser omnibox instead of
  committing. **`normalizeNavUrl` must pick a scheme exactly as the CLI does**
  (`docs/specs/dor-cli.md` → Browser Open Target Resolution): explicit schemes
  kept, an explicit **port** or a bare loopback host means `http://`, and only a
  bare remote host with no port falls back to `https://`. So a typed `host:port`
  renders in the iframe (the proxy frames remote `http://`) while a bare remote
  host is deferred to agent-browser, the path for real HTTPS. Shared by both
  headers.
- Back, forward, and reload are always enabled. Agent-browser sends native
  `back` / `forward` / `reload`; iframe uses parent-side history and re-resolves
  the proxy on reload/back/forward.
- Non-default managed `--key` renders as its own quiet badge, **never as a title
  prefix**. Raw `--session` and iframe surfaces show no key badge.
- Split/zoom buttons hide below `420px`; nav buttons hide below `360px`; minimize
  and kill remain.

Source of truth: `lib/src/components/wall/SurfacePaneHeader.tsx`,
`lib/src/components/wall/agent-browser-screen.ts`,
`lib/src/components/wall/browser-url.ts`, Storybook
`lib/src/stories/BrowserChromeHeader.stories.tsx`.

## Dev-Server Chip

For loopback URLs (`localhost`, `*.localhost`, `127.0.0.1`, `::1`), the header
registers interest in the URL port. The Wall scans terminal panes and minimized
doors via `PlatformAdapter.getOpenPorts(id)` and **shows a chip only when exactly
one terminal owns that port**; zero or two-plus owners leave the port unsettled,
so a dev server that starts later still matches.

**Match only binds that actually serve localhost**: loopback (`127.0.0.1`, `::1`)
or any-interface (`0.0.0.0`, `::`); a specific non-loopback bind does not.
Scanning is debounced, idle-scheduled, and polls only while a wanted port is
still unmatched. Reload revalidates optimistically.

Source of truth: `lib/src/components/wall/use-dev-server-ports.ts`,
`lib/src/components/wall/port-url.ts` (the `servesLoopback` predicate),
`lib/src/components/wall/agent-browser-ports.ts`,
`lib/src/components/wall/browser-url.ts`.

## Pane Context Menu Connect

The terminal pane header's context menu (`docs/specs/layout.md` → Pane header —
right-click, or `>` in command mode; that spec owns the menu's layout and
keyboard contract) lists the ports a pane's process tree binds, using the
**same** per-port URL selection as `surface.resolveOpen` (`dor ab open <surface>`
/ `dor iframe <surface>`): `listenerUrlsByPort` in `port-url.ts` groups TCP
listeners into one openable `http://<host>:<port>/` per distinct port
(loopback-reachable bind wins `localhost`; otherwise the bound LAN/Tailnet
address, IPv6 bracketed).

Activating a port row — click, its `1`–`9` digit accelerator, or `Enter` on the
focused row — reproduces `dor ab open <url>` against the **default** key/session:
`agent-browser open <url>` on that session, reusing or creating the session's
browser surface — the wall-side mirror of the CLI flow, not the control plane. It
is host-gated on `agentBrowserCommand`: absent (e.g. the web demo host), the rows
render as inert labels.

**Activation reveals its surface.** Unlike `dor ab` (focus-neutral: an agent must
not steal focus from the human), a menu row is the human asking to see and
control that browser, so every arm of the eager lookup below **must end by
selecting the surface in passthrough mode**, reattaching it first when minimized,
on the same terms as clicking its Door chip — including when the menu was opened
from command mode with `>` (rationale). Source of truth: `revealSurface` in
`Wall.tsx`, threaded into `useDorControl`.

**Instant create.** The click is fire-and-forget — the menu closes at once and
the pane appears **before** `agent-browser open` runs (rationale):

- The eager surface is placed synchronously and **must carry no `session`**: a
  session-less `ab-screencast` pane is inert (`maybeRecoverStalePort` returns
  early with no session, so it spawns no CLI and cannot race the daemon boot),
  and it shows its own `Connecting to browser session…` placeholder rather than
  the idle `run dor ab open <url>` line (rationale). It carries `key: 'default'`
  and the target `url`, so the chrome shows the destination immediately.
- `agent-browser open <url>` runs, then a best-effort `stream status`.
- The pane receives `{session, wsPort, binaryPath}` as **one** params refresh —
  setting `session` reconciles the controller and connects it, safe now that the
  daemon is up. A failed `open` still hands over the `session` so the placeholder
  names it, and logs the failure rather than showing it in the already-closed
  menu.

The eager lookup reuses before it creates: (a) a surface already bound to the
default session, else (b) a still-booting session-less `key: 'default'` pane from
a rapid earlier click, so a double-click doesn't spawn two panes, else (c) a
fresh session-less pane. Accepted edge: a pane persisted mid-boot restores
session-less and stays a `Connecting…` placeholder — kill it, or connect again
(arm (b) reuses it).

Source of truth: `lib/src/components/wall/connect-port.ts`
(`connectPortToDefaultBrowser`), the `connectPort` binding in
`use-dor-control.ts` (its `ensureEagerSurface` + `updateSurfaceParams` seams,
shared with `ensureAgentBrowserSurface`),
`lib/src/components/wall/PaneHeaderContextMenu.tsx`.

## Display Modal And Render Swaps

The Display modal is the sole GUI for changing render mode and screencast
resolution.

Render options:

- `ab-screencast`: live Chromium via agent-browser stream plus Dormouse canvas.
- `ab-popout`: same session relaunched headed as a native OS window. Hidden if
  the host lacks `agentBrowserPopOut`.
- `iframe`: proxied iframe. Agents cannot drive it.

Resolution controls apply only to `ab-screencast`. They are GUI wrappers around
native agent-browser commands:

- Resize with pane: Dormouse-owned sync that issues
  `set viewport <paneW> <paneH> <displayDpr>` on resize.
- Fixed: `set viewport <w> <h> <dpr>`, or `set device <name>` from the modal's
  fixed registry.

**Only `syncEngaged` persists** — device/custom viewport state lives in
agent-browser itself. `SYNCED`/`SCALED` is derived from viewport CSS dimensions
versus pane CSS dimensions; DPR is issued but not part of the comparison because
stream frames are CSS-resolution. Sync coexists with external `set viewport`/`set
device` last-writer-wins: **disengage sync (→ `SCALED`) only after a frame
confirms Dormouse's own issued size landed**, so a resize transient is not
mistaken for an external override.

Swap behavior:

| From -> To | Behavior |
| --- | --- |
| `iframe` -> `ab-screencast` / `ab-popout` | Host spawns a fresh `gui-<hex>` agent-browser session at the current URL via `agentBrowserOpen`. `ab-popout` spawns headed in one shot, so the new surface mounts already popped out instead of flashing a headless launch. Hidden/inert without that capability. |
| `ab-screencast` <-> `ab-popout` | Same session, headed/headless relaunch in `AgentBrowserPanel`; preserves only the active URL. |
| `ab-*` -> `iframe` | Uses canonical `params.url`; if multiple tabs exist, requires the user to press `c` in the warning overlay because only the active tab survives. |

Source of truth: `lib/src/components/wall/AgentBrowserScreenModal.tsx`,
`agent-browser-surface-controller.ts` (`screenActions`, sync effects, pop-out/pop-in),
`Wall.tsx` (`onSwapRenderMode`), Storybook
`lib/src/stories/AgentBrowserScreenModal.stories.tsx`.

## Agent-Browser Renderer

**Dormouse is a viewer/client for the user's installed `agent-browser`** — it
neither bundles nor forks Chromium behavior. `dor ab` intercepts only the three
mutually exclusive identity flags `--key`, `--session` and `--surface`; every
other argument is forwarded to:

```sh
agent-browser --session <resolved-session> <args...>
```

The only rewrite is inside `open` / `goto` / `navigate`, where a Dormouse target
(`surface:N`, `:port`, `host:port`) is resolved to a URL first
(`docs/specs/dor-cli.md` → Browser Open Target Resolution). Everything else is
verbatim, including flags Dormouse does not model: `--headed` reaches a *live*
daemon as a no-op, since agent-browser fixes headed/headless at daemon launch,
and only pop-out's kill-then-relaunch changes the mode.

The binary is resolved from `DORMOUSE_AGENT_BROWSER_BIN` or `PATH`. If present,
`dor ab` resolves an absolute `binaryPath` and passes it to the host, because GUI
hosts may not share the terminal's shell PATH. **Both `dor ab` and the host must
spawn `agent-browser` through `spawnAndCapture`** (`dor-lib-common`), never raw
`child_process`; the Windows `.cmd`-shim recipe applies even to that absolute
`binaryPath` (`docs/specs/dor-cli.md` → Spawning External Binaries).

Managed identity:

- Default is `--key default`.
- `--key <name>` maps to `dormouse.1.<name>` and must match
  `[A-Za-z0-9._-]+`.
- `--key`, raw `--session` and `--surface` are mutually exclusive.
- GUI-spawned sessions use `dormouse.1.gui-<hex>` and are not addressable by
  `--key`. They are reachable by `dor ab --surface <handle>`, which asks the
  host for the session bound to the Surface a handle names rather than deriving
  one from a key — the only address a GUI-minted session has (`docs/specs/dor-cli.md`
  → Agent-Browser Surface Addressing). **The host answers only for an
  agent-browser-rendered Surface**: web verbs stay renderMode-gated, so an
  `iframe`-rendered Surface has a browser but no session to drive.
- One agent-browser session maps to one Dormouse surface. Re-running `dor ab`
  for an existing session refreshes `wsPort`/`binaryPath` and reuses the pane.
  A `--surface`-addressed run normally does the same: it resolved against a
  surface already bound to that session. Not an invariant, though — the
  forwarded command and `stream status` run in between, so a surface killed or
  render-swapped in that window leaves the trailing request to mint a fresh
  pane.

Source of truth: `dor/src/commands/agent-browser.ts`,
`dor/src/commands/types.ts` (`AgentBrowserSurfaceRequest`,
`ResolveAgentBrowserSessionRequest`), `Wall.tsx` / `use-dor-control.ts`
(`findAgentBrowserSurface`, `surface.agentBrowser` and
`surface.resolveAgentBrowser` handling).

### Agent-Browser Connection

Each agent-browser surface's live client state lives in a surface-id-keyed
controller registry (`agent-browser-surface-controller.ts`, mirroring
`terminal-lifecycle.ts`); `AgentBrowserPanel` is a thin view that mounts a
canvas, feeds params/visibility, forwards DOM input, and subscribes to one
snapshot via `useSyncExternalStore`. The controller owns one
`AgentBrowserConnection` for `{ session, streamPort, binaryPath }` plus its
screenshot loop. **It is Surface-scoped, not panel-scoped**: it survives panel
unmount (minimize, layout churn, React StrictMode), so a minimize releases the
connection through the park path below rather than synchronously, while the
daemon/session stays alive and reattaches from persisted params. Client resources
are released only at pane kill or a render swap away from the renderer
(`disposeAgentBrowserSurfaceController` in `Wall.tsx`).

**A controller whose params carry no `session` must stay inert** — no connection,
no `stream status` query: [Pane Context Menu Connect](#pane-context-menu-connect)
depends on that inertness to keep the eager pane from racing the daemon boot, so
**never derive the session from `key` here**.

**Parking.** A Lath leaf is always mounted (no active-tab gating), so nothing
else stops a hidden pane's ~20Hz stream and per-pulse screenshot loop
(rationale). A pane that goes off-screen — or whose view unmounts (minimize) —
parks after a ~1s debounce, so a quick visibility flip or a StrictMode remount
doesn't thrash the connection: connection and screenshot loop are disposed while
the daemon/session stays alive, and daemon-side streaming stops on its own
because clients trigger it. Rules the park and recovery paths must not break:

- **Parking clears the "this stream port opened live" marker**, so a reattach
  that fails to reconnect can ask `stream status` and adopt a daemon port that
  changed while the pane was hidden.
- Becoming visible (or reattaching) reconnects and re-primes from the stream's
  re-broadcast frame/tabs: **an unpark keeps the last good frame on screen**
  rather than blanking to the placeholder, while a fresh reattach mounts a blank
  canvas and so shows the placeholder until the first screenshot.
- **Never park a popped-out pane** — its stream/CDP observer must keep running
  for window-close auto-revert, even while minimized.
- **Never set `AGENT_BROWSER_IDLE_TIMEOUT_MS`** for Dormouse-managed sessions:
  daemon self-exit when idle would defeat "alive while parked".
- **Never query the daemon mid-relaunch** — see [Pop-Out](#pop-out).

The stream WebSocket provides frame pulses + status, tab snapshots, and native
`input_mouse` / `input_keyboard` input.

**Two-stage paint.** Dormouse paints a changed stream JPEG immediately as a
**provisional frame** — for the first image, and for 250ms after pointer input
(continuous movement extends the window) — then replaces it with a crisp
device-resolution screenshot through the host's `agentBrowserScreenshot`, so
pointer feedback stays aligned with the live cursor while the resting image stays
sharp on HiDPI. The provisional frame is CSS-resolution because Chromium's
`Page.startScreencast` captures in DIP with no DPR knob. Rules that keep the two
paths honest (rationale):

- **Both are latest-only**: a newer stream pulse cancels an older provisional
  decode, and a provisional paint during an in-flight crisp capture marks that
  capture stale so it cannot overwrite the newer responsive pixels.
- **The loop must start no capture inside the provisional window** — every one
  would be superseded before it resolved — and defers to the window's end for one
  settled shot. Continued pointer input pushes the window out, re-arming the wait.
- **A capture dropped as stale must leave the loop dirty**, because nothing will
  necessarily pulse it again. An unpainted pulse alone does not suppress a crisp
  draw, so idle animated pages still update.
- Byte-identical daemon heartbeat frames are dropped before either path, and
  byte-identical crisp captures skip decode/draw. **That byte-dedup assumes the
  crisp loop is the only canvas writer, so anything else painting must bump the
  draw generation** folded into its key — re-attach does (a fresh canvas mounts
  blank), and so does every provisional paint; otherwise a resting page whose
  crisp bytes match the last crisp draw dedups to a no-op and strands the pane on
  the blurry frame.
- **A host without `agentBrowserScreenshot` paints every changed provisional
  frame as its final image** rather than showing only the placeholder.

The high-rate `[ab-panel]`/`[agent-browser]` stream and screenshot console
diagnostics sit behind the `dormouse.flags.abDebugLogs` localStorage flag, read
once at module load (reload to apply); the connection's `debugSnapshot()` ring is
always on as the post-hoc tool.

Input rules:

- **Canvas pointer coordinates map through one width-derived scale on both
  axes**; the frame/device heights would stretch input when a stream frame is
  shorter than the viewport. Source of truth: `toDevice` in
  `AgentBrowserPanel.tsx`.
- `input_keyboard.text` is always sent; non-text keys use `text: ""`.
- **`windowsVirtualKeyCode` comes from a real key map, never
  `key.charCodeAt(0)`** (`.` is char 46 = VK_DELETE, so periods would otherwise
  become Delete presses).
- Local paste is replayed as per-character key input.
- macOS select-all/copy/cut use the purpose-built host `agentBrowserEdit`
  channel. Undo/redo is not emulated.

Tabs live inside the agent-browser surface: the header is integrated for one tab,
the in-body tab strip appears for two or more, and select/close actions go
through `agentBrowserCommand`.

Source of truth: `lib/src/components/wall/AgentBrowserPanel.tsx`,
`agent-browser-surface-controller.ts`, `agent-browser-connection.ts`,
`agent-browser-screenshot-loop.ts`, `agent-browser-input.ts`,
`agent-browser-tab.ts`, `use-surface-visibility.ts`, and their tests.

### Pop-Out

`ab-popout` relaunches the same session headed, because Chrome fixes
headed/headless at daemon launch. The pane becomes a stub with Pop back in, and
optionally Bring to front if a host implements `agentBrowserBringToFront`.

**State carried in v1 is only the active non-blank URL**: other tabs, DOM state,
scroll, form inputs, session storage, and cookies/logins do not survive the
relaunch.

Host sequence: run `close`, **then terminate the daemon by its pid file**
(`$AGENT_BROWSER_SOCKET_DIR/<session>.pid`, default `~/.agent-browser`) **and
wait for it to exit** — without that the relaunch reattaches to the live daemon
and silently stays in the old mode — then reopen and read a new stream port.
**Never query the daemon during the close/reopen gap**, host and controller
park/recovery paths alike: a `stream status` or tab query there spawns a
competing blank daemon, which is why Dormouse supplies the active-tab URL and the
host trusts it rather than asking. After reopening, the host best-effort closes
any stray `about:blank` tab the close+reopen race left behind, **but only while a
real page is open**, so it never closes the sole tab (rationale).

While popped out, Dormouse keeps a stream/CDP observer so URL/header state follows
same-tab navigation and so a headed window close can auto-revert to headless.
**Hosts must close tracked popped-out sessions on shutdown** to avoid orphan
headed windows.

Source of truth: `agent-browser-surface-controller.ts` (pop-out state, CDP
observer, auto-revert), `lib/src/host/agent-browser-host.ts` (`popOut`, `popIn`,
`killDaemon`, `closePoppedOut`), VS Code/standalone shutdown wiring.

### Agent-Browser Host Capabilities

The `PlatformAdapter` methods are optional. The shared implementation is
`lib/src/host/agent-browser-host.ts`; VS Code imports it directly and standalone
runs the bundled copy through the sidecar/Rust adapter.

| Method | Contract |
| --- | --- |
| `agentBrowserCommand` | Allowlisted CLI subcommands — `AGENT_BROWSER_ALLOWED_SUBCOMMANDS` (`lib/src/lib/platform/types.ts`) is the allowlist; host-side `get` is further limited to `get cdp-url`. |
| `agentBrowserScreenshot` | One device-resolution JPEG/PNG frame. VS Code structured-clones the bytes to the webview; standalone hands Rust the capture's temp-file **path** over the sidecar stdio and Rust reads the file itself, so image bytes never ride the JSON-lines pipe shared with PTY traffic. |
| `agentBrowserStreamStatus` | Current stream port, for stale-`wsPort` recovery. |
| `agentBrowserEdit` | select-all/copy/cut via fixed host-owned JS and an OS clipboard write. |
| `getAgentBrowserStreamUrl` | Direct stream URL, or the VS Code relay URL. |
| `agentBrowserOpen` | Spawn a GUI-owned session for iframe -> agent-browser. |
| `agentBrowserPopOut` / `agentBrowserPopIn` | Headed/headless relaunch. |
| `agentBrowserBringToFront` | Optional; no real host implements it today. |

**VS Code must reach the stream through a loopback relay** — the agent-browser
stream server rejects `vscode-webview://` origins. The relay grants one
single-use, short-TTL token bound to one stream port, and strips the Origin
header. Standalone connects directly.

Source of truth: `lib/src/lib/platform/types.ts`,
`lib/src/host/agent-browser-host.ts`, `vscode-ext/src/agent-browser-host.ts`,
`vscode-ext/src/webview-html.ts`, `standalone/src/tauri-adapter.ts`,
`standalone/src-tauri/src/lib.rs`, `standalone/sidecar/main.js`.

## Iframe Renderer

`dor iframe <url>` frames the page's own DOM: zero-lag and good for local human
inspection, but agents cannot drive or read it the way they can agent-browser.

On hosts with `createIframeProxyUrl`, `IframePanel` frames a per-surface loopback
proxy URL; without it, it falls back to a raw uninstrumented iframe.

The proxy instruments any `http://` upstream — loopback and remote alike:

- HTTP (any host): rewrite the request headers, strip the response's framing +
  hop-by-hop headers, inject the shim into HTML, pass through HTTP and WebSocket
  traffic. **A site's "do not embed" is overridden, not obeyed**: the embed is
  the user's own `dor iframe`, not a third party framing the site to deceive its
  user — the same trust boundary as the agent-browser renderer. (JS framebusting
  is neutralized separately, by the sandbox below.)
- Unreachable / timed-out upstream: served Dormouse error page (distinct pages
  for "couldn't connect" and "didn't respond in 30s of socket idle").
- HTTPS: synchronous `scheme` failure in the panel with a `dor ab` hint —
  agent-browser is the path for pages that need real HTTPS or a login.
- **Link-local / cloud-metadata address: refused (`scheme`)** — an SSRF guard
  that stands regardless of the loosened framing policy. **Canonicalize every
  equivalent spelling** (decimal/octal/hex, short forms, IPv4-mapped IPv6) before
  range-checking, so `0xA9FEA9FE` and `::ffff:169.254.169.254` are caught too.

What is rewritten, exactly:

| Direction | Header | Treatment |
| --- | --- | --- |
| request | `Host` | set to the upstream host |
| request | `Origin` | set to the upstream origin **only** when it is the proxy's own origin; otherwise forwarded untouched (absent stays absent) |
| request | `Referer` | proxy origin substituted for the upstream origin |
| request | `Accept-Encoding` | deleted, so HTML comes back identity for rewriting |
| response | `X-Frame-Options`, `Content-Security-Policy`, `Content-Security-Policy-Report-Only` | dropped **whole**, not per-directive — the injected shim is an inline script, so a surviving `script-src` would block it as surely as `frame-ancestors` blocks the frame |
| response | hop-by-hop (RFC 7230 §6.1) | dropped |
| response | `Location` | upstream origin rewritten back to the proxy origin, so a redirect doesn't bounce the frame at the un-instrumented upstream |
| response body | `<meta http-equiv="content-security-policy">` | removed, for the same reason as the header |

**One dedicated `127.0.0.1:0` server per grant, with no token in the path**: the
dedicated origin is the grant boundary, and it preserves root-relative
resources/client routers without body URL rewriting. Grants have a sliding idle
TTL and a hard cap; **a request refused by the `Host` check must not refresh the
TTL**, so a stranger cannot hold one open.

Current limits:

- Absolute-origin subresources such as `http://localhost:5173/...` and
  `ws://localhost:5173/...` bypass the proxy — acceptable for loopback, but those
  resources are not instrumented.
- The shim reclaims only Dormouse control messages; all ordinary keyboard and
  pointer interaction stays inside the frame by design.
- Killed iframe panes wait for the proxy idle sweep until the generic
  per-surface teardown hook exists.

Source of truth: `lib/src/components/wall/IframePanel.tsx`,
`lib/src/host/iframe-proxy.ts`, `lib/src/host/iframe-proxy-rewrite.ts`
(`STRIP_RESPONSE_HEADERS`, `instrumentHtml`, `isBlockedAddress`),
`lib/src/lib/platform/iframe-proxy-types.ts`, and proxy tests.

### Iframe Shim

**The injected shim is fixed Dormouse-owned code, never user-provided eval.** It
posts only these messages to the parent:

- `leader`: dual-tap Meta/Shift leader chord.
- `pointerdown`: genuine click inside the frame, used to select/focus the pane.
- `location`: same-frame navigation after history/hash/page events, and after a
  same-frame anchor click that the page did not cancel.
- `open-window`: intercepted `target=_blank` anchor or `window.open` URL.

**Parent listeners must validate the message origin against live proxy grants.**
Leader messages feed the same Wall command-mode exit path as in-document dual-tap
handling. `IframePanel` maps proxy-origin `location` URLs back to upstream URLs
for chrome/history without reloading the frame.

New-tab requests show an overlay prompt: accept opens a new browser pane beside
the current one, cancel drops it. The shipped prompt does not directly switch the
current pane to agent-browser.

Source of truth: `IFRAME_SHIM` in
`lib/src/host/iframe-proxy-rewrite.ts`,
`lib/src/lib/iframe-proxy-registry.ts`,
`lib/src/components/wall/use-wall-keyboard.ts`, `IframePanel.tsx`.

### Iframe Focus And Rendering Notes

- Cross-origin iframe focus blurs the parent window while `document.hasFocus()`
  remains true; **focus code must distinguish this from app backgrounding**.
- Proxied frames use shim `pointerdown` for click adoption. Raw fallback uses the
  older `window.blur` + active iframe heuristic.
- `registerSurfaceFocusHandle` focuses/blurs the iframe element like other
  surfaces.
- `IframePanel` applies `transform: translateZ(0)` to its immediate container to
  avoid Chromium out-of-process iframe pointer offsets from a far-away
  compositing/containing ancestor.
- **The iframe `sandbox` omits `allow-top-navigation`** to block framebusting,
  while allowing scripts, same-origin (within the proxy origin), forms, popups,
  modals, and downloads. Device/clipboard permissions ride the separate `allow`
  attribute.

Source of truth: `IframePanel.tsx`, `lib/src/components/wall/use-window-focused.ts`,
`lib/src/lib/terminal-lifecycle.ts` (`registerSurfaceFocusHandle`).

## Iframe Host Capability And CSP

The optional `PlatformAdapter.createIframeProxyUrl` method and
`IframeProxyResult` union are canonical in `lib/src/lib/platform/types.ts` and
`lib/src/lib/platform/iframe-proxy-types.ts`.

Reachability is diagnosed lazily by served error pages after the iframe loads the
proxy URL, and frame refusal is not diagnosed at all — any http upstream is
framed with its frame-blocking headers stripped — so v1 mostly returns `ok` or
`scheme`.

VS Code routes this through webview request/response messages to
`vscode-ext/src/iframe-proxy-host.ts`; standalone routes through
`standalone/src/tauri-adapter.ts` -> `standalone/src-tauri/src/lib.rs` ->
sidecar `iframe:createProxyUrl`.

The VS Code webview CSP must allow loopback frames:

```txt
frame-src http://127.0.0.1:* http://localhost:*
```

Security boundaries:

- the proxy binds loopback only — a mitigation, **not** the boundary; the two
  gates below are,
- **`Host` must name the grant's own loopback port**, on the request and upgrade
  paths alike, so DNS rebinding fails,
- **the `Origin` rewrite applies only to a caller the proxy itself served**,
- each grant fronts exactly one upstream,
- no user script is injected,
- link-local/cloud-metadata ranges are blocked,
- every other user-supplied `http://` target is trusted as the user's command
  and framed with its response CSP and `X-Frame-Options` dropped (the embed is
  the user's own, not third-party clickjacking). The cost is real: inside the
  frame the upstream loses its own XSS policy for the duration of the embed.

**Why the `Origin` rewrite is conditional.** Presenting a request as coming from
the upstream's own origin is the proxy *vouching* for it, which is what
origin-aware dev servers rely on. The per-grant ephemeral port is not a secret —
the range scans in seconds — so vouching unconditionally would let any page in
the user's browser POST here and have its `Origin: https://evil.example`
relabelled as the upstream's own, defeating exactly the check the rewrite exists
to satisfy. It matters most on `handleUpgrade`: WebSockets are not subject to
CORS, so a laundered `Origin` yields a *readable* socket to a dev server or
`openvscode-server` that would have refused the real one. A foreign `Origin` is
forwarded untouched rather than blocked, so the upstream applies its own policy
and the proxy grants nothing that hitting the upstream's port directly would not.
An absent `Origin` stays absent — an ordinary top-level navigation or same-origin
GET. `Referer` needs no such test: it only substitutes the proxy's own origin.
The shared rule for all of Dormouse's loopback listeners lives in
`lib/src/host/loopback-guard.ts`; `SECURITY.md` → "Loopback Listeners" audits it.

Source of truth: `lib/src/lib/platform/iframe-proxy-types.ts`,
`lib/src/lib/platform/types.ts`,
`lib/src/lib/platform/vscode-adapter.ts`, `vscode-ext/src/message-types.ts`,
`vscode-ext/src/message-router.ts`, `vscode-ext/src/webview-html.ts`,
`standalone/src/tauri-adapter.ts`, `lib/src/host/iframe-proxy-rewrite.ts`.

## Future

- Stable agent-browser profile/state persistence so pop-out preserves logins,
  cookies, tabs, DOM state, and scroll.
- CLI affordance to re-engage Dormouse sync-to-pane.
- Upstream support for stream keyboard `commands`, replacing the host edit
  workaround and enabling undo/redo.
- General per-surface teardown hook for iframe proxy grants and future
  Dormouse-owned backend processes. (Agent-browser surfaces already dispose their
  controller on kill/swap; iframe proxy grants still wait on the idle sweep.)
- Process-backed targets are owned by the **dor-tools** scope
  (`docs/specs/dor-tool.md` `## Future`), which subsumes the plugin/backend
  target axis formerly staged here. (That scope's C1 phase also depends on the
  general per-surface teardown hook above.)
- Optional terminal-side "this port is viewed by surface:N" indicator.
- Replace the spawn-per-shot CLI screenshot with a persistent host-side CDP
  capture channel. Measured against agent-browser 0.27.3 (headless, attach
  dance + correct-target selection): naive `Page.captureScreenshot` is
  byte-identical to the CLI at DPR 1 and tracks external `set viewport`
  automatically, but returns CSS-resolution frames at DPR>1 — the crisp-HiDPI
  point of this path — unless the client re-applies
  `Emulation.setDeviceMetricsOverride`, which Dormouse can only do correctly
  while sync-to-pane owns the values (an external `set device`/`set viewport`
  DPR is unrecoverable from frames). `captureBeyondViewport:true` bypasses
  emulation and crashed the headless daemon in testing; `clip.scale` returns
  blank frames. Adopt only with a daemon-side answer (e.g. an upstream verb
  exposing current viewport+DPR, or a daemon-owned capture channel).
