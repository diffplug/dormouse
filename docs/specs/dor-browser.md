# Dor Browser Surface

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary
> (a browser pane is a **browser Surface**), and `docs/specs/dor-cli.md` for the
> shared `dor` CLI, surface handle model, and host control plumbing this surface
> builds on.
> Owns the browser Surface end to end — params, chrome, the renderers, the
> iframe proxy boundary. Evidence behind the rules:
> [dor-browser.rationale.md](dor-browser.rationale.md).

One body component renders all web content: `BrowserPanel`, persisted as
`surfaceType: 'browser'` with a swappable `renderMode`. Two axes define a browser
pane — its **target** (today always a bare URL; process-backed targets belong to
the **dor-tools** scope, `docs/specs/dor-tool.md`) and its **render** mode
(`ab-screencast`, `ab-popout`, `pw-screencast`, `pw-popout`, `iframe`). **Render is a pane parameter, never a
separate surface kind**; `docs/specs/glossary.md` owns the `kind` / `render_mode`
mapping.

Browser entry points take a URL, a schemeless `host:port`, or a terminal Surface
handle (`docs/specs/dor-cli.md` → Browser Open Target Resolution):

- `dor ab ...` / `dor agent-browser ...` forwards to the user's own
  `agent-browser` binary and binds that session to a browser pane.
- `dor pw ...` / `dor playwright ...` binds the user-installed Playwright CLI.
- `dor iframe <url>` uses the iframe renderer, for `http://` pages
  ([Iframe Renderer](#iframe-renderer)).

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
- **Must keep automation state flat** (`session`, `wsPort`, `binaryPath`,
  `syncEngaged`, `key`, plus Playwright `cwd`/`nativeIdentity`), never nested. Pop-out is not a param — it derives from
  `renderMode` once, at controller construction.
- **`contextPortKey` is declared and persisted like any other param.** Only a
  Surface the pane context menu opened for a port carries it, and reuse looks
  one up by it ([Pane Context Menu Connect](#pane-context-menu-connect)).
  **Must keep agent-browser's provider suffix `agent`**, the value persisted
  before Playwright existed, so a restored pane still matches.
- **Never move a browser Surface's DOM, and never let a minimize unmount it**
  (rationale): Lath never re-parents its leaf div, and a minimize **parks** it
  (`docs/specs/tiling-engine.md` → "Parked leaves"), so the document returns with
  scroll, form, and script state intact. A restart is still a cold load: every
  param above survives it, no document state does.

Source of truth: `lib/src/components/wall/BrowserPanel.tsx` (`BrowserPanelParams`), `lib/src/components/wall/browser-surface.ts`,
`lib/src/components/Wall.tsx` (`replaceSurface`), `lib/src/components/wall/agent-browser-surface-controller.ts`
(`rememberRestorableUrl`), `lib/src/components/wall/IframePanel.tsx` (`applyFrameUrl`).

## Placement And Lifetime

**Must share one placement rule across browser entry points** (`createContentSurface`):
replace an untouched, helper-less *terminal* caller in place, else split next to
the reference surface. **Never replace a reference that already has a browser** —
web content is not destroyed to make room. A replacement transfers the target
Surface's `surface:N` ref to the new browser Surface id.

**Must open focus-neutrally**, like `dor ensure`, with one exception: replacing
the pane the user is currently selected on moves selection to the replacement
(`docs/specs/layout.md` corner case #6, which owns both halves).

Surface lifetime owns backing resources:

- **Must retain the mounted DOM when minimizing.** Agent-browser connection
  parking follows [Agent-Browser Connection](#agent-browser-connection).
  **Must unpark a doored pane before killing it**, so its DOM dies with the Surface.
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
- Width tiers and the narrow-pane popover: `docs/specs/layout.md` → "Pane header responsive sizing".

Source of truth: `lib/src/components/wall/SurfacePaneHeader.tsx`,
`lib/src/components/wall/agent-browser-screen.ts`,
`lib/src/components/wall/BrowserDisplayIcon.tsx`,
`lib/src/components/Door.tsx`,
`lib/src/components/wall/browser-url.ts`, Storybook
`lib/src/stories/BrowserChromeHeader.stories.tsx`,
`lib/src/stories/Baseboard.stories.tsx`.

## Dev-Server Chip

For loopback URLs (`localhost`, `*.localhost`, `127.0.0.1`, `::1`) the header
registers interest in the port, and `PlatformAdapter.getOpenPorts(id)` resolves
it against terminal panes and minimized doors.

- **One scan loop per Window**, over every mounted Wall's Surfaces; the
  wanted-port store and the resolutions are window-wide.
- **Show a chip only when exactly one terminal owns that port**; zero or
  two-plus leave it unsettled, so a later dev server still matches.
- **Match only binds that serve localhost** — loopback or any-interface
  (`0.0.0.0`, `::`), never a specific non-loopback bind.
- **The scan stays decorative and off the hot path**, so it may never pile onto
  a tab open or poll forever.

Source of truth: `lib/src/components/wall/use-dev-server-ports.ts`,
`lib/src/components/wall/port-url.ts` (`servesLoopback`),
`lib/src/components/wall/agent-browser-ports.ts`, `lib/src/components/wall/browser-url.ts`.

## Pane Context Menu Connect

**Must scan once per context opening**, using the shared per-port URL selection in `docs/specs/dor-cli.md` → Browser Open Target Resolution. Zero/one port uses an inline row; multiple ports use a selector. Failed scans are distinct from no listeners.

**Must offer System browser, Iframe, and each automation provider’s screencast and popout for the selected port**, disabling unavailable host capabilities with a reason. Opening a browser from context always preserves the source terminal, including an untouched one.

**Must reuse targets per source, port, and provider**: each provider’s screencast and popout share a browser session and switch display modes. Reattach minimized targets and recreate closed ones. System browser follows the OS opener's behavior.

**Must create automated browser Surfaces eagerly without a session**, binding the returned session only after the host launch succeeds; failures are reported in context. A launch completing after its eager Surface has closed releases its browser session. Concurrent requests for the same target are serialized.

Source of truth: `openContextPort` in `lib/src/components/Wall.tsx`; `listenerUrlsByPort` in `lib/src/components/wall/port-url.ts`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`.

## Display Modal And Render Swaps

**Must make the Display modal the GUI for render mode and screencast
resolution**, the pop-out stub's own Pop back in aside. It splits the Browser
Chrome icon pair across its nesting: the
robot rides each provider’s screencast parent, each nested resolution row carrying only
its presentation glyph.

**Must offer only the render modes the Surface's screen controller declares** (`renderModes`), never the host's global capabilities: a provider its host can launch, or the running one, which relaunches; that provider's popout where the host can also pop out; always `iframe`; for a Tool, only its declarable renders (`docs/specs/dor-tool.md` → Declaring tools). **`setRenderMode` refuses any other mode.**
The iframe option lists that the embed keeps no logins or cookies (for
`https://`, see [Iframe Renderer](#iframe-renderer)).

Resolution controls apply to both screencast providers, as GUI wrappers around native
commands: **Resize with pane** is Dormouse-owned sync issuing
`set viewport <paneW> <paneH> <displayDpr>` once a pane resize settles (200ms);
**only a DPR change re-syncs at once**, off the window `resize` event, which
fires every frame of a drag. **Fixed** issues
`set viewport <w> <h> <dpr>` or `set device <name>` from the modal's registry.

**Only `syncEngaged` persists** — device/custom viewport state lives in
the browser itself. `SYNCED`/`SCALED` derives from viewport versus pane CSS
dimensions, DPR issued but not compared because stream frames are CSS-resolution.
Sync coexists with external `set viewport`/`set device` last-writer-wins:
**disengage sync (→ `SCALED`) only after a frame confirms Dormouse's own issued
size landed**, so a resize transient is not read as an external override.

| From -> To | Behavior |
| --- | --- |
| `iframe` -> `ab-screencast` / `ab-popout` | **The pane swaps at once** to a session-less agent-browser pane — inert, so it cannot race the boot (rationale) — while the host spawns a fresh `gui-<hex>` session at the current URL via `agentBrowserOpen` and hands over `{session, wsPort, binaryPath}` as **one** params refresh. `ab-popout` spawns headed in one shot, so the surface mounts already popped out. A spawn that rejects or yields no session restores the iframe; a Surface minimized meanwhile receives either outcome through its Door, while one killed meanwhile closes a spawned session. Hidden/inert without that capability. **A non-http(s) `url` refuses the swap** — the same `browserSurfaceUrl` check the iframe sink applies. |
| `ab-screencast` <-> `ab-popout` | Same Surface id and session, headed/headless relaunch in the surface controller; preserves only the active URL. |
| `ab-*` -> `iframe` | Uses canonical `params.url`; with multiple tabs, requires the user to press `c` in the warning overlay, because only the active tab survives. |

Source of truth: `lib/src/components/wall/AgentBrowserScreenModal.tsx`,
`offeredRenderModes` in `lib/src/components/wall/browser-automation.ts`,
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

### Managed identity

- Default is `--key default`; **`--key <name>` must match `[A-Za-z0-9._-]+`**,
  because it becomes part of a session name that becomes a filesystem path.
  **`--key`, raw `--session`, and `--surface` are mutually exclusive** — naming
  a browser twice is a mistake, never a precedence question.
- **A key is namespaced by the Workspace that holds the browser** —
  `dormouse.<workspaceId>.<name>`, the Workspace's *stable* id so a strip reorder
  renames nothing — and `dormouse.1.<name>` for a bare Wall, which has no
  Workspace id (VS Code, the website, Pocket). The same key in two Workspaces is
  therefore two browsers, which is what keeps one Surface per session (below)
  once several Workspaces each run `dor ab --key default`. **Only the answering Workspace can name it**,
  so `dor ab` asks the host (`surface.resolveAgentBrowser` with `key`) before it
  forwards anything, and namespaces the key itself only when there is no control
  endpoint at all — outside Dormouse, where `dor ab` is a pure passthrough.
  **Every managed `dor ab` invocation depends on the host answering** — a
  passthrough verb included — with no CLI-side fallback: a refusal (a Wall still
  mounting, a webview mid-reload, the VS Code guard) fails the command with the
  host's message before the binary runs, and the router answers the no-Wall
  case after its bounded retry rather than leaving `dor ab` to its deadline
  (`docs/specs/dor-cli.md` → "Handle Model"). A CLI-namespaced fallback would
  name the wrong Workspace's browser.
- GUI-spawned sessions use `dormouse.1.gui-<hex>`, minted host-wide (the Window's
  one agent-browser host, not a Workspace), which no `--key` names; they
  are reachable by `dor ab --surface <handle>` (`docs/specs/dor-cli.md` →
  Agent-Browser Surface Addressing). **The host answers only for an
  agent-browser-rendered Surface** — an `iframe`-rendered Surface has a browser
  but no session to drive.
- **One agent-browser session maps to one Dormouse surface.** Re-running `dor ab`
  for an existing session refreshes `wsPort`/`binaryPath` and reuses the pane, as
  does a `--surface`-addressed run — not an invariant, though: a surface killed
  or render-swapped mid-command leaves the trailing request to mint a fresh pane
  (rationale).

Source of truth: `sessionForKey` in `dor-lib-common/src/agent-browser.ts`,
`resolveSession` in `dor/src/commands/agent-browser.ts`, `dor/src/commands/types.ts`
(`AgentBrowserSurfaceRequest`, `ResolveAgentBrowserSessionRequest`), `lib/src/components/Wall.tsx` /
`lib/src/components/wall/use-dor-control.ts` (`findAgentBrowserSurface`, `surface.agentBrowser`,
`surface.resolveAgentBrowser`).

### Agent-Browser Connection

A surface-id-keyed controller registry (mirroring `terminal-lifecycle.ts`) owns
one `AgentBrowserConnection` for `{ session, streamPort, binaryPath }` plus its
screenshot loop. **The controller is Surface-scoped, not panel-scoped** — it
survives panel unmount (layout churn, StrictMode). **Must keep the daemon/session
alive while parked**, releasing viewer resources as specified below; killing
or swapping away disposes the controller too. **A view must key its controller
by provider as well as Surface id, and the registry must replace one driving
the other provider**: a minimized pane stays mounted while a failed
cross-provider swap is restored in place, and a controller's provider is fixed
for its life.

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

**Two-stage paint.** A changed stream JPEG paints at once as a CSS-resolution
**provisional frame** — the first image, 250ms after any input (pointer, keys,
pasted text, editing chords; continuous input extends the window), and while a
capture is **overdue** — then a crisp device-resolution
`agentBrowserScreenshot` replaces it (rationale):

- **Both paths are latest-only.**
- **No capture may start inside the provisional window** (rationale).
- **A capture is overdue past twice the average round trip, at least 400ms. It
  is never re-issued while its host call is unresolved, and a paint made only
  because it is overdue does not supersede it** (rationale).
- **Must leave the loop dirty when capture or bitmap decode becomes stale**
  (rationale). Pinned by `agent-browser-screenshot-loop.test.ts`.
- **Any canvas writer but the crisp loop must bump the draw generation** in its
  key, or the byte-identical-frame dedup drops its paint (rationale).
- **A host without `agentBrowserScreenshot` paints every changed provisional
  frame as its final image** rather than showing only the placeholder.

High-rate `[ab-panel]`/`[agent-browser]` console diagnostics sit behind the
`dormouse.flags.abDebugLogs` localStorage flag, read lazily and memoized on the
first log (reload to apply); `debugSnapshot()`'s ring is always on.

Input rules:

- **Canvas pointer coordinates map through one width-derived scale on both
  axes**; frame/device heights would stretch input when a stream frame is shorter
  than the viewport.
- `input_keyboard.text` is always sent; non-text keys use `text: ""`.
- **`windowsVirtualKeyCode` comes from a real key map, never
  `key.charCodeAt(0)`** (`.` is char 46 = VK_DELETE, so periods would otherwise
  become Delete presses).
- Local paste is replayed as per-character key input.
- **Select-all/copy/cut go through the host `agentBrowserEdit` channel on every
  platform**, since those chords do not survive CDP input; every shipped host
  implements it. Undo/redo is not emulated.

Tabs live in the agent-browser surface: **the in-body strip renders only at two
or more**, one tab getting the ordinary URL header and nothing tab-shaped.
Select/close go through `agentBrowserCommand`.

Source of truth: `lib/src/components/wall/AgentBrowserPanel.tsx` (`toDevice`, the
tab strip), `lib/src/components/wall/agent-browser-surface-controller.ts`, `lib/src/components/wall/agent-browser-connection.ts`,
`lib/src/components/wall/agent-browser-screenshot-loop.ts`, `lib/src/components/wall/agent-browser-input.ts`,
`lib/src/components/wall/use-surface-visibility.ts`, `lib/src/lib/agent-browser-tab.ts` (the tab record
shared by the stream and `tab list --json`).

### Pop-Out

`ab-popout` relaunches the same session headed, because Chrome fixes
headed/headless at daemon launch. The pane becomes a stub with Pop back in;
while the window is still opening (a relaunch in flight, or an eager pane
without its session) the stub offers nothing. **State carried in v1 is only the active
non-blank URL**: other tabs, DOM state, scroll, form inputs, session storage,
cookies/logins do not survive.

Host sequence: run `close`, **then terminate the daemon by its pid file and wait
for it to exit** (rationale), then reopen. **Never wait for the page to load**
(rationale): every launch — pop-out, pop-in, `agentBrowserOpen` — resolves once
the *relaunched* daemon is up, asking `stream status` only after `open` returns.
**A non-zero `open` exit with the daemon up is a page still loading, not a
failed launch**; only a launch without a published port fails, including after a
zero exit; `agentBrowserOpen` then closes its spawn. **A headed session is
tracked for shutdown before its launch**, so a window whose page never loads is
still closed. **Never query the daemon during the close/reopen gap**
(rationale), host and controller park/recovery paths alike, so **Dormouse
supplies the active-tab URL and the host trusts it**. Once `open` returns, only
a still-current relaunch best-effort closes stray `about:blank` tabs, **and only
while a real page is open**, so it never closes the sole tab (rationale).

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
| `agentBrowserCommand` | Navigation, tab, viewport/device, `get cdp-url` and `close` commands, one shape per verb. |
| `agentBrowserScreenshot` | One device-resolution JPEG/PNG frame. VS Code structured-clones the bytes; standalone passes Rust the capture's temp-file **path** over the sidecar stdio, for Rust to read (rationale). **One capture per session in flight**: a request made meanwhile joins it. |
| `agentBrowserStreamStatus` | Current stream port, for stale-`wsPort` recovery. |
| `agentBrowserEdit` | select-all/copy/cut via fixed host-owned JS plus an OS clipboard write. |
| `getAgentBrowserStreamUrl` | Direct stream URL, or the VS Code relay URL. |
| `agentBrowserOpen` | Spawn a GUI-owned session for iframe -> agent-browser; resolves when the daemon is up, not when the page loads ([Pop-Out](#pop-out)). |
| `agentBrowserPopOut` / `agentBrowserPopIn` | Headed/headless relaunch. |

**Every adapter must wait past agent-browser's 25s action timeout for a
command, edit or capture reply** (30s on each host), so the webview never
re-asks while the host still works.

**Host-side validation is the security boundary: both provider hosts run only
what the shared `parseWebviewCommand` accepts, rebuilt from its parsed value,
and refuse an option- or path-shaped session name and a non-http(s) launch URL
on every entry point** (rationale). Pinned by
`lib/src/host/agent-browser-host.test.ts`.

**`binaryPath` crosses from the webview realm, so it is checked at the spawn**
(rationale) — the gate is `runWithBinaryFallback`, the one call every entry point
shares. Accepted: the agent-browser executable by file name — absolute, or bare
and resolved on `PATH` — plus the host's own `DORMOUSE_AGENT_BROWSER_BIN` by
exact match. **A refused path is dropped, never fatal**, so the host's own
candidates run. The webview applies the same predicate before storing or sending
one.

**Screenshots are captured into a private per-process directory, and it is
removed** (rationale). **A tmpdir that cannot be created is answered
`{ ok: false }` and retried on the next capture, never memoized.**

**VS Code must reach the stream through a loopback relay** — the agent-browser
stream server rejects `vscode-webview://` origins. The relay grants one
single-use, short-TTL token bound to one stream port and strips the Origin
header; standalone connects directly.

Source of truth: `lib/src/host/agent-browser-host.ts` (`runWithBinaryFallback`),
`lib/src/host/browser-host-shared.ts` (`parseWebviewCommand`,
`isAgentBrowserSession`, `isPlaywrightSession`),
`dor-lib-common/src/agent-browser.ts` (`isAllowedAgentBrowserBinary`),
`lib/src/host/private-capture-dir.ts`, `lib/src/host/browser-stream-guard.ts`,
`vscode-ext/src/agent-browser-host.ts`, `vscode-ext/src/webview-html.ts`,
`standalone/src/tauri-adapter.ts`, `standalone/src-tauri/src/lib.rs`,
`standalone/sidecar/main.js`.

## Playwright Renderer

**Must share browser chrome, Display controls, input, screenshot scheduling, parking, and pop-out behavior with agent-browser.** `pw-screencast` and `pw-popout` select providers within the existing Surface kind. Cross-provider swaps preserve only the active URL, warn when other tabs will be lost, and close the old provider. Failed launches restore the previous renderer for visible and minimized Surfaces.

**Must use the user's installed `@playwright/cli`, resolved from `DORMOUSE_PLAYWRIGHT_BIN` or `PATH`.** GUI launches use Chromium. Native commands retain Playwright semantics: `open` restarts, `goto` navigates; commands for unsupported engines still run, with a viewer warning. The viewer requires CLI 0.1.19’s local browser-binding endpoint; installation errors name this requirement.

**Must scope managed keys by provider and Dormouse workspace.** Managed bindings retain unique native session names. The first command reserves its cwd and executable for two minutes while binding the Surface; concurrent first commands share the reservation, and one that succeeds without a viewer (a non-Chromium browser) keeps it until a Surface binds. Successful bindings remove reservations; Surfaces retain cwd/executable for later commands, including relative paths. `--session` bypasses managed-key addressing and uses the caller's native project scope. `--surface` requires a Playwright renderer. GUI Connect inherits the source terminal's cwd; a swap without one uses the host cwd.

**Must discover the native session in its CLI project scope and connect using that installation's matching Playwright client.** Accept only a unique registry entry matching session, workspace and library, with a local pipe endpoint and Chromium engine. Never load modules from the registry's library path. The host derives the client from the validated CLI installation. Raw sessions reuse Surfaces by that native identity, including callers in different subdirectories of one project. Native CLI tabs and the pane share the selected tab; the host polls tab selection and metadata every 750ms while viewed, broadcasting only changes, and the current state to each connecting viewer. Screenshots reuse tab state for up to 750ms; explicit host controls refresh immediately. A native launch updates headed shutdown ownership and the pane's display mode. **Must apply that host-reported mode in the controller before the new viewer port**, so sync never sizes a headed window; ignore it mid-relaunch, and until params show the controller's own last mode write.

**Must expose only fixed host operations.** Navigation, tabs, viewport/device, screenshots, editing and close are validated host-side (commands by the shared parser above); arbitrary CLI arguments, JavaScript and CDP methods are unavailable through the webview channel. The trusted `dor pw` process retains native passthrough. Executable hints use the same filename/exact-host-override boundary as agent-browser, with `playwright-cli` as the accepted name; `dor pw` applies it to the executable a binding returns (`docs/specs/dor-cli.md` → Playwright Surface Addressing).

**Must serialize GUI relaunches and closes per native session.** Close the previous CLI session before polling for its replacement; return when the browser endpoint is ready, without waiting for page load. **A pop-out or pop-in whose page is not http(s) must reopen blank**, never fail; only a GUI open's URL must pass the http(s) check. **Must answer a GUI launch inside the transports' `PLAYWRIGHT_REQUEST_TIMEOUT_MS`**: startup, queueing included, gets 30 s from the request's arrival, and every CLI call it waits on is killed at that deadline. **Must bound every other CLI call to 10 s, except `open`**, which lasts as long as the page load and whose end could take its browser down; nothing waits on it past a launch's own bounds. **A launch that gives up must let its `open` land, for up to 4 s, before closing the session**, and close again when a later `open` lands unless a newer launch owns the session (rationale). Only a completed, still-current GUI launch may close startup blank tabs, and only while a real page exists. Shutdown cancels pending launches, disconnects viewers and closes tracked headed sessions. Viewer disconnect alone leaves the CLI browser alive. Concurrent input/captures share CDP attachments; disposal releases late attachments. **A screencast that fails to start must forget its page**, so the next poll releases the attachment and retries. Temporary screenshots follow the agent-browser private-directory contract.

**Must authorize every stream upgrade with an own-loopback Host and a single-use, 60-second token bound to that viewer port.** Grants are capped at 1024; normal HTTP requests are refused. Input is limited to 64 KiB per message and 256 queued messages; frame backpressure drops frames above 2 MB queued. **Must send a paste as `input_text` messages of at most 8192 characters**, which the host inserts with CDP `Input.insertText`, never as a key pair per character (rationale). The same guarded stream serves all three hosts.

Source of truth: `browserPlatform` in `lib/src/components/wall/browser-automation.ts`; `followParamsHeadedness` in `lib/src/components/wall/agent-browser-surface-controller.ts`; `playwrightTextInputs` in `lib/src/lib/platform/browser-automation.ts`; `BrowserBindingReservations` in `lib/src/components/wall/browser-binding-reservations.ts`; `createPlaywrightHost` in `lib/src/host/playwright-host.ts`; `resolvePlaywrightInstall` in `lib/src/host/playwright-install.ts`; `BrowserStreamGrants` in `lib/src/host/browser-stream-guard.ts`. Pinned by `lib/src/host/playwright-host.test.ts` (opt-in real CLI via `DORMOUSE_PLAYWRIGHT_TEST_BIN`), `lib/src/host/playwright-host.lifecycle.test.ts`, `lib/src/host/browser-stream-guard.test.ts`, `lib/src/components/wall/browser-binding-reservations.test.ts`, and `AgentBrowserPanel Playwright params` in `lib/src/components/wall/AgentBrowserPanel.test.tsx`.

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
  "couldn't connect" and "didn't respond in 30s of socket idle", in the system
  color scheme; **only a loopback upstream is called a dev server**.
- HTTPS: refused, per the table below. **Every panel error but a non-http(s)
  URL offers Open in agent-browser** (a swap to `ab-screencast`) where the host
  can launch one, with `dor ab open <url>` as the fallback text.
- **Link-local / cloud-metadata address: refused (`scheme`)** — an SSRF guard
  that stands regardless of the loosened framing policy. **Canonicalize every
  equivalent spelling** (decimal/octal/hex, short forms, IPv4-mapped IPv6) before
  range-checking, so `0xA9FEA9FE` and `::ffff:169.254.169.254` are caught too;
  pinned by `lib/src/host/iframe-proxy-rewrite.test.ts`.

**Must refuse `https://` at every entry to the iframe renderer on a host with
the proxy, in the one `IFRAME_HTTP_ONLY` wording, naming `dor ab open <url>`**
(a host without it frames https raw):

| Entry | Outcome |
| --- | --- |
| `surface.iframe` (`dor iframe`) | refused before any pane opens |
| Display modal / render swap to `iframe` | option disabled with the reason; the Wall's swap refuses too |
| New-tab request from a framed page | an `ab-screencast` pane, bound to its launch like a render swap, closed if the launch fails |
| A pane already holding one | synchronous `scheme` panel error |

Header rewriting:

| Direction | Header | Treatment |
| --- | --- | --- |
| request | `Host` | upstream host |
| request | `Origin` | upstream origin **only** when it is the proxy's own; else forwarded untouched (absent stays absent) |
| request | `Referer` | proxy origin replaced with the upstream origin |
| request | `Accept-Encoding` | deleted on a document load (`Sec-Fetch-Dest` `document`, `iframe`, `frame`, `embed`, `object`, or none sent), so its HTML comes back identity; kept on every other request |
| request | `Cookie` | dropped, including WebSocket handshakes |
| response | `Set-Cookie` | dropped, including successful and refused WebSocket handshakes |
| response | `X-Frame-Options`, CSP headers | with validated chain, replaced by `frame-ancestors 'self' <validated chain>`; opted-in CSP policies remain alongside it (rationale) |
| response | `X-Dormouse-Preserve-CSP: 1` | consumed; preserves upstream CSP headers and meta policies |
| response | hop-by-hop (RFC 7230 §6.1) | dropped |
| response | `Location` | upstream origin rewritten back to the proxy origin, so a redirect stays inside the proxy |
| response body | `<meta http-equiv="content-security-policy">` | removed unless the response opts into CSP preservation |

**Must update this table whenever header rewriting changes.**

**Must instrument only an identity-encoded, ASCII-compatible HTML body, and keep
its `content-type` as sent**, charset included; a compressed or UTF-16 body
passes through uninstrumented (rationale). **Never place the shim ahead of the
doctype or a `<meta charset>`**: it goes before `</head>`, else after `<body…>`,
else after the document's leading doctype/`<html>`/`<head>`/`<meta charset>`
tags.

**Must preserve enforced and report-only CSP verbatim when the upstream response sends `X-Dormouse-Preserve-CSP: 1`.** Add the validated ancestor policy separately, for every MIME type; preserve meta policies during HTML instrumentation. Never infer this opt-in from request headers. Additional upstream restrictions may prevent framing or shim execution. (rationale)

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
`isBlockedAddress`, `errorPageHtml`), `lib/src/lib/platform/iframe-proxy-types.ts`
(`IFRAME_HTTP_ONLY`), `iframeRefusal` in `lib/src/components/wall/browser-url.ts`,
`isLoopbackHostname` in `lib/src/lib/ip-literal.ts`.

### Iframe Shim

**Must send four fixed, never-user-provided message kinds to the app and nothing
else** — `leader`, `pointerdown`, `location`, `open-window`. **`location` is
never relayed from a nested document**; the other three are. **`open-window`
intercepts every anchor target but `_self`**, plus `window.open`.

**Only `http:` and `https:` reach a browser Surface, re-checked at the sink.**
`open-window` and the control socket's `surface.iframe` go through
`browserSurfaceUrl`, and `IframePanel` checks `params.url` again before framing
it — the header's URL editor writes there too. (rationale)

**Parent listeners must validate the message origin against live proxy grants.**
Leader messages feed the same Wall command-mode exit path as in-document
dual-tap; `IframePanel` maps proxy-origin `location` URLs back to upstream URLs
for chrome/history without reloading the frame.

New-tab requests show an overlay: accept opens an adjacent browser pane (for
`https://`, see [Iframe Renderer](#iframe-renderer)); cancel drops it.

**A proxied frame `load` with no `location` report within 1s marks the document
uninstrumented** (off the proxy, refused, or its grant gone), and a banner
offers Reload and Open in agent-browser. Only a report naming the proxy origin
counts, including one up to 250ms before the load.

Source of truth: `lib/src/host/iframe-proxy-rewrite.ts` (`iframeShim`),
`lib/src/components/wall/browser-url.ts` (`browserSurfaceUrl`),
`lib/src/components/Wall.tsx` (`onOpenBrowserPane`),
`lib/src/lib/iframe-proxy-registry.ts`,
`lib/src/components/wall/use-wall-keyboard.ts`, `lib/src/components/wall/IframePanel.tsx`.

### Iframe Focus And Rendering Notes

- Cross-origin iframe focus blurs the parent window while `document.hasFocus()`
  remains true; **focus code must distinguish this from app backgrounding**.
- Proxied frames adopt clicks from shim `pointerdown`; the raw fallback adopts
  focus alone, acknowledging nothing, by the older `window.blur` + active iframe
  heuristic.
- **`IframePanel` must apply `transform: translateZ(0)` to its immediate
  container**, or Chromium offsets out-of-process iframe pointer events from a
  far-away compositing ancestor.
- **Every framed page is sandboxed, proxied or raw** (rationale), and the
  `sandbox` omits `allow-top-navigation` to block framebusting.
- **The `allow` attribute grants no device or clipboard-read permission** —
  `autoplay`, `clipboard-write`, `fullscreen` only. (rationale)

Source of truth: `lib/src/components/wall/IframePanel.tsx`, `subscribeWindowFocus` in `lib/src/lib/window-focus.ts`,
`lib/src/lib/terminal-lifecycle.ts` (`registerSurfaceFocusHandle`, which
focuses/blurs the iframe element like other surfaces).

## Iframe Host Capability And CSP

The optional `PlatformAdapter.createIframeProxyUrl` method and the
`IframeProxyResult` union are canonical in the platform types. Reachability is
diagnosed lazily by served error pages after the iframe loads the proxy URL, and
frame refusal only as an uninstrumented load ([Iframe Shim](#iframe-shim)), so
v1 mostly returns `ok` or `scheme`.

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
  at the cost of the upstream's own XSS policy unless it opts into preservation.

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
`Referer` substitutes only an exact parsed proxy origin, preserving its path and query; redirects likewise substitute only an exact upstream origin. (rationale) The shared rule
for all loopback listeners lives in `lib/src/host/loopback-guard.ts` and is
audited by `docs/specs/security-local.md` → "Loopback Listeners".

Iframe cookies and script-access limits: `docs/specs/security-local.md` → "Loopback Listeners".

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
  target axis formerly staged here.
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
