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
**browser-surface only**, gated on the screen-controller presence exactly like
the SYNCED/SCALED chip; terminals and iframes keep their plain title header. The
header is shared (`SurfacePaneHeader.tsx`) and already tight and responsive.

### Layout — mirror Chrome's toolbar

Left→right, matching a real browser so it reads as "browser-ish":

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⤢   ←  →  ⟳    (storybook) localhost:5173   ◉ pnpm dev          ⬍ ⬌ ⤢   _  ✕ │
└──────────────────────────────────────────────────────────────────────────────┘
 sync  back/fwd/    key      URL              dev-server          split/zoom  min/
 chip  refresh      badge    (host+path)      connection          (collapse)  kill
```

- **Sync chip → far left.** The SYNCED/SCALED icon (`FrameCorners`/`Resize`,
  click → screen modal) sits at the very left edge, out of the way of the nav
  controls. Behavior unchanged.
- **Back / forward / refresh** sit where Chrome puts them, immediately left of
  the URL.
- **URL is the primary text**, replacing the HTML title. A flexible spacer lives
  after the URL/connection so the layout buttons stay right-aligned.

Priority order under width pressure: **sync + URL/connection always visible; nav
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
SYNCED/SCALED chip and vice versa.

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
  `agentBrowserCommand` (Tauri today), like the screen-modal resizes.

## Screen Indicator & Viewport

The surface viewport is governed by agent-browser's own `set viewport` / `set
device`. Dormouse does not invent a parallel "mode" enum; instead the header
carries a **two-state indicator that reflects reality**, and a modal that is
nothing more than a GUI front-end for those native `set` commands.

### The indicator (SYNCED / SCALED)

At the **far left of the header** (see Browser-Chrome Header), the chip shows one
of two derived states — never a stored mode:

- **`SYNCED`** — the browser's live viewport (CSS pixels) equals the pane's CSS
  pixel size, so the display maps 1:1 with no scaling.
- **`SCALED`** — anything else; the display is letterboxed/zoomed to fit the pane.

The viewport is read from the stream (`status.viewportWidth/Height`, equal to
frame `metadata.deviceWidth/Height`) and compared against the pane's CSS size
(`getBoundingClientRect`). **DPR is not part of the comparison:** the screencast
is delivered at CSS-pixel resolution, so it never encodes the browser's device
pixel ratio (verified 0.27.0 — `set viewport 800 600 2` yields the same 800×600
frame as `@1`); it is therefore unrecoverable from frames. Dormouse still
*issues* `displayDpr` when syncing so the page renders at the right density, but
the indicator is a pure CSS-size match. Because it is derived, the indicator is
correct no matter *how* the viewport was set — modal, `dor ab set …`, or a raw
`agent-browser` call. `SYNCED` is simply the case where the viewport equals the
pane. There is **no keyboard shortcut**.

### The modal

Clicking the indicator opens a modal — three mutually exclusive targets:

```
╭─ Screen — surface:3 ────────────────────────────────────────╮
│                                                              │
│   Currently  SCALED                                          │
│   browser 393×852   ·   pane 980×560 @2x                     │
│                                                              │
│   ( ) Sync to pane                                           │
│       viewport follows the pane, pixel-for-pixel             │
│       → now: 980×560 @2x                                      │
│                                                              │
│   (•) Device           all devices emulate touch + mobile UA │
│       ┌──────────────────┐  ┌──────────────────┐            │
│       │ • iPhone 16      │  │   iPhone 16 Pro  │             │
│       │   iPhone 17      │  │   iPhone 15      │             │
│       │   Pixel 9        │  │   Galaxy S25     │             │
│       │   iPad           │  │   iPad Pro       │             │
│       └──────────────────┘  └──────────────────┘            │
│       iPhone 16 · 393×852                                    │
│                                                              │
│   ( ) Custom     W [ 1280 ]   H [ 720 ]    DPI [ 1 ]         │
│                                                              │
│                                   [ Cancel ]   [ Apply ]     │
╰──────────────────────────────────────────────────────────────╯
```

Each target maps to a native command — the modal issues exactly what a user
could type:

| Target | Native command issued |
| --- | --- |
| **Sync to pane** | `set viewport <paneCssW> <paneCssH> <displayDpr>`, re-issued (debounced ~200ms) on pane resize |
| **Device** | `set device <name>` — the fixed registry only (`iPhone 15`, `iPhone 16`, `iPhone 16 Pro`, `iPhone 17`, `iPad`, `iPad Pro`, `Pixel 9`, `Galaxy S25`); bundles viewport + DPR + touch + mobile UA |
| **Custom** | `set viewport <w> <h> <dpi>` |

The device registry is fixed (no custom descriptors), and touch / mobile-UA are
**only** available bundled inside `set device` — there is no standalone touch
setting (verified against 0.27.0). So Sync/Custom are never touch; only Device
is. The modal **reads the live viewport on open** and pre-selects accordingly:
*Sync* if sync is engaged and matching, otherwise *Custom* pre-filled with the
current dims. Like the indicator, the modal reflects reality rather than a stored
intent. The CLI does not expose a device's dimensions ahead of time, so device
sizing is **apply-then-reflect**: choosing a device issues `set device <name>`,
and its detail line fills in from the next frames rather than being known up
front (the same gap means the modal cannot pre-select a device by matching dims).

**Transparency with `dor ab set …`.** There is nothing extra to "expose" — the
modal *is* a GUI for native `agent-browser set`. Device/Custom issue the same
`set device` / `set viewport` a user runs as `dor ab set …`. Two issue paths
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
> *Sync to pane*.

Persistence and degradation:

- The only Dormouse-side state worth persisting is **whether sync is engaged**;
  device/custom viewports live in the agent-browser session itself and survive
  reattach. `syncEngaged` rides in the surface's dockview **panel params**, which
  already round-trip through the serialized layout blob (the same channel that
  carries `session`/`wsPort` across webview reloads), so it persists with no
  `session-types.ts`/`session-save.ts` changes; the panel seeds its initial state
  from `params.syncEngaged` (absent ⇒ fresh surface ⇒ auto-engage).
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
| Surface component (canvas viewer + WS client + tab strip + screenshot loop + sync tracking + SYNCED/SCALED + chrome snapshot) | `lib/src/components/wall/AgentBrowserPanel.tsx` |
| Browser-chrome header (sync chip + back/fwd/reload + URL + key badge + dev-server chip; agent-browser surfaces only) | `lib/src/components/wall/SurfacePaneHeader.tsx` |
| Screen modal (Sync / Device-registry / Custom; issues native `set …`) | `lib/src/components/wall/AgentBrowserScreenModal.tsx` |
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
- **`agentBrowserEdit(session, op)`** — host-owned `eval` for the macOS editing
  chords (select-all/copy/cut) the stream input path can't dispatch.
- **`getAgentBrowserStreamUrl(port)`** — returns the WebSocket URL the webview
  should use for the session stream (see CSP/origin below).

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

---

# Future Expansions

> Designed, not yet built. Everything above describes the surface as it exists
> today; everything below is planned.

## Headed Pop-Out

> Status: **implemented** on the VS Code host as a third render mode (not a
> separate header arrow): the Display modal's *Render* section offers
> `agent-browser popout` whenever the host exposes `agentBrowserPopOut`
> (`canPopOut`). Selecting it relaunches the session headed and turns the pane
> into a stub (`AgentBrowserPanel`'s popped-out state); the stub keeps the stream
> open to observe tabs/status and **auto-reverts** to a headless screencast when
> the headed window closes. *Bring to front* renders only when the host wires
> `agentBrowserBringToFront` (a no-op today). **v1 limits:** preserves the active
> tab URL only (multi-tab + cookie/profile restore are follow-ups), and **does
> not position** the window over the pane (VS Code can't read screen coords, so
> Chrome places it). Standalone/Tauri lacks agent-browser entirely, so pop-out
> is VS-Code-only for now.

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

**Affordance.** A pop-out arrow in the surface header's action cluster, on
agent-browser surfaces only, gated on a host capability (hidden on web). GUI-only
— like *Sync to pane* it has no `agent-browser` equivalent, so no `dor ab` verb.
Because it is destructive of live state, the click is confirmed with a
`randomKillChar()`-style type-the-character overlay (mirror `KillConfirm`).

**Identity-preserving relaunch.** Pop-out keeps the session name; only the Chrome
process changes (headed, new stream port). The key→`{session, surfaceId}`
registry is untouched, so `dor ab --key …` keeps driving the same surface
transparently.

**State carried.** v1 preserves the **ordered tab URL list + which was active**
and reopens them in order. Lost in v1: live DOM, scroll, form inputs,
`sessionStorage`, and — because agent-browser uses an ephemeral temp profile —
**cookies/login**. The **profile-persistence spike** (stable user-data-dir or
`agent-browser state save`/`load`) is the wanted follow-up that makes pop-out
usable for authenticated sites.

**The pane while popped out.** Stays open as a clean placeholder: copy that it's
in a separate window, a best-effort **Bring to front**, and **Pop back in**
(closes the window → triggers the revert below). Frame display / screenshots /
input / chip / tab strip are inert, but the stream WS stays connected to observe
`tabs`/`status` — we track the **last non-empty tab list** and watch for
`connected: false`.

**Positioning.** Best-effort, one-time, does **not** follow: place the headed
window's content area over the pane's screen rect when the host can resolve it;
otherwise — **always in VS Code** (sandboxed webview) and **on Wayland** (clients
can't self-position) — center on the current monitor.

**Window identity.** No control tab. *Bring to front* raises the OS window via
the host (by the session's process); a Dormouse-flavored window title isn't
guaranteed (a Chrome window's title follows its active tab).

**Lifecycle.** The headed window ending and the surface being disposed are
**decoupled**:

- **The headed window ends** — by any gesture (window `×`/`⌘⇧W`, or closing the
  last tab; without a control tab these are indistinguishable) → **auto-revert**:
  relaunch headless, resume streaming, reopen the **last non-empty tab list** in
  order. So closing the final tab reopens *that* tab; closing a three-tab window
  reopens those three. The surface is never lost this way.
- **Kill the Dormouse pane / `dor kill`** → the only teardown.
- **Dormouse/editor quits** → headed windows are cleaned up; no orphans.

**Host capability & cross-platform.** Needs host support beyond
`agentBrowserCommand`: relaunch headed with window-position args, raise a window,
resolve the pane→screen rect. Adapters degrade rather than fail:

| Host / platform | Spawn headed | Position over pane | Bring to front |
| --- | --- | --- | --- |
| Standalone (Tauri), macOS / Windows / Linux-X11 | yes | yes (best-effort) | yes |
| Standalone, Linux-**Wayland** | yes | **no** → center | best-effort / maybe no |
| VS Code (any OS) | yes | **no** → center (webview can't read screen coords) | best-effort |
| Web | **no** (affordance hidden) | — | — |

Windows adds per-monitor / fractional-DPI math; Wayland can't self-position or
reliably raise, so it always centers. The feature is therefore a **platform-gated
enhancement**, never load-bearing — the streamed surface stays the portable
baseline on every target.

## Other planned

- **Profile persistence** (above) — also benefits the streamed surface (logins
  survive daemon restarts), not just pop-out.
- **Re-trigger sync from the CLI** — a Dormouse-reserved `dor ab` verb, at the
  cost of the first non-passthrough subcommand.
- **Undo/redo chords** — blocked on the upstream stream-input `commands` fix.
