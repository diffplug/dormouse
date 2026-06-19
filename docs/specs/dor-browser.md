# Dor Browser Surface

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary, and
> `docs/specs/dor-cli.md` for the shared `dor` CLI, surface handle model, and
> host control plumbing this surface builds on.

Dormouse has exactly one content surface for "view a web thing in a pane" —
**`surfaceType: 'browser'`** — with a **swappable renderer**. Two CLI commands
are entry points into the same surface, differing only in the renderer they
start and the target they accept:

- **`dor agent-browser <url>`** (alias `dor ab`) opens it as a live, interactive
  Chromium screencast (`renderMode: 'ab-screencast'`) by delegating 100% to the
  user's own [agent-browser](https://github.com/vercel-labs/agent-browser)
  install. Any URL, agent-drivable, slightly laggy.
- **`dor iframe <url>`** opens it as a high-fidelity `<iframe>` over a host-owned
  transparent proxy (`renderMode: 'iframe'`) — the page's **own DOM**, zero-lag
  and pixel-perfect, loopback dev servers.

A browser pane is **one surface with a swappable renderer, not separate surface
types**. The render axis is a per-pane choice: same target, switch
`ab-screencast` ↔ `ab-popout` ↔ `iframe` in place from the Display modal. This is
the hedge between the two engines — if the screencast's lag is unacceptable for a
local dev server, one gesture swaps it to the zero-lag iframe; if a page refuses
to be framed, one gesture swaps it to the real Chromium of agent-browser.

Each renderer has its own keyboard story, but both keep Dormouse's global leader
chord. The agent-browser renderer draws to a Dormouse-owned `<canvas>` rather
than a cross-origin `<iframe>`, so Dormouse keeps its own keydown listener and
never loses focus control. The iframe renderer recovers the same control through
a proxy-injected keyboard side-channel (see *The iframe renderer*). The shell,
chrome, and persisted state above the renderers are identical either way.

## Two axes

"View a web thing in a pane" factors into two **independent axes**. There is
exactly one content surface — `surfaceType: 'browser'` — and these axes are its
parameters, not separate surface types:

| | **Target: just a URL** | **Target: a backend Dormouse spawns & owns** |
| --- | --- | --- |
| **Render: `ab-screencast` / `ab-popout`** | `dor ab open <url>` — today | (possible, rarely wanted) |
| **Render: `iframe`** (proxy + shim iframe) | `dor iframe <localhost>` — today | **the plugin system (Path 2)** |

- **Render axis** = *how* you see it, the pane's `renderMode`. The agent-browser
  engine offers two (`ab-screencast` — real Chromium to a canvas, agent-drivable,
  any URL, laggy; `ab-popout` — the same session relaunched headed as an OS
  window); `iframe` is the engine-less DOM embed (the page's own DOM, zero-lag,
  loopback-only, not agent-drivable). The `ab-` prefix names the *engine*, leaving
  room for a future engine (`xyz-screencast`) beside it; `iframe` carries no
  engine.
- **Target axis** = *what* you point at. A bare URL, vs. a URL whose backend
  process Dormouse spawns and reaps (Path 2 — *Plugin system*, below).

The proxy + shim substrate lives **entirely in the `iframe` render backend**,
which is why both target-axis paths reuse it unchanged — they differ only in which
other axis they exercise.

---

# The shared shell

This is the part that is identical no matter what's rendered: the pane, its
chrome, its persisted state, the render swap, and the host plumbing pattern. The
two renderers plug in below it.

## One shell, two renderer children (not a fused component)

`AgentBrowserPanel` and `IframePanel` are **not** fused into a dual-mode
mega-component — their input models differ fundamentally (CDP `input_*` messages
vs native DOM). Instead a thin **`BrowserPanel` shell** owns `url` + `renderMode`,
registers the screen controller, and conditionally mounts the matching renderer
**child** (`AgentBrowserContent` / `IframeContent`). Switching mode updates the
shell's state + params and remounts only the child; the shell, the chrome, and the
URL survive. The two renderers stay separate components, so the anti-fusion
constraint holds while the chrome and target unify above them.

**All browser chrome is gated on screen-controller presence, which a `browser`
surface registers unconditionally** — every render mode, including `iframe`, on
every host — while **terminals** never do and keep their plain title header. This
is why `dor iframe` is a **full browser-chrome tab** (URL bar, back/forward,
dev-server chip, render chip), identical chrome to `dor ab`, and not a lesser
"iframe-only" surface: the chrome is no longer gated on the host being able to
swap to a screencast.

## Placement

Both commands follow the shared content-surface rule
(`lib/src/components/Wall.tsx` → `createContentSurface`): an untouched terminal
caller is replaced in place; anything else gets a split next to the caller. The
CLI front ends (`dor/src/commands/agent-browser.ts`, `dor/src/commands/iframe.ts`)
each send a control request; `parseIframeUrl` constrains `dor iframe` inputs to
absolute `http://`/`https://` (Dormouse does not infer schemes).

## Canonical pane state (the single source of truth)

Two things are persisted in the dockview **panel params** and are authoritative
for *every* renderer — this is what makes a swap preserve "where you were" and
"how you were looking at it":

```ts
// surfaceType: 'browser'
type BrowserPaneState = {
  url: string;                                      // the target — every renderer reads & writes it
  renderMode: 'ab-screencast' | 'ab-popout' | 'iframe';
  agentBrowser?: {                                  // engine state, present iff renderMode starts with `ab-`
    session: string; wsPort?: number; binaryPath?: string; syncEngaged?: boolean;
  };
};
```

- **`url` is single-homed.** The iframe renderer already round-trips `params.url`;
  the agent-browser renderer must do the same — write the active tab's URL back to
  `params.url` whenever its chrome snapshot changes, and seed the param from the
  `dor ab open <url>` that created it. Every transition then reads `params.url`,
  **never** a live stream snapshot that can be empty mid-relaunch. This is the fix
  for the previous class of swap bugs (blank-page swaps, `about:blank`
  auto-revert): the URL had no canonical home for agent-browser and was laundered
  from whatever happened to be live at the instant of the swap.
- **`renderMode` is one field**, not a `(surfaceType, poppedOut)` tuple split
  across two representations. Restore seeds straight from it. Invariant:
  `renderMode`'s engine prefix ⇔ the matching `agentBrowser` sub-state is present.

The `agentBrowser` sub-state survives reattach because panel params already
round-trip through the serialized layout blob (the same channel that carries
`session`/`wsPort` across webview reloads), so no `session-types.ts` /
`session-save.ts` change is needed. Engine-specific recovery of a stale `wsPort`,
and the `syncEngaged` seed, are detailed under *The agent-browser renderer*.

## Browser-chrome header

The browser surface's header reads like a browser: the active tab's **URL** (not
its HTML `<title>`), Chrome-style nav controls, and the one thing only Dormouse
can show — which pane in the workspace is serving a localhost URL. The header is
shared (`SurfacePaneHeader.tsx`) across both renderers and already tight and
responsive.

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
  state (see *Render indicator & the Display modal*) and clicking opens the
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
`<title>` is **demoted to the tooltip**. The persisted panel title (door labels,
session save) stays the tab's display title — the URL preference is a live-header
concern only, so the agent-browser multi-tab strip still shows HTML titles to tell
tabs apart. For the agent-browser renderer the URL rides the `tabs` stream and
flows body→header through the screen controller's separate **chrome snapshot**
channel (URL / key), kept distinct from the screen snapshot so tab updates don't
churn the render/screen chip and vice versa; for the iframe renderer it comes from
the shim's `location` message.

**Click to navigate.** Clicking the URL opens an inline editor (the
terminal-rename pattern) pre-filled with the full URL, all selected: **Enter**
navigates (scheme-normalized — `http://` for loopback so a bare `localhost:5173`
doesn't SSL-error, `https://` otherwise); **Escape**/blur cancels, browser-omnibox
style. While it's open the surface flags dialog-keyboard so the Wall's chord
handler stands down, and the panel's key-forwarder skips editable targets so
keystrokes reach the field, not the page. The agent-browser renderer issues
`open <url>`; the iframe renderer re-resolves the proxy.

### `--key` badge

The `--key` (default `default`) is what `dor ab --key …` targets, so with two or
more browser surfaces it's exactly what you need to see. A small badge renders
for **non-default keys only** (`default` is skipped), as a **separate element —
not a string prefix on the title** — because the title is persisted and we don't
want `(storybook)` leaking into saved state. It rides the chrome snapshot from
`params.key`; raw `--session` and iframe surfaces (no key) show no badge. See
*The `--key` model* for what a key is.

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
  PowerShell), so a scan never runs synchronously on tab-open: it's **debounced +
  idle-scheduled** (`requestIdleCallback`) so the opening tab's first screenshots
  come first. It **scans once, then settles** — a matched port is remembered and
  not rescanned; we only keep retrying (slow idle poll) while a wanted port is
  still *unmatched* (the dev server may start after the tab). A **surface reload**
  un-settles and re-validates, but optimistically — the current chip stays until
  the rescan disagrees. At most one scan is in flight; visible panes and minimized
  doors are both scanned (both keep live ptys).
- **Fallbacks (degrade to just the URL):** non-loopback URL; no pane listening on
  the port; a bind on a specific non-loopback interface; a tunneled/proxied
  domain; or two+ panes claiming the port (ambiguous).
- **Bidirectional (later):** a terminal serving a port could conversely show
  "viewed in `surface:3`". Out of scope for now; the port store would make it
  cheap.

### Back / forward / refresh

- For the agent-browser renderer **all three are native agent-browser commands** —
  `back`, `forward`, `reload` — added to the `agentBrowserCommand` allowlist and
  issued like tab actions, no eval fallback. For the iframe renderer they walk the
  panel's small parent-side history and re-resolve the proxy.
- **No enabled-state.** `canGoBack` / `canGoForward` aren't in the agent-browser
  stream, so the buttons are **always enabled** (a click at the ends no-ops)
  rather than greyed, matching most embedded browsers. They are inert on hosts
  without the backing capability (the web host), like the Display-modal resizes.

## Render indicator & the Display modal

### The chip

The **far-left header chip** is the surface's render/screen indicator and the
entry point to the **Display modal** (below). Its glyph reflects reality — the
current render backend, and for a screencast whether the viewport is locked to
the pane:

- **`iframe`** — frame-corners glyph.
- **`ab-screencast`, `SYNCED`** — link glyph (viewport resizes with the pane): the
  browser's live viewport (CSS pixels) equals the pane's CSS size, so the display
  maps 1:1. Matches the Display modal's *Resize with pane* control.
- **`ab-screencast`, `SCALED`** — closed-lock glyph (fixed resolution): anything
  else; the display is letterboxed/zoomed to fit the pane. Matches *Fixed* in the
  modal.
- **`ab-popout`** — box-with-arrow glyph (see *Headed pop-out*).

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

- **Render** — swap the backend in place: `ab-screencast`, `ab-popout`
  (*Headed pop-out*, below), or `iframe`. The `ab-popout` option appears only when
  the host exposes `canPopOut`; the `ab-*` options appear only when the host
  exposes `agentBrowserOpen` (the web host has neither). See *Render-mode
  transitions* for what each swap costs.
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
the same `set viewport` / `set device` a user runs as `dor ab set …`. Two issue
paths converge on one session — the terminal's `dor ab` execs agent-browser
directly; the webview modal goes through the host's `agentBrowserCommand` — and
the daemon serializes them. Whichever wrote last, the indicator and the modal's
pre-fill reflect it.

**Sync is the one non-native concept.** agent-browser has no "follow the pane"
mode; *Sync to pane* is a Dormouse behavior that auto-issues native `set viewport
<pane>` and re-issues on resize. **A freshly created browser surface auto-engages
sync**, so it starts `SYNCED` — pixel-for-pixel and responsive to the pane —
rather than at agent-browser's native 1280×720. Coexistence is
**last-writer-wins**: Dormouse tracks the viewport it last issued (`lastIssued`)
and only treats a deviating frame as an external override once a frame has first
*confirmed* the issued size landed (so a resize transient isn't mistaken for an
external `dor ab set …`). When an external setter wins, Dormouse disengages sync
and the indicator falls to `SCALED`.

> **Known limitation: no way to re-trigger sync from the CLI.** Because sync is
> not an agent-browser concept, `dor ab` has no verb for it; once an external
> `set` disengages sync, re-enabling it means reopening the modal and choosing
> *Resize with pane*.

The only Dormouse-side state worth persisting is **whether sync is engaged**;
device/custom viewports live in the agent-browser session itself and survive
reattach. `syncEngaged` rides in the surface's `agentBrowser` panel sub-state
(above), so it persists with no `session-types.ts` / `session-save.ts` change; the
panel seeds its initial state from `params.agentBrowser.syncEngaged` (absent ⇒
fresh surface ⇒ auto-engage). The capability inherits `agentBrowserCommand`,
implemented on both the VS Code and standalone hosts; only a host that doesn't run
agent-browser at all (the web host) leaves modal-driven resizes inert.

## Render-mode transitions (the swap)

Switching the renderer is triggered from the Display modal's *Render* section.
Because `url` and `renderMode` are canonical params, a swap preserves both no
matter the mechanism — it reads `params.url` / `params.renderMode`, never a
possibly-empty live snapshot.

| From → To | Behavior |
| --- | --- |
| `iframe` → `ab-screencast` / `ab-popout` | **Trivial.** One frame → spawn an agent-browser session at `params.url` = one tab; no loss. Host-gated on `agentBrowserOpen` (the webview can't resolve/run the binary); the Wall caches the last `dor ab` `binaryPath` to spawn with. Absent ⇒ the swap option is hidden (e.g. the web host). |
| `ab-screencast` ↔ `ab-popout` | Same session, relaunch headed/headless. **Silently drops all but the active tab** — no warning. |
| `ab-screencast` / `ab-popout` → `iframe` | If the session has **1 tab**, swap directly. If it has **≥2 tabs**, the agent-browser renderer (which owns the live tab list — the chrome snapshot carries only the active tab) shows a **warning that only the active tab transitions and the rest are closed, gated behind a typed-character confirm** (the gesture the original pop-out design reserved). On confirm, close the session and mount the iframe renderer at `params.url`. |

**Why only the crossing to `iframe` warns.** Every render-mode swap *within*
agent-browser is a Chrome relaunch that carries only the active tab's URL (see
*State carried (v1)* under *Headed pop-out*), so `ab-screencast` ↔ `ab-popout`
silently closes all other tabs. This is deliberate: multi-tab is the rare case,
the swap is user-initiated, and the auto-revert path (headed window closed) can't
prompt anyway. Only crossing to the single-frame `iframe` renderer warns +
requires a typed confirm, because that's the surprising loss — staying within
agent-browser is not. **Profile persistence** (*Future work*) retires this by
making the relaunch carry the full tab set.

Same-engine `ab-screencast` ↔ `ab-popout` is an in-panel relaunch (no surface
swap). A cross-renderer `ab-*` ↔ `iframe` swap still recreates the pane through
`Wall.replaceSurface` — the iframe renderer needs dockview's `renderer:'always'`
(fixed at panel creation), so it can't be a pure in-place child remount — but it
is no longer fragile: it reads `url` / `renderMode` from params instead of
hand-assembling state from a possibly-empty live snapshot.

## Lifecycle

Surface lifetime and the backing engine's lifetime are bound, both directions:

- **Kill the surface → tear down the engine.** `dor kill` / the header `×` /
  `dor ab … close` tears down the agent-browser session
  (`agent-browser --session <resolved> close`); an iframe surface's proxy server
  is released.
- **Engine dies externally → tear down the surface.** If an agent-browser session
  exits (crash, or a plain `agent-browser close` elsewhere), the stream reports
  `connected: false` and the Wall removes or placeholders the surface.
- **Render-swap away → tear down the old engine.** Swapping a screencast/popout
  surface to `iframe` closes its session too, through the same path
  (`Wall.replaceSurface` → `closeAgentBrowserSession`).
- **Pop-out auto-revert is guarded against teardown.** A popped-out surface keeps
  its stream open to watch for the headed window closing, then relaunches headless
  (see *Headed pop-out*). But Dormouse-initiated closes — a pane kill, or a swap
  away from popout — *also* drop that stream, which would otherwise be read as
  "the window closed" and resurrect the session. So a kill/swap marks the session
  closed first (`agent-browser-sessions.ts`) and auto-revert stands down.

**The teardown-on-kill hook.** The agent-browser close is currently special-cased
in `Wall.tsx`'s `killPaneImmediately`. The iframe proxy server has the same need —
today a killed iframe surface's proxy server is reaped by the idle sweep, not
immediately on kill — and so does Path 2's spawned backend. Generalizing this into
a per-surface teardown-on-kill hook is the shared follow-up (tracked under
*Plugin system*).

## Host plumbing pattern

Narrow host capabilities back the surface, all **optional** on `PlatformAdapter`
so hosts degrade gracefully. The capability *logic* for each concern is **one
host-agnostic module** with a single source of truth, never re-implemented per
host:

- The **VS Code** extension host imports the module directly.
- The **standalone** Node sidecar runs the bundled copy behind thin Rust
  forwarders (`standalone/src/tauri-adapter.ts` → `standalone/src-tauri/src/lib.rs`
  → `standalone/sidecar/main.js`).
- The **web** host omits the methods entirely, and the renderer falls back (raw
  uninstrumented iframe; screencast frame rendered directly; resizes/pop-out
  hidden).

So the two real hosts can't drift — there is no parallel re-implementation. The
agent-browser renderer's capabilities live in `lib/src/host/agent-browser-host.ts`
(each host injects only the OS clipboard write + logging); the iframe renderer's
`createIframeProxyUrl` lives in the shared proxy module. The specific methods for
each are listed under their renderer sections below.

---

# The agent-browser renderer

`dor ab` is a **viewer client, not a fork**: every piece of browser behavior —
Chromium, CDP, the screencast, the entire command surface — stays in
`agent-browser`. Dormouse adds only a thin surface that renders the session,
forwards input, and presents tabs. We reimplement none of agent-browser's
behavior, the same way an HTTP client is not a fork of the server.

## Delegation boundary

`dor ab` resolves the user's `agent-browser` binary on `PATH` (override with
`DORMOUSE_AGENT_BROWSER_BIN`). It is **not bundled or vendored**; if it is
missing, the command fails with an install hint (`npm i -g agent-browser`). The
version is therefore always the user's own — commands and the stream protocol are
version-matched by construction.

`dor ab <args...>` is a near-transparent passthrough to `agent-browser <args...>`.
Dormouse intercepts exactly one flag — `--key` (below) — translating it to an
`agent-browser --session` selector; every other argument is forwarded verbatim,
including subcommands that do not exist yet. Three behaviors are delegated rather
than reimplemented:

| Concern | Delegated to |
| --- | --- |
| Video (frames) | agent-browser session **stream** WebSocket, as change signals (see *Channels → Frames*) |
| Input (mouse/keyboard) | the same stream WebSocket's native **`input_*`** messages |
| Tabs | stream `tabs` messages (read) + **`tab list` / `tab <n>` / `tab close`** (act) |

## The `--key` model

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

A surface **spawned from the GUI** — a render-swap from `iframe` up to a live
screencast/popout, where there is no `--key` — instead gets a random
`dormouse.1.gui-<hex>` session, minted host-side by `agentBrowserOpen`.
**Known limitation:** a gui session is not `--key`-addressable, so `dor ab --key
…` can't target it; it stays driven through its surface.

### `--key` vs raw `--session`

`--key` (managed, namespaced) and `--session` (attach to a session by its literal
agent-browser name) are **mutually exclusive**. `--key default` applies only when
neither is given. `--session <raw>` is the bring-your-own escape hatch for
attaching to a session some other tool created; Dormouse still opens/reuses a
surface for it but performs no namespacing.

## Session ↔ surface mapping

The session name is the single source of truth. The Wall holds a registry:

```
key (or raw session) → { session, surfaceId }
```

- **1:1, auto-managed.** The first `dor ab` for a session with no surface creates
  a browser surface (split next to the caller, per *Placement*). Later commands
  for that session reuse it. No 1:many mirroring.
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
  trusts the stream's active bit when it already marks the new tab active.
  Dormouse only issues `tab <newestTabId>` when the new tab is not active, or
  when a provisional duplicate-URL tab later reaches its destination and still
  is not active. Dormouse does not fight the web's popup / open-in-new-tab
  behavior.
- **Empty tab snapshots after a non-empty list are transient**, usually a stream
  disconnect or target churn. They are logged and ignored so the browser chrome
  keeps showing the last real active tab instead of blanking the URL and title.

## Single-instance connection

Each visible agent-browser surface owns one `AgentBrowserConnection` for one
`{ session, streamPort, binaryPath }` tuple. The connection is the UI-agnostic
boundary for a single agent-browser daemon instance:

- **All tab metadata, one active visual target.** The stream publishes every tab
  (`tabs: [{ tabId, title, url, active }]`) so Dormouse can render the strip,
  close tabs, track the active URL, and detect new-tab/provisional-tab churn. The
  frame stream and input path still target only the daemon's active tab. Dormouse
  does not model per-tab frame streams.
- **Both screencast and pop-out use it.** In screencast mode the panel consumes
  frame pulses to drive screenshots and forwards input. In pop-out mode the panel
  stays connected only as an observer for tabs/status and auto-revert; it does
  not draw screenshots or force viewport sync.
- **Minimized browser surfaces are quiescent.** Minimize removes the pane, which
  unmounts `AgentBrowserPanel` and disposes the connection: the WebSocket closes,
  screenshot capture stops, input forwarding stops, and tab/status observation
  stops. The agent-browser session itself remains alive, like a terminal PTY
  behind a Door (see `layout.md`). Reattach recreates the connection from
  persisted params (`session`, `wsPort`, `binaryPath`, `url`) and resumes
  observation/rendering.
- **Stale-`wsPort` recovery.** A persisted `wsPort` is best-effort only. If a
  restored panel has no port or its saved stream socket is proven dead before that
  port ever opens in this panel instance, the panel asks the host for
  `agentBrowserStreamStatus(session)` and rewrites `params.agentBrowser.wsPort`
  with the current port before reconnecting. Once a port has opened live, later
  disconnects are treated as stream failures and do **not** trigger `stream
  status`: that CLI read can spawn a fresh daemon and reset the session, hiding
  the real failure. If the host reports the same port, the panel still clears the
  ended state and restarts its stream connection once; an unchanged live port can
  happen after a webview reload even though the prior socket attempt has failed.
- **Protocol hardening lives here.** The connection owns stream parsing,
  `tabId`/`id` normalization, ignored transient empty tab snapshots, provisional
  duplicate-URL new tabs, explicit tab selection for inactive web-opened tabs,
  close-code logging, retry on the same stream port, and the debug ring. Each
  connection records a bounded debug ring (`connect`, `open`, `close`, `tabs`,
  ignored transient events, tab-selection decisions); the durable diagnostic
  surface is the connection snapshot and debug ring.

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
- **Fallback:** on hosts without `agentBrowserScreenshot` (e.g. the web host),
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
  capability (the web host), the chords fall through to plain key
  forwarding, so pages' own JS shortcuts still fire.

Focus behaves like a terminal surface: click-to-focus; keystrokes forward to the
browser only while the surface is selected and in interact mode. Because Dormouse
owns the keydown listener (unlike an iframe), the leader chord always returns
control to the Wall.

### Tabs (in)

The stream WebSocket pushes `{ type: "tabs", tabs: [{ tabId, title, url,
active }] }` messages, which feed the strip for free. Tab *actions* still go
through the CLI — `tab <n>` (switch), `tab close` (per-tab `×`) — issued by the
host on the webview's behalf (a webview cannot spawn processes; see
`agentBrowserCommand` below).

## Headed pop-out

> Status: **implemented on the VS Code and standalone (Tauri) hosts** as a third
> render mode — not a separate header arrow. The Display modal's *Render* section
> offers `ab-popout` whenever the host exposes `agentBrowserPopOut` (`canPopOut`).
> The web host has no agent-browser, so pop-out is unavailable there.

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

**Affordance.** Selecting `ab-popout` in the Display modal's *Render* section and
pressing *Apply* (`AgentBrowserPanel.popOut` → `agentBrowserPopOut`). GUI-only —
like *Sync to pane* it has no `agent-browser` equivalent, so no `dor ab` verb.
(The original design called for a header arrow with a type-the-character confirm;
the shipped affordance is the modal radio, with no confirm step.)

**Identity-preserving relaunch.** Pop-out keeps the session name; only the Chrome
process changes (headed, new stream port). The key→`{session, surfaceId}`
registry is untouched, so `dor ab --key …` keeps driving the same surface
transparently.

**State carried (v1).** Only the **active tab's URL** is preserved across the
relaunch, resolved from the panel's latest non-blank active-tab observation and
passed to the host. Lost: other tabs, live DOM, scroll, form inputs,
`sessionStorage`, and — because agent-browser uses an ephemeral temp profile —
**cookies/login**. The **profile-persistence spike** (*Future work*) is the wanted
follow-up that makes pop-out usable for authenticated sites.

**The pane while popped out.** A clean stub: copy that the browser is in a
separate window, a **Pop back in** button (relaunch headless → resume the
screencast), and a best-effort **Bring to front** that renders only when the host
wires `agentBrowserBringToFront` (unimplemented today, so hidden). Frame display /
screenshots / input / chip / tab strip are inert, but the stream WS stays
connected to observe `status`/`tabs` and to drive auto-revert. Same-tab manual
navigation in the headed window is observed through a CDP subscription:
`agent-browser get cdp-url` returns the DevTools WebSocket, and the panel listens
for `Target.targetInfoChanged` / `Page.frameNavigated` events to keep the
Dormouse URL/header current without polling.

**Lifecycle.** The headed window ending and the surface being disposed are
decoupled:

- **The headed window closes** (its `×`/`⌘⇧W`, or closing the last tab — without a
  control tab these are indistinguishable) → the stream drops → **auto-revert**:
  relaunch headless at the active tab URL and resume streaming. The surface is
  never lost this way. A *Dormouse-initiated* close (kill, or a swap away from
  popout) also drops the stream, so the teardown guard keeps auto-revert from
  resurrecting it (see *Lifecycle*).
- **Kill the pane / `dor kill`** → the only teardown.
- **Dormouse/editor quits** → headed windows are cleaned up; no orphans. The
  shared host tracks popped-out sessions and closes them from each host's
  shutdown — VS Code's `deactivate()`, standalone's Tauri `RunEvent::Exit`
  sends the sidecar `sidecar:shutdown`, and the sidecar's `shutdown()` runs
  `closePoppedOut()` — so neither host leaves a detached Chrome window behind.

**Not built yet.** Window **positioning** over the pane (no host acts on the pane
`rect` it's passed yet, so Chrome places the window), **Bring to front**, and any
**web host** support (no agent-browser to spawn). Positioning eventually wants
per-monitor / fractional-DPI math on Windows and a center-only fallback on
Wayland; it stays a **platform-gated enhancement**, never load-bearing — the
streamed surface is the portable baseline.

## Agent-browser host capabilities

These follow the *Host plumbing pattern* above; the logic is the one shared module
`lib/src/host/agent-browser-host.ts`, run by both real hosts.

- **`agentBrowserCommand(session, args)`** — runs the user's agent-browser
  binary for tab actions (`tab <n>`, `tab close`, `tab new`), screen-mode
  resizing (`set viewport`, `set device`), navigation (`open <url>`, `reload`,
  `back`, `forward`), and lifecycle (`close`). The host validates `args[0]`
  against an allowlist (`tab`, `set`, `screenshot`, `open`, `reload`, `back`,
  `forward`, `close`); this is not a general exec channel.
- **`agentBrowserScreenshot(session, { format, quality })`** — captures one
  device-resolution frame via `agent-browser screenshot` (which honors the
  session DPR, unlike the screencast) and returns the raw bytes. (VS Code hands
  the webview a `Uint8Array` via structured clone; the standalone base64s them
  over the sidecar stdio, decoded back to raw bytes by the Rust forwarder, so the
  webview still receives an `ArrayBuffer`.) Drives the crisp display path; absent
  ⇒ the panel falls back to rendering screencast frames.
- **`agentBrowserStreamStatus(session)`** — reads the current `stream status
  --json` port for an existing session so restored panels can recover from a
  stale persisted `wsPort`. This is intentionally narrower than adding `stream`
  to `agentBrowserCommand`'s allowlist.
- **`agentBrowserEdit(session, op)`** — host-owned `eval` for the macOS editing
  chords (select-all/copy/cut) the stream input path can't dispatch.
- **`getAgentBrowserStreamUrl(port)`** — returns the WebSocket URL the webview
  should use for the session stream (see *VS Code webview CSP and stream origin*).
- **`agentBrowserOpen(url, { headed })`** — spawns a fresh managed session
  (`dormouse.1.gui-<hex>`) and opens `url`, optionally headed, returning
  `{ session, wsPort }`. Backs a render-swap from `iframe` up to a live
  screencast/popout, where the webview can't resolve/run the binary itself.
- **`agentBrowserPopOut(session, { url, rect })`** / **`agentBrowserPopIn(session,
  { url })`** — relaunch a session headed / headless at the active tab URL
  observed by the panel's live `tabs` stream, returning the new `wsPort`.
  Dormouse is the source of truth for this URL: the panel ignores transient
  `about:blank` values, mirrors the latest real active-tab URL into panel
  params, and also keeps a local ref so a just-arrived headed-window navigation
  wins over stale persisted params. The host trusts that supplied URL and does
  not query the daemon during close/reopen, because `stream status` / tab queries
  in the gap can spawn a competing blank daemon. Chrome's headed/headless choice
  is fixed at launch, so pop-out is a close + relaunch rather than a live toggle;
  `rect` is accepted but unused (no window positioning today). After relaunch,
  the host best-effort closes stray blank tabs when a real tab is also present,
  accepting either stream-style `tabId` or CLI-style `id` fields from
  `tab list --json`.
- **`agentBrowserBringToFront(session)`** — raise the headed OS window. Optional
  and **unimplemented today**, so the stub's *Bring to front* button stays hidden.

> **Footgun:** in the VS Code adapter these methods use `this.requestResponse`
> internally and are **bound in the adapter constructor**, because the panel calls
> some through detached references (`getPlatform().agentBrowserScreenshot`) which
> would otherwise drop `this`. (The Tauri adapter routes through a module-level
> `invoke`, so it has no such binding concern.)

### VS Code webview CSP and stream origin

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

## Implementation touchpoints

| Piece | Location |
| --- | --- |
| `dor ab` command (passthrough + `--key` intercept) | `dor/src/commands/agent-browser.ts` |
| Control method `surface.agentBrowser` request/response | `dor/src/commands/types.ts`, `dor/src/control-client.ts` |
| Shell + render swap | `lib/src/components/wall/BrowserPanel.tsx`, `lib/src/components/Wall.tsx` (`replaceSurface` / `onSwapRenderMode`) |
| Surface component (canvas viewer + tab strip + screenshot loop + sync tracking + render indicator + chrome snapshot + pop-out stub + auto-revert) | `lib/src/components/wall/AgentBrowserPanel.tsx` |
| Single-session stream connection (WebSocket lifecycle + tab/status/frame-pulse parsing + debug ring + visible-only resource boundary) | `lib/src/components/wall/agent-browser-connection.ts` |
| Browser-chrome header (render/screen chip + back/fwd/reload + URL + key badge + dev-server chip) | `lib/src/components/wall/SurfacePaneHeader.tsx` |
| Display modal (Render swap + Resolution; issues native `set …`) | `lib/src/components/wall/AgentBrowserScreenModal.tsx` |
| Per-surface teardown guard (auto-revert vs kill/swap) | `lib/src/components/wall/agent-browser-sessions.ts` |
| Per-surface screen+chrome bridge (header↔body↔modal) + modal host | `lib/src/components/wall/agent-browser-screen.ts`, `lib/src/components/AgentBrowserScreenModalHost.tsx` |
| URL display/loopback-port parsing | `lib/src/components/wall/browser-url.ts` |
| Dev-server port→pane store (consumed by the header) + Wall-side correlation driver | `lib/src/components/wall/agent-browser-ports.ts`, `lib/src/components/wall/use-dev-server-ports.ts` |
| Surface registration + control handler + key→session registry + `onFocusPane` | `lib/src/components/Wall.tsx` |
| Host capability logic — **single source of truth, run by both hosts** | `lib/src/host/agent-browser-host.ts` (+ types/allowlist in `lib/src/lib/platform/types.ts`) |
| Host wiring — VS Code | `lib/src/lib/platform/vscode-adapter.ts`, `vscode-ext/src/agent-browser-host.ts` (thin: instantiates the shared host + owns the VS-Code-only stream relay), `vscode-ext/src/message-router.ts` |
| Host wiring — standalone | `standalone/src/tauri-adapter.ts` → thin forwarders in `standalone/src-tauri/src/lib.rs` → the Node sidecar (`standalone/sidecar/main.js`, running the bundled `agent-browser-host.cjs`), exactly like the iframe proxy |

---

# The iframe renderer

`dor iframe <url>` opens an absolute `http(s)` URL in a high-fidelity `<iframe>`.
The iframe renders the page's **own DOM** directly — zero-lag and pixel-perfect —
but in a **separate browsing context** that the browser, not Dormouse, drives.

The renderer no longer points the `<iframe>` at the target directly. It fronts the
target with a **host-owned transparent proxy**: Dormouse serves the bytes, so it
controls them. That converts the iframe from a blind embedder into Dormouse-served
content, which is the one capability the raw iframe lacked — and from it the
surface gains a keyboard side-channel for its global leader chord, an accurate
focus model, and real error pages.

> Status: **works for loopback dev servers** in hosts that can run the shared
> Node proxy (VS Code extension host and standalone/Tauri sidecar). Arbitrary
> web browsing is still better served by the **agent-browser** renderer: the
> iframe renderer proxies `http://` upstreams (loopback dev servers are
> overwhelmingly plain http), defers `https://`, and routes a remote that refuses
> framing to an error page pointing at `dor ab`.

`IframePanel.tsx` asks the host to front the target with its proxy
(`getPlatform().createIframeProxyUrl`) and frames the returned loopback URL. If
the host has no proxy it falls back to a raw `<iframe src={url}>`; if the target
isn't proxyable (e.g. an `https://` URL) it shows an actionable message instead.

## The transparent proxy (instrumented iframe)

This is the **substrate** the renderer is built on. Instead of pointing the
`<iframe>` at the target, Dormouse points it at a loopback proxy
(`lib/src/host/iframe-proxy.ts`) that fetches the target and serves it back. The
moment Dormouse serves the bytes, three things become possible that the raw iframe
cannot do:

1. **Inject a keyboard side-channel** so Dormouse's global leader chord keeps
   working inside the frame (the technique VS Code uses for its own webviews).
2. **See the upstream result**, so a refused-to-be-framed page or a dead server
   becomes a clear error page instead of a blank pane.
3. **Report the frame's current location**, so Dormouse's browser chrome stays
   aligned with same-frame iframe navigation.

### The one load-bearing fact

Same-origin policy blocks the **parent from reaching into the child**
(`iframe.contentDocument` throws cross-origin). It does **not** block the **child
from posting to the parent** — `window.parent.postMessage()` is cross-origin-safe
by design. Dormouse can never reach *in*, but a script *we put in the served HTML*
can always call out. The only capability we need is control over the served
bytes, which the proxy gives us. This is exactly how VS Code instruments its
plugin webviews — serve HTML from an origin you own, inject a bootstrap — not a
new technique, the proven one.

### Target policy: loopback instruments, remote diagnoses

| Target | Proxy behavior |
| --- | --- |
| **Loopback** (`localhost`/`127.0.0.1`/`[::1]`) http | Full instrument: strip `X-Frame-Options`, drop the page CSP, inject the shim, serve. The user spawned it; framing is the intent. |
| **Remote** http, frameable | Best-effort render with the injected shim (flagged that `dor ab` is the better tool for arbitrary browsing). A CSP `frame-ancestors *` is considered frameable; scoped sources such as `https://*.example.com` are restrictive. |
| **Remote** http, refuses framing | **Never force-framed.** Serve a Dormouse error page with a one-click hint to `dor ab open <url>`. |
| **Unreachable** (conn refused, DNS, non-2xx) | Serve a Dormouse error page ("is the dev server running?"). |
| **`https://`** | Deferred. The panel reports `scheme` and points at `dor ab`. |

We do **not** force-frame a site that refuses embedding: rewriting authenticated
cross-origin pages is an auth/cookie/ToS dead end, and that's what the
agent-browser renderer is for. v1 proxies `http://` upstreams plus WebSocket
upgrades; `https://` is deferred.

### Proxy mechanism

Modeled on the agent-browser **stream relay**
(`vscode-ext/src/agent-browser-host.ts`) — already a loopback-only, single-purpose
forwarder. The difference: this proxy speaks **HTTP** (it parses and rewrites
responses) and passes through **WebSocket upgrades** (dev-server HMR,
openvscode-server's connection).

Source of truth: `lib/src/host/iframe-proxy.ts` owns the shared HTTP/WebSocket
server, while `lib/src/host/iframe-proxy-rewrite.ts` owns the dependency-free
policy, HTML instrumentation, framing checks, and served error pages.

- **Per-grant dedicated loopback server.** Each grant gets its own ephemeral
  `http.Server` bound to `127.0.0.1:0`, fronting exactly **one** fixed upstream.
  The grant's *origin* is the grant. Two consequences, and they are deliberate
  departures from the original "single shared port + `…/<token>/<path>`" sketch:
  - Root-relative sub-resources (`/assets/x.js`) and absolute paths resolve and
    proxy **transparently with zero body rewriting** — a shared origin can't do
    this without rewriting.
  - **No token in the URL.** A path-prefix token would land in
    `location.pathname`, and a client-side router (a React-Router/Remix dev
    server) would match no route and render its own 404. A server bound to a
    single upstream is inherently not an open forwarder, so the token bought
    nothing here that the dedicated server doesn't already provide.

  Grants use a sliding idle TTL with a lazy sweep (a live iframe refreshes on
  every request; an idle grant's server is closed), plus a hard cap.
- **Response rewriting.** For `text/html` from a frameable upstream: strip
  `X-Frame-Options`, drop the page CSP (response header **and** any
  `<meta http-equiv>`), inject the shim before `</head>`. `Host`/`Origin`/`Referer`
  are rewritten to the upstream so origin-aware servers (`Vary: Origin`, CSRF
  checks) see a same-origin request, and a `Location` redirect back to the
  upstream origin is rewritten to the proxy origin so it doesn't bounce the frame
  off-proxy. Non-HTML passes through (framing/hop-by-hop headers still stripped).
  The initial framed proxy URL preserves the target's path, query, and fragment;
  the fragment remains browser-only and is not sent on upstream HTTP requests.
  HTML injection streams: the proxy buffers only until `</head>`, `<body>`, or a
  bounded prefix cap, instruments that prefix, then pipes the rest of the
  upstream response through without waiting for the full document.
- **WebSocket passthrough.** Upgrades are forwarded as a raw byte pipe once the
  upgrade head is rewritten (`Host`/`Origin` → upstream), exactly like the stream
  relay.
- **Anti-framebust.** The `<iframe>` uses a `sandbox` without
  `allow-top-navigation`, so a tool's `if (top !== self) top.location = …` cannot
  navigate the Wall away.

## The iframe shim message channel

A fixed, Dormouse-owned script — like agent-browser's `EDIT_SCRIPTS`, never
user-supplied, so it is not an eval vector — injected inline before `</head>`.
It posts only Dormouse-owned control messages to the parent:

- `leader`: the reserved leader chord (dual-tap ⌘ / ⇧, the same detection as
  `handle-dual-tap.ts`).
- `pointerdown`: genuine user pointerdown inside the cross-origin frame, so the
  panel can adopt the click as pane selection + passthrough entry.
- `location`: the proxied frame URL after `pushState`/`replaceState`,
  `popstate`, `hashchange`, page show/load, and before same-frame anchor
  navigation. `IframePanel` maps that proxy-origin URL back to the upstream URL
  before updating iframe chrome and Back/Forward history. It does **not** write
  pane params or re-resolve the iframe source; in-frame client-side navigation
  must not become a full page reload.
- `open-window`: a `target=_blank` click or `window.open` the shim intercepts
  (see *New tab → new pane*), carrying the target URL.

Every other keystroke and pointer event flows to the tool untouched. The
embedded tool (a code editor, a VS-Code-web workbench) keeps full keyboard
interactivity; Dormouse keeps its one global chord and a click-adoption signal.

The Wall already owns a capturing `window` keydown listener
(`use-wall-keyboard.ts`); it gains a `message` listener that validates
`event.origin` against the live proxy grants (`lib/src/lib/iframe-proxy-registry.ts`)
and feeds the forwarded chord into the same dispatch the in-document dual-tap
would (`exitTerminalMode`) — no synthesized `KeyboardEvent` round-trip. The
iframe panel separately listens for the same validated proxy origin and treats a
`pointerdown` message as `onClickPanel(api.id)` and a `location` message as a
browser-history update for iframe chrome.

## Accurate focus model

- Focusing one of our iframes fires `blur` on the parent `window` even though the
  app isn't backgrounded; the focused element is just an `<iframe>` *inside* our
  document, so `document.hasFocus()` stays **true**. `use-window-focused.ts` and
  Wall's blur handler read it instead of blindly going inactive, so
  headers/attention stay live when an iframe takes focus.
- `IframePanel` registers a focus handle (`registerSurfaceFocusHandle` in
  `terminal-lifecycle.ts`) so `focusSession` focuses the frame element like any
  other surface. Because clicking *into* a cross-origin frame doesn't bubble a
  `mousedown` to the pane, proxied frames adopt the shim's validated
  `pointerdown` message as entering the pane. The raw fallback has no shim, so it
  preserves the older focus heuristic: window `blur` while our iframe is
  `document.activeElement` and the app still has focus. Both paths keep
  mode/selection consistent when the frame owns focus.

## Real error signals

With the proxy, **Dormouse is the server**, so it diagnoses lazily and serves a
precise error *page* from the proxy origin (which frames fine): a refused remote →
"`<host>` refuses to be embedded; `dor ab open <url>`"; a dead upstream → "nothing
responding at `localhost:8080` — is the dev server running?". `createIframeProxyUrl`
itself returns `{ ok: false, reason }` only for the synchronous cases (chiefly an
unproxyable `scheme`); reachability and frame-refusal are surfaced as served
pages. These served error pages include the same fixed leader shim as proxied
HTML, so the keyboard escape path still works after the user clicks inside an
error state.

## Cursor alignment (the out-of-process-frame offset)

A cross-origin iframe is an **out-of-process frame**; Chromium maps pointer events
to it relative to its nearest compositing/containing ancestor. Dockview's root
(`.dv-dockview`) sets `contain: layout`, so without intervention clicks land offset
by the pane's distance from that root (hundreds of px for a split pane).
`IframePanel` gives the iframe's **immediate container** its own identity layer
(`transform: translateZ(0)`), co-located with the frame, so it becomes the nearest
reference and the offset collapses to ~0. It's an identity transform, so
`getBoundingClientRect` (overlay measurement) is unaffected. Same-origin surfaces
(xterm, the agent-browser canvas) are immune — they recompute from
`getBoundingClientRect`, which a cross-origin frame can't.

## New tab → new pane

The iframe renderer is a single frame with no tab model, but pages do try to open
new tabs (`target=_blank`, `window.open`). Because Dormouse owns the served bytes,
the shim intercepts instead of letting the attempt be silently dropped: it posts
an **`open-window`** message (from intercepted `target=_blank` clicks and a
`window.open` override) carrying the target URL.

`IframePanel`'s existing origin-validated `message` listener handles `open-window`
by **prompting the user**, and on accept opens the URL as a **new `browser` pane**
(split beside the current one). This is the renderer-symmetric model:
**agent-browser holds many tabs inside one pane (the tab strip); the iframe
renderer spreads them across panes.** Two honest limits, surfaced in the prompt
rather than hidden:

- **Proxied mode only.** The raw-iframe fallback (no proxy, e.g. the web host) has
  no shim to intercept with, so popups there stay at the webview's mercy.
- **Opener-coupled popups don't survive a new pane.** OAuth / payment flows that
  `postMessage` back to `window.opener` break across a separate browsing context +
  proxy origin. Those are exactly what agent-browser's real tabs handle natively,
  so the prompt also offers **"switch this pane to `ab-screencast`"** for
  popup-heavy pages — turning a silent dead-end into an informed choice.

## Iframe host capability and CSP

A new optional `PlatformAdapter` method mirroring `getAgentBrowserStreamUrl`
(`lib/src/lib/platform/types.ts`), following the *Host plumbing pattern* above:

```ts
createIframeProxyUrl?(targetUrl: string): Promise<
  | { ok: true; url: string }
  | { ok: false; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string }
>;
```

VS Code implements it in the extension host (`vscode-ext/src/iframe-proxy-host.ts`),
routed via `message-router.ts` / `message-types.ts` and the `vscode-adapter.ts`
request/response pair. Standalone implements the same adapter method through
`standalone/src/tauri-adapter.ts` → `iframe_create_proxy_url` in
`standalone/src-tauri/src/lib.rs` → the sidecar's `iframe:createProxyUrl` command,
which loads the bundled shared proxy. **The proxy is needed on every host** —
even where a Tauri webview could frame `http://127.0.0.1` directly for origin
reasons, injection still requires controlling the bytes. Hosts with no process
to run one (the web host) omit the method and the panel falls back to a raw,
uninstrumented `<iframe>`.

With the proxy, the VS Code webview CSP (`vscode-ext/src/webview-html.ts`) narrows
from the old broad `frame-src http: https:` to the loopback proxy origin only:

```
frame-src http://127.0.0.1:* http://localhost:*
```

### Security model

The same fences as the stream relay: loopback-only bind both sides; a per-surface
grant served by a dedicated **single-upstream** server (no open forwarder); the
injected shim is fixed and Dormouse-owned (no user script ever reaches the page);
header-stripping never force-frames a third-party site (a refusing remote is
diverted to an error page, not stripped). For CSP, only a standalone
`frame-ancestors *` is permissive; wildcard host patterns remain restrictive.
**SSRF:** the proxy fetches a user-supplied URL, so it refuses link-local /
cloud-metadata ranges (`169.254.0.0/16`, `fe80::/10`) and trusts other ranges —
the trust boundary is the user's own `dor iframe <url>`.

## Remaining limitations

### Inherent (designed around, not patchable)

- **Focus still leaves Dormouse for the tool's own keys.** The shim reclaims only
  the leader chord; every other keystroke fires in the frame's document and never
  reaches the Wall's `window` listener — *by design*, so the embedded tool keeps
  full keyboard interactivity. The same-origin policy means the parent can't
  observe those keys; the leader is the one chord we round-trip.

### Known v1 gaps

- **`https://` upstreams are deferred** — the panel shows a `scheme` message with a
  `dor ab` hint.
- **Absolute-origin sub-resources bypass the proxy.** The dedicated-port origin
  makes root-relative URLs proxy transparently, but a dev server that emits
  absolute `http://localhost:5173/…` (notably Vite's HMR `ws://localhost:5173/…`)
  connects straight to the upstream — uninstrumented, though harmless for loopback
  since the browser can reach it.
- **No teardown-on-kill hook yet.** A killed iframe surface's proxy server is
  reaped by the idle sweep, not immediately on kill (the shared teardown hook is
  tracked under *Lifecycle* and *Plugin system*).

## Path 2 — Plugin system

> Status: **not yet built** — the remaining roadmap item.

Extend the **target axis** with process ownership: Dormouse spawns the plugin's
backend (an HTML editor, `openvscode-server` / `code serve-web`, any local tool)
and renders it through the same `iframe` backend. The rendering is solved by the
proxy; what Path 2 adds is a **process supervisor** — spawn (in what cwd/env?
per-workspace or per-pane? reuse across panes?), allocate/health-check the port,
wire the proxy to it, and **reap the process when the pane is killed.**

That last requirement is the second consumer that justifies generalizing the
per-surface **teardown-on-kill hook** — the one-off `agent-browser` close
currently special-cased in `Wall.tsx`'s `killPaneImmediately` (see *Lifecycle*),
and the same hook the iframe proxy server would use to close immediately instead
of waiting for the idle sweep.

**Risk specific to the motivating example (code-server / openvscode-server):** it
will stress the substrate more than a Vite dev server — worth a spike before
committing. It needs a broader `sandbox` (`allow-same-origin allow-scripts
allow-forms allow-popups allow-downloads allow-modals`, still omitting
`allow-top-navigation`); may want COOP/COEP for cross-origin isolation
(SharedArrayBuffer) — verify against the actual target; and leans on WebSocket
passthrough harder than most.

## Decisions made in v1

1. **Remote frameable targets** → render best-effort with the leader shim
   (loopback fully instrumented; a remote that refuses → error page). Keeps a crisp
   "loopback = full instrument, remote = best-effort, refusing = `dor ab`" line.
2. **Absolute-origin sub-resources** → left as a known gap. The dedicated-port
   origin solves root-relative URLs for free; absolute upstream URLs bypass the
   proxy rather than rewriting response bodies.
3. **SSRF range-blocking** → refuse link-local/metadata, trust other ranges (the
   command is the user's own).
4. **Web host** → keep the blind raw-iframe fallback rather than hiding the
   surface.

---

# Future work

- **Profile persistence** — a stable user-data-dir or `agent-browser state
  save`/`load`. Makes pop-out usable for authenticated sites, benefits the
  streamed surface too (logins survive daemon restarts), and **retires the
  silent-tab-drop limitation**: every render-mode swap within agent-browser is a
  Chrome relaunch that today carries only the active tab's URL (see *Render-mode
  transitions* and *State carried (v1)*), so `ab-screencast` ↔ `ab-popout` closes
  all other tabs. Profile persistence makes the relaunch carry the full tab set.
- **Re-trigger sync from the CLI** — a Dormouse-reserved `dor ab` verb, at the
  cost of the first non-passthrough subcommand.
- **Undo/redo chords** — blocked on the upstream stream-input `commands` fix.
- **Per-surface teardown-on-kill hook** — generalize the special-cased
  agent-browser close so the iframe proxy server and Path 2's spawned backend tear
  down immediately on kill instead of waiting for the idle sweep (see *Lifecycle*,
  *Plugin system*).
- **Bidirectional dev-server chip** — a terminal serving a port could show "viewed
  in `surface:3`"; the port store would make it cheap.
</content>
</invoke>
