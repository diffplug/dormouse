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

## Providers

An automated renderer belongs to one **provider**, the CLI that drives its
browser. **Must read every per-provider fact from the one registry** — render
modes, CLI, binary for `dor`, the hosts and the webview; label, device presets
and viewport hint for the GUI — never a ternary on the provider or a mode
prefix. **Never change a persisted mode string**: they are the public
`render_mode` and `dormouse.yml` `render` values. `parseRenderMode` decodes one
to its provider and presentation (`screencast` / `popout`), reading anything
else as `iframe`.

| Provider | CLI | Render modes | Binary override / name | Install |
| --- | --- | --- | --- | --- |
| agent-browser | `dor ab` | `ab-screencast`, `ab-popout` | `DORMOUSE_AGENT_BROWSER_BIN` / `agent-browser` | `npm i -g agent-browser` |
| Playwright | `dor pw` | `pw-screencast`, `pw-popout` | `DORMOUSE_PLAYWRIGHT_BIN` / `playwright-cli` | `npm i -g @playwright/cli` |

Source of truth: `BROWSER_PROVIDERS` and `parseRenderMode` in
`dor-lib-common/src/browser-providers.ts`; `BROWSER_PROVIDER_GUI` in
`lib/src/components/wall/browser-automation.ts`.

## Canonical Params

Invariants on the flat persisted `BrowserPanelParams`:

- **`renderMode` is canonical**; an absent one resolves to `iframe`, never to a
  live agent-browser. **Only params may omit it** — a live `ScreenSnapshot`
  always carries one, so nothing defaults it a second time.
- **`url` is the canonical target** across render swaps and relaunches.
  Agent-browser mirrors the newest http(s) active tab URL into it — the host
  relaunches at nothing else; iframe persists only navigations initiated by
  Dormouse chrome.
- **Must keep automation state flat** (`session`, `launchSession`,
  `launchFallback`, `binaryPath`, `cwd`, `nativeIdentity`, `syncEngaged`,
  `key`), never nested but for a `launchFallback` restore's params. Pop-out is not a param — it derives from `renderMode`
  once, at controller construction.
- **Never carry a stream port in params**: the port `dor ab` reads, or the one
  the Playwright host's `attach` answers for `dor pw`, goes straight to the
  Surface's controller (rationale).
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
(`rememberRestorableUrl`, `handOverBrowserPort`), `lib/src/components/wall/IframePanel.tsx` (`applyFrameUrl`).

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
  parking follows [Browser Connection](#browser-connection).
  **Must unpark a doored pane before killing it**, so its DOM dies with the Surface.
- **Killing an automated pane — or swapping away from that renderer — must go
  through `closeBrowserSurface`**: it closes the session through the controller
  (or from params when none holds it) and releases every client resource.
  **Work that lands after the close closes what it brought up.**
- **A Workspace transfer releases its browser controllers without closing their
  sessions**; the destination attaches to them, or opens the same named session
  a launch was opening. **An abandoned launch closes only a session the host
  minted.**
- Iframe proxy grants are reclaimed by the proxy idle sweep, not a per-surface
  teardown hook.

Source of truth: `lib/src/components/Wall.tsx` (`createContentSurface`'s `focusNeutral`,
`settleAddSelection`, `killPaneImmediately`, `replaceSurface`),
`closeBrowserSurface` in `lib/src/components/wall/agent-browser-surface-controller.ts`,
`prepareWorkspaceTransfer` in `lib/src/components/wall/workspace-transfer.ts`,
`lib/src/host/iframe-proxy.ts` (`GRANT_IDLE_TTL_MS`, `MAX_GRANTS`).

## Browser Chrome

Chrome is keyed by a screen controller. **Both renderers must register one
unconditionally**; render swaps are separately host-gated.

Header contract:

- **Must open the Display modal from this capability-first identity**
  (rationale):

  | Display, labelled `<provider> <view>` | Icon cluster |
  | --- | --- |
  | resizes with pane (`syncEngaged`) | wide robot + frame corners |
  | fixed size | wide robot + picture-in-picture |
  | popout | wide robot + arrow-square-out |
  | iframe embed | frame corners only |

- **Must reuse this mapping in browser Doors** (`docs/specs/layout.md` →
  Baseboard owns the Door label rule).
- **Must show the URL as primary text:** host+path without query, or path behind
  a dev-server chip; the HTML title is its tooltip. An iframe surface's
  persisted title keeps the query.
- **Must open a pre-selected `InlineEditInput` from the URL.** Blur discards;
  `normalizeNavUrl` follows CLI scheme selection plus bare loopback → `http://`
  and bare remote → `https://` (rationale). **Must refuse any other scheme with
  a warning under the field**, since no renderer opens one.
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

**Must reuse targets per source, port, and provider**: each provider’s screencast and popout share a browser session and switch display modes. **A reuse is one intent, `setRenderMode(mode, { url })`, reaching the Surface's controller by id** (`requestBrowserRenderMode`), so a mode switch relaunches at the port's page rather than racing a navigation into it, even in an unmounted Door. Reattach minimized targets and recreate closed ones. System browser follows the OS opener's behavior.

**Must create automated browser Surfaces at once with the URL and no session**, their controller launching ([Browser Connection](#browser-connection)); a failure is reported in context and closes the pane (`launchFallback: 'close'`). Concurrent requests for the same target are serialized.

Source of truth: `openContextPort` in `lib/src/components/Wall.tsx`; `listenerUrlsByPort` in `lib/src/components/wall/port-url.ts`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`.

## Display Modal And Render Swaps

**Must make the Display modal the GUI for render mode and screencast
resolution**, the pop-out stub's own Pop back in aside. It splits the Browser
Chrome icon pair across its nesting: the
robot rides each provider’s screencast parent, each nested resolution row carrying only
its presentation glyph.

**Must offer only the render modes the Surface's screen controller declares** (`renderModes`), never the host's global capabilities: both presentations of a provider its host drives (`browserProviders`), the running one's screencast even where it does not; always `iframe`; for a Tool, only its declarable renders (`docs/specs/dor-tool.md` → Declaring tools). **`setRenderMode` refuses any other mode.**
The iframe option lists that the embed keeps no logins or cookies (for
`https://`, see [Iframe Renderer](#iframe-renderer)).

Resolution controls apply to both screencast providers, as GUI wrappers around native
commands: **Resize with pane** is Dormouse-owned sync issuing
`set viewport <paneW> <paneH> <displayDpr>` once a pane resize settles (200ms);
**only a DPR change re-syncs at once**, off a `(resolution: <dpr>dppx)` media
query `change` event. **Fixed** issues
`set viewport <w> <h> <dpr>` or `set device <name>` from the modal's registry.

**Only `syncEngaged` persists** — device/custom viewport state lives in
the browser itself. `SYNCED`/`SCALED` derives from viewport versus pane CSS
dimensions, DPR issued but not compared because stream frames are CSS-resolution.
Sync coexists with external `set viewport`/`set device` last-writer-wins:
**disengage sync (→ `SCALED`) only after a frame confirms Dormouse's own issued
size landed**, so a resize transient is not read as an external override.

| From -> To | Behavior |
| --- | --- |
| `iframe` or the other provider -> `ab-*` / `pw-*` | **The pane swaps at once** to a session-less pane whose controller launches at the current URL, headed for a popout (rationale). **A failed launch restores the previous renderer in place** (`launchFallback: { restore }`), even minimized: the embed, or the previous provider reopened in its own session, keeping its `key` (rationale). Inert without the capability. **A non-http(s) `url` refuses the swap** — the same `browserSurfaceUrl` check the iframe sink applies. |
| `ab-screencast` <-> `ab-popout` | Same Surface id and session, headed/headless relaunch in the surface controller; preserves only the active URL. |
| `ab-*` -> `iframe` | Uses canonical `params.url`; with multiple tabs, requires the user to press `c` in the warning overlay, because only the active tab survives. |

Source of truth: `lib/src/components/wall/AgentBrowserScreenModal.tsx`,
`offeredRenderModes` in `lib/src/components/wall/browser-automation.ts`,
`lib/src/components/wall/agent-browser-surface-controller.ts` (`screenActions`, sync effects,
pop-out/pop-in), `lib/src/components/Wall.tsx` (`onSwapRenderMode`), Storybook
`lib/src/stories/AgentBrowserScreenModal.stories.tsx`. Pinned by `restores a failed provider swap minimized meanwhile in place` in `lib/src/components/Wall.test.tsx`.

## Automated Browser

**Dormouse is a viewer/client for the user's installed provider CLI** — it
neither bundles nor forks a browser ([Providers](#providers)). `dor ab` / `dor
pw` intercept only the identity flags and forward everything else verbatim to
the provider's CLI against the resolved session; the only rewrite is a
navigation verb's Dormouse target (`surface:N`, `:port`, `host:port`), resolved
to a URL first (`docs/specs/dor-cli.md` → Browser Surface Addressing). Flags
Dormouse does not model still pass through.

The binary comes from the provider's override variable or `PATH`; `dor`
resolves an absolute `binaryPath` for the host, which may not share the
terminal's shell PATH; **a GUI launch passes the one that provider's `dor`
command last resolved, and remembers the one it ran**. **Both `dor` and the host
must spawn a provider CLI through `spawnAndCapture`** (`dor-lib-common`), never
raw `child_process` — the Windows `.cmd`-shim recipe applies even to that
absolute path (`docs/specs/dor-cli.md` → Spawning External Binaries).

### Managed identity

- Default is `--key default`; **`--key <name>` must match `[A-Za-z0-9._-]+`**,
  because it becomes part of a session name that becomes a filesystem path.
  **`--key`, raw `--session`, and `--surface` are mutually exclusive** — naming
  a browser twice is a mistake, never a precedence question.
- **A key names the Surface of that provider holding it in the answering Wall**,
  whose stored binding — session, cwd, executable — the command runs with; so a
  Surface keeps its session however keys were named when it was made.
- **A key no Surface holds is minted `dormouse.<scope>.<name>`**, scoped by the
  Workspace that will hold the browser — its *stable* id, so a strip reorder
  renames nothing. **A bare Wall, which has no Workspace id (a VS Code webview,
  the website, Pocket), mints a scope of its own for its life**, so two
  webviews' `--key default` are two browsers. Its first commands that may bind
  reserve the caller's cwd and executable for two minutes, shared by concurrent
  first commands; one that succeeds without a viewer (a non-Chromium Playwright)
  keeps it until a Surface binds, and binding removes it.
- **Only the answering Workspace can name a key**, so `dor` asks the host
  (`surface.resolveBrowser`) before it forwards anything, and names the key
  itself (`dormouse.1.<name>`) only when there is no control endpoint at all —
  outside Dormouse, where `dor` is a pure passthrough. **Every managed
  invocation depends on the host answering** — a passthrough verb included —
  with no CLI-side fallback: a refusal (a Wall still mounting, a webview
  mid-reload, the VS Code guard) fails the command with the host's message
  before the binary runs, and the router answers the no-Wall case after its
  bounded retry rather than leaving `dor` to its deadline (`docs/specs/dor-cli.md`
  → "Handle Model"). A CLI-namespaced fallback would name the wrong Workspace's
  browser.
- GUI-spawned sessions use `dormouse.1.gui-<hex>`, minted host-wide, which no
  `--key` names; they are reachable by `--surface <handle>`
  (`docs/specs/dor-cli.md` → Browser Surface Addressing). **The host answers only
  for a Surface its provider renders** — an `iframe`-rendered Surface has a
  browser but no session to drive.
- **One browser maps to one Dormouse surface**, found by its host-reported
  native identity (agent-browser: the session; Playwright: installation,
  project scope and session, which a raw `--session` shares across one
  project's subdirectories). A command for a browser that has a Surface hands
  its port over, refreshes `binaryPath` and reuses the pane — not an invariant,
  though: a surface killed or render-swapped mid-command leaves the trailing
  request to mint a fresh pane (rationale).

Source of truth: `sessionForKey` in `dor-lib-common/src/browser-providers.ts`,
`runBrowserCli` in `dor/src/commands/browser-cli.ts`, `BrowserBindingReservations`
in `lib/src/components/wall/browser-binding-reservations.ts`,
`lib/src/components/wall/use-dor-control.ts` (`findBrowserSurface`,
`ensureBrowserSurface`, `browserKeyScope`). Pinned by `resolves a browser surface
handle to its agent-browser session, and gates the rest` in
`lib/src/components/Wall.test.tsx`.

### Browser Connection

A surface-id-keyed controller registry (mirroring `terminal-lifecycle.ts`) owns
one `AgentBrowserConnection` plus its screenshot loop. **The controller is
Surface-scoped, not panel-scoped** — it survives panel unmount. **Must keep the
daemon/session alive while parked.** **A view must key its controller by
provider as well as Surface id, and the registry must replace one driving the
other provider**: a minimized pane stays mounted while a failed cross-provider
swap is restored in place, and a controller's provider is fixed for its life.
**A view whose controller was released takes a new one on its next params
change, never on the release itself** (a kill's, as its fade starts).

**Phase.** The controller holds one `Phase`; the stream connection and CDP
observer exist exactly in `live`. A hidden headless pane enters `parked` in
place of `live`; a `dor` handover moves any phase but `launching` and
`relaunching` to its port; a new `session` in params rebinds.

| Phase | State | Next |
| --- | --- | --- |
| `idle` | No view has started it | `launching` without a session; `live` at a handed-over port; else `attaching` with its page |
| `launching` | Opening `url`, in `launchSession` when set, then binding the session answered | `live` at the answered port, else `attaching`; `ended` |
| `attaching` | Asking the host (`attach`) where the session streams | `live`; `ended` |
| `live` | Streaming from its port | `parked` (hidden ≥1s, headless); `relaunching`; `ended` when a headless stream drops (rationale); `attaching` with no page when an unpark's port fails |
| `parked` | Stream released; daemon up at its port | `live` at that port on unpark (rationale); `relaunching` |
| `relaunching` | Headed↔headless relaunch | `live` at the host's port; else `attaching` with its page, headless |
| `ended` | No browser; `error` says why | `relaunching`; a navigation rebinds, with its page |
| `disposed` | Released | — |

- **Every daemon command must pass one gate (`driver`), open only in `live`,
  and after an unpark only once its stream opens** — chrome and Display modal
  actions, tabs, sync-to-pane, `get cdp-url`, edit chords, screenshots
  (rationale).
- **A navigation asked for outside `live` is kept as the one latest intent**,
  run on the next `live`; **so is a pop-out or pop-in asked before the browser
  is bound** (`idle`, `launching`, `attaching`), run as a relaunch, and so is
  a new `url` in params while `launching` (rationale). **A launch or relaunch
  opens the pending page itself; one the host opened never loads again**
  (rationale).
- **The controller never asks a daemon-spawning CLI verb for a port**: ports
  come from a launch or relaunch answer, a `dor` handover, or `attach`.
- **A failed first launch is reported once to the Wall, which applies the
  Surface's `launchFallback`**: `close` the pane, `embed` (a Tool's iframe), or
  `{ restore }` the params a swap replaced. A param cleared on success, it
  survives a restore mid-launch (rationale). **A launch into a named session is
  sent at once, and so is a close of a Surface whose launch names one**: the
  host orders them ([Browser Host](#browser-host)).
- **Params predating the controller's own `session` or `renderMode` write are
  ignored until they show it back.**
- **One relaunch at a time, only of a bound browser** (`live`, `parked`,
  `ended`). **A relaunch leaves `live` before headedness changes** (rationale).

**Parking.** A Lath leaf is always mounted, so nothing else stops a hidden pane's
~20Hz stream and per-pulse screenshot loop (rationale). A pane that goes
off-screen — or whose view unmounts — parks after a ~1s debounce: connection and
screenshot loop disposed, daemon/session alive, daemon-side streaming stopping on
its own because clients trigger it.

- **An unpark keeps the last good frame on screen**, re-priming from the stream's
  re-broadcast frame/tabs; a fresh reattach mounts a blank canvas and shows the
  placeholder until the first screenshot.
- **A resize made while not `live` is pushed on the next `live`.**
- **Never park a popped-out pane**: its stream/CDP observer must keep running for
  window-close auto-revert, even while minimized.
- **Never set `AGENT_BROWSER_IDLE_TIMEOUT_MS`** for Dormouse-managed sessions —
  daemon self-exit when idle would defeat "alive while parked".

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
host `screenshot` replaces it (rationale):

- **Both paths are latest-only.**
- **No capture may start inside the provisional window** (rationale).
- **A capture is overdue past twice the average round trip, at least 400ms. It
  is never re-issued while its host call is unresolved, and a paint made only
  because it is overdue does not supersede it** (rationale).
- **Must leave the loop dirty when capture or bitmap decode becomes stale**
  (rationale). Pinned by `agent-browser-screenshot-loop.test.ts`.
- **Any canvas writer but the crisp loop must bump the draw generation** in its
  key, or the byte-identical-frame dedup drops its paint (rationale).
- **A host that cannot drive the provider paints every changed provisional
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
- Local paste is replayed as per-character key input — as `input_text` on
  [Playwright](#playwright).
- **Select-all/copy/cut go through the host `edit` operation on every
  platform**, since those chords do not survive CDP input. Undo/redo is not
  emulated.

Tabs live in the automated browser surface: **the in-body strip renders only at two
or more**, one tab getting the ordinary URL header and nothing tab-shaped.
Select/close go through the host `tab` operation. The daemon gate is pinned by
`reaches no daemon from the header, Display modal, tabs, sync or edit chords
mid-relaunch` in `lib/src/components/wall/agent-browser-surface-controller.test.ts`.

Source of truth: `lib/src/components/wall/AgentBrowserPanel.tsx` (`toDevice`, the
tab strip, placeholders), `lib/src/components/wall/agent-browser-surface-controller.ts`
(`Phase`, `driver`, `launch`, `attach`, `whenBrowserLaunched`), `onBrowserLaunchFailed` in `lib/src/components/Wall.tsx`,
`lib/src/components/wall/agent-browser-connection.ts`,
`lib/src/components/wall/agent-browser-screenshot-loop.ts`, `lib/src/components/wall/agent-browser-input.ts`,
`lib/src/components/wall/use-surface-visibility.ts`, `lib/src/lib/agent-browser-tab.ts` (the tab record
shared by the stream and `tab list --json`).

### Pop-Out

A popout (`ab-popout`, `pw-popout`) relaunches the same session headed, because
Chrome fixes headed/headless at launch. The pane becomes a stub with Pop back in;
while the window is still opening (a launch, attach or relaunch in flight) the
stub offers nothing. **State carried in v1 is only the last
http(s) active URL**: other tabs, DOM state, scroll, form inputs, session storage,
cookies/logins do not survive.

A pop-out or pop-in is a `launch` of the bound session, under the host's
lifecycle ([Browser Host](#browser-host)).
agent-browser's relaunch runs `close`, **then terminates the daemon by its pid
file and waits for it to exit** (rationale), then reopens. **Never wait for the
page to load** (rationale): its launch resolves once the *relaunched* daemon is
up, asking `stream status` only after `open` returns. **A non-zero `open` exit
with the daemon up is a page still loading, not a failed launch**; only a launch
without a published port fails, including after a zero exit. **Never query the
daemon during the close/reopen gap** (rationale) — host-side, and in the
controller through its daemon gate — so **Dormouse supplies the active-tab URL
and the host trusts it**.

While popped out, Dormouse keeps a stream/CDP observer for same-tab URL/header
updates and headed-window close auto-revert.

Source of truth: `lib/src/components/wall/agent-browser-surface-controller.ts` (pop-out state, CDP
observer, auto-revert), `lib/src/host/agent-browser-host.ts` (`killDaemon`),
VS Code/standalone shutdown wiring.

### Browser Host

**Every browser operation rides one `PlatformAdapter.browser(request)`**: a
provider-tagged `BrowserRequest` — `{ provider, binding: { session?, cwd?,
binaryPath? } }` plus one operation — answered by a `BrowserResult`. A host lists
the providers it drives in `browserProviders`; one without them (the web demo)
offers no automated renderer. VS Code runs the shared host in the extension
host; standalone runs the bundled copy in the sidecar behind one Rust command,
plus `browser_screenshot` for raw bytes.

| Operation | Contract |
| --- | --- |
| `launch` | Without a session, open an http(s) `url` in a new GUI session; with one, relaunch it headed or headless at `url`, blank when that page is not http(s). Resolves when the browser is up, not when the page loads ([Pop-Out](#pop-out)). |
| `attach` | The live stream port, found without starting a browser ([agent-browser](#agent-browser), [Playwright](#playwright)), with headedness where the provider can tell. Only a gone browser, for a caller naming a page, is relaunched there (headed on request), answering `relaunched`; one it cannot view is left alone. |
| `screenshot` | One device-resolution JPEG/PNG frame. VS Code structured-clones the bytes; standalone passes Rust the capture's temp-file **path** over the sidecar stdio, for Rust to read (rationale). **One capture per session and format in flight**: a request made meanwhile joins it — never one from before the session's close or relaunch — and the capture's spawn is killed past 30s. |
| `edit` | select-all/copy/cut via fixed host-owned JS plus an OS clipboard write. |
| `streamUrl` | The URL the webview connects to for a stream port. |
| `navigate`, `history`, `tab`, `viewport`, `device`, `close` | One fixed argv (agent-browser) or client call (Playwright) each. |
| `cdpUrl` | agent-browser only: the browser's CDP endpoint, for the popped-out URL observer. |

**Every transport waits `BROWSER_REQUEST_TIMEOUT_MS` (40s) for any reply**, past
agent-browser's 25s action timeout, so the webview never re-asks while the host
still works.

**The host runs one lifecycle for both providers**; a provider implements only
the primitives that differ (`BrowserProvider`: find, stop, open, probe, close,
list tabs, act, evaluate, screenshot, stream URL):

- **Must serialize a browser's launches, relaunching attaches and closes per
  native identity**, in arrival order — a launch into a session waits out a
  close of it still in flight, and two panes restoring one session relaunch it
  once. **A close runs after the launch or attach already running, closing what
  it brings up, and supersedes one sent before it that has not begun**, which
  answers that the browser was closed (rationale).
- **Must answer a launch inside `BROWSER_REQUEST_TIMEOUT_MS`**: startup,
  queueing included, gets 30 s from the request's arrival. A launch stops what
  runs a named session first, then resolves once the provider reports the
  browser up, **never waiting for the page**.
- **A launch that gives up must let its `open` land, for up to 4 s, before
  closing the session**, and close again when a later `open` lands unless a
  newer launch owns the session (rationale).
- **Once `open` returns, only a still-current launch closes stray
  `about:blank` tabs, last first, and only while a real page is open**, so it
  never closes the sole tab (rationale).
- **A headed launch is tracked for shutdown before it starts**, so a window
  whose page never loads is still closed; a headless relaunch or a close drops
  it. **Shutdown supersedes pending launches and sweeps, then closes every
  tracked headed browser**, so quitting orphans no window.

Pinned by `lib/src/host/browser-host.test.ts`.

**Host-side validation is the security boundary: `parseBrowserRequest` rebuilds
every request field by field before a provider sees it** — a known provider and
operation, an http(s) navigation or new-session URL, bounded dimensions, a tab
id and device name that cannot read as an option, and a session name neither
CLI reads as an option or a path (rationale). Pinned by
`lib/src/host/agent-browser-host.test.ts`.

**`binaryPath` crosses from the webview realm, so it is checked at the spawn**
(rationale). Accepted: the provider's executable by file name — absolute, or
bare and resolved on `PATH` — plus the host's own override variable by exact
match. **A refused path is dropped, never fatal**, so the host's own candidates
run. The webview applies the same predicate before sending one
(`browserHandle`) or storing one.

**Screenshots are captured into a private per-process directory, and it is
removed** (rationale). **A tmpdir that cannot be created is answered
`{ ok: false }` and retried on the next capture, never memoized.** A capture
file is reused per session: its reader leaves it, the next capture overwrites
it.

Source of truth: `lib/src/host/browser-host.ts` (`parseBrowserRequest`,
`createBrowserHost`, `BrowserProvider`), `BROWSER_PROVIDERS` (`isSessionName`,
`isAllowedBinary`) in `dor-lib-common/src/browser-providers.ts`, `BrowserRequest` in
`lib/src/lib/platform/browser-automation.ts`, `browserHandle` in
`lib/src/components/wall/browser-automation.ts`,
`lib/src/host/private-capture-dir.ts`, `vscode-ext/src/agent-browser-host.ts`,
`vscode-ext/src/webview-html.ts`, `standalone/src/tauri-adapter.ts`,
`standalone/src-tauri/src/lib.rs` (`browser_request`, `browser_screenshot`),
`standalone/sidecar/main.js`.

### agent-browser

What is agent-browser's alone: its per-session daemon, the state files beside
its socket, the pid kill a relaunch needs ([Pop-Out](#pop-out)), and one fixed
argv per operation. `--headed` is a no-op against a *live* daemon; only a
relaunch changes the mode.

- **`attach` reads the live port from `<session>.pid` / `<session>.stream` and a
  port probe, never spawning** — any CLI verb starts a daemon to answer. A
  daemon up but not streaming is left alone; its native identity is its session.
- **A launch runs `open` in the binding's project directory while it exists**,
  so a relaunch reads the same `./agent-browser.json` the `dor ab` there did;
  every other call runs in the host's.
- **Every spawn passes the `binaryPath` gate in `runWithBinaryFallback`**, the
  host's `DORMOUSE_AGENT_BROWSER_BIN` being the exact-match override.
- **VS Code must reach the stream through a loopback relay** — the agent-browser
  stream server rejects `vscode-webview://` origins. The relay grants one
  single-use, short-TTL token bound to one stream port and strips the Origin
  header; standalone connects directly.

Source of truth: `createAgentBrowserProvider` and `runWithBinaryFallback` in
`lib/src/host/agent-browser-host.ts`, `isAllowedAgentBrowserBinary` in
`dor-lib-common/src/browser-providers.ts`, `vscode-ext/src/agent-browser-host.ts`.
Pinned by `lib/src/host/agent-browser-host.test.ts`.

### Playwright

**Must use the user's installed `@playwright/cli`, resolved from `DORMOUSE_PLAYWRIGHT_BIN` or `PATH`.** GUI launches use Chromium. Native commands retain Playwright semantics: `open` restarts, `goto` navigates; commands for unsupported engines still run, with a viewer warning. The viewer requires CLI 0.1.19’s local browser-binding endpoint; installation errors name this requirement. A Playwright session lives in its CLI project scope, so a binding's cwd and executable pin every later command, relative paths included; `--session` uses the caller's own scope. GUI Connect inherits the source terminal's cwd; a swap without one uses the host cwd.

**Must discover the native session in its CLI project scope and connect using that installation's matching Playwright client.** Accept only a unique registry entry matching session, workspace and library, with a local pipe endpoint and Chromium engine. Never load modules from the registry's library path. The host derives the client from the validated CLI installation. **`attach` relaunches at the page only when the registry lists no browser for the session**, never one it cannot view; `dor pw`'s binding attaches with no page, and reports the browser's headedness. Native CLI tabs and the pane share the selected tab; the host polls tab selection and metadata every 750ms while viewed, broadcasting only changes, and the current state to each connecting viewer. Screenshots reuse tab state for up to 750ms; explicit host controls refresh immediately. **The controller must apply a host-reported mode before the new viewer port**, so sync never sizes a headed window, except mid-relaunch or as an echo ([Browser Connection](#browser-connection)).

Arbitrary CLI arguments, JavaScript and CDP methods are unavailable through the webview channel; the trusted `dor pw` process retains native passthrough. Executable hints use the same filename/exact-host-override boundary as agent-browser, with `playwright-cli` as the accepted name; `dor pw` applies it to the executable a binding returns (`docs/specs/dor-cli.md` → Browser Surface Addressing).

A relaunch closes the previous CLI session, and a launch completes when the browser endpoint is ready. **Every CLI call a launch waits on is killed at its deadline; every other one at 10 s, except `open`**, which lasts as long as the page load and whose end could take its browser down; nothing waits on it past a launch's own bounds. Shutdown also disconnects viewers. Viewer disconnect alone leaves the CLI browser alive. Concurrent input/captures share CDP attachments; disposal releases late attachments. **A screencast that fails to start must forget its page**, so the next poll releases the attachment and retries.

**Must authorize every stream upgrade with an own-loopback Host and a single-use, 60-second token bound to that viewer port.** Grants are capped at 1024; normal HTTP requests are refused. Input is limited to 64 KiB per message and 256 queued messages; frame backpressure drops frames above 2 MB queued. **Must send a paste as `input_text` messages of at most 8192 characters**, which the host inserts with CDP `Input.insertText`, never as a key pair per character (rationale). The same guarded stream serves all three hosts.

Source of truth: `followParamsHeadedness` in `lib/src/components/wall/agent-browser-surface-controller.ts`; `playwrightTextInputs` in `lib/src/lib/platform/browser-automation.ts`; `createPlaywrightProvider` in `lib/src/host/playwright-host.ts`; `resolvePlaywrightInstall` in `lib/src/host/playwright-install.ts`; `BrowserStreamGrants` in `lib/src/host/browser-stream-guard.ts`. Pinned by `lib/src/host/playwright-host.test.ts` (opt-in real CLI via `DORMOUSE_PLAYWRIGHT_TEST_BIN`), `lib/src/host/playwright-host.lifecycle.test.ts`, `lib/src/host/browser-stream-guard.test.ts`, and `AgentBrowserPanel Playwright params` in `lib/src/components/wall/AgentBrowserPanel.test.tsx`.

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
the proxy, in the one `IFRAME_HTTP_ONLY` wording** (a host without it frames
https raw):

| Entry | Outcome |
| --- | --- |
| `surface.iframe` (`dor iframe`) | refused before any pane opens, naming `dor ab open <url>` |
| Display modal | iframe option disabled, showing the wording |
| Render swap to `iframe`, tool or not | refused with a console warning; the modal never offers it, since both judge the page on screen (chrome URL, then `params.url`) |
| New-tab request from a framed page | an `ab-screencast` pane, bound to its launch like a render swap, closed if the launch fails |
| A pane already holding one | `scheme` panel error with Open in agent-browser and `dor ab open <url>` |

The terminal context's port rows are always `http://` (`listenerUrlsByPort`).

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
| response | `Vary` | `Sec-Fetch-Dest` appended, since the `Accept-Encoding` sent upstream depends on it |
| response body | `<meta http-equiv="content-security-policy">` | removed unless the response opts into CSP preservation |

**Must update this table whenever header rewriting changes.**

**Must instrument only an identity-encoded, ASCII-compatible HTML body, and keep
its `content-type` as sent**, charset included; a compressed body, or a UTF-16
one (any WHATWG label, or a byte-order mark), passes through uninstrumented
(rationale). **Never place the shim ahead of the doctype, a `<meta charset>` or a
UTF-8 BOM**: it goes before `</head>`, else after `<body…>`, else after the
document's leading BOM/doctype/`<html>`/`<head>`/`<meta charset>` tags.

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
else** — `leader`, `pointerdown`, `location`, `open-window`; `location` carries
`loaded: true` only on the document's own `pageshow`/`DOMContentLoaded` report.
**`location` is never relayed from a nested document**; the other three are. **`open-window`
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

**Once a proxied frame's shim has reported, a `load` with no `location` report
within 1s marks the document uninstrumented** (not HTML, off the proxy, refused,
or its grant gone), and a banner offers Reload and Open in agent-browser. Only a
`loaded` report naming the proxy origin counts, including one up to 250ms before
the load — a clicked link's report comes from the page being left; a new frame
source waits for its first report again, since a non-HTML
document served from the start carries no shim (rationale).

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
