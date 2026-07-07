# Phase 2 — Session persistence: throughput, durability, and a graceful quit

> **Temporary planning doc.** Captures the loose threads left after Phase 1
> (standalone Rust per-window session store — PR #225, merged). **Problems and
> requirements only — no solutions.** Delete this file once Phase 2 ships and
> its requirements have been promoted into the specs (`docs/specs/standalone.md`
> `## Future` mirrors the spec-appropriate subset).

## Where Phase 1 left things

Phase 1 moved the standalone app's persisted session blob off WebKit
`localStorage` (whose SQLite WAL grew unbounded) onto a Rust per-window file
store (`save_session` / `load_session`, one atomic file per Tauri window). The
seam (`SessionKeyValueStore`) and the boot-seeded write-through cache
(`TauriSessionStore`) are in place; VS Code and the browser-dev harness are
unchanged. See `docs/specs/standalone.md` §Persistence.

Phase 1 was verified only at unit / typecheck / spec-lint level. It was **never
run in a rebuilt standalone app**, and it deliberately deferred write-throughput
reduction and quit-time durability. Those, plus a new quit-confirmation request,
are Phase 2.

---

## Thread A — Verify Phase 1 in a real build

**Problem.** The Phase 1 runtime behaviors were never observed in a rebuilt app;
only reasoned about. Nothing below is confirmed against a running binary.

**Requirements — confirm in a real standalone build:**
- The per-window session file is created and updated during normal use
  (`<app_data_dir>/sessions/<window-label>.json`).
- A session restores correctly across a real quit → relaunch: panes, layout,
  scrollback, CWD, alert/TODO state, minimized doors.
- The one-time `localStorage` → Rust migration adopts a legacy blob exactly once
  and clears the legacy key.
- After migration, the WebKit `localStorage` WAL stops growing during a
  long-running session (the original bug).

---

## Thread B — Reduce session write throughput

**Problem.** The session blob (multi-MB, scrollback-bearing) is rewritten on a
500 ms-debounced save **plus an unconditional ~30 s heartbeat**, whether or not
anything changed. On the Rust file store every write is a full-file
write + fsync + rename. The WAL-bloat pathology is gone, but the IO churn
remains: a mostly-idle session still rewrites megabytes on a timer. The save
cadence is **shared code** (`lib/src/components/wall/use-session-persistence.ts`,
`lib/src/lib/session-save.ts`), so this affects every adapter, not just
standalone.

**Requirements:**
- A write must not occur when the persisted state is unchanged since the last
  successful write.
- The unconditional periodic heartbeat must not force writes when nothing has
  changed.
- Persisted scrollback must be bounded so a single busy terminal cannot make
  each write arbitrarily large. (The sidecar buffer already caps at 1M
  chars/PTY; the *persisted* size policy is the open part.)
- No regression to restore fidelity (scrollback / CWD / layout / alert state).

**Open questions:**
- How to detect "unchanged" cheaply, without serializing the whole blob every
  tick.
- Whether any periodic safety-net write should remain at all, vs. purely
  event-driven saves.
- The persisted-scrollback size limit and trimming policy.

---

## Thread C — Guaranteed session save on a clean quit (durability)

**Problem.** Phase 1 replaced the synchronous-durable `localStorage.setItem`
(which WebKit flushed on teardown) with an async `save_session` that returns
before the write lands, and nothing on the quit path awaits it. On a clean quit
the final save (fired at `pagehide`) can be dropped, losing state changed in the
last debounce/heartbeat window — a durability regression from the `localStorage`
baseline. A webview `pagehide` / `unload` handler **cannot reliably await async
work**, so the guarantee cannot live there.

**Requirements:**
- On a clean quit, the latest session state is durably written before the
  process exits.
- Quit must not hang if a write stalls — the wait must be bounded.
- Unclean exits (crash, force-kill, OS kill) remain best-effort; fully
  guaranteeing those is out of scope.

**Relationship.** Thread D's graceful-quit flow, if it guarantees a final
completed save before exit, satisfies this for clean quits. Treat C as the
durability *requirement* and D as the flow that (among other things) delivers it.

---

## Thread D — Quit confirmation + graceful terminal teardown (the new request)

**Goal.** Quitting the app ends all terminals. Today that happens abruptly (hard
kill), with no warning and no guaranteed capture of a terminal's final output.
Make quit deliberate and safe: warn when it would kill running work, tear
terminals down gracefully so their final output is captured, persist the
freshest scrollback, then exit.

**Requirements:**

1. **Confirmation, scoped to running work.** When the user initiates quit and at
   least one terminal has a live/running command (not merely an idle shell at a
   prompt), show a confirmation stating the consequence and the count of running
   terminals. If nothing is running, quit proceeds with no prompt. (Per-terminal
   running/finished/prompt state is already tracked — see
   `docs/specs/terminal-state.md`.)

2. **Unskippable across every quit trigger.** The confirmation + graceful
   teardown must apply to *all* ways the app can quit: window close button,
   Cmd+Q / app-menu Quit, dock-menu Quit, and OS logout/shutdown where it can be
   intercepted. (Today only the window-close path is intercepted, and only when
   an update is pending — `standalone/src/updater.ts`.)

3. **Graceful teardown ordered so scrollback survives.** On confirm (or when
   nothing is running), terminals must be terminated in a way that lets them
   flush final output, and that output must be captured into the persisted
   scrollback **before** the terminal's buffer is discarded. (Constraint: the
   current hard-kill path discards a PTY's scrollback buffer synchronously — see
   "Current behavior" below — so any order that kills before capturing loses
   scrollback.)

4. **Final durable save before exit.** After teardown, the freshest session —
   including the just-captured final scrollback — must be written to disk and
   that write must complete before the process exits. (This is where Thread C's
   guarantee is delivered for the quit path.)

5. **Bounded.** A terminal that ignores graceful termination, or a stalled save,
   must not wedge quit. The teardown has a bounded timeout after which quit
   proceeds anyway.

6. **Clean cancel.** Declining the confirmation aborts the quit and leaves the
   app and every terminal exactly as they were.

7. **Composes with update-on-quit.** When a downloaded update is pending at quit
   time, the graceful teardown + final save must still run and must complete
   *before* the updater installs (on Windows the installer force-kills the
   process). The terminal confirmation and the update install are distinct
   concerns and must not clobber each other. See `docs/specs/auto-update.md`.

8. **Confirmation UX.** The dialog matches the app's design system (consistent
   with the existing in-pane kill-confirmation aesthetic — `docs/specs/layout.md`),
   states the consequence and the running-terminal count, and offers clear
   confirm / cancel.

**Open questions:**
- What counts as "running" for the gate: any non-prompt state, a live foreground
  child process, or the existing running/finished/prompt classification —
  which, exactly?
- Graceful-termination semantics: signal used, per-terminal vs. all-at-once, and
  the timeout value.
- Should "graceful" give a running program a real chance to react (it is only
  being terminated + captured, not asked to save its own work) — confirm intent.
- Scope: local standalone quit only, or also remote/Pocket-driven disconnects?
  (Presumably local standalone only.)
- Post-quit experience: next launch restores captured scrollback + resume
  commands (the existing restore model) — confirm this is the intended result of
  a graceful quit.

---

## Thread E — Retire the `localStorage` → Rust migration (sunset)

**Problem.** The one-time migration branch (adopt a legacy `localStorage` blob →
Rust store → clear the key) lives in the boot path
(`standalone/src/tauri-adapter.ts`, marked `SUNSET`). It is dead weight once
shipped builds have all migrated, and it encodes a single-window assumption
(Thread F).

**Requirements:**
- Define when it is safe to remove (which shipped version(s) must have run
  first) and remove it then.
- Until removed, it must run at most once and must not misbehave under the
  multi-window case (Thread F).

---

## Thread F — Multi-window assumptions

**Problem.** The Rust store is per-window (keyed by window label) and
multi-window-ready, but the app ships a single window and some logic assumes it.
Concretely: the migration reads a per-origin (window-*shared*) legacy
`localStorage` blob, so under multiple windows every window would adopt the same
blob and race on clearing the key.

**Requirements:**
- Before multi-window ships, the migration (if still present) must be gated so
  only one window adopts the shared legacy blob.
- Identify and make multi-window-safe any other single-window assumptions in the
  session and quit paths — e.g. whether the quit confirmation + teardown is
  per-window or app-wide, and which windows' terminals a given quit affects.

**Note.** This overlaps the workspaces-rollout scope owned by
`docs/specs/layout.md` `## Future`. Cross-reference it; do not duplicate its
ledger here.

---

## Current behavior (facts, so they aren't rediscovered — not prescriptions)

- **WebKit WAL (the Phase 1 bug).** WKWebView stores `localStorage` as SQLite in
  WAL mode. WebKit pins its own WAL with a long-lived reader, so it never
  checkpoints during a running session and grows unbounded; an external
  checkpoint is blocked by the same reader; it only truncates when WebKit closes
  the store (app quit). This is why the blob had to leave `localStorage`.
- **Hard kill discards scrollback.** The sidecar's `kill` / `killAll`
  (`standalone/sidecar/pty-core.js`) drop a PTY's scrollback buffer
  synchronously. A terminal that exits on its own (natural or signal-driven
  exit) is removed from the live-PTY map but its scrollback buffer is **not**
  cleared until something explicitly clears it. (This is the constraint behind
  requirement D-3.)
- **Async save durability.** `save_session` returns before the Rust write lands;
  nothing awaits it on quit; `pagehide` cannot await async work.
- **Quit paths differ.** The window close button, Cmd+Q / app-menu Quit, and
  dock quit reach the app through different mechanisms; only the window-close
  path is intercepted today, and only when an update is pending.
- **Save cadence.** Saves fire on layout change, pane add/remove, PTY exit,
  `pagehide`, and an unconditional ~30 s interval, debounced 500 ms
  (`use-session-persistence.ts`).
- **Scrollback cap.** Sidecar scrollback buffers are capped at 1M chars/PTY.
- **Existing capabilities worth knowing.** The sidecar already exposes a
  graceful-termination command distinct from the hard kill, and a per-PTY
  scrollback read; the Rust store already persists per window. What's missing is
  the orchestration, the quit interception, the confirmation UI, and the
  await-before-exit — the *design* of which is Phase 2's job, not this doc's.

---

## What "done" looks like

- **Thread A:** Phase 1 behaviors confirmed in a real build.
- **Thread B:** an idle session performs no session writes; write rate drops
  measurably; restore fidelity unchanged.
- **Thread C / D-4:** after any clean quit, the next launch restores the state
  as of the moment of quit (no lost final window).
- **Thread D:** quit confirmation appears iff running work exists; graceful
  teardown captures each terminal's final scrollback; cancel is a clean no-op;
  every quit trigger is covered; update-on-quit still installs after a completed
  save; nothing wedges quit.
- **Thread E/F:** migration removal criteria recorded; no multi-window landmines
  left in the session/quit paths.
