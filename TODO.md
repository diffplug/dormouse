# Validation TODO — Render Swap + Headed Pop-Out

This branch (`ab-iframe-unify`) wires up the **swappable render backend** and
**headed pop-out** described in `docs/specs/dor-iframe.md` (Path 1) and
`docs/specs/dor-agent-browser.md` (Headed Pop-Out). The **lib** side is fully
typechecked + unit-tested (620 tests green); the **VS Code host** process
orchestration was written but **never run against a live `agent-browser`**.
This doc is the manual/computer-use validation pass.

You are validating that the three render modes — `agent-browser screencast`,
`agent-browser popout`, `iframe embed` — swap correctly in place, and capturing
the exact failure mode of anything that doesn't so it can be fixed.

> **Platform note:** all of this is **VS Code–only**. Standalone (Tauri) has no
> agent-browser support and the web host can't spawn one — those are expected to
> degrade (embed surface works, no swap-to-screencast / no pop-out). Validate on
> **VS Code**.

---

## Run 2 — fixes applied since the last validation pass

A round of fixes landed in response to the Run 1 findings. **Phase 0 was run and
the CLI behaves exactly as the host assumes** (recorded results in Phase 0
below), so Run 1's root-cause hypothesis — "the host can't spawn/drive a
screencast viewport" — was **wrong**; the real defects were in the lib. The host
capabilities (`agentBrowserOpen` / `…PopOut` / `…PopIn`) are all wired through
the adapter + message-router. Re-validate the items called out here.

**Fixed**

- **Issue 1 — embed→screencast Apply was disabled (3b).** The Display modal gated
  Apply on the *viewport-drive* capability (`hostCapable`), which an embed surface
  reports as `false`. A render-mode *swap* only needs the *spawn* capability
  (already gating whether the option appears), so Apply is now enabled for any
  swap and the misleading "run `dor ab set …`" note is hidden during a swap.
  (`AgentBrowserScreenModal.tsx`) → **re-test 3b**.

- **Issue 2 — auto-revert resurrected a torn-down session.** Killing or swapping
  away from a popped-out surface issues `… close`, dropping the headed stream; the
  panel read that as "the user closed the window" and relaunched the session
  headless — so the session came back during teardown / after popout→embed. A
  shared teardown guard (`agent-browser-sessions.ts`) marks a session closed
  before Dormouse closes it, so auto-revert stands down; a freshly-mounted panel
  clears the mark so a re-created managed name works again.
  → **re-test 3f, 4a, 5b, 5d** (no leaked/resurrected session).

- **Desync hardening.** `readStreamPort` now retries briefly so a relaunch that
  hasn't yet published its stream port doesn't pin the pane to a dead port
  ("pane says ended while the session is live"). (`agent-browser-host.ts`)

**Not bugs (Run 1 mis-diagnoses)**

- **"gui ids are not unique."** By design: a managed gui session is minted once
  (`randomBytes(6)` — unique) and **reused across pop-out/pop-in**, which are
  identity-preserving relaunches of the *same* session (spec → "Identity-
  preserving relaunch"). The same id across a surface's pop-out/in is correct.

- **3e / 4a "host can't spawn."** Not a host/CLI problem (Phase 0 proves
  spawn / headed-stream / relaunch all work). These were entangled with the
  auto-revert race above; re-test after that fix.

**Could not reproduce (watch for it)**

- **"screencast→popout orphans the original session."** In-place pop-out reuses
  the *same* session (close + headed-open), so there is no second session in code
  or CLI. Possibly a transient of the auto-revert race. If it recurs, capture
  `agent-browser session list` immediately before/after the swap.

---

## Glossary of what you'll see

- **Surface header chip** = the small icon at the **far left** of a surface's
  title bar. Clicking it opens the **Display modal**. Its glyph tells you the
  current render mode:
  - 🔗 **link** = screencast, viewport resizes with the pane (`SYNCED`)
  - 🔒 **closed lock** = screencast, fixed resolution (`SCALED`)
  - ⛶ **frame-corners** = iframe embed
  - ⤢ **box-with-arrow** = popped out to a window
- **Display modal** title = `Display — surface:N`. Its **Render** section has the
  three radios; **Apply** commits the choice.
- **Managed session names**: a `dor ab` surface uses `dormouse.1.<key>` (default
  key ⇒ `dormouse.1.default`). A surface **spawned by a GUI swap** uses
  `dormouse.1.gui-<hex>`.

---

## Prerequisites / setup

1. **agent-browser installed & working** (the user's own global install):
   ```sh
   agent-browser --version            # any version; 0.27.0+ ideal
   agent-browser install              # downloads Chrome if needed
   agent-browser open https://example.com && agent-browser close
   ```
   If this fails, stop — nothing downstream can work. `npm i -g agent-browser`.

2. **A plain-http loopback dev server** to point at. The iframe proxy only
   handles `http://` loopback (not https). Easiest:
   ```sh
   mkdir -p /tmp/devsrv && printf '<h1>hello from devsrv</h1>' > /tmp/devsrv/index.html
   (cd /tmp/devsrv && python3 -m http.server 8000) &
   # ⇒ http://localhost:8000
   ```
   A real Vite/Next dev server on `http://localhost:<port>` also works and better
   exercises HMR/WebSockets.

3. **Build & install the Dormouse VS Code extension** from this repo:
   ```sh
   pnpm dogfood:vscode      # builds lib + frontend + ext, packages, installs the .vsix
   ```
   Then in VS Code: **Cmd+Shift+P → "Reload Window"**.

4. **Open a Dormouse terminal** (the webview surface): Cmd+Shift+P → type
   "Dormouse" and open its view/panel. Inside it the `dor` CLI is available
   (`dor iframe`, `dor ab`, `dor kill`, `dor split`).

5. **Keep the Dormouse output channel open** for diagnostics:
   View → Output → select **"Dormouse"** from the dropdown. Host agent-browser
   failures log here as `[agent-browser] …`.

---

## Phase 0 — Validate the load-bearing `agent-browser` CLI assumptions FIRST

The pop-out + spawn code assumes specific CLI behavior. **If these raw commands
behave differently than expected, that is the root cause of any Dormouse
failure below** — capture the real behavior so the host code can be corrected.
Run these in a **plain terminal** (not Dormouse):

> **RECORDED (Run 2 — agent-browser 0.27.3, loopback `http://localhost:8000`):**
> every assumption holds; the host CLI invocations match reality.
> - **0a** headless `open` → `stream status --json` =
>   `{"data":{"connected":true,"enabled":true,"port":51835,"screencasting":false}}`
>   — port lives under `data` (top-level absent); the host parser handles both. ✓
> - **0b** `--headed open` → exit 0; a real Chrome window opened. ✓
> - **0c** headed session `stream status --json` → `{"data":{…,"port":51858}}` —
>   **a headed session DOES expose a stream** (backs auto-revert + tab/status
>   observation). ✓
> - **0d** relaunch by the same name after `close` — both `--headed open` and
>   headless `open`, back-to-back with no delay — exit 0, a fresh port each time. ✓
> - **close/leak** `close` prints "Browser closed" and the name leaves
>   `session list`; `close` fully terminates the browser (headed included). ✓

- [x] **0a. Spawn + read stream port (backs embed→screencast & `dor ab`):**
  ```sh
  agent-browser --session probe-headless open http://localhost:8000
  agent-browser --session probe-headless stream status --json
  ```
  **Expect:** the 2nd command prints JSON containing a numeric `port` (either
  top-level `"port"` or `"data":{"port":…}`). **Record the exact JSON.**

- [x] **0b. Headed launch (backs pop-out & embed→popout):**
  ```sh
  agent-browser --session probe-headed --headed open http://localhost:8000
  ```
  **Expect:** a **real, visible Chrome window** opens showing the page.
  **Record:** Did a window open? Is `--headed` accepted (no usage error)? If the
  flag name/position is wrong, capture stderr.

- [x] **0c. Does a headed session still expose a stream?** (pop-out keeps the
  stream to observe tabs/status + auto-revert):
  ```sh
  agent-browser --session probe-headed stream status --json
  ```
  **Expect:** a numeric `port` like 0a. **Record the JSON.** If headed sessions
  have *no* stream, auto-revert + tab observation won't work and the design
  needs adjusting.

- [x] **0d. Relaunch a session by the same name after close (backs pop-out =
  close+relaunch):**
  ```sh
  agent-browser --session probe-relaunch open http://localhost:8000
  agent-browser --session probe-relaunch close
  agent-browser --session probe-relaunch --headed open http://localhost:8000
  agent-browser --session probe-relaunch stream status --json
  ```
  **Expect:** the headed relaunch succeeds and the final status prints a (new)
  port. **Record** whether reusing the closed name works or errors.

- [x] **0e. Cleanup:** `agent-browser close --all`

> **Deliverable for Phase 0:** a short note for each of 0a–0d: the exact command,
> whether it worked, and the real output/stderr. Everything below depends on
> these.

---

## Phase 1 — Baseline (regression: existing surfaces still work)

- [ ] **1a.** In a Dormouse terminal: `dor iframe http://localhost:8000`
  **Expect:** a new pane frames the page (zero-lag, the page's own DOM).
- [ ] **1b.** `dor ab open http://localhost:8000`
  **Expect:** a new pane shows a live **screencast** of the page; clicking into
  it and interacting works. The header shows the URL + a 🔗/🔒 chip.
- [ ] **1c.** `agent-browser session list` → shows `dormouse.1.default`.

---

## Phase 2 — The Display modal (UI only)

- [ ] **2a.** On the screencast surface from 1b, **click the far-left chip**.
  **Expect:** the **Display — surface:N** modal opens with a **Render** section
  listing exactly: `agent-browser screencast` (selected), `agent-browser popout`,
  `iframe embed` — each with a ✓/✗ trade-off list. Under screencast: a
  **Resolution** sub-section (Resize with pane / Fixed `W H DPI` / Emulate ▼).
- [ ] **2b.** Pick **Fixed**, type e.g. `W 800 H 600`, **Apply**.
  **Expect:** the screencast viewport changes; the chip becomes 🔒 (fixed).
- [ ] **2c.** Reopen the modal, pick **Resize with pane**, Apply.
  **Expect:** viewport tracks the pane again; chip becomes 🔗.

---

## Phase 3 — Render-swap matrix (the core feature)

Each row: open the Display modal (far-left chip) → **Render** → pick the target →
**Apply**. After each, run `agent-browser session list` to confirm session
lifecycle.

- [ ] **3a. screencast → embed.** On a `dor ab` surface, Render → **iframe embed**.
  **Expect:** the **same pane** (same dock slot) becomes a zero-lag iframe of the
  same URL; chip becomes ⛶. The old screencast session is **closed**
  (`session list` no longer shows it).

- [ ] **3b. embed → screencast.** On that embed surface (or a fresh
  `dor iframe http://localhost:8000`), Render → **agent-browser screencast**.
  **Expect:** the pane becomes a live screencast; `session list` shows a **new**
  `dormouse.1.gui-<hex>` session. (Known gap: that gui session is **not**
  `dor ab --key`-addressable — see Known Limitations.)

- [ ] **3c. embed → popout.** On an embed surface, Render → **agent-browser
  popout**.
  **Expect:** a **headed Chrome window** opens directly (no flash of a screencast
  first), and the pane becomes a **stub** ("This browser is running in a separate
  window" + "Pop back in"). `session list` shows a new `gui-<hex>` session.

- [ ] **3d. screencast → popout.** On a `dor ab` surface, Render → **agent-browser
  popout**.
  **Expect:** headed window opens; pane becomes the stub; chip ⤢.

- [ ] **3e. popout → screencast.** On a popped-out stub, click **"Pop back in"**
  (or Render → screencast).
  **Expect:** the headed window closes; the pane resumes a live screencast.

- [ ] **3f. popout → embed.** From a popped-out stub, Render → **iframe embed**.
  **Expect:** headed window closes (session closed); pane becomes an iframe.

> Note dock position + selection are preserved across every swap (the pane should
> not jump or resize).

---

## Phase 4 — Pop-out lifecycle

- [ ] **4a. Auto-revert on window close.** While popped out (from 3c/3d), close
  the **headed Chrome window** directly (its OS ×, or ⌘⇧W).
  **Expect:** the Dormouse pane **auto-reverts** to a headless screencast (stub
  disappears, screencast resumes within a couple seconds).

- [ ] **4b. Native interactivity.** While popped out, confirm the headed window
  is a real browser: scroll, open DevTools (⌥⌘I), type in a field — all native.

- [ ] **4c. Position (known-limited).** Note **where** the headed window opens —
  it is **not** expected to be positioned over the pane (just record where it
  lands). Not a bug.

- [ ] **4d. Bring to front (known-limited).** The "Bring to front" button is
  expected to be **absent** (no host capability). Confirm only "Pop back in"
  shows. Not a bug.

---

## Phase 5 — Teardown / kill

- [ ] **5a.** Kill a screencast surface (header **×**, or `dor kill` targeting it).
  **Expect:** its agent-browser session disappears from `session list`.
- [ ] **5b.** Kill a **popped-out** surface.
  **Expect:** the headed window closes **and** the session is gone.
- [ ] **5c.** Kill an embed surface. **Expect:** the frame goes away (the proxy is
  reaped lazily by an idle sweep, not necessarily instantly — acceptable).
- [ ] **5d.** Quit/reload the VS Code window with surfaces open. **Expect:** no
  orphaned headed Chrome windows or leaked sessions (`agent-browser session list`
  in a fresh terminal is clean after a moment).

---

## Phase 6 — Edge cases & embed chrome

- [ ] **6a. Embed URL nav.** On an embed surface, click the **URL** in the header,
  type a different `http://localhost:<port>/path`, Enter.
  **Expect:** the frame navigates to the new URL. The **reload** button
  re-resolves the proxy. **back/forward are expected no-ops** (cross-origin frame
  history is unreachable) — not a bug.
- [ ] **6b. Dev-server chip.** When framing/screencasting a `localhost:<port>`
  served by a terminal in the same workspace, the header should show a clickable
  dev-server chip that focuses that terminal. (Only if you have such a terminal.)
- [ ] **6c. Multi-tab pop-out (known-limited).** On a screencast, open a 2nd tab
  (`dor ab tab new http://localhost:8000` or a link that opens a new tab), then
  pop out. **Expect:** only the **active tab** is preserved on relaunch; other
  tabs are lost. Record but do not treat as a bug (v1 limit).
- [ ] **6d. Rapid swap.** Swap back and forth quickly a few times; confirm no
  crash/stuck-stub (there's no explicit race guard — note any wedge).

---

## How to diagnose a failure (so it can be fixed/iterated)

When any Phase 1–6 step fails, capture:

1. **A screenshot** of the surface/modal state.
2. **The Dormouse output channel** (`View → Output → "Dormouse"`) — grep for
   `[agent-browser]`. Host swap/pop-out failures log the exact exit code +
   stderr there.
3. **`agent-browser session list`** before/after the action.
4. **The raw repro.** The host runs these exact commands — run them yourself in a
   plain terminal with a real URL to see the true error:
   | Action | Host command(s) |
   |---|---|
   | embed→screencast | `agent-browser --session dormouse.1.gui-XXXX open <url>` → `… stream status --json` |
   | embed→popout / screencast→popout | `agent-browser --session <s> close` → `agent-browser --session <s> --headed open <url>` → `… stream status --json` |
   | pop back in / auto-revert | `agent-browser --session <s> close` → `agent-browser --session <s> open <url>` → `… stream status --json` |
   | kill | `agent-browser --session <s> close` |

   The **most likely root cause** is a mismatch in Phase 0 (e.g. `--headed` isn't
   the right flag, or a headed session has no stream, or a closed session can't
   be relaunched by name). If so, the fix is in
   `vscode-ext/src/agent-browser-host.ts` (`runAgentBrowserOpen` /
   `runAgentBrowserPopOut` / `runAgentBrowserPopIn`) — adjust the CLI invocation
   to match what Phase 0 proved actually works, rebuild (`pnpm dogfood:vscode`),
   reload, retest.

---

## Known limitations (expected — do NOT report as bugs)

- **VS Code only.** Standalone/Tauri and web have no agent-browser; embed surfaces
  there stay plain-title (no swap chip).
- **Spawned (gui) sessions aren't `--key`-addressable.** embed→screencast mints a
  random `dormouse.1.gui-<hex>` session; `dor ab --key …` won't target it. (Design
  gap, tracked.)
- **Pop-out window is not positioned** over the pane (VS Code can't read screen
  coords); Chrome places it.
- **"Bring to front" is absent** (no host raise capability).
- **Only the active tab URL survives a pop-out/relaunch**; other tabs, scroll,
  form state, cookies/login are lost (ephemeral profile; profile-persistence is a
  follow-up).
- **iframe back/forward are no-ops** (cross-origin history unreachable); reload +
  URL-edit work.

---

## Summary report format

For each Phase, report: ✅ pass / ⚠️ pass-with-caveat / ❌ fail. For every ❌ or
⚠️, attach: screenshot + `[agent-browser]` log excerpt + the raw-CLI repro output.
Lead the report with the **Phase 0 findings**, since they determine whether the
host CLI invocations match reality.
