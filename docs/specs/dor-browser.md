# Dor Browser Surface

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary
> (a browser pane is a **browser Surface**), and `docs/specs/dor-cli.md` for the
> shared `dor` CLI, surface handle model, and host control plumbing this surface
> builds on.
> Owns the browser Surface end to end — params, chrome, both renderers, the
> iframe proxy boundary. Evidence behind the rules:
> [dor-browser.rationale.md](dor-browser.rationale.md).

One body component renders all web content: `BrowserPanel`, persisted as
`surfaceType: 'browser'` with a swappable `renderMode`. Two axes define a browser
pane — its **target** (today always a bare URL; process-backed targets belong to
the **dor-tools** scope, `docs/specs/dor-tool.md`) and its **render** mode
(`ab-screencast`, `ab-popout`, `iframe`). **Render is a pane parameter, never a
separate surface kind**; `docs/specs/glossary.md` owns the `kind` / `render_mode`
mapping.

Both entry points take a URL, a schemeless `host:port`, or a terminal Surface
handle (`docs/specs/dor-cli.md` → Browser Open Target Resolution):

- `dor ab ...` / `dor agent-browser ...` forwards to the user's own
  `agent-browser` binary and binds that session to a browser pane.
- `dor iframe <url>` uses the iframe renderer. The CLI accepts `https://`, but
  the proxy instruments `http://` upstreams only, so the pane reports an
  unproxyable scheme.

Source of truth: `lib/src/components/wall/BrowserPanel.tsx`,
`lib/src/components/wall/browser-surface.ts` (`resolveRenderMode`,
`surfaceKindFromParams`), `lib/src/components/wall/LathHost.tsx`
(`BODY_COMPONENTS`), `lib/src/components/Wall.tsx`
(`surfaceRenderModeFromParams`, `createContentSurface`).

## Canonical Params

Invariants on the flat persisted `BrowserPanelParams`:

- **`renderMode` is canonical**; an absent one resolves to `iframe`, never to a
  live agent-browser. **Only params may omit it** — a live `ScreenSnapshot`
  always carries one, so nothing defaults it a second time.
- **`url` is the canonical target** across render swaps and relaunches.
  Agent-browser mirrors the newest non-blank active tab URL into it; iframe
  persists only navigations initiated by Dormouse chrome.
- **Agent-browser session state is flat** (`session`, `wsPort`, `binaryPath`,
  `syncEngaged`, `key`), never nested. Pop-out is not a param — it derives from
  `renderMode` once, at controller construction.
- **Never move a browser Surface's DOM, and never let a minimize unmount it**
  (rationale): Lath never re-parents its leaf div, and a minimize **parks** it
  (`docs/specs/tiling-engine.md` → "Parked leaves"), so the document returns with
  scroll, form, and script state intact. A restart is still a cold load — only
  `url` persists.

Source of truth: `lib/src/components/wall/BrowserPanel.tsx` (`BrowserPanelParams`), `lib/src/components/wall/browser-surface.ts`,
`lib/src/components/Wall.tsx` (`replaceSurface`), `lib/src/components/wall/agent-browser-surface-controller.ts`
(`rememberRestorableUrl`), `lib/src/components/wall/IframePanel.tsx` (`applyFrameUrl`).

## Placement And Lifetime

**Both CLI entry points share one placement rule** (`createContentSurface`):
replace an untouched *terminal* caller in place, else split next to the reference
surface. **Never replace a reference that already has a browser** — web content is
not destroyed to make room. A replacement transfers the target Surface's
`surface:N` ref to the new browser Surface id. `dor iframe` also takes
`--surface`, `--minimize`, `--json`.

**Both open focus-neutrally**, like `dor ensure`, with one exception: replacing
the pane the user is currently selected on moves selection to the replacement
(`docs/specs/layout.md` corner case #6, which owns both halves).

Surface lifetime owns backing resources:

- **Minimizing parks the pane** — mounted and connected but invisible, with
  `useSurfaceVisibility` reporting it hidden, so a doored `ab-screencast` stops
  pulling frames while its daemon and socket stay up. **Killing a doored pane
  unparks it first**, so the parked DOM dies with the Surface.
- **Killing an agent-browser-rendered pane — or swapping away from that renderer
  — must mark the session closed, run `agent-browser close` through
  `closeAgentBrowserSession`, then dispose the surface controller**
  (`disposeAgentBrowserSurfaceController`) and every client resource it holds.
- A popped-out window closing normally auto-reverts to headless; **the
  closed-session mark keeps a Dormouse-initiated kill/swap from resurrecting
  it**.
- Iframe proxy grants are reclaimed by the proxy idle sweep, not a per-surface
  teardown hook.

Source of truth: `lib/src/components/Wall.tsx` (`createContentSurface`'s `focusNeutral`,
`settleAddSelection`, `killPaneImmediately`, `closeAgentBrowserSession`,
`replaceSurface`), `lib/src/components/wall/agent-browser-sessions.ts`,
`lib/src/components/wall/agent-browser-surface-controller.ts`,
`lib/src/host/iframe-proxy.ts` (`GRANT_IDLE_TTL_MS`, `MAX_GRANTS`).

## Browser Chrome

Chrome is keyed by a screen controller. **Both renderers must register one
unconditionally**; render swaps are separately host-gated.

Header contract:

- **Must open the Display modal from this capability-first identity**
  (rationale):

  | Display | Icon cluster |
  | --- | --- |
  | agent-browser resizes with pane (`syncEngaged`) | wide robot + frame corners |
  | agent-browser fixed size | wide robot + picture-in-picture |
  | agent-browser popout | wide robot + arrow-square-out |
  | iframe embed | frame corners only |

- **Must reuse this mapping in browser Doors** (`docs/specs/layout.md` →
  Baseboard owns the Door label rule).
- **Must show the URL as primary text:** host+path without query, or path behind
  a dev-server chip; the HTML title is its tooltip. An iframe surface's
  persisted title keeps the query.
- **Must open a pre-selected `InlineEditInput` from the URL.** Blur discards;
  `normalizeNavUrl` follows CLI scheme selection plus bare loopback → `http://`
  and bare remote → `https://` (rationale).
- **Must keep back/forward/reload enabled.** Agent-browser uses native commands;
  iframe uses parent history and re-resolves its proxy.
- **Must show non-default managed `--key` as a badge, never a title prefix.**
- **Must hide split/zoom below `420px` and nav below `360px`;** minimize and kill
  remain.

Source of truth: `lib/src/components/wall/SurfacePaneHeader.tsx`,
`lib/src/components/wall/agent-browser-screen.ts`,
`lib/src/components/wall/BrowserDisplayIcon.tsx`,
`lib/src/components/Door.tsx`,
`lib/src/components/wall/browser-url.ts`, Storybook
`lib/src/stories/BrowserChromeHeader.stories.tsx`,
`lib/src/stories/Baseboard.stories.tsx`.

## Dev-Server Chip

For loopback URLs (`localhost`, `*.localhost`, `127.0.0.1`, `::1`) the header
registers interest in the port. The Wall scans terminal panes and minimized doors
via `PlatformAdapter.getOpenPorts(id)` and **shows a chip only when exactly one
terminal owns that port**; zero or two-plus leave it unsettled, so a dev server
that starts later still matches. **Match only binds that serve localhost** —
loopback or any-interface (`0.0.0.0`, `::`), never a specific non-loopback bind.
Scanning is debounced, idle-scheduled, and polls only while a wanted port is
unmatched; reload revalidates optimistically.

Source of truth: `lib/src/components/wall/use-dev-server-ports.ts`,
`lib/src/components/wall/port-url.ts` (`servesLoopback`),
`lib/src/components/wall/agent-browser-ports.ts`, `lib/src/components/wall/browser-url.ts`.

## Pane Context Menu Connect

The terminal pane header's context menu (`docs/specs/layout.md` → Header context
menu) lists the ports a pane's process tree binds, using the **same** per-port
URL selection as `surface.resolveOpen` (`docs/specs/dor-cli.md` → Browser Open
Target Resolution). Activating a row — click, its `1`–`9` digit accelerator, or
`Enter` — reproduces `dor ab open <url>` against the **default** key/session,
reusing or creating that session's browser surface: the wall-side mirror of the
CLI flow, not the control plane. Host-gated on `agentBrowserCommand`; without it
the rows are inert labels.

**Activation reveals its surface.** Unlike focus-neutral `dor ab`, a menu row is
the human asking to see and control that browser, so every arm of the lookup
below **must end by selecting the surface in passthrough mode**, reattaching it
first when minimized, exactly as clicking its Door chip does — including from
command mode with `>` (rationale).

**Instant create.** The click is fire-and-forget: the menu closes at once and the
pane appears **before** `agent-browser open` runs (rationale).

- The eager surface is placed synchronously and **must carry no `session`** — a
  session-less `ab-screencast` pane is inert, so it cannot race the daemon boot
  (rationale). It carries `key: 'default'` and the target `url`, and shows a
  `Connecting to browser session…` placeholder rather than the idle
  `run dor ab open <url>` line (rationale).
- `agent-browser open <url>` runs, then a best-effort `stream status`.
- The pane receives `{session, wsPort, binaryPath}` as **one** params refresh
  (rationale). A failed `open` still hands over the `session` so the placeholder
  names it, and logs rather than reporting into the closed menu.

The lookup reuses before it creates: (a) a surface bound to the default session,
else (b) a still-booting session-less `key: 'default'` pane, so a double-click
doesn't spawn two panes, else (c) a fresh session-less pane. Accepted edge: a
pane persisted mid-boot restores session-less and stays a `Connecting…`
placeholder — kill it, or connect again (arm (b) reuses it).

Source of truth: `lib/src/components/wall/connect-port.ts`
(`connectPortToDefaultBrowser`, `ensureEagerSurface`), `lib/src/components/wall/use-dor-control.ts`
(`useDorControl`'s `connectPort` and `updateSurfaceParams`, shared with
`ensureAgentBrowserSurface`), `lib/src/components/Wall.tsx` (`revealSurface`), `lib/src/components/wall/port-url.ts`
(`listenerUrlsByPort`), `lib/src/components/wall/PaneHeaderContextMenu.tsx`.

## Display Modal And Render Swaps

**Must make the Display modal the sole GUI for render mode and screencast
resolution.** It splits the Browser Chrome icon pair across its nesting: the
robot rides the `ab-screencast` parent, each nested resolution row carrying only
its presentation glyph.

**Must hide the popout option where the host lacks `agentBrowserPopOut`.**

Resolution controls apply only to `ab-screencast`, as GUI wrappers around native
commands: **Resize with pane** is Dormouse-owned sync issuing
`set viewport <paneW> <paneH> <displayDpr>` on resize; **Fixed** issues
`set viewport <w> <h> <dpr>` or `set device <name>` from the modal's registry.

**Only `syncEngaged` persists** — device/custom viewport state lives in
agent-browser itself. `SYNCED`/`SCALED` derives from viewport versus pane CSS
dimensions, DPR issued but not compared because stream frames are CSS-resolution.
Sync coexists with external `set viewport`/`set device` last-writer-wins:
**disengage sync (→ `SCALED`) only after a frame confirms Dormouse's own issued
size landed**, so a resize transient is not read as an external override.

| From -> To | Behavior |
| --- | --- |
| `iframe` -> `ab-screencast` / `ab-popout` | **The pane swaps at once** to a session-less agent-browser pane — inert, so it cannot race the boot (rationale) — while the host spawns a fresh `gui-<hex>` session at the current URL via `agentBrowserOpen` and hands over `{session, wsPort, binaryPath}` as **one** params refresh. `ab-popout` spawns headed in one shot, so the surface mounts already popped out. A spawn that rejects or yields no session restores the iframe; a Surface minimized meanwhile receives either outcome through its Door, while one killed meanwhile closes a spawned session. Hidden/inert without that capability. |
| `ab-screencast` <-> `ab-popout` | Same session, headed/headless relaunch in `AgentBrowserPanel`; preserves only the active URL. |
| `ab-*` -> `iframe` | Uses canonical `params.url`; with multiple tabs, requires the user to press `c` in the warning overlay, because only the active tab survives. |

Source of truth: `lib/src/components/wall/AgentBrowserScreenModal.tsx`,
`lib/src/components/wall/agent-browser-surface-controller.ts` (`screenActions`, sync effects,
pop-out/pop-in), `lib/src/components/Wall.tsx` (`onSwapRenderMode`), Storybook
`lib/src/stories/AgentBrowserScreenModal.stories.tsx`.

## Agent-Browser Renderer

**Dormouse is a viewer/client for the user's installed `agent-browser`** — it
neither bundles nor forks Chromium behavior. `dor ab` intercepts only the three
mutually exclusive identity flags `--key`, `--session`, `--surface` and forwards
everything else verbatim to
`agent-browser --session <resolved-session> <args...>`.
The only rewrite is inside `open` / `goto` / `navigate`, where a
Dormouse target (`surface:N`, `:port`, `host:port`) resolves to a URL first
(`docs/specs/dor-cli.md` → Browser Open Target Resolution). Flags Dormouse does
not model still pass through: `--headed` is a no-op against a *live* daemon, and
only pop-out's kill-then-relaunch changes the mode ([Pop-Out](#pop-out)).

The binary comes from `DORMOUSE_AGENT_BROWSER_BIN` or `PATH`; `dor ab` resolves
an absolute `binaryPath` for the host, which may not share the terminal's shell
PATH. **Both `dor ab` and the host must spawn `agent-browser` through
`spawnAndCapture`** (`dor-lib-common`), never raw `child_process` — the Windows
`.cmd`-shim recipe applies even to that absolute path (`docs/specs/dor-cli.md` →
Spawning External Binaries).

Managed identity:

- Default is `--key default`; `--key <name>` maps to `dormouse.1.<name>` and must
  match `[A-Za-z0-9._-]+`. `--key`, raw `--session`, `--surface` are mutually
  exclusive.
- GUI-spawned sessions use `dormouse.1.gui-<hex>`, which no `--key` names; they
  are reachable by `dor ab --surface <handle>` (`docs/specs/dor-cli.md` →
  Agent-Browser Surface Addressing). **The host answers only for an
  agent-browser-rendered Surface** — an `iframe`-rendered Surface has a browser
  but no session to drive.
- **One agent-browser session maps to one Dormouse surface.** Re-running `dor ab`
  for an existing session refreshes `wsPort`/`binaryPath` and reuses the pane, as
  does a `--surface`-addressed run — not an invariant, though: a surface killed
  or render-swapped mid-command leaves the trailing request to mint a fresh pane
  (rationale).

Source of truth: `dor/src/commands/agent-browser.ts`, `dor/src/commands/types.ts`
(`AgentBrowserSurfaceRequest`, `ResolveAgentBrowserSessionRequest`), `lib/src/components/Wall.tsx` /
`lib/src/components/wall/use-dor-control.ts` (`findAgentBrowserSurface`, `surface.agentBrowser`,
`surface.resolveAgentBrowser`).

### Agent-Browser Connection

A surface-id-keyed controller registry (mirroring `terminal-lifecycle.ts`) owns
one `AgentBrowserConnection` for `{ session, streamPort, binaryPath }` plus its
screenshot loop. **The controller is Surface-scoped, not panel-scoped** — it
survives panel unmount (minimize, layout churn, StrictMode), so the
daemon/session stays alive and reattaches from persisted params, and client
resources are released only at pane kill or a render swap away.

**A controller whose params carry no `session` must stay inert** — no connection,
no `stream status`, and **never derive the session from `key`**, which is what
[Pane Context Menu Connect](#pane-context-menu-connect) leans on to keep the
eager pane from racing the daemon boot.

**Parking.** A Lath leaf is always mounted, so nothing else stops a hidden pane's
~20Hz stream and per-pulse screenshot loop (rationale). A pane that goes
off-screen — or whose view unmounts — parks after a ~1s debounce: connection and
screenshot loop disposed, daemon/session alive, daemon-side streaming stopping on
its own because clients trigger it. Rules park and recovery must not break:

- **Parking clears the "this stream port opened live" marker**, so a reattach
  that fails to reconnect can ask `stream status` and adopt a port that changed
  while the pane was hidden.
- **An unpark keeps the last good frame on screen**, re-priming from the stream's
  re-broadcast frame/tabs; a fresh reattach mounts a blank canvas and shows the
  placeholder until the first screenshot.
- **Never park a popped-out pane**: its stream/CDP observer must keep running for
  window-close auto-revert, even while minimized.
- **Never set `AGENT_BROWSER_IDLE_TIMEOUT_MS`** for Dormouse-managed sessions —
  daemon self-exit when idle would defeat "alive while parked".
- **Never query the daemon mid-relaunch** — see [Pop-Out](#pop-out).
- **A relaunch in flight drops the stream and CDP observer at once**, shows a
  relaunching placeholder, and reconnects only to the port the host hands back
  (rationale). **One relaunch at a time**: a pop-out or pop-in issued during
  one is ignored; a session-less pane has nothing to relaunch.
- **A `{session, wsPort, binaryPath}` refresh reconciles its session even at the
  live port**, with no `stream status`.

The stream carries frames, status, tab snapshots, `url`, and native
`input_mouse` / `input_keyboard` input. **Control envelopes dispatch at any
size.** **`url` names the active tab at navigation commit; `tabs`
refreshes only when the driving command completes**
(for a slow page, after the load; rationale), so every commit clears the title
until `tabs` refreshes, even at the same URL.

**Two-stage paint.** A changed stream JPEG paints at once as a **provisional
frame** — the first image, and 250ms after pointer input (continuous movement
extends the window) — then a crisp device-resolution `agentBrowserScreenshot`
replaces it (rationale). The provisional frame is CSS-resolution (rationale).
Rules that keep the two paths honest:

- **Both paths are latest-only**: a newer pulse cancels an older provisional
  decode; a provisional paint during an in-flight capture marks it stale.
- **No capture may start inside the provisional window** (rationale) — one
  settled shot at its end, and continued pointer input pushes the window out.
- **A capture dropped as stale must leave the loop dirty** (rationale); an
  unpainted pulse alone must not suppress a crisp draw, so idle animated pages
  still update.
- Byte-identical heartbeat frames and crisp captures are dropped before drawing.
  **That dedup assumes the crisp loop is the only canvas writer, so any other
  painter must bump the draw generation** in its key — re-attach and every
  provisional paint do (rationale).
- **A host without `agentBrowserScreenshot` paints every changed provisional
  frame as its final image** rather than showing only the placeholder.

High-rate `[ab-panel]`/`[agent-browser]` console diagnostics sit behind the
`dormouse.flags.abDebugLogs` localStorage flag, read once at module load (reload
to apply); `debugSnapshot()`'s ring is always on.

Input rules:

- **Canvas pointer coordinates map through one width-derived scale on both
  axes**; frame/device heights would stretch input when a stream frame is shorter
  than the viewport.
- `input_keyboard.text` is always sent; non-text keys use `text: ""`.
- **`windowsVirtualKeyCode` comes from a real key map, never
  `key.charCodeAt(0)`** (`.` is char 46 = VK_DELETE, so periods would otherwise
  become Delete presses).
- Local paste is replayed as per-character key input.
- macOS select-all/copy/cut use the host `agentBrowserEdit` channel, since those
  chords do not survive CDP input, and fall through to the page where the host
  has none. Undo/redo is not emulated.

Tabs live in the agent-browser surface: header-integrated for one, an in-body
strip for two or more, select/close through `agentBrowserCommand`.

Source of truth: `lib/src/components/wall/AgentBrowserPanel.tsx` (`toDevice`, the
tab strip), `lib/src/components/wall/agent-browser-surface-controller.ts`, `lib/src/components/wall/agent-browser-connection.ts`,
`lib/src/components/wall/agent-browser-screenshot-loop.ts`, `lib/src/components/wall/agent-browser-input.ts`,
`lib/src/components/wall/use-surface-visibility.ts`, `lib/src/lib/agent-browser-tab.ts` (the tab record
shared by the stream and `tab list --json`).

### Pop-Out

`ab-popout` relaunches the same session headed, because Chrome fixes
headed/headless at daemon launch. The pane becomes a stub with Pop back in, plus
Bring to front where a host implements `agentBrowserBringToFront`; while the
window is still opening (a relaunch in flight, or an eager pane without its
session) the stub offers neither. **State carried in v1 is only the active
non-blank URL**: other tabs, DOM state, scroll, form inputs, session storage,
cookies/logins do not survive.

Host sequence: run `close`, **then terminate the daemon by its pid file**
(`$AGENT_BROWSER_SOCKET_DIR/<session>.pid`, default `~/.agent-browser`) **and
wait for it to exit** (rationale), then reopen. **Never wait for the page to
load** (rationale): every launch — pop-out, pop-in, `agentBrowserOpen` —
resolves once the *relaunched* daemon is up (a pid file naming a pid other than
the killed one, and a `<session>.stream` file naming a port that accepts a
connection), asking `stream status` only after `open` returns. **A non-zero
`open` exit with the daemon up is a page still loading, not a failed launch**;
only a launch without a published port fails, including after a zero exit;
`agentBrowserOpen` then closes its spawn. **A headed session is tracked for
shutdown before its launch**, so a window whose page never loads is still
closed. **Never query the daemon during the close/reopen gap** (rationale), host and controller
park/recovery paths alike, so **Dormouse supplies the active-tab URL and the
host trusts it**. Once `open` returns, only a still-current relaunch best-effort
closes stray `about:blank` tabs, **and only while a real page is open**, so it
never closes the sole tab (rationale).

While popped out, Dormouse keeps a stream/CDP observer for same-tab URL/header
updates and headed-window close auto-revert. **Hosts must cancel pending
relaunch sweeps, then close tracked popped-out sessions on shutdown** so
quitting orphans no headed window.

Source of truth: `lib/src/components/wall/agent-browser-surface-controller.ts` (pop-out state, CDP
observer, auto-revert), `lib/src/host/agent-browser-host.ts` (`popOut`, `popIn`,
`killDaemon`, `closePoppedOut`), VS Code/standalone shutdown wiring.

### Agent-Browser Host Capabilities

These `PlatformAdapter` methods are optional: VS Code imports the shared
implementation directly, standalone runs the bundled copy through the
sidecar/Rust adapter.

| Method | Contract |
| --- | --- |
| `agentBrowserCommand` | Allowlisted CLI subcommands (`AGENT_BROWSER_ALLOWED_SUBCOMMANDS` in `lib/src/lib/platform/types.ts`); host-side `get` limited to `get cdp-url`. |
| `agentBrowserScreenshot` | One device-resolution JPEG/PNG frame. VS Code structured-clones the bytes; standalone passes Rust the capture's temp-file **path** over the sidecar stdio, for Rust to read (rationale). |
| `agentBrowserStreamStatus` | Current stream port, for stale-`wsPort` recovery. |
| `agentBrowserEdit` | select-all/copy/cut via fixed host-owned JS plus an OS clipboard write. |
| `getAgentBrowserStreamUrl` | Direct stream URL, or the VS Code relay URL. |
| `agentBrowserOpen` | Spawn a GUI-owned session for iframe -> agent-browser; resolves when the daemon is up, not when the page loads ([Pop-Out](#pop-out)). |
| `agentBrowserPopOut` / `agentBrowserPopIn` | Headed/headless relaunch. |
| `agentBrowserBringToFront` | Optional; no host implements it today. |

**Host-side validation is the security boundary:** every `agentBrowserCommand`
implementation must enforce the shared allowlist; the CLI is not trusted to
pre-filter arguments.

**`binaryPath` crosses from the webview realm, so it is checked at the spawn**
(rationale) — the gate is `runWithBinaryFallback`, the one call every entry point
shares. Accepted: the agent-browser executable by file name — absolute, or bare
and resolved on `PATH` — plus the host's own `DORMOUSE_AGENT_BROWSER_BIN` by
exact match. **A refused path is dropped, never fatal**, so the host's own
candidates run. The webview applies the same predicate before storing or sending
one.

**Screenshots are captured into a private per-process directory, and it is
removed** (rationale): an `0700` `mkdtemp` with an unguessable file name. The
byte-returning capture unlinks its file once the bytes are in memory;
`closePoppedOut` drops the directory, with a `process.once('exit')` backstop. **A
tmpdir that cannot be created is answered `{ ok: false }` and retried on the next
capture, never memoized.**

**VS Code must reach the stream through a loopback relay** — the agent-browser
stream server rejects `vscode-webview://` origins. The relay grants one
single-use, short-TTL token bound to one stream port and strips the Origin
header; standalone connects directly.

Source of truth: `lib/src/host/agent-browser-host.ts` (`runWithBinaryFallback`),
`lib/src/lib/agent-browser-binary.ts` (`isAllowedAgentBrowserBinary`),
`vscode-ext/src/agent-browser-host.ts`, `vscode-ext/src/webview-html.ts`,
`standalone/src/tauri-adapter.ts`, `standalone/src-tauri/src/lib.rs`,
`standalone/sidecar/main.js`.

## Iframe Renderer

`dor iframe <url>` frames the page's own DOM — zero-lag for human inspection, but
agents cannot drive or read it. On hosts with `createIframeProxyUrl`,
`IframePanel` frames a per-surface loopback proxy URL; without it, a raw
uninstrumented iframe.

The proxy instruments any `http://` upstream, loopback and remote alike:

- HTTP (any host): headers rewritten per the table below, the shim injected into
  HTML, HTTP and WebSocket traffic passed through. **A site's "do not embed" is
  overridden, not obeyed** (rationale); JS framebusting is neutralized
  separately, by the sandbox.
- Unreachable / timed-out upstream: served Dormouse error page, distinct for
  "couldn't connect" and "didn't respond in 30s of socket idle".
- HTTPS: synchronous `scheme` failure with a `dor ab` hint — agent-browser is the
  path for real HTTPS or a login.
- **Link-local / cloud-metadata address: refused (`scheme`)** — an SSRF guard
  that stands regardless of the loosened framing policy. **Canonicalize every
  equivalent spelling** (decimal/octal/hex, short forms, IPv4-mapped IPv6) before
  range-checking, so `0xA9FEA9FE` and `::ffff:169.254.169.254` are caught too;
  pinned by `lib/src/host/iframe-proxy-rewrite.test.ts`.

What is rewritten, exactly:

| Direction | Header | Treatment |
| --- | --- | --- |
| request | `Host` | upstream host |
| request | `Origin` | upstream origin **only** when it is the proxy's own; else forwarded untouched (absent stays absent) |
| request | `Referer` | proxy origin substituted for the upstream origin |
| request | `Accept-Encoding` | deleted, so HTML comes back identity for rewriting |
| response | `X-Frame-Options`, `Content-Security-Policy`, `Content-Security-Policy-Report-Only` | replaced **whole** by `frame-ancestors 'self' <validated chain>` (rationale) |
| response | hop-by-hop (RFC 7230 §6.1) | dropped |
| response | `Location` | upstream origin rewritten back to the proxy origin, so a redirect stays inside the proxy |
| response body | `<meta http-equiv="content-security-policy">` | removed, like the header |

**Must update** this table and `FRAMING_RESPONSE_HEADERS` /
`HOP_BY_HOP_RESPONSE_HEADERS` together for every new stripped response header.

**One dedicated `127.0.0.1:0` server per grant, with no token in the path** — the
origin itself is the grant boundary (rationale). Grants have a sliding idle TTL
and a hard cap; **a request refused by the `Host` check must not refresh the
TTL**, so a stranger cannot hold one open.

Current limits: absolute-origin subresources (`http://localhost:5173/...`,
`ws://localhost:5173/...`) bypass the proxy uninstrumented — acceptable for
loopback; and the shim reclaims only Dormouse control messages, leaving ordinary
keyboard and pointer interaction inside the frame by design.

Source of truth: `lib/src/components/wall/IframePanel.tsx`,
`lib/src/host/iframe-proxy.ts`, `lib/src/host/iframe-proxy-rewrite.ts`
(`FRAMING_RESPONSE_HEADERS`, `HOP_BY_HOP_RESPONSE_HEADERS`, `instrumentHtml`,
`isBlockedAddress`), `lib/src/lib/platform/iframe-proxy-types.ts`.

### Iframe Shim

**Must send these fixed, never-user-provided shim messages to the app:**

- `leader`: dual-tap Meta/Shift leader chord; relayed from nested documents.
- `pointerdown`: genuine click, used to select/focus the pane; relayed.
- `location`: outer-document history/hash/page events and uncancelled same-frame
  anchor clicks; never relayed from nested documents.
- `open-window`: intercepted `target=_blank` anchor or `window.open` URL; relayed.

**A URL from the frame is re-checked before it becomes a pane.** `open-window`
and the control socket's `surface.iframe` both go through `browserSurfaceUrl`;
only `http:` and `https:` are accepted. (rationale)

**Parent listeners must validate the message origin against live proxy grants.**
Leader messages feed the same Wall command-mode exit path as in-document
dual-tap; `IframePanel` maps proxy-origin `location` URLs back to upstream URLs
for chrome/history without reloading the frame.

New-tab requests show an overlay prompt — accept opens a browser pane beside the
current one, cancel drops it; neither switches the pane to agent-browser.

Source of truth: `lib/src/host/iframe-proxy-rewrite.ts` (`iframeShim`),
`lib/src/components/wall/browser-url.ts` (`browserSurfaceUrl`),
`lib/src/lib/iframe-proxy-registry.ts`,
`lib/src/components/wall/use-wall-keyboard.ts`, `lib/src/components/wall/IframePanel.tsx`.

### Iframe Focus And Rendering Notes

- Cross-origin iframe focus blurs the parent window while `document.hasFocus()`
  remains true; **focus code must distinguish this from app backgrounding**.
- Proxied frames adopt clicks from shim `pointerdown`; the raw fallback uses the
  older `window.blur` + active iframe heuristic.
- **`IframePanel` must apply `transform: translateZ(0)` to its immediate
  container**, or Chromium offsets out-of-process iframe pointer events from a
  far-away compositing ancestor.
- **Every framed page is sandboxed, proxied or raw** (rationale); the `sandbox`
  omits `allow-top-navigation` to block framebusting, allowing scripts,
  same-origin (within the frame's own origin), forms, popups, modals, downloads.
- **The `allow` attribute grants no device or clipboard-read permission** —
  `autoplay`, `clipboard-write`, `fullscreen` only. (rationale)

Source of truth: `lib/src/components/wall/IframePanel.tsx`, `lib/src/components/wall/use-window-focused.ts`,
`lib/src/lib/terminal-lifecycle.ts` (`registerSurfaceFocusHandle`, which
focuses/blurs the iframe element like other surfaces).

## Iframe Host Capability And CSP

The optional `PlatformAdapter.createIframeProxyUrl` method and the
`IframeProxyResult` union are canonical in the platform types. Reachability is
diagnosed lazily by served error pages after the iframe loads the proxy URL, and
frame refusal is not diagnosed at all, so v1 mostly returns `ok` or `scheme`.

**The webview passes its own ancestor chain with every request for a proxy
URL** — `location.origin` plus `location.ancestorOrigins`, knowable only in the
realm that has a `location` (rationale). **Validated host-side and used
all-or-nothing**: an unparseable or opaque (`"null"`) entry means no chain
(rationale).

VS Code routes this through webview request/response messages to
`vscode-ext/src/iframe-proxy-host.ts`; standalone routes through
`standalone/src/tauri-adapter.ts` -> `standalone/src-tauri/src/lib.rs` ->
sidecar `iframe:createProxyUrl`.

The VS Code webview CSP must allow loopback frames (`docs/specs/vscode.md` →
CSP policy, which prints the directive and its consequence).

Security boundaries:

- the proxy binds loopback only — a mitigation, **not** the boundary; the two
  gates below are,
- **`Host` must name the grant's own loopback port**, on the request and upgrade
  paths alike, so DNS rebinding fails,
- **the `Origin` rewrite applies only to a caller the proxy itself served**,
- each grant fronts exactly one upstream,
- no user script is injected,
- link-local/cloud-metadata ranges are blocked,
- every other user-supplied `http://` target is trusted as the user's command,
  at the cost of the upstream's own XSS policy inside the frame.

**Must replace framing controls with exactly `frame-ancestors 'self'
<validated embedder chain>`.** `'self'` permits same-grant nesting; foreign
ancestors fail. **Each shim hop must target only its origin and that chain's
innermost origin, never `'*'`** (rationale; `docs/specs/security-local.md` →
"Loopback Listeners"). **With no chain it preserves headers and injects nothing.**

**Must refresh a grant's idle timer for every caller except one that named itself
foreign.** `isOwnOrigin` and `isForeignOrigin` are not each other's negation — an
*absent* `Origin` must keep refreshing. (rationale)

**Must rewrite `Origin` only when it names the proxy itself.** Forward a foreign
origin unchanged and keep an absent origin absent, on request and upgrade paths;
`Referer` only substitutes the proxy's own origin. (rationale) The shared rule
for all loopback listeners lives in `lib/src/host/loopback-guard.ts` and is
audited by `docs/specs/security-local.md` → "Loopback Listeners".

**Never relax** the `Host` validation, the conditional `Origin` gate, or the
`frame-ancestors` replacement without updating that `docs/specs/security-local.md` audit. Pinned
by `lib/src/host/iframe-proxy.test.ts`, which covers the upgrade path as well as
the request path.

Source of truth: `lib/src/lib/platform/iframe-proxy-types.ts`,
`lib/src/lib/platform/types.ts`, `lib/src/lib/platform/vscode-adapter.ts`,
`lib/src/lib/embedder-origins.ts` (`embedderOrigins`),
`lib/src/host/iframe-proxy-rewrite.ts` (`normalizeEmbedderOrigins`),
`vscode-ext/src/message-types.ts`,
`vscode-ext/src/message-router.ts`, `vscode-ext/src/webview-html.ts`,
`standalone/src/tauri-adapter.ts`.

## Future

- Stable agent-browser profile/state persistence so pop-out preserves logins,
  cookies, tabs, DOM state, and scroll.
- CLI affordance to re-engage Dormouse sync-to-pane.
- Upstream support for stream keyboard `commands`, replacing the host edit
  workaround and enabling undo/redo.
- General per-surface teardown hook for iframe proxy grants and future
  Dormouse-owned backend processes; agent-browser surfaces already dispose their
  controller on kill/swap.
- Process-backed targets are owned by the **dor-tools** scope
  (`docs/specs/dor-tool.md` `## Future`), which subsumes the plugin/backend
  target axis formerly staged here. (That scope's C1 phase also depends on the
  teardown hook above.)
- Optional terminal-side "this port is viewed by surface:N" indicator.
- Replace the spawn-per-shot CLI screenshot with a persistent host-side CDP
  capture channel. Measured against agent-browser 0.27.3 (headless, attach dance
  + correct-target selection): `Page.captureScreenshot` is byte-identical to the
  CLI at DPR 1 and follows external `set viewport`, but returns CSS-resolution
  frames at DPR>1 — this path's whole point — unless the client re-applies
  `Emulation.setDeviceMetricsOverride`, which Dormouse can do correctly only
  while sync-to-pane owns the values (an external `set device`/`set viewport` DPR
  is unrecoverable from frames). `captureBeyondViewport:true` bypasses emulation
  and crashed the headless daemon; `clip.scale` returns blank frames. Adopt only
  with a daemon-side answer — an upstream verb exposing current viewport+DPR, or
  a daemon-owned capture channel.
