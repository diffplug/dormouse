# Dor Agent-Browser Surface

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary, and
> `docs/specs/dor-cli.md` for the shared `dor` CLI, surface handle model, and
> host control plumbing this surface builds on.

`dor agent-browser` (alias `dor ab`) shows a live, interactive browser **inside**
Dormouse by delegating 100% to the user's own
[agent-browser](https://github.com/vercel-labs/agent-browser) install. It is a
**viewer client, not a fork**: every piece of browser behavior — Chromium, CDP,
the screencast, the entire command surface — stays in `agent-browser`. Dormouse
adds only a thin surface that renders the session's video stream, forwards input,
and presents tabs. We reimplement none of agent-browser's behavior, the same way
an HTTP client is not a fork of the server.

This is the chosen alternative to the iframe surface (see
`dor-cli.md` → "Iframe Surface: Limitations And Status"). Because the browser
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
| Video (frames) | agent-browser session **stream** WebSocket |
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

`--key` (managed, namespaced) and `--session` (your point 2: attach to a session
by its literal agent-browser name) are **mutually exclusive**. `--key default`
applies only when neither is given. `--session <raw>` is the bring-your-own
escape hatch for attaching to a session some other tool created; Dormouse still
opens/reuses a surface for it but performs no namespacing.

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

## Screen Modes (Zoom)

Each browser surface has a **screen mode** that controls the agent-browser
viewport and how the frame fills the pane. It is a thin convenience over
agent-browser's own `set viewport` / `set device` — it wraps none of
agent-browser's other `set` options, which stay reachable via `dor ab set …`
passthrough. Three presets, default **`ONE_TO_ONE`**:

| Mode | Icon | agent-browser viewport | Canvas |
| --- | --- | --- | --- |
| `ONE_TO_ONE` | `FrameCornersIcon` | `set viewport <paneW> <paneH>` (DPR 1), re-issued (debounced ~200ms) as the pane resizes | frame ≈ pane → renders pixel-for-pixel; the page reflows responsively to the pane |
| `DESKTOP` | `DesktopIcon` | `set viewport 1280 720` (DPR 1 — typical non-retina desktop; a tunable constant) | fixed frame scaled to **contain** (letterboxed) |
| `PHONE` | `DeviceMobileIcon` | `set device "iPhone 14"` (390×844 @ DPR 3, mobile UA + touch) | fixed frame scaled to **contain** |

The panel's existing contain-scaling (`max-h-full max-w-full`) and
canvas→device coordinate mapping (via frame `metadata`) already handle the
`DESKTOP`/`PHONE` letterboxing; no input-mapping change is needed. `ONE_TO_ONE`
is the responsive case — resize the pane and the page reflows, the way a browser
window would.

- **Indicator & control.** The mode icon sits immediately to the **right of the
  title** in the surface header. Clicking cycles
  `ONE_TO_ONE → DESKTOP → PHONE → ONE_TO_ONE`. In command mode, `s` cycles the
  focused browser surface's mode (gated to agent-browser surfaces, the way `t` /
  `a` are gated to panes in `handle-pane-shortcuts.ts`).
- **`CUSTOM` state.** If the live viewport (from frame
  `metadata.deviceWidth/Height`) does not match the active preset's target —
  e.g. the user ran `dor ab set viewport …` / `set device …` directly — the
  indicator shows a distinct `CUSTOM` glyph (e.g. `SlidersHorizontalIcon`) so it
  reflects reality, not intent (mirroring how the tab strip reflects pushed
  state). Toggling from `CUSTOM` re-enters the cycle at `ONE_TO_ONE`. This is how
  "custom resolutions and other agent-browser options" are accommodated without
  the presets trying to enumerate them.
- **Default & persistence.** New surfaces start `ONE_TO_ONE`. The chosen mode is
  per-surface and persists in saved session state (`session-types.ts`,
  `session-save.ts`); on (re)attach Dormouse re-asserts it by issuing the
  corresponding `set`.
- **Mechanism & host capability.** Mode changes issue `set viewport` / `set
  device` through `agentBrowserCommand`, whose allowlist must be extended from
  `{tab, close}` to also permit `set`. Like tab actions, the control inherits
  that host capability: on adapters that do not implement `agentBrowserCommand`
  (currently Tauri), the resize is inert and the control degrades accordingly.

## Lifecycle

Surface lifetime and browser lifetime are bound, both directions:

- **Kill the surface → close the browser.** `dor kill` / the header `×` /
  `dor ab … close` tears down the session (`agent-browser --session <resolved>
  close`).
- **Session dies externally → tear down the surface.** If the browser exits
  (crash, or a plain `agent-browser close` elsewhere), the stream reports
  `connected: false`; the Wall removes or placeholders the surface.

## Channels

Mirrors the validated `~/Documents/dev/agent-proto` prototype.

### Frames (out)

The webview connects directly to the session stream WebSocket and renders frames
to a `<canvas>`:

- Port discovery: `agent-browser --session <s> stream status --json` →
  `{ "port": <n>, ... }` ⇒ `ws://127.0.0.1:<n>`. Streaming is always enabled;
  `AGENT_BROWSER_STREAM_PORT` pins a port.
- Frame message: `{ "type": "frame", "data": "<base64 jpeg>", "metadata": {
  deviceWidth, deviceHeight, pageScaleFactor, scrollOffsetX, scrollOffsetY, … } }`.
  Decode → `drawImage`; map pointer coordinates through `metadata` device size vs
  canvas size.

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
  - `copy` → read the selection, write it to the **OS clipboard**
    (`vscode.env.clipboard`). Copying from the embedded browser lands in your
    real clipboard, which is the desired UX anyway.
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
| `dor ab` command (passthrough + `--key` intercept) | `dor/src/commands/agent-browser.ts` (new) |
| Control method `surface.agentBrowser` request/response | `dor/src/commands/types.ts`, `dor/src/control-client.ts` (mirror `surface.iframe`, types.ts:109, control-client.ts:71) |
| Surface component (canvas viewer + WS client + tab strip + screen-mode state / `set` issuance / pane-resize tracking) | `lib/src/components/wall/AgentBrowserPanel.tsx` |
| Screen-mode indicator/control, right of the title (agent-browser surfaces only) | `lib/src/components/wall/SurfacePaneHeader.tsx` |
| Command-mode `s` (cycle screen mode, gated to agent-browser surfaces) | `lib/src/components/wall/keyboard/handle-pane-shortcuts.ts` |
| Per-surface screen-mode persistence | `lib/src/lib/session-types.ts`, `lib/src/lib/session-save.ts` |
| Surface registration | `lib/src/components/Wall.tsx:339` (`'agent-browser': AgentBrowserPanel`) |
| Control handler + key→session registry | `lib/src/components/Wall.tsx` (mirror the `surface.iframe` handler at Wall.tsx:1255) |
| Host CLI runner (`agentBrowserCommand`) + VS Code stream relay | `lib/src/lib/platform/types.ts` (optional adapter methods), `vscode-ext/src/message-router.ts`, `vscode-ext/src/agent-browser-host.ts` |

### Host capabilities

Two narrow host capabilities back the surface, both optional on
`PlatformAdapter` so hosts degrade gracefully:

- **`agentBrowserCommand(session, args)`** — runs the user's agent-browser
  binary for tab actions (`tab <n>`, `tab close`, `tab new`), screen-mode
  resizing (`set viewport`, `set device`), and lifecycle (`close`). The host
  validates `args[0]` against an allowlist (`tab`, `set`, `close`); this is not
  a general exec channel.
- **`getAgentBrowserStreamUrl(port)`** — returns the WebSocket URL the webview
  should use for the session stream (see CSP/origin below).

## VS Code Webview CSP and Stream Origin

The VS Code webview CSP (`vscode-ext/src/webview-html.ts`) must allow the stream
WebSocket:

```
connect-src ws://127.0.0.1:* ws://localhost:* <existing cspSource>
```

The canvas is drawn from base64 frame data, so no `img-src` change is needed, and
no `frame-src` is involved — there is no iframe.

CSP alone is not enough in VS Code: the agent-browser stream server rejects
WebSocket upgrades whose `Origin` is not localhost-or-absent (verified against
0.27.0: `vscode-webview://…` → 403; `tauri://localhost` and plain localhost →
allowed; no override env var exists). The VS Code extension host therefore runs
a loopback-only TCP relay that strips the `Origin` header and pipes bytes to
`127.0.0.1:<streamPort>`; `getAgentBrowserStreamUrl` returns the relay URL
(`ws://127.0.0.1:<relayPort>/stream/<streamPort>`). The standalone (Tauri)
webview connects directly — its origin is allowed.
