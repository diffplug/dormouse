# DOR_AGENT_BROWSER — Implementation Plan

Implementation plan for the `dor agent-browser` / `dor ab` surface.

## Implementation status (2026-06-12)

All seven phases are built; see the spike outcome under Phase 4 for the three
design changes the build forced (dot-separated session names, stream-native
input replacing the CDP proxy, VS Code origin-stripping relay). Verified so
far: CLI phases headless (`dor/test`), stream input + relay live against
agent-browser 0.27.0. Outstanding:

- **In-app dogfood pass** (VS Code): extension is built and installed; needs a
  window reload and a `dor ab open` walk-through of frames/input/tabs/kill.
- **Standalone (Tauri) gaps:** frames + input work (its origin is allowed, so
  it connects to the stream directly), but `agentBrowserCommand` is not
  implemented in the Tauri adapter — tab switch/close, popup auto-focus, and
  kill→session-close are inert there until the sidecar grows that capability.
- **Favicons** are omitted from the tab strip (webview CSP blocks external
  images); spec updated.

**Design spec (read first):** [`docs/specs/dor-agent-browser.md`](docs/specs/dor-agent-browser.md).
This plan does not restate the design — it sequences the build and says how to
verify each step. When the plan and the spec disagree, the spec wins; if the
build forces a design change, update the spec in the same commit.

**Reference prototype:** `~/Documents/dev/agent-proto` (`serve.mjs` + `viewer.html`).
A working end-to-end viewer: stream-WS frames + CDP-proxied input + active-target
re-resolution. Treat it as the source of truth for the channel mechanics.

---

## Locked decisions (do not relitigate)

These are settled in the spec; the implementation follows them:

- Viewer client, **not a fork**. Resolve the user's `agent-browser` on `PATH`
  (`DORMOUSE_AGENT_BROWSER_BIN` override); never bundle it.
- `--key <name>` is primary, workspace-scoped, default `default`; maps to session
  `dormouse/<workspaceId>/<key>` (`workspaceId` hardcoded `1`). Mutually exclusive
  with raw `--session`.
- Session is the join key; **1:1 with an auto-managed surface**; no 1:many.
- Surface kill ↔ session close, both directions.
- One session = one surface regardless of tab count; tabs live **inside** the
  surface (integrated vs multi-tab strip), orthogonal to minimize.
- Three delegated channels: frames (stream WS), input (CDP via host proxy — but
  see the spike below), tabs (`tab list/<n>/close`).

---

## Dev loop & prerequisites

- `agent-browser` installed on PATH (`agent-browser --version`; tested against
  `0.27.0`). `npm i -g agent-browser` if missing.
- CLI-only iteration: `cd dor && pnpm build && node --test test/cli-output.test.mjs`.
- Full app: `pnpm build:vscode` then `pnpm --filter dormouse dogfood`, reload the
  VS Code window. (`dogfood:vscode` does **not** exist at the repo root.)
- Manual channel checks against a live session:
  ```
  agent-browser --session dormouse/1/default open http://localhost:5173
  agent-browser --session dormouse/1/default stream status --json   # → { port }
  agent-browser --session dormouse/1/default tab list --json
  ```

---

## Architecture at a glance

```
dor ab <args>  ──(resolve --key→session, exec)──▶  agent-browser  (user's binary)
      │
      └─(control: surface.agentBrowser {key,session,wsPort})─▶ Wall registry → surface
                                                                      │
AgentBrowserPanel (webview):                                          │
  • frames:  ws://127.0.0.1:<port>  ──── direct ───▶  canvas          │
  • input:   pointer/key ─▶ host (CDP proxy) ─▶ Chrome   ◀── see spike ┘
  • tabs:    tab list/<n>/close  (delegated via dor ab passthrough or control)
```

The host CDP proxy is the only genuinely new long-lived plumbing. The webview
**cannot** open a CDP WebSocket directly (Chrome refuses CDP from non-localhost
origins), so a host process (sidecar / `pty-host`) must hold the CDP socket and
forward input. **Unless the spike below removes that need.**

---

## ⚠️ Spike first: can input ride the stream WS directly?

The prototype proxies input through CDP. But agent-browser's stream WS protocol
documents **native input messages** (`input_mouse`, `input_keyboard`,
`input_touch`). If those work, the webview can send input over the **same
ws://localhost socket it already opened for frames** — eliminating the host CDP
proxy entirely and collapsing the hardest phase.

**Spike (do this before Phase 4):**
1. `agent-browser --session s open <url>` + `stream status --json` for the port.
2. Open that WS from a throwaway Node script; send
   `{"type":"input_mouse","eventType":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}`
   then `mouseReleased`; confirm the page reacts (e.g. a button click).
3. Repeat for `input_keyboard` (keyDown/keyUp + a focused field).

**Decision:**
- **Works** → use stream-native input, skip the host CDP proxy, and **update the
  spec's "Input (in)" section** to match. Phase 4 shrinks to "send input_* over
  the frame socket."
- **Insufficient** (missing key codes, IME, uploads, modifier handling) → keep the
  CDP-via-host-proxy design as spec'd and port `serve.mjs`'s approach.

Record the outcome at the top of Phase 4 before building it.

**SPIKE OUTCOME (2026-06-12, agent-browser 0.27.0): stream-native input WORKS.**
Click, typing (with `text`), and `mouseWheel` scrolling all confirmed against a
live session. The CDP host proxy is dead. Additional discoveries:
- Session names must not contain `/` (daemon dies on startup — the name becomes
  a socket path). Managed sessions are `dormouse.<workspaceId>.<key>`; spec
  updated.
- The stream WS pushes `status` and `tabs` messages, so the tab strip needs no
  polling; only tab *actions* need the CLI.
- The stream WS **rejects upgrades with a non-localhost `Origin`** (403 for
  `vscode-webview://…`; `tauri://localhost` and absent Origin are allowed). VS
  Code needs a loopback origin-stripping TCP relay in the extension host
  (Phase 7); standalone connects directly. Spec updated.

---

## Phases

Build leaf-up. Each phase is independently verifiable; the surface is usable for
real (frames visible) by end of Phase 3.

### Phase 1 — `dor ab` command (passthrough + `--key`)

CLI leaf, no rendering. Mirror an existing command end-to-end.

- **Files:** `dor/src/commands/agent-browser.ts` (new, mirror
  `dor/src/commands/iframe.ts`); register in `dor/src/cli.ts` `COMMANDS` +
  `ROUTES` with **both** keys `'agent-browser'` and `'ab'` pointing at the same
  `.command` (confirm stricli renders the alias acceptably in help — adjust if it
  duplicates the entry).
- **Behavior:** parse/strip `--key` (default `default`) and `--session`; error if
  both given; resolve `--key` → `dormouse/1/<key>`; forward all remaining args
  verbatim to the resolved `agent-browser --session <s> …`. Resolve the binary
  via `DORMOUSE_AGENT_BROWSER_BIN` ?? PATH; friendly error + install hint if
  absent.
- **Tests/snapshots:** add `dor/test/snapshots/help/agent-browser.md`; extend
  `dor/test/cli-output.test.mjs` for: `--help`, `--key`/`--session` mutual
  exclusion error, missing-binary error, and the key→session translation.
- **Verify:** `node --test test/cli-output.test.mjs` green; `dor ab open <url>`
  drives the right session from a terminal (no surface yet).
- **Spec:** "Delegation Boundary", "The `--key` Model".

### Phase 2 — `surface.agentBrowser` control method + Wall registry

Wire surface creation; the surface can stay the stub.

- **Files:** `dor/src/commands/types.ts` (add `AgentBrowserSurfaceRequest/Response`
  + `ControlClient.agentBrowserSurface`, mirror `IframeSurface*` at types.ts:109);
  `dor/src/control-client.ts` (map to `'surface.agentBrowser'`, mirror line 71);
  `lib/src/components/Wall.tsx` (handler mirroring the `surface.iframe` handler at
  Wall.tsx:1255 + `createIframeSurface` at Wall.tsx:888; add the
  `key→{session,surfaceId}` registry).
- **Behavior:** first call for a session with no surface → create (split next to
  caller, iframe placement rule); subsequent calls reuse. Pass `wsPort` (from
  `stream status --json`) + session into panel params.
- **Verify:** `dor ab open <url>` twice with same key → one surface, reused;
  different `--key` → second surface. (Stub still renders.)
- **Spec:** "Session ↔ Surface Mapping".

### Phase 3 — Frames channel (the payoff)

Replace the `AgentBrowserPanel` stub with a live canvas viewer.

- **Files:** `lib/src/components/wall/AgentBrowserPanel.tsx` (currently a stub).
- **Behavior:** connect `ws://127.0.0.1:<wsPort>`; on `{type:'frame'}` decode
  base64 JPEG → `drawImage` on a `<canvas>`; track `metadata` device size for
  later coordinate mapping; handle status messages (`connected`,
  `screencasting`) for placeholder states. Port `viewer.html`'s frame loop.
- **Verify:** `dor ab open http://localhost:5173` shows the live page in the
  surface; navigations update.
- **Spec:** "Channels → Frames (out)".

### Phase 4 — Input channel

**Resolve the spike first** and note the outcome here. Then either:

- **Stream-native:** send `input_mouse`/`input_keyboard` over the frame socket;
  map canvas → device coords via `metadata` (port `toViewport` from the
  prototype). Update the spec's Input section.
- **CDP-via-host-proxy:** add a long-lived CDP connection manager in the host
  (`standalone/sidecar/*`, `vscode-ext/src/pty-host.js`) holding the browser-level
  CDP WS + flattened `Target.attachToTarget` session, dispatching
  `Input.dispatchMouseEvent`/`dispatchKeyEvent`; add a webview→host input message
  path through the adapters (`lib/src/lib/platform/vscode-adapter.ts`,
  `standalone/src/tauri-adapter.ts`, `vscode-ext/src/message-router.ts`); throttle
  `mousemove`; re-resolve the active target on navigation (prototype's
  `/cdp-target`).
- **Focus:** terminal-surface semantics — click-to-focus, forward keys only while
  selected + in interact mode; leader chord returns to the Wall (Dormouse owns the
  keydown listener — `lib/src/components/wall/use-wall-keyboard.ts`).
- **Verify:** click and type into the embedded page; ⌘-leader still navigates panes.
- **Spec:** "Channels → Input (in)".

### Phase 5 — Tabs

- **Files:** `AgentBrowserPanel.tsx` (tab strip below header).
- **Behavior:** poll/refresh `tab list` → integrated (1) vs multi-tab (≥2) strip
  (title + favicon + close ×); selecting → `tab <n>` (stream/input follow active
  target); × → `tab close`; focus newest web-opened tab; `dor ab open` navigates
  active, never spawns.
- **Verify:** trigger a `target=_blank`/popup → strip appears, newest focused,
  closing extras returns to integrated mode; minimized surface stays title-only.
- **Spec:** "Tabs".

### Phase 6 — Lifecycle

- **Behavior:** surface kill (`dor kill` / header × / `dor ab … close`) →
  `agent-browser --session <s> close` + registry cleanup; external session death
  (stream `connected:false`) → remove/placeholder the surface.
- **Verify:** kill surface → browser process exits; `agent-browser close`
  elsewhere → surface tears down.
- **Spec:** "Lifecycle".

### Phase 7 — VS Code CSP + dogfood

- **Files:** `vscode-ext/src/webview-html.ts` — add
  `connect-src ws://127.0.0.1:* ws://localhost:* <existing cspSource>`. No
  `frame-src`/`img-src` change (canvas from base64, no iframe).
- **Verify:** `pnpm build:vscode` + `pnpm --filter dormouse dogfood`, reload; full
  flow works in the real extension. Also smoke-test the standalone (Tauri) build.
- **Spec:** "VS Code Webview CSP".

---

## Testing strategy

- **CLI:** snapshot + behavior tests alongside the other commands
  (`dor/test/cli-output.test.mjs`, `dor/test/snapshots/`). This is the
  highest-leverage automated coverage — Phases 1–2 are fully testable headless.
- **Channels:** mostly manual against a live `agent-browser` (frames/input/tabs
  need a real browser). The spike script and the prototype are the harness.
- **Run `node --test` in `dor/` after every CLI change; snapshots will catch help
  drift** (see how the iframe help snapshot is maintained).

---

## Risks & edge cases

- **Input spike is the pivot.** It decides whether Phase 4 is small (stream-native)
  or the largest phase (host CDP proxy + new adapter message path). Spike before
  committing to either.
- **CDP origin refusal** (if proxying): the webview cannot hold the CDP socket;
  it must live in the host. Don't try to connect CDP from the panel.
- **Coordinate mapping:** canvas size ≠ device size; scale through frame
  `metadata` (`deviceWidth/Height`, `pageScaleFactor`, scroll offsets). Port
  `toViewport` rather than reinventing.
- **Stream port churn:** OS-assigned per session; always read `stream status
  --json` fresh, don't cache across session restarts. `AGENT_BROWSER_STREAM_PORT`
  can pin it if needed.
- **Zero-tab state:** closing the last page leaves a context with no page — define
  the surface's empty state (placeholder, not a crash).
- **Mousemove chatter** (CDP path): throttle webview→host input.
- **`--headed` passthrough** pops a separate OS window (defeats embedding). Decide
  whether to warn/block; spec currently leaves passthrough verbatim.
- **stricli alias rendering:** verify `ab` appears sanely in `dor --help` / `dor ab
  --help`; adjust ROUTES if it duplicates.

---

## Definition of done

- `dor ab` and `dor ab --key <name>` open/reuse browser surfaces per the registry;
  CLI snapshot tests pass.
- Frames render live; input works; ⌘-leader still controls the Wall.
- Tabs present integrated vs multi-tab per spec; minimize stays binary.
- Surface kill ↔ session close both directions.
- Works in `dogfood` (VS Code) and standalone; CSP allows the stream WS.
- Spec updated for any design change the build forced (especially the input
  channel after the spike).

---

## Phase 8 — Screen indicator (SYNCED/SCALED) + viewport modal

**Spec:** "Screen Indicator & Viewport". A two-state header indicator derived
from reality, plus a modal that is purely a GUI front-end for native
`agent-browser set viewport` / `set device`. No keyboard shortcut.

**The architectural wrinkle to solve first.** The indicator lives in
`SurfacePaneHeader` (a dockview *tab* component) but the live state (viewport,
pane size, sync) and the action (`runAgentBrowser`) live in `AgentBrowserPanel`
(the *body* component). They are separate components for one pane, so they need a
per-surface bridge. Use the patterns already in the tree: a surface-id-keyed
registry like `terminal-lifecycle.ts` + a `useSyncExternalStore` store like
`external-link-confirmation.ts`. Build that bridge in 8b before the UI.

Leaf-up, each step independently verifiable:

### 8a — Allowlist `set`

- Add `'set'` to **both** allowlists: `AGENT_BROWSER_ALLOWED_SUBCOMMANDS`
  (`lib/src/lib/platform/types.ts:45`) and `ALLOWED_SUBCOMMANDS`
  (`vscode-ext/src/agent-browser-host.ts:23`). Still `args[0]`-gated — not a
  general exec channel.
- **Verify:** from the panel, `runAgentBrowser(['set','viewport','800','600','1'])`
  resizes the live browser (frames reflow).

### 8b — Per-surface screen bridge

- New `lib/src/components/wall/agent-browser-screen.ts`: registry keyed by
  surface id, each entry exposing `subscribe`/`snapshot` of
  `{ state: 'SYNCED'|'SCALED', viewport:{w,h,dpr}, paneCss:{w,h}, displayDpr,
  syncEngaged }` and actions `{ engageSync(), applyDevice(name),
  applyViewport(w,h,dpr), openModal() }`.
- `AgentBrowserPanel` registers its controller on mount (with `session` /
  `binaryPath`), unregisters on unmount. Presence of a controller for `api.id`
  is how the header knows a pane is an agent-browser surface.

### 8c — Derive SYNCED/SCALED in the panel + publish

- Compute from `deviceRef` (browser CSS viewport) and `canvas.width /
  deviceRef.width` (inferred DPR) vs pane CSS size (`getBoundingClientRect` on
  `elRef`) and `window.devicePixelRatio`. `SYNCED` iff dims + DPR match within a
  tolerance (guard fractional-DPR off-by-one). Publish to the registry **only on
  flip or dim change** — never per frame (don't thrash the header).
- **Verify:** resize the pane / change display scale → indicator value flips.

### 8d — Sync-to-pane + reconciliation (panel)

- While `syncEngaged`: `ResizeObserver` on `elRef` → re-issue `set viewport
  <cssW> <cssH> <displayDpr>` debounced ~200ms; track `lastIssued`.
- **Disengage rule:** when a frame reports a viewport matching neither
  `lastIssued` nor the current pane (evaluated only when the pane is stable and
  after we've issued), set `syncEngaged=false`. This is what lets `dor ab set …`
  and modal Device/Custom transparently take over.
- **Default on create: auto-engage sync** (decided) — a fresh browser surface
  starts `SYNCED`, responsive to the pane, not at native 1280×720. Spec updated.
- **Verify:** engage sync → `SYNCED`, resizes stay `SYNCED`; run `dor ab set
  device "iPhone 16"` in a terminal → sync disengages, `SCALED`.

### 8e — Header indicator

- In `SurfacePaneHeader`, if a controller exists for `api.id`, render the
  `SYNCED`/`SCALED` chip immediately right of the title; click → `openModal()`.
  Gate strictly on controller presence so terminals/iframes are untouched.
- **Verify:** chip shows only on browser surfaces, reflects state, click opens.

### 8f — The modal

- New `lib/src/components/wall/AgentBrowserScreenModal.tsx`, mounted via a host
  in `Wall` (mirror `ExternalLinkModalHost`). Reads the controller snapshot and
  pre-selects: *Sync* (if engaged + matching), else the registry device whose
  dims match, else *Custom* prefilled with current dims. Radios: **Sync to pane**
  / **Device** (fixed registry: iPhone 15/16/16 Pro/17, iPad, iPad Pro, Pixel 9,
  Galaxy S25) / **Custom** (W/H/DPI). Apply → `engageSync()` / `applyDevice()` /
  `applyViewport()`. Suppress Wall keys while open via `DialogKeyboardContext`
  (`setDialogKeyboardActive`); Esc cancels.
- **Device dims: apply-then-reflect** (decided) — the CLI doesn't expose a
  device's dims up front, so choosing a device issues `set device <name>` and the
  detail line fills in from the next frames. No hardcoded dims map. Spec updated.
- **Verify:** pick iPhone 16 → `SCALED` + phone frame; Custom 800×600 → applies;
  Sync → `SYNCED`.

### 8g — Persistence

- Persist `syncEngaged` per agent-browser surface. **Built via dockview panel
  params** (`AgentBrowserPanel` writes `api.updateParameters({ syncEngaged })`
  and seeds from `params.syncEngaged`), which round-trip through the serialized
  layout blob — the same channel that already carries `session`/`wsPort` across
  reloads — so no `session-types.ts`/`session-save.ts` change was needed. Device/
  custom viewports live in the agent-browser session and survive reattach on
  their own; sync re-engages on reattach iff it was engaged.
- **Verify:** save/restore preserves sync; save/restore with a device keeps that
  device (from the session).

### 8h — Host-capability degradation

- Without `agentBrowserCommand` (Tauri today), modal Apply / Sync are inert —
  disable Apply or show a note, mirroring tab-action degradation. `dor ab set …`
  from a terminal still works there (execs directly).

### Definition of done (Phase 8)

- Header shows `SYNCED`/`SCALED`, derived from frames, only on browser surfaces.
- Modal applies Sync / Device / Custom via native `set`; pre-fills from reality.
- `dor ab set …` from a terminal disengages sync and the indicator follows —
  CLI and GUI stay consistent.
- `syncEngaged` persists; standalone degrades gracefully.
- Spec updated for the two decisions (create-default, device-dims).

---

## Phase 9 — HiDPI screenshot streaming (DONE)

**Spec:** "Channels → Frames (out)". Shipped (commit `55bc7d3`).

The stream's screencast is CSS-resolution only — Chromium's
`Page.startScreencast` ignores `deviceScaleFactor` (verified against the CDP
spec, crbug 781117, and probes incl. our own CDP screencast + the proposed
`maxWidth=css*dpr` snippet — all 1×; only `Page.captureScreenshot` honors DPR).
So the panel **displays device-resolution screenshots** and uses screencast
frames purely as "page changed" pulses.

- Host capability `agentBrowserScreenshot(session, {format, quality})` runs
  `agent-browser screenshot` to a temp file and returns the bytes base64
  (`vscode-ext/src/agent-browser-host.ts`, `message-router.ts`,
  `message-types.ts`, `vscode-adapter.ts`, `platform/types.ts`).
- `AgentBrowserPanel` no longer decodes/draws stream frames; each is a pulse.
  Backpressure: one shot in flight, dirty-coalesce (latest wins), seq-guard
  against out-of-order decodes, adaptive ~1.5×-capture-time pacing (≈⅔ duty,
  50ms floor). Static page ⇒ no pulses ⇒ no cost. ~17fps JPEG q85 device-res.
- Fallback to rendering screencast frames where `agentBrowserScreenshot` is
  absent (Tauri).
- Adapter methods bound in the constructor — detached `getPlatform().agentBrowserX`
  references drop `this` and throw on `requestResponse` (bit us 3×).

## Phase 10 — Headed pop-out (planned)

**Spec:** "Headed Pop-Out". A header affordance that relaunches the surface's
browser **headed** as a real OS window the user drives directly; the Dormouse
pane becomes a clean placeholder. GUI-only, `randomKillChar()`-confirmed,
platform-gated. **Build leaf-up; this is desktop-only (Tauri-first), degraded in
VS Code, hidden on web.**

### 10pre — Profile-persistence spike (prerequisite-ish)

- Without it, pop-out drops cookies/login (ephemeral temp profile), so it's
  frustrating for authenticated sites. Spike a stable per-session user-data-dir
  (or `agent-browser state save`/`load`) so logins survive the relaunch.
- Decoupled from the v1 ship (v1 = URLs-only), but the first thing that makes
  pop-out genuinely useful. Land before or shortly after 10a–10f.

### 10a — Host capability: headed relaunch + window control

- New optional `PlatformAdapter` methods (mirror `agentBrowserScreenshot`):
  relaunch a session **headed** with window-position args, **raise** a window
  (by session/process), and resolve the **pane→screen rectangle** (Tauri only).
- Allowlist the headed `open`/launch path; degrade where unimplemented.
- **Verify:** from a terminal/host call, a session reopens headed as a window.

### 10b — Affordance + confirm

- Pop-out arrow in `SurfacePaneHeader` action cluster, agent-browser surfaces
  only, gated on host capability (hidden on web). Click → `randomKillChar()`
  overlay (mirror `KillConfirm`/`KillConfirmOverlay`).
- **Verify:** chip shows only on browser surfaces with a capable host; confirm
  overlay gates the action.

### 10c — Relaunch headed + reopen tabs + position

- Capture the ordered tab URL list (+ active) from the live `tabs` stream.
- Keep the session name; relaunch headed; reopen each URL in order, focus the
  active one. Best-effort position over the pane rect; **center on monitor**
  when coords are unavailable (always VS Code, always Wayland).
- **Verify:** pop-out reopens all tabs in order; lands over the pane (Tauri/mac)
  or centered (VS Code).

### 10d — Pane placeholder mode

- Clean placeholder copy; **Bring to front** (host raise) + **Pop back in**
  (closes the window → 10e revert). Stream stays connected for `tabs`/`status`
  only; frame display / screenshots / input / chip / tab strip inert.
- **Verify:** popped-out pane shows placeholder; bring-to-front raises; pop back
  in returns to headless.

### 10e — Lifecycle

- Headed window ends (any gesture) → **auto-revert**: relaunch headless, resume
  streaming, reopen the **last non-empty tab list**. Decoupled from teardown.
- `dor kill` / pane `×` → the only teardown (close window + session).
- App quit → clean up headed windows (no orphans).
- **Verify:** close window (1 tab) → that tab returns headless; close 3-tab
  window → 3 return; `dor kill` ends it; quitting leaves no stray Chrome.

### 10f — Cross-platform gating

- VS Code: spawns headed but can't position → center; bring-to-front best-effort.
- Wayland: center, raise may be unavailable. Windows: per-monitor/fractional DPI
  math for pane→window. Web: affordance hidden.
- **Verify (needs real hardware):** Windows high-DPI placement; a Wayland session
  centers and doesn't crash; macOS positions over the pane.

### Definition of done (Phase 10)

- Pop-out relaunches headed, reopens tabs in order, positions best-effort.
- Pane is a clean placeholder with bring-to-front + pop-back-in.
- Any window-end auto-reverts to headless (last non-empty tabs); only `dor kill`
  tears down; no orphan windows on quit.
- Confirmed via `randomKillChar()`; GUI-only; platform-gated with graceful
  degradation.
- (Stretch) profile persistence so logins survive the relaunch.
