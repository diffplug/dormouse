# DOR_AGENT_BROWSER — Implementation Plan

The `dor agent-browser` / `dor ab` surface is **built and shipped**. Its design
and current behavior are described in
[`docs/specs/dor-agent-browser.md`](docs/specs/dor-agent-browser.md) — that spec
is the source of truth. This doc tracks only the **remaining build work**; the
spec's "Future Expansions" section is the design for it.

## Dev loop

- `agent-browser` on `PATH` (`agent-browser --version`; tested against `0.27.0`).
- CLI-only iteration: `cd dor && pnpm build && node --test test/cli-output.test.mjs`.
- Lib unit tests: `cd lib && npx vitest run`.
- Full app: `pnpm build:vscode` then `pnpm --filter dormouse dogfood`, then reload
  the VS Code window. Standalone: smoke-test the Tauri build separately.
- Channel behaviors (frames/input/tabs/screenshots) are mostly manual against a
  live `agent-browser`; the probes under `~/.agent-browser/tmp/probe-*.mjs` are
  the harness for protocol questions.

---

## Phase 10 — Headed pop-out (planned)

**Spec:** "Future Expansions → Headed Pop-Out". A header affordance that
relaunches the surface's browser **headed** as a real OS window the user drives
directly; the Dormouse pane becomes a clean placeholder. GUI-only,
`randomKillChar()`-confirmed, platform-gated. **Build leaf-up; desktop-only
(Tauri-first), degraded in VS Code, hidden on web.**

### 10pre — Profile-persistence spike (prerequisite-ish)

- Without it, pop-out drops cookies/login (ephemeral temp profile), so it's
  frustrating for authenticated sites. Spike a stable per-session user-data-dir
  (or `agent-browser state save`/`load`) so logins survive the relaunch.
- Decoupled from the v1 ship (v1 = URLs-only), but the first thing that makes
  pop-out genuinely useful. Also benefits the streamed surface (logins survive
  daemon restarts). Land before or shortly after 10a–10f.

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
