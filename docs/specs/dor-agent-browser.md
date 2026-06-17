# Dor Agent-Browser Surface

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary, and
> `docs/specs/dor-cli.md` for the shared `dor` CLI, surface handle model, and
> host control plumbing this surface builds on.

`dor agent-browser` (alias `dor ab`) shows a live, interactive browser **inside**
Dormouse by delegating 100% to the user's own
[agent-browser](https://github.com/vercel-labs/agent-browser) install. It is a
**viewer client, not a fork**: every piece of browser behavior — Chromium, CDP,
the screencast, the entire command surface — stays in `agent-browser`. Dormouse
adds only a thin surface that renders the session, forwards input, and presents
tabs. We reimplement none of agent-browser's behavior, the same way an HTTP
client is not a fork of the server.

This is the chosen alternative to the iframe surface (see
[dor-iframe.md](dor-iframe.md)). Because the browser
renders to a Dormouse-owned `<canvas>` rather than a cross-origin `<iframe>`,
Dormouse keeps its own keydown listener and never loses focus control: the
keyboard model that breaks for iframes does not apply here.

## Delegation Boundary

`dor ab` resolves the user's `agent-browser` binary on `PATH` (override with
`DORMOUSE_AGENT_BROWSER_BIN`). It is **not bundled or vendored**; if it is
missing, the command fails with an install hint
(`npm i -g agent-browser`). The version is therefore always the user's own —
commands and the stream protocol are version-matched by construction.

`dor ab <args...>` is a near-transparent passthrough to `agent-browser <args...>`.
Dormouse intercepts exactly one flag — `--key` (below) — translating it to an
`agent-browser --session` selector; every other argument is forwarded verbatim,
including subcommands that do not exist yet. Three behaviors are delegated rather
than reimplemented:

| Concern | Delegated to |
| --- | --- |
| Video (frames) | agent-browser session **stream** WebSocket, as change signals (see Channels → Frames) |
| Input (mouse/keyboard) | the same stream WebSocket's native **`input_*`** messages |
| Tabs | stream `tabs` messages (read) + **`tab list` / `tab <n>` / `tab close`** (act) |

## The `--key` Model

`--key <name>` is the primary interface. It is **workspace-scoped** and defaults
to `--key default`, so a human running `dor ab` and a coding agent running
`dor ab` from any terminal in the same workspace land on the **same** browser
surface. This is the 80% case: one browser everyone iterates on. A second
concurrent browser is one flag away:

```
dor ab open http://localhost:5173        # → key "default"
dor ab --key storybook open http://localhost:6006
dor ab click @e3                          # drives key "default"
dor ab --key storybook reload             # drives key "storybook"
```

Workspace scoping is automatic: `dor ab` routes its control request to the Wall
that owns the invoking terminal surface, and the Wall is per-workspace, so key
resolution is scoped to the right workspace with no extra plumbing.

### Key → session naming

A managed `--key` maps to a namespaced agent-browser session:

```
session = "dormouse.<workspaceId>.<key>"
```

`<workspaceId>` is hardcoded `1` until Dormouse exposes real workspaces (see
`dor-cli.md` → Handle Model); it is encoded now to avoid a later rename.
Namespacing keeps managed keys from colliding with sessions a user created
directly via plain `agent-browser`. Dots, not slashes: agent-browser session
names become socket paths, and a `/` in the name kills the daemon on startup
(verified against 0.27.0). Keys are validated to `[A-Za-z0-9._-]+` for the
same reason.

A surface **spawned from the GUI** — a render-swap from `iframe embed` up to a
live screencast/popout, where there is no `--key` — instead gets a random
`dormouse.1.gui-<hex>` session, minted host-side by `agentBrowserOpen`.
**Known limitation:** a gui session is not `--key`-addressable, so `dor ab --key
…` can't target it; it stays driven through its surface.

### `--key` vs raw `--session`

`--key` (managed, namespaced) and `--session` (attach to a session by its literal
agent-browser name) are **mutually exclusive**. `--key default` applies only when
neither is given. `--session <raw>` is the bring-your-own escape hatch for
attaching to a session some other tool created; Dormouse still opens/reuses a
surface for it but performs no namespacing.

## Session ↔ Surface Mapping

The session name is the single source of truth. The Wall holds a registry:

```
key (or raw session) → { session, surfaceId }
```

- **1:1, auto-managed.** The first `dor ab` for a session with no surface creates
  a browser surface (split next to the caller, same placement rule as
  `dor iframe`). Later commands for that session reuse it. No 1:many mirroring.
- **Two namespaces, reconciled.** Every other `dor` command addresses a *surface*
  (`surface:3`, `title:…`); agent-browser addresses a *session*. Driving the
  browser is **session-keyed exclusively** (via `--key`/`--session`). Layout
  commands (`dor split`, `dor kill`, move) still treat the pane as an ordinary
  surface. The pane is addressable two ways for two purposes; there is no
  dual-identity ambiguity because only one namespace ever drives the browser.
- **Targeting by surface is supported but secondary.** A surface ref resolves
  *to* its bound session; `--key` remains the primary interface.

## Tabs

A session may have any number of tabs (page targets). Dormouse has no tab model
and gains none: **one session is always exactly one surface**, regardless of tab
count. Tabs live entirely inside that surface's chrome.

- **Integrated mode (1 tab):** the page title sits in the Dormouse surface
  header. No tab strip — the pretty, default case.
- **Multi-tab mode (≥2 tabs):** a tab strip renders *below* the Dormouse header,
  inside the surface body (title + close `×` per tab; no manual "+", and no
  favicons — the webview CSP blocks arbitrary external images). The strip is a
  thin view over the stream's pushed `tabs` messages; selecting a tab issues
  `tab <tabId>` (the frame stream and input follow the active target because
  "active tab" is an agent-browser operation); the `×` issues
  `tab close <tabId>`. When the session returns to one tab, the surface drops
  back to integrated mode.
- **Orthogonal to minimize.** Internal tab count is invisible when the surface is
  minimized: title-only along the bottom whether it holds 1 tab or 9. Dormouse's
  binary "you're looking at it or you're not" model is preserved.

Tab behaviors:

- **`dor ab open <url>` navigates the active tab; it does not spawn one.** New
  tabs arrive only from the web (popups, `target=_blank`) or an explicit
  `dor ab tab new`. The agent drives the active tab; the web spawns extras —
  which is what naturally moves the surface into multi-tab mode.
- **Web-opened tabs are focused** (enter multi-tab mode, select the newest),
  matching typical browser foregrounding; reversible by clicking back. Dormouse
  does not fight the web's popup / open-in-new-tab behavior.

## Browser-Chrome Header

The browser surface's header reads like a browser: the active tab's **URL** (not
its HTML `<title>`), Chrome-style nav controls, and the one thing only Dormouse
can show — which pane in the workspace is serving a localhost URL. All of this is
gated on **screen-controller presence**: a screencast surface and an `iframe
embed` surface (on hosts that can swap render mode) both register one and get the
full chrome; **terminals** keep their plain title header. The header is shared
(`SurfacePaneHeader.tsx`) and already tight and responsive.

### Layout — mirror Chrome's toolbar

Left→right, matching a real browser so it reads as "browser-ish":

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⤢   ←  →  ⟳    (storybook) localhost:5173   ◉ pnpm dev          ⬍ ⬌ ⤢   _  ✕ │
└──────────────────────────────────────────────────────────────────────────────┘
 disp  back/fwd/    key      URL              dev-server          split/zoom  min/
 chip  refresh      badge    (host+path)      connection          (collapse)  kill
```

- **Render/screen chip → far left.** Its glyph reflects the render mode + sync
  state (see Render Indicator & Viewport → The chip) and clicking opens the
  Display modal; it sits at the very left edge, out of the way of the nav
  controls.
- **Back / forward / refresh** sit where Chrome puts them, immediately left of
  the URL.
- **URL is the primary text**, replacing the HTML title. A flexible spacer lives
  after the URL/connection so the layout buttons stay right-aligned.

Priority order under width pressure: **chip + URL/connection always visible; nav
buttons collapse next (below ~360px); split/zoom collapse first (below 420px);
kill always stays.**

### URL over HTML title

The header's primary text is the active tab's **URL (host + path)**; the HTML
`<title>` is **demoted to the tooltip**. The URL already rides the `tabs` stream.
The persisted panel title (door labels, session save) stays the tab's display
title — the URL preference is a live-header concern only, so the multi-tab strip
still shows HTML titles to tell tabs apart. Both flow body→header through the
existing screen controller's separate **chrome snapshot** channel (URL / key),
kept distinct from the screen snapshot so tab updates don't churn the
render/screen chip and vice versa.

**Click to navigate.** Clicking the URL opens an inline editor (the
terminal-rename pattern) pre-filled with the full URL, all selected: **Enter**
navigates (`open <url>`, scheme-normalized — `http://` for loopback so a bare
`localhost:5173` doesn't SSL-error, `https://` otherwise); **Escape**/blur
cancels, browser-omnibox style. While it's open the surface flags
dialog-keyboard so the Wall's chord handler stands down, and the panel's
key-forwarder skips editable targets so keystrokes reach the field, not the page.

### `--key` badge

The `--key` (default `default`) is what `dor ab --key …` targets, so with two or
more browser surfaces it's exactly what you need to see. A small badge renders
for **non-default keys only** (`default` is skipped), as a **separate element —
not a string prefix on the title** — because the title is persisted and we don't
want `(storybook)` leaking into saved state. It rides the chrome snapshot from
`params.key`; raw `--session` surfaces (no key) show no badge.

### Dev-server connection

When the active tab URL is **loopback** (`localhost` / `127.0.0.1` / `[::1]` /
`*.localhost`), Dormouse correlates `<port>` to the **terminal pane serving it**
and surfaces a clickable chip — e.g. `◉ pnpm dev :5173` — that **focuses that
terminal** on click (reattaching it first if it's minimized). Dormouse is the
only tool that owns both the browser surface and the terminals, and the building
block is `PlatformAdapter.getOpenPorts(id)` (the TCP ports a terminal's process
tree is listening on).

Mechanics & wrinkles:

- **Where it lives.** A panel can't see other panes' ports, so correlation lives
  in the **Wall** (`use-dev-server-ports.ts` driving a shared store,
  `agent-browser-ports.ts`); the header consumes the resolved `{ paneId, label }`
  and clicks back into the Wall (`onFocusPane`) to focus the pane.
- **Which binds match.** A pane owns the port when it listens on it with a
  localhost-reachable bind — loopback (`127.0.0.1` / `::1`) **or** any-interface
  (`0.0.0.0` / `::`, which still answers `localhost`). A bind on one specific
  non-loopback interface does not match.
- **Cost — strictly off the hot path.** `getOpenPorts` shells out (`lsof` /
  PowerShell) on the host that also drives the screencast, so a scan never runs
  synchronously on tab-open: it's **debounced + idle-scheduled**
  (`requestIdleCallback`) so the opening tab's first screenshots come first. It
  **scans once, then settles** — a matched port is remembered and not rescanned;
  we only keep retrying (slow idle poll) while a wanted port is still *unmatched*
  (the dev server may start after the tab). A **surface reload** un-settles and
  re-validates, but optimistically — the current chip stays until the rescan
  disagrees. At most one scan is in flight; visible panes and minimized doors are
  both scanned (both keep live ptys).
- **Fallbacks (degrade to just the URL):** non-loopback URL; no pane listening on
  the port; a bind on a specific non-loopback interface; a tunneled/proxied
  domain; or two+ panes claiming the port (ambiguous).
- **Bidirectional (later):** a terminal serving a port could conversely show
  "viewed in `surface:3`". Out of scope for now; the port store would make it
  cheap.

### Back / forward / refresh

- **All three are native agent-browser commands** — `back`, `forward`, `reload`
  — added to the `agentBrowserCommand` allowlist and issued like tab actions, no
  eval fallback.
- **No enabled-state.** `canGoBack` / `canGoForward` aren't in the stream, so the
  buttons are **always enabled** (a click at the ends no-ops) rather than greyed,
  matching most embedded browsers. They are inert on hosts without
  `agentBrowserCommand` (Tauri today), like the Display-modal resizes.

## Render Indicator & Viewport

### The chip

The **far-left header chip** is the surface's render/screen indicator and the
entry point to the **Display modal** (below). Its glyph reflects reality — the
current render backend, and for a screencast whether the viewport is locked to
the pane:

- **embed** (`iframe`) — frame-corners glyph.
- **screencast, `SYNCED`** — link glyph (viewport resizes with the pane): the
  browser's live viewport (CSS pixels) equals the pane's CSS size, so the display
  maps 1:1. Matches the Display modal's *Resize with pane* control.
- **screencast, `SCALED`** — closed-lock glyph (fixed resolution): anything else;
  the display is letterboxed/zoomed to fit the pane. Matches *Fixed* in the modal.
- **popped out** — box-with-arrow glyph (see Headed Pop-Out).

> **UI source of truth:** the `Components/BrowserChromeHeader` Storybook story.

The screencast viewport is governed by agent-browser's own `set viewport` / `set
device`; Dormouse invents no parallel "mode" enum. `SYNCED`/`SCALED` is
**derived, never stored**: the viewport read from the stream
(`status.viewportWidth/Height`, equal to frame `metadata.deviceWidth/Height`) is
compared against the pane's CSS size (`getBoundingClientRect`). **DPR is not part
of the comparison:** the screencast is delivered at CSS-pixel resolution, so it
never encodes the browser's device pixel ratio (verified 0.27.0 — `set viewport
800 600 2` yields the same 800×600 frame as `@1`) and is unrecoverable from
frames. Dormouse still *issues* `displayDpr` when syncing so the page renders at
the right density, but the indicator is a pure CSS-size match — correct no matter
*how* the viewport was set (modal, `dor ab set …`, or a raw `agent-browser`
call). There is **no keyboard shortcut**.

### The Display modal

The chip opens the **Display modal** — the one place that owns *how* the surface
renders. Two parts:

- **Render** — swap the backend in place: `agent-browser screencast`,
  `agent-browser popout` (Headed Pop-Out, below), or `iframe embed`
  ([dor-iframe.md](dor-iframe.md) → Path 1). The popout option appears only when
  the host exposes `canPopOut`.
- **Resolution** (screencast only, greyed for the other render modes) — *Resize
  with pane*, a *Fixed* `W H DPI`, or a device from a fixed registry. Each is a
  GUI front-end for native `agent-browser set viewport` / `set device`: the modal
  issues exactly what a user could type as `dor ab set …` (Sync to pane →
  `set viewport <paneCssW> <paneCssH> <displayDpr>`, re-issued debounced on pane
  resize; Fixed → `set viewport <w> <h> <dpi>`; device → `set device <name>`).

> **UI source of truth:** the `Modals/AgentBrowserScreenModal` Storybook story.
> This spec describes behavior, not layout.

Two CLI constraints shape the resolution controls (verified against 0.27.0):
touch / mobile-UA exist **only** bundled inside `set device` (no standalone touch
setting), so *Resize with pane* and *Fixed* are never touch; and the CLI doesn't
expose a device's dimensions up front, so device sizing is **apply-then-reflect**
— the dims fill in from the next frames. Like the indicator, the modal reads live
state on open and reflects reality rather than a stored intent.

**Transparency with `dor ab set …`.** There is nothing extra to "expose" — the
modal *is* a GUI for native `agent-browser set`. *Fixed* and device-emulate issue
the same `set viewport` / `set device` a user runs as `dor ab set …`. Two issue paths
converge on one session — the terminal's `dor ab` execs agent-browser directly;
the webview modal goes through the host's `agentBrowserCommand` — and the daemon
serializes them. Whichever wrote last, the indicator and the modal's pre-fill
reflect it.

**Sync is the one non-native concept.** agent-browser has no "follow the pane"
mode; *Sync to pane* is a Dormouse behavior that auto-issues native `set
viewport <pane>` and re-issues on resize. **A freshly created browser surface
auto-engages sync**, so it starts `SYNCED` — pixel-for-pixel and responsive to
the pane — rather than at agent-browser's native 1280×720. Coexistence is
**last-writer-wins**: Dormouse tracks the viewport it last issued (`lastIssued`)
and only treats a deviating frame as an external override once a frame has first
*confirmed* the issued size landed (so a resize transient isn't mistaken for an
external `dor ab set …`). When an external setter wins, Dormouse disengages sync
and the indicator falls to `SCALED`.

> **Known limitation: no way to re-trigger sync from the CLI.** Because sync is
> not an agent-browser concept, `dor ab` has no verb for it; once an external
> `set` disengages sync, re-enabling it means reopening the modal and choosing
> *Resize with pane*.

Persistence and degradation:

- The only Dormouse-side state worth persisting is **whether sync is engaged**;
  device/custom viewports live in the agent-browser session itself and survive
  reattach. `syncEngaged` rides in the surface's dockview **panel params**, which
  already round-trip through the serialized layout blob (the same channel that
  carries `session`/`wsPort` across webview reloads), so it persists with no
  `session-types.ts`/`session-save.ts` changes; the panel seeds its initial state
  from `params.syncEngaged` (absent ⇒ fresh surface ⇒ auto-engage).
- A persisted `wsPort` is best-effort only. If a restored panel has no port or
  its saved stream socket is proven dead while the session is still live, the
  panel asks the host for `agentBrowserStreamStatus(session)` and rewrites
  `params.wsPort` with the current port before reconnecting. If the host reports
  the same port, the panel still clears the ended state and restarts its stream
  connection once; an unchanged live port can happen after a webview reload even
  though the prior socket attempt has failed.
- Like tab actions, this inherits the `agentBrowserCommand` host capability: on
  adapters that do not implement it (currently Tauri), modal-driven resizes are
  inert. (`dor ab set …` from a terminal still works there, since it execs
  agent-browser directly.)

## Lifecycle

Surface lifetime and browser lifetime are bound, both directions:

- **Kill the surface → close the browser.** `dor kill` / the header `×` /
  `dor ab … close` tears down the session (`agent-browser --session <resolved>
  close`).
- **Session dies externally → tear down the surface.** If the browser exits
  (crash, or a plain `agent-browser close` elsewhere), the stream reports
  `connected: false`; the Wall removes or placeholders the surface.
- **Render-swap away → close the browser.** Swapping a screencast/popout surface
  to `iframe embed` (Display modal → Render) closes its session too, through the
  same path (`Wall.replaceSurface` → `closeAgentBrowserSession`).
- **Pop-out auto-revert is guarded against teardown.** A popped-out surface keeps
  its stream open to watch for the headed window closing, then relaunches
  headless (see Headed Pop-Out). But Dormouse-initiated closes — a pane kill, or a
  swap away from popout — *also* drop that stream, which would otherwise be read
  as "the window closed" and resurrect the session. So a kill/swap marks the
  session closed first (`agent-browser-sessions.ts`) and auto-revert stands down.

## Channels

### Frames (out) — screenshot display, screencast-paced

The stream's screencast is **CSS-resolution only**: Chromium's
`Page.startScreencast` captures in DIP and has no deviceScaleFactor/scale knob,
so on a HiDPI display its frames upscale to mush. (Verified against the CDP spec
— screencast metadata is defined in DIP, `maxWidth/maxHeight` only *downscale* —
and by probe: our own CDP screencast at `deviceScaleFactor: 2` still returns 1×;
only `Page.captureScreenshot` honors DPR. This is a Chromium limitation, not
agent-browser's, so owning the CDP connection wouldn't change it.)

So Dormouse **displays device-resolution screenshots** and uses the screencast
purely as a **change signal**:

- Port discovery: `agent-browser --session <s> stream status --json` →
  `{ "port": <n>, ... }` ⇒ `ws://127.0.0.1:<n>`. Streaming is always enabled;
  `AGENT_BROWSER_STREAM_PORT` pins a port.
- Each `{ "type": "frame", … }` message is a "page changed" **pulse**. The
  frame's own JPEG is **not** decoded/drawn — in fact it is **not even parsed**:
  frames are the only large stream messages (a base64 JPEG, ~150–220 KB at
  desktop sizes; an animating page streams ~13 MB/s of them at 1080p/60fps that
  we'd otherwise `JSON.parse` and throw away), so we pulse on any message over a
  size threshold and skip the parse + allocation. The live viewport (for the
  indicator and input mapping) comes from the small `status` messages, which fire
  whenever it changes. Frame size is fixed to the viewport — the screencast has
  no resolution/fps knob (only `AGENT_BROWSER_STREAM_PORT`), and its rate is
  ~60fps regardless of size, so there's nothing to shrink anyway.
- On a pulse, capture a crisp frame via the host's `agentBrowserScreenshot`
  (`agent-browser screenshot`, which honors the session viewport/DPR — device
  resolution, e.g. 2560×1600 for a 1280×800@2 pane) and `drawImage` it to the
  canvas.
- **Backpressure (latest-only, self-throttling):** at most one screenshot in
  flight; a pulse during a shot sets a `dirty` flag (no queue — bursts collapse
  to one follow-up, latest wins); a sequence guard drops out-of-order decodes;
  the next shot waits ~1.5× the measured (EWMA) capture time since the last
  start (≈⅔ duty), with a floor against tight loops. A static page produces no
  pulses, hence no shots and no cost. (~17 fps JPEG q85 on an M-series Mac.)
- **Fallback:** on hosts without `agentBrowserScreenshot` (e.g. Tauri today),
  render the CSS-resolution screencast frame directly instead.
- Pointer coordinates map through the pane rect vs `metadata` device size
  (aspect-preserving; independent of the screenshot's pixel size).

### Input (in)

The stream WebSocket natively accepts input messages, so the webview sends
input on the **same socket it already opened for frames** — there is no CDP
connection and no host input proxy. (Verified against 0.27.0: `input_mouse`
press/release/move/wheel and `input_keyboard` keyDown/keyUp with `text` all
work, including scroll. The daemon dispatches to the active target itself, so
tab switches need no input re-attachment.)

- Mouse: `{ type: "input_mouse", eventType: "mousePressed" | "mouseReleased" |
  "mouseMoved" | "mouseWheel", x, y, button, clickCount, deltaX?, deltaY?,
  modifiers }` — coordinates mapped from canvas space to device space via frame
  `metadata`.
- Keyboard: `{ type: "input_keyboard", eventType: "keyDown" | "keyUp", key,
  code, text, windowsVirtualKeyCode, modifiers }`.

Keyboard caveats (all verified against 0.27.0):

- **`text` must always be present.** The daemon silently drops any
  `input_keyboard` whose `text` field is absent — arrows, Escape, modifier
  keys, every chord. `text: ""` dispatches a proper non-text key event;
  printable keyDowns carry the character. `text` is suppressed (sent as `""`)
  while ctrl/cmd is held so chords act as chords rather than inserting text.
- **`windowsVirtualKeyCode` needs a real VK map**, never
  `key.charCodeAt(0)` — `.` is char 46 = VK_DELETE, so periods turn into
  Delete presses (agent-browser's own bundled viewer has this bug).
- **Paste is bridged.** cmd/ctrl-V types the *local* clipboard into the page
  as per-character keyDown events; plain forwarding would paste the embedded
  Chromium's own (empty) clipboard.
- **macOS native editing chords (cmd-A/C/X) are emulated via the host edit
  channel,** not the stream. CDP `Input.dispatchKeyEvent` needs the `commands`
  hint for OS-level editing on macOS, and the stream protocol drops it (upstream
  limitation — see the filed issue). So instead of forwarding those chords, the
  panel routes the *intent* to the host's `agentBrowserEdit(session, op)`
  capability, which runs a host-owned `eval` over the daemon's CDP connection:
  - `selectAll` → `el.select()` / `execCommand('selectAll')`.
  - `copy` → read the selection, write it to the **OS clipboard**.
  - `cut` → copy + delete the selection.
  The webview only picks one of these three op names; the host owns the JS, so
  this is a purpose-built channel, not arbitrary eval. **cmd-Z/⇧Z (undo/redo)
  are not emulated** — `execCommand('undo')` is unreliable for CDP-typed input;
  they remain no-ops pending the upstream `commands` fix. On hosts without the
  capability (standalone/Tauri), the chords fall through to plain key
  forwarding, so pages' own JS shortcuts still fire.

Focus behaves like a terminal surface: click-to-focus; keystrokes forward to the
browser only while the surface is selected and in interact mode. Because Dormouse
owns the keydown listener (unlike an iframe), the leader chord always returns
control to the Wall.

### Tabs

The stream WebSocket pushes `{ type: "tabs", tabs: [{ tabId, title, url,
active }] }` messages, which feed the strip for free. Tab *actions* still go
through the CLI — `tab <n>` (switch), `tab close` (per-tab `×`) — issued by the
host on the webview's behalf (a webview cannot spawn processes; see
`agentBrowserCommand` below).

## Implementation Touchpoints

| Piece | Location |
| --- | --- |
| `dor ab` command (passthrough + `--key` intercept) | `dor/src/commands/agent-browser.ts` |
| Control method `surface.agentBrowser` request/response | `dor/src/commands/types.ts`, `dor/src/control-client.ts` |
| Surface component (canvas viewer + WS client + tab strip + screenshot loop + sync tracking + render indicator + chrome snapshot + pop-out stub + auto-revert) | `lib/src/components/wall/AgentBrowserPanel.tsx` |
| Browser-chrome header (render/screen chip + back/fwd/reload + URL + key badge + dev-server chip; agent-browser + iframe-embed surfaces) | `lib/src/components/wall/SurfacePaneHeader.tsx` |
| Display modal (Render swap + Resolution; issues native `set …`) | `lib/src/components/wall/AgentBrowserScreenModal.tsx` |
| Render-backend swap (in-place replace) + iframe-embed surface controller | `lib/src/components/Wall.tsx` (`replaceSurface` / `onSwapRenderMode`), `lib/src/components/wall/IframePanel.tsx` |
| Per-surface teardown guard (auto-revert vs kill/swap) | `lib/src/components/wall/agent-browser-sessions.ts` |
| Per-surface screen+chrome bridge (header↔body↔modal) + modal host | `lib/src/components/wall/agent-browser-screen.ts`, `lib/src/components/AgentBrowserScreenModalHost.tsx` |
| URL display/loopback-port parsing | `lib/src/components/wall/browser-url.ts` |
| Dev-server port→pane store (consumed by the header) + Wall-side correlation driver | `lib/src/components/wall/agent-browser-ports.ts`, `lib/src/components/wall/use-dev-server-ports.ts` |
| Per-surface `syncEngaged` persistence | dockview **panel params**, via the serialized layout blob (no `session-types.ts`/`session-save.ts` change) |
| Surface registration + control handler + key→session registry + `onFocusPane` | `lib/src/components/Wall.tsx` |
| Host capabilities + VS Code stream relay | `lib/src/lib/platform/types.ts`, `lib/src/lib/platform/vscode-adapter.ts`, `vscode-ext/src/agent-browser-host.ts`, `vscode-ext/src/message-router.ts` |

### Host capabilities

Narrow host capabilities back the surface, all optional on `PlatformAdapter` so
hosts degrade gracefully:

- **`agentBrowserCommand(session, args)`** — runs the user's agent-browser
  binary for tab actions (`tab <n>`, `tab close`, `tab new`), screen-mode
  resizing (`set viewport`, `set device`), navigation (`open <url>`, `reload`,
  `back`, `forward`), and lifecycle (`close`). The host validates `args[0]`
  against an allowlist (`tab`, `set`, `screenshot`, `open`, `reload`, `back`,
  `forward`, `close`); this is not a general exec channel.
- **`agentBrowserScreenshot(session, { format, quality })`** — captures one
  device-resolution frame via `agent-browser screenshot` (which honors the
  session DPR, unlike the screencast) and returns the raw bytes (a `Uint8Array`
  over structured clone, no base64 round-trip). Drives the crisp display path;
  absent ⇒ the panel falls back to rendering screencast frames.
- **`agentBrowserStreamStatus(session)`** — reads the current `stream status
  --json` port for an existing session so restored panels can recover from a
  stale persisted `wsPort`. This is intentionally narrower than adding `stream`
  to `agentBrowserCommand`'s allowlist.
- **`agentBrowserEdit(session, op)`** — host-owned `eval` for the macOS editing
  chords (select-all/copy/cut) the stream input path can't dispatch.
- **`getAgentBrowserStreamUrl(port)`** — returns the WebSocket URL the webview
  should use for the session stream (see CSP/origin below).
- **`agentBrowserOpen(url, { headed })`** — spawns a fresh managed session
  (`dormouse.1.gui-<hex>`) and opens `url`, optionally headed, returning
  `{ session, wsPort }`. Backs a render-swap from `iframe embed` up to a live
  screencast/popout, where the webview can't resolve/run the binary itself.
- **`agentBrowserPopOut(session, { url, rect })`** / **`agentBrowserPopIn(session,
  { url })`** — relaunch a session headed / headless at `url`, returning the new
  `wsPort`. Chrome's headed/headless choice is fixed at launch, so pop-out is a
  close + relaunch rather than a live toggle; `rect` is accepted but unused (no
  window positioning today).
- **`agentBrowserBringToFront(session)`** — raise the headed OS window. Optional
  and **unimplemented today**, so the stub's *Bring to front* button stays hidden.

> **Footgun:** these adapter methods use `this.requestResponse` internally and
> are **bound in the adapter constructor**, because the panel calls some through
> detached references (`getPlatform().agentBrowserScreenshot`) which would
> otherwise drop `this`.

## VS Code Webview CSP and Stream Origin

The VS Code webview CSP (`vscode-ext/src/webview-html.ts`) must allow the stream
WebSocket:

```
connect-src ws://127.0.0.1:* ws://localhost:* <existing cspSource>
```

The canvas is drawn from in-memory image bytes (`createImageBitmap` over a
`Blob`, never an `<img src>` to an external URL), so no `img-src` change is
needed, and no `frame-src` is involved — there is no iframe.

CSP alone is not enough in VS Code: the agent-browser stream server rejects
WebSocket upgrades whose `Origin` is not localhost-or-absent (verified against
0.27.0: `vscode-webview://…` → 403; `tauri://localhost` and plain localhost →
allowed; no override env var exists). The VS Code extension host therefore runs
a loopback-only TCP relay that strips the `Origin` header and pipes bytes only
to a stream port it has explicitly authorized. `getAgentBrowserStreamUrl` asks
the host for a short-lived, one-use relay URL
(`ws://127.0.0.1:<relayPort>/stream/<streamPort>/<token>`); the relay rejects
requests without a matching token/port grant. The standalone (Tauri) webview
connects directly — its origin is allowed.

## Headed Pop-Out

> Status: **implemented on the VS Code host** as a third render mode — not a
> separate header arrow. The Display modal's *Render* section offers
> `agent-browser popout` whenever the host exposes `agentBrowserPopOut`
> (`canPopOut`). Standalone/Tauri and web have no agent-browser, so pop-out is
> **VS-Code-only** for now.

The headless + streamed-screenshot surface above is the default everywhere: it is
crisp, deterministic, and **uniformly portable** (no OS window, no positioning,
no DPI/Wayland concerns; works identically on win/mac/linux, in VS Code, and on
web). But streaming can't match a *real* window for hands-on interactivity — IME
composition, file uploads, smooth scrolling, native editing chords, extensions,
DevTools, native dialogs. **Pop-out** is the escape hatch: it relaunches the
surface's browser **headed**, as an ordinary OS window the user drives directly.
A deliberate, occasional mode, not the rendering path.

Because Chrome's headed/headless choice is fixed at process launch (no live
toggle — verified), pop-out is a **relaunch**, not a move. The design embraces
that: the user interacts with the headed window natively, so Dormouse does
**not** screencast it — the in-Dormouse pane becomes a stub. This sidesteps the
headed-screencast, off-screen-occlusion, and window-tracking problems entirely.

**Affordance.** Selecting `agent-browser popout` in the Display modal's *Render*
section and pressing *Apply* (`AgentBrowserPanel.popOut` → `agentBrowserPopOut`).
GUI-only — like *Sync to pane* it has no `agent-browser` equivalent, so no
`dor ab` verb. (The original design called for a header arrow with a
type-the-character confirm; the shipped affordance is the modal radio, with no
confirm step.)

**Identity-preserving relaunch.** Pop-out keeps the session name; only the Chrome
process changes (headed, new stream port). The key→`{session, surfaceId}`
registry is untouched, so `dor ab --key …` keeps driving the same surface
transparently.

**State carried (v1).** Only the **active tab's URL** is preserved across the
relaunch. Lost: other tabs, live DOM, scroll, form inputs, `sessionStorage`, and
— because agent-browser uses an ephemeral temp profile — **cookies/login**. The
**profile-persistence spike** (stable user-data-dir or `agent-browser state
save`/`load`) is the wanted follow-up that makes pop-out usable for authenticated
sites.

**The pane while popped out.** A clean stub: copy that the browser is in a
separate window, a **Pop back in** button (relaunch headless → resume the
screencast), and a best-effort **Bring to front** that renders only when the host
wires `agentBrowserBringToFront` (unimplemented today, so hidden). Frame display /
screenshots / input / chip / tab strip are inert, but the stream WS stays
connected to observe `status`/`tabs` and to drive auto-revert.

**Lifecycle.** The headed window ending and the surface being disposed are
decoupled:

- **The headed window closes** (its `×`/`⌘⇧W`, or closing the last tab — without a
  control tab these are indistinguishable) → the stream drops → **auto-revert**:
  relaunch headless at the active tab URL and resume streaming. The surface is
  never lost this way. A *Dormouse-initiated* close (kill, or a swap away from
  popout) also drops the stream, so the teardown guard keeps auto-revert from
  resurrecting it (see Lifecycle above).
- **Kill the pane / `dor kill`** → the only teardown.
- **Dormouse/editor quits** → headed windows are cleaned up; no orphans.

**Not built yet.** Window **positioning** over the pane (VS Code can't read screen
coords, so Chrome places the window), **Bring to front**, and any **non-VS-Code
host**. Positioning eventually wants per-monitor / fractional-DPI math on Windows
and a center-only fallback on Wayland; it stays a **platform-gated enhancement**,
never load-bearing — the streamed surface is the portable baseline.

---

# Future work

- **Profile persistence** (above) — also benefits the streamed surface (logins
  survive daemon restarts), not just pop-out.
- **Re-trigger sync from the CLI** — a Dormouse-reserved `dor ab` verb, at the
  cost of the first non-passthrough subcommand.
- **Undo/redo chords** — blocked on the upstream stream-input `commands` fix.
