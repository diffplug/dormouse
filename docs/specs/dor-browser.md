# Dor Browser Surface

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary
> (a browser pane is a **browser Surface**), and `docs/specs/dor-cli.md` for the
> shared `dor` CLI, surface handle model, and host control plumbing this surface
> builds on.

Dormouse has one dockview component for web content: `BrowserPanel`, persisted as
`surfaceType: 'browser'` with a swappable `renderMode`.

Entry points:

- `dor ab ...` / `dor agent-browser ...` forwards to the user's own
  `agent-browser` binary and binds that agent-browser session to a browser pane.
  Typical navigation is `dor ab open <url>`.
- `dor iframe <url>` opens an absolute `http://` or `https://` URL in the iframe
  renderer. The proxy currently instruments only `http://` upstreams; `https://`
  is accepted by the CLI but shown as an unproxyable scheme in the pane.

Two independent axes define a browser pane:

| Axis | Values |
| --- | --- |
| Target | A bare URL, or a future Dormouse-owned backend process |
| Render | `ab-screencast`, `ab-popout`, `iframe` |

The render axis is a pane parameter, not a separate surface type. The `dor` CLI
still reports `iframe` or `agent-browser` as a legacy/informative surface type;
that is derived from `renderMode`.

Source of truth: `lib/src/components/wall/BrowserPanel.tsx`,
`lib/src/components/wall/browser-surface.ts`, `lib/src/components/Wall.tsx`
(`surfaceTypeFromParams`, `componentForSurfaceType`, `createContentSurface`).

## Canonical Params

The persisted pane params are flat:

```ts
type BrowserPanelParams = {
  surfaceType?: 'browser';
  renderMode?: 'ab-screencast' | 'ab-popout' | 'iframe';
  url?: string;
  session?: string;
  key?: string;
  wsPort?: number;
  binaryPath?: string;
  syncEngaged?: boolean;
  poppedOut?: boolean; // legacy migration only
};
```

Invariants:

- `renderMode` is canonical. Legacy params (`surfaceType: 'iframe'`,
  `surfaceType: 'agent-browser'`, `poppedOut`) are migrated by
  `resolveRenderMode`.
- `url` is the canonical target across render swaps and relaunches. Agent-browser
  mirrors the newest non-blank active tab URL into params; iframe persists only
  navigations initiated by Dormouse chrome.
- Agent-browser session state is flat (`session`, `wsPort`, `binaryPath`,
  `syncEngaged`, `key`), not nested.
- Every browser panel uses dockview `renderer: 'always'`, because moving iframe
  DOM reloads it and moving the screencast canvas mid-click breaks click
  synthesis.

Source of truth: `BrowserPanel.tsx`, `browser-surface.ts`, `Wall.tsx`
(`rendererForParams`, `replaceSurface`), `AgentBrowserPanel.tsx`
(`rememberRestorableUrl`, URL mirror), `IframePanel.tsx` (`applyFrameUrl`).

## Placement And Lifetime

Both CLI entry points use the same content-surface placement rule in
`Wall.tsx:createContentSurface`: replace an untouched terminal caller in place;
otherwise split next to the reference surface. `dor iframe` also accepts
`--surface`, `--minimize`, and `--json`.

Surface lifetime owns backing resources:

- Killing an agent-browser-rendered pane marks the session closed and runs
  `agent-browser close` through `closeAgentBrowserSession`.
- Swapping away from an agent-browser renderer closes the old session through
  the same path.
- A popped-out window closing is normally auto-reverted to headless, but the
  closed-session mark prevents Dormouse-initiated kill/swap from resurrecting it.
- Iframe proxy grants are currently reclaimed by the proxy idle sweep, not by an
  immediate per-surface teardown hook.

Source of truth: `Wall.tsx` (`killPaneImmediately`, `closeAgentBrowserSession`,
`replaceSurface`), `lib/src/components/wall/agent-browser-sessions.ts`,
`lib/src/host/iframe-proxy.ts` (`GRANT_IDLE_TTL_MS`, `MAX_GRANTS`).

## Browser Chrome

Browser chrome is keyed by presence of a screen controller. Agent-browser panels
register one, and iframe panels now register one unconditionally, so `dor iframe`
gets the same browser header on every host. Render swapping from iframe to
agent-browser is gated separately by host capabilities.

Header contract:

- Far-left chip opens the Display modal and reflects the render backend:
  `iframe` frame glyph, `ab-popout` external-window glyph, `ab-screencast`
  link/lock depending on whether viewport CSS size matches pane CSS size.
- Primary text is URL-oriented: host+path, with query omitted in the live header.
  HTML title is tooltip/secondary state.
- Clicking the URL opens an inline editor. `normalizeNavUrl` keeps explicit
  schemes, uses `http://` for bare loopback hosts, and `https://` otherwise.
- Back, forward, and reload are always enabled. Agent-browser sends native
  `back` / `forward` / `reload`; iframe uses parent-side history and re-resolves
  the proxy on reload/back/forward.
- Non-default managed `--key` renders as its own quiet badge, never as a title
  prefix. Raw `--session` and iframe surfaces show no key badge.
- Split/zoom buttons hide below `420px`; nav buttons hide below `360px`; minimize
  and kill remain.

Source of truth: `lib/src/components/wall/SurfacePaneHeader.tsx`,
`lib/src/components/wall/agent-browser-screen.ts`,
`lib/src/components/wall/browser-url.ts`, Storybook
`lib/src/stories/BrowserChromeHeader.stories.tsx`.

## Dev-Server Chip

For loopback URLs (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), the header
registers interest in the URL port. The Wall scans terminal panes and minimized
doors via `PlatformAdapter.getOpenPorts(id)` and shows a chip only when exactly
one terminal owns that port.

Matching is intentionally narrow: a process bound to loopback
(`127.0.0.1`, `::1`) or any-interface (`0.0.0.0`, `::`) serves localhost; a
specific non-loopback bind does not. Scanning is debounced, idle-scheduled, and
polls only while a wanted port is still unmatched. Reload revalidates
optimistically.

Source of truth: `lib/src/components/wall/use-dev-server-ports.ts`,
`lib/src/components/wall/agent-browser-ports.ts`,
`lib/src/components/wall/browser-url.ts`.

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
- Fixed: `set viewport <w> <h> <dpr>`.
- Device: `set device <name>` from the modal's fixed registry.

Sync state is the only Dormouse-specific resolution state that persists
(`syncEngaged`). Device/custom viewport state lives in agent-browser itself.
`SYNCED`/`SCALED` is derived from viewport CSS dimensions versus pane CSS
dimensions; DPR is issued but not part of the comparison because stream frames
are CSS-resolution. Sync coexists with external `set viewport`/`set device`
last-writer-wins: Dormouse disengages sync (→ `SCALED`) only after a frame first
confirms its own issued size landed, so a resize transient is not mistaken for an
external override.

Swap behavior:

| From -> To | Behavior |
| --- | --- |
| `iframe` -> `ab-screencast` / `ab-popout` | Host spawns a fresh `gui-<hex>` agent-browser session at the current URL via `agentBrowserOpen`. Hidden/inert without that capability. |
| `ab-screencast` <-> `ab-popout` | Same session, headed/headless relaunch in `AgentBrowserPanel`; preserves only the active URL. |
| `ab-*` -> `iframe` | Uses canonical `params.url`; if multiple tabs exist, requires the user to press `c` in the warning overlay because only the active tab survives. |

Source of truth: `lib/src/components/wall/AgentBrowserScreenModal.tsx`,
`AgentBrowserPanel.tsx` (`screenActions`, sync effects, pop-out/pop-in),
`Wall.tsx` (`onSwapRenderMode`), Storybook
`lib/src/stories/AgentBrowserScreenModal.stories.tsx`.

## Agent-Browser Renderer

Dormouse is a viewer/client for the user's installed `agent-browser`; it does
not bundle or fork Chromium behavior. `dor ab` intercepts only `--key` and
`--session`; every other argument is forwarded verbatim to:

```sh
agent-browser --session <resolved-session> <args...>
```

The binary is resolved from `DORMOUSE_AGENT_BROWSER_BIN` or `PATH`. If present,
`dor ab` resolves an absolute `binaryPath` and passes it to the host because GUI
hosts may not share the terminal's shell PATH.

Both `dor ab` and the host spawn `agent-browser` through `cross-spawn`, never raw
`child_process` — on Windows it ships as a `.cmd` shim that a bare-name spawn
can't find (ENOENT) and Node ≥22 won't run directly (EINVAL), so even the
absolute `binaryPath` must go through it. See docs/specs/dor-cli.md → "Spawning
External Binaries".

Managed identity:

- Default is `--key default`.
- `--key <name>` maps to `dormouse.1.<name>` and must match
  `[A-Za-z0-9._-]+`.
- `--key` and raw `--session` are mutually exclusive.
- GUI-spawned sessions use `dormouse.1.gui-<hex>` and are not addressable by
  `--key`.
- One agent-browser session maps to one Dormouse surface. Re-running `dor ab`
  for an existing session refreshes `wsPort`/`binaryPath` and reuses the pane.

Source of truth: `dor/src/commands/agent-browser.ts`,
`dor/src/commands/types.ts` (`AgentBrowserSurfaceRequest`), `Wall.tsx`
(`findAgentBrowserSurface`, `surface.agentBrowser` handling).

### Agent-Browser Connection

Each visible agent-browser surface owns one `AgentBrowserConnection` for
`{ session, streamPort, binaryPath }`. Minimize unmounts the panel and disposes
the connection; the agent-browser daemon/session stays alive and reattaches from
persisted params.

Hidden-but-mounted panes park too. Browser panels use `renderer: 'always'`, so
an inactive dockview tab or a backgrounded window stays mounted and would keep
its ~20Hz stream plus per-pulse screenshot loop running for nothing. A pane that
goes off-screen parks after a ~1s debounce (so quick tab-flipping doesn't thrash
the connection): the connection and screenshot loop are disposed while the
daemon/session stays alive, and daemon-side frame streaming stops on its own
because clients trigger it. Becoming visible reconnects and re-primes from the
stream's re-broadcast frame/tabs (the last good frame is kept on screen across
the reconnect rather than blanking to the placeholder). Popped-out panes are
exempt from parking so their stream/CDP observer keeps running and window-close
auto-revert still works. Caveat: `AGENT_BROWSER_IDLE_TIMEOUT_MS` (daemon
self-exit when idle) would defeat "alive while parked" and must not be set for
Dormouse-managed sessions.

The stream WebSocket provides:

- frame pulses and status,
- tab snapshots,
- native `input_mouse` / `input_keyboard` input.

Dormouse does not render the stream JPEG by default. The screencast is
CSS-resolution only — Chromium's `Page.startScreencast` captures in DIP with no
DPR knob, so its frames upscale to mush on HiDPI; this is a Chromium limit, not
agent-browser's, so owning the CDP connection wouldn't change it. So Dormouse
treats frame messages as change pulses, captures a crisp device-resolution
screenshot through the host's `agentBrowserScreenshot`, and draws that to canvas
with latest-only backpressure. If the host cannot screenshot, it falls back to the
stream frame path.

Important input details:

- `input_keyboard.text` is always sent; non-text keys use `text: ""`.
- `windowsVirtualKeyCode` comes from a real key map, never `key.charCodeAt(0)`
  (`.` is char 46 = VK_DELETE, so periods would otherwise become Delete presses).
- Local paste is replayed as per-character key input.
- macOS select-all/copy/cut use the purpose-built host `agentBrowserEdit`
  channel. Undo/redo is not emulated.

Tabs live inside the agent-browser surface. The header is integrated for one tab;
the in-body tab strip appears for two or more. Tab select/close actions go
through `agentBrowserCommand`.

Source of truth: `lib/src/components/wall/AgentBrowserPanel.tsx`,
`agent-browser-connection.ts`, `agent-browser-screenshot-loop.ts`,
`agent-browser-input.ts`, `agent-browser-tab.ts`,
`use-surface-visibility.ts`, and their tests.

### Pop-Out

`ab-popout` relaunches the same session headed because Chrome headed/headless is
fixed at daemon launch. The pane becomes a stub with Pop back in, and optionally
Bring to front if a host implements `agentBrowserBringToFront`.

State carried in v1: only the active non-blank URL. Other tabs, DOM state,
scroll, form inputs, session storage, and cookies/logins are not preserved across
the relaunch. The host kills the daemon before reopening so the headed/headless
mode actually changes, then reads a new stream port. Dormouse supplies that
active-tab URL; the host trusts it and does not query the daemon during the
close/reopen gap, because a `stream status` or tab query there can spawn a
competing blank daemon.

While popped out, Dormouse keeps a stream/CDP observer so URL/header state follows
same-tab navigation and so a headed window close can auto-revert to headless.
Hosts close tracked popped-out sessions on shutdown to avoid orphan headed
windows.

Source of truth: `AgentBrowserPanel.tsx` (pop-out state, CDP observer,
auto-revert), `lib/src/host/agent-browser-host.ts` (`popOut`, `popIn`,
`closePoppedOut`), VS Code/standalone shutdown wiring.

### Agent-Browser Host Capabilities

The `PlatformAdapter` methods are optional. The shared implementation is
`lib/src/host/agent-browser-host.ts`; VS Code imports it directly and standalone
runs the bundled copy through the sidecar/Rust adapter.

Capabilities:

- `agentBrowserCommand`: allowlisted CLI subcommands. Source of truth for the
  allowlist is `AGENT_BROWSER_ALLOWED_SUBCOMMANDS` in
  `lib/src/lib/platform/types.ts`; host-side `get` is further limited to
  `get cdp-url`.
- `agentBrowserScreenshot`: one device-resolution JPEG/PNG frame.
- `agentBrowserStreamStatus`: current stream port for stale-`wsPort` recovery.
- `agentBrowserEdit`: select-all/copy/cut via fixed host-owned JS and OS
  clipboard write.
- `getAgentBrowserStreamUrl`: direct stream URL or VS Code relay URL.
- `agentBrowserOpen`: spawn a GUI-owned session for iframe -> agent-browser.
- `agentBrowserPopOut` / `agentBrowserPopIn`: headed/headless relaunch.
- `agentBrowserBringToFront`: optional, currently not implemented by the real
  hosts.

VS Code needs a loopback relay for the stream because the agent-browser stream
server rejects `vscode-webview://` origins. The relay grants one authorized
stream port/token and strips the Origin header. Standalone connects directly.

Source of truth: `lib/src/lib/platform/types.ts`,
`lib/src/host/agent-browser-host.ts`, `vscode-ext/src/agent-browser-host.ts`,
`vscode-ext/src/webview-html.ts`, `standalone/src/tauri-adapter.ts`,
`standalone/src-tauri/src/lib.rs`, `standalone/sidecar/main.js`.

## Iframe Renderer

`dor iframe <url>` frames the page's own DOM. It is zero-lag and good for local
human inspection, but agents cannot drive/read it like agent-browser.

On hosts with `createIframeProxyUrl`, `IframePanel` frames a per-surface loopback
proxy URL. On hosts without it, it falls back to a raw uninstrumented iframe.

The proxy instruments `http://` upstreams only:

- Loopback HTTP: strip frame-blocking headers/CSP, inject the shim, pass through
  HTTP and WebSocket traffic.
- Remote HTTP that permits framing: best-effort proxy with shim.
- Remote HTTP that refuses framing: served Dormouse error page with `dor ab`
  hint, not forced embedding.
- Unreachable upstream: served Dormouse error page.
- HTTPS: synchronous `scheme` failure in the panel with `dor ab` hint.

The proxy uses one dedicated `127.0.0.1:0` server per grant. There is no token in
the path; the dedicated origin is the grant boundary and preserves root-relative
resources/client routers without body URL rewriting. Grants have a sliding idle
TTL and a hard cap.

Current limits:

- Absolute-origin subresources such as `http://localhost:5173/...` and
  `ws://localhost:5173/...` bypass the proxy. This is acceptable for loopback,
  but those resources are not instrumented.
- The shim reclaims only Dormouse control messages. All ordinary keyboard and
  pointer interaction stays inside the frame by design.
- Killed iframe panes wait for the proxy idle sweep until the generic
  per-surface teardown hook exists.

Source of truth: `lib/src/components/wall/IframePanel.tsx`,
`lib/src/host/iframe-proxy.ts`, `lib/src/host/iframe-proxy-rewrite.ts`,
`lib/src/lib/platform/iframe-proxy-types.ts`, and proxy tests.

### Iframe Shim

The injected shim is fixed Dormouse-owned code, not user-provided eval. It posts
only these messages to the parent:

- `leader`: dual-tap Meta/Shift leader chord.
- `pointerdown`: genuine click inside the frame, used to select/focus the pane.
- `location`: same-frame navigation after history/hash/page events.
- `open-window`: intercepted `target=_blank` or `window.open` URL.

Parent listeners validate the message origin against live proxy grants. Leader
messages feed the same Wall command-mode exit path as in-document dual-tap
handling. `IframePanel` maps proxy-origin `location` URLs back to upstream URLs
for chrome/history without reloading the frame.

New-tab requests show an overlay prompt. Accept opens a new browser pane beside
the current one; cancel drops it. The shipped prompt does not directly switch the
current pane to agent-browser.

Source of truth: `IFRAME_SHIM` in
`lib/src/host/iframe-proxy-rewrite.ts`,
`lib/src/lib/iframe-proxy-registry.ts`,
`lib/src/components/wall/use-wall-keyboard.ts`, `IframePanel.tsx`.

### Iframe Focus And Rendering Notes

- Cross-origin iframe focus blurs the parent window while `document.hasFocus()`
  remains true; focus code must distinguish this from app backgrounding.
- Proxied frames use shim `pointerdown` for click adoption. Raw fallback uses the
  older `window.blur` + active iframe heuristic.
- `registerSurfaceFocusHandle` focuses/blurs the iframe element like other
  surfaces.
- `IframePanel` applies `transform: translateZ(0)` to its immediate container to
  avoid Chromium out-of-process iframe pointer offsets caused by dockview
  containment.
- The iframe sandbox omits `allow-top-navigation` to block framebusting while
  allowing scripts, same-origin within the proxy origin, forms, popups, modals,
  downloads, and common device/clipboard permissions.

Source of truth: `IframePanel.tsx`, `lib/src/components/wall/use-window-focused.ts`,
`lib/src/lib/terminal-lifecycle.ts` (`registerSurfaceFocusHandle`).

## Iframe Host Capability And CSP

The optional adapter method is:

```ts
createIframeProxyUrl?(targetUrl: string): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string }
>;
```

Reachability and frame refusal are normally diagnosed lazily by served error
pages after the iframe loads the proxy URL, so v1 mostly returns `ok` or
`scheme`.

VS Code routes this through webview request/response messages to
`vscode-ext/src/iframe-proxy-host.ts`. Standalone routes through
`standalone/src/tauri-adapter.ts` -> `standalone/src-tauri/src/lib.rs` ->
sidecar `iframe:createProxyUrl`.

The VS Code webview CSP must allow loopback frames:

```txt
frame-src http://127.0.0.1:* http://localhost:*
```

Security boundaries:

- proxy binds loopback only,
- each grant fronts exactly one upstream,
- no user script is injected,
- refusing remote sites are diverted to an error page,
- link-local/cloud-metadata ranges are blocked,
- other user-supplied `http://` targets are trusted as the user's command.

Source of truth: `lib/src/lib/platform/types.ts`,
`lib/src/lib/platform/vscode-adapter.ts`, `vscode-ext/src/message-types.ts`,
`vscode-ext/src/message-router.ts`, `vscode-ext/src/webview-html.ts`,
`standalone/src/tauri-adapter.ts`, `lib/src/host/iframe-proxy-rewrite.ts`.

## Code Map

- CLI: `dor/src/commands/agent-browser.ts`, `dor/src/commands/iframe.ts`,
  `dor/src/commands/types.ts`.
- Shell/render swap/lifecycle: `lib/src/components/Wall.tsx`,
  `lib/src/components/wall/BrowserPanel.tsx`,
  `lib/src/components/wall/browser-surface.ts`.
- Chrome/modal: `SurfacePaneHeader.tsx`, `AgentBrowserScreenModal.tsx`,
  `agent-browser-screen.ts`, `browser-url.ts`.
- Agent-browser renderer: `AgentBrowserPanel.tsx`,
  `agent-browser-connection.ts`, `agent-browser-input.ts`,
  `agent-browser-screenshot-loop.ts`, `agent-browser-tab.ts`,
  `agent-browser-sessions.ts`.
- Iframe renderer/proxy: `IframePanel.tsx`, `iframe-proxy-registry.ts`,
  `lib/src/host/iframe-proxy.ts`, `lib/src/host/iframe-proxy-rewrite.ts`,
  `lib/src/lib/platform/iframe-proxy-types.ts`.
- Host adapters: `lib/src/host/agent-browser-host.ts`,
  `vscode-ext/src/agent-browser-host.ts`, `vscode-ext/src/iframe-proxy-host.ts`,
  `standalone/src/tauri-adapter.ts`, `standalone/src-tauri/src/lib.rs`,
  `standalone/sidecar/main.js`.

## Future Work

- Stable agent-browser profile/state persistence so pop-out preserves logins,
  cookies, tabs, DOM state, and scroll.
- CLI affordance to re-engage Dormouse sync-to-pane.
- Upstream support for stream keyboard `commands`, replacing the host edit
  workaround and enabling undo/redo.
- General per-surface teardown hook for iframe proxy grants and future
  Dormouse-owned backend processes.
- Plugin/backend target axis: spawn, health-check, proxy, and reap a local web
  process such as `openvscode-server`.
- Optional terminal-side "this port is viewed by surface:N" indicator.
