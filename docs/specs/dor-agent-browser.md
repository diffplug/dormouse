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
| Input (mouse/keyboard) | **CDP** `Input.*`, proxied by the Dormouse host |
| Tabs | agent-browser **`tab list` / `tab <n>` / `tab close`** |

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
session = "dormouse/<workspaceId>/<key>"
```

`<workspaceId>` is hardcoded `1` until Dormouse exposes real workspaces (see
`dor-cli.md` → Handle Model); it is encoded now to avoid a later rename.
Namespacing keeps managed keys from colliding with sessions a user created
directly via plain `agent-browser`.

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
  inside the surface body (title + favicon + close `×` per tab; no manual "+").
  The strip is a thin view over `agent-browser tab list`; selecting a tab issues
  `tab <n>` (the frame stream and CDP input follow the active target because
  "active tab" is an agent-browser operation); the `×` issues `tab close`. When
  the session returns to one tab, the surface drops back to integrated mode.
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

Chrome refuses CDP WebSocket connections from regular http(s) origins, so the
webview **cannot** speak CDP directly. Input is proxied by the Dormouse host
(sidecar / `pty-host`, the same process that already bridges control requests):
the host holds one persistent browser-level CDP WebSocket plus a flattened
`Target.attachToTarget` session and dispatches `Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent`. The host re-resolves the active page target on
navigation (the prototype's `/cdp-target`).

Focus behaves like a terminal surface: click-to-focus; keystrokes forward to the
browser only while the surface is selected and in interact mode. Because Dormouse
owns the keydown listener (unlike an iframe), the leader chord always returns
control to the Wall.

### Tabs

`agent-browser tab list` (strip contents), `tab <n>` (switch), `tab close`
(per-tab `×`) — all verbatim passthrough.

## Implementation Touchpoints

| Piece | Location |
| --- | --- |
| `dor ab` command (passthrough + `--key` intercept) | `dor/src/commands/agent-browser.ts` (new) |
| Control method `surface.agentBrowser` request/response | `dor/src/commands/types.ts`, `dor/src/control-client.ts` (mirror `surface.iframe`, types.ts:109, control-client.ts:71) |
| Surface component (canvas viewer + WS client + tab strip) | `lib/src/components/wall/AgentBrowserPanel.tsx` (currently a stub) |
| Surface registration | `lib/src/components/Wall.tsx:339` (`'agent-browser': AgentBrowserPanel`) |
| Control handler + key→session registry | `lib/src/components/Wall.tsx` (mirror the `surface.iframe` handler at Wall.tsx:1255) |
| CDP input proxy | host: `standalone/sidecar/*`, `vscode-ext/src/pty-host.js` |

## VS Code Webview CSP

The VS Code webview CSP (`vscode-ext/src/webview-html.ts`) must allow the stream
WebSocket:

```
connect-src ws://127.0.0.1:* ws://localhost:* <existing cspSource>
```

The canvas is drawn from base64 frame data, so no `img-src` change is needed, and
no `frame-src` is involved — there is no iframe.
