# Layout Spec

> See `docs/specs/glossary.md` for canonical state names, layer definitions, and transition verbs. This spec uses the glossary's vocabulary throughout.

## Conceptual model

A **Pane** holds a **Surface** — a terminal **Session** or a **browser surface** (`iframe` / agent-browser). `docs/specs/glossary.md` is canonical for the Pane / Surface / Session model, `docs/specs/dor-browser.md` for browser surfaces. This spec says "Session" where a statement is terminal-specific and "Surface" where it holds for both. Per-Session semantic state (CWD, command lifecycle, title candidates, header derivation, grouping keys) belongs to `docs/specs/terminal-state.md`; Activity state (alert status, TODO, notification detail) to `docs/specs/alert.md`.

A Surface's **View** state places it in one of two containers:

- **Pane** — visible, in the content area. A terminal renders through xterm.js, a browser surface through `BrowserPanel`. The header carries the controls and doubles as the drag handle.
- **Door** — minimized, in the baseboard, drawn as a mouse hole cut into it. The Surface stays alive — a terminal's PTY keeps running and buffering; a browser surface's backing session or proxy grant stays alive and its DOM stays mounted-but-hidden (see [Minimize and reattach](#minimize-and-reattach)). The door shows the Surface's title plus alert and TODO indicators.

Transitioning between Pane and Door never alters the Surface. Terminal content, scrollback, and process state survive; for a browser surface the backing session survives while the *viewer* resources are released — no canvas, screencast WebSocket, screenshot loop, or input forwarding runs while it is a Door.

A **Workspace** is the named group of Surfaces rendered by a single **Wall**, together with their layout (see `docs/specs/glossary.md`). A Window may hold several Workspaces. This spec owns the standalone Workspace presentation; the strip UI and real switching are staged in [Future](#future) (**Scope: workspaces-rollout**). VS Code maps each Workspace to its own webview instead; see `docs/specs/vscode.md`.

## Shell layout

There are two areas:

- **Content** — tiling layout containing Panes, rendered by the **Lath** tiling engine (`docs/specs/tiling-engine.md` owns the engine)
- **Baseboard** — bottom strip containing Doors and shortcut hints. Always present in the app shell; suppressible with `Wall showBaseboard={false}`.

The user can navigate between all elements using the mouse, or by entering `command` mode and using the keyboard.

```
Wall
├── Context providers (Mode, SelectedId, WallActions, PaneWrite, PaneElements,
│   │                  DoorElements, RenamingId, Zoomed, WindowFocused, DialogKeyboard)
│   └── div (flex-1, flex col)
│       ├── Content wrapper (flex-1, 7px top/sides inset, 2px bottom inset)
│       │   ├── LathHost (the tiling engine's HTML adapter)
│       │   │   └── Leaf divs (one Surface per leaf, absolutely positioned, never re-parented)
│       │   │       ├── TerminalPanel → TerminalPane → xterm.js  (or BrowserPanel)
│       │   │       └── TerminalPaneHeader (drag handle)          (or SurfacePaneHeader)
│       │   └── WorkspaceSelectionOverlay (fixed positioned, pointer-events: none)
│       ├── Baseboard (bottom strip, shortcut hints when empty; optional for constrained embedders)
│       │   └── Door components (one per minimized session)
│       └── KillConfirmOverlay / ShellSpawnNotice / modal hosts (conditional)
```

**Lath owns** the split tree, per-leaf rects, sash geometry and `layout()`; sash resize, hierarchical pointer drag-and-drop, zoom geometry; and the native FLIP animation of splits/kills/restores. `docs/specs/tiling-engine.md` is the source of truth for all of it.

**The Wall owns** focus and selection state (`selectedId` / `selectedType`), the passthrough/command mode system, keyboard dispatch and selection-overlay rendering, the minimize/reattach/kill lifecycle, terminal lifecycle via the registry, Activity + TODO state, and session persistence.

## Content

The content area is a tiling layout of panes rendered by Lath (`docs/specs/tiling-engine.md`). Each pane is one **leaf** in Lath's split tree — a stable, absolutely-positioned div that is never re-parented (so a moved `<iframe>` never reloads and a focused xterm never blurs). There is no tab stacking: one Surface per leaf, always. Splitting a pane inserts a sibling leaf; removing a pane collapses single-child splits back.

Panes are separated by a 7px gap (`PANE_GUTTER_PX`) — odd on purpose, so the 1px selection ring can center in it on whole pixels (see [Selection overlay](#selection-overlay)).

**Center drop = swap.** Dragging a pane onto the *center* of another swaps their Surfaces (same as `Cmd/Ctrl+Arrow`) — a Lath `swap` op that trades leaf identities, so meta and registry entries follow the ids with no companion title swap. Dragging onto an *edge* band splits beside that leaf (or beside an ancestor column/row, chosen by scroll-wheel depth). The full DnD model — depth cycling, the preview-equals-commit rect, baseboard-drop minimize, door drag-out — lives in `docs/specs/tiling-engine.md` → "Hierarchical drag and drop"; the Wall owns only the op commit + selection policy (`onProposeMove` / `onProposeMinimize` / `onExternalDrop` in `Wall.tsx`). A baseboard drop is a no-op when `showBaseboard={false}` — there is nowhere to minimize into.

### Pane header

Each pane has a 30px header that doubles as a drag handle (a `pointerdown` on the header, past a 5px threshold, begins a Lath pane drag; below the threshold the header's own click behavior stands). The header uses `cursor-grab` / `active:cursor-grabbing`, `select-none`, and the shared terminal top radius from `lib/src/components/design.tsx`. Background and foreground use the `--color-header-active-*` / `--color-header-inactive-*` token pairs, which map to VSCode file-tree list colors.

Elements from left to right: the derived label; the alert bell; the TODO pill (compact+ tiers); a flexible gap; the mouse-reporting override icon (only when the inside program requests mouse reporting, compact+ tiers); split left/right, split top/bottom, and zoom/unzoom (full tier only); minimize; kill (hover turns error-red). Bell and TODO pill behavior is `docs/specs/alert.md`'s; the mouse-override icon is `docs/specs/mouse-and-clipboard.md`'s.

The label is the `DerivedHeader` from `deriveHeader(...)` — `docs/specs/terminal-state.md` is the single source of truth for the priority chain, the disambiguator rule, and which OSC sources contribute. Layout renders the result: the primary label truncates with ellipsis, the secondary is shown muted beside it, and a failed last command appends an error-colored glyph. Click renames/pins; right-click — or `>` in command mode — opens the header context menu.

#### Header context menu

Right-clicking anywhere on the header opens the pane's single **context menu** at the pointer; `>` in command mode opens the same menu for the selected pane, anchored under the header's left edge (the handler finds the header via `data-pane-header-for` and dispatches a synthetic `contextmenu` at that corner, so both paths share one code path; browser surfaces and Doors have no such header, so `>` no-ops there). Only the alert bell owns its own right-click (`stopPropagation`, opening the alert dialog); every other region — including the title span — bubbles to this one menu. It is portaled to `document.body`, viewport-clamped, and dismissed by outside `pointerdown`, `Escape`, `resize`, or capture-phase `scroll` — except scrolls originating inside the menu itself, which must not dismiss it (arrow-key focus moves auto-scroll the overflowing list).

Content, top to bottom:

- **Header row** — the current display title, the pane's `surface:N` handle (`resolveSurfaceRef`, muted), and a close button.
- **Title-candidates table** — the latest entry per `titleCandidates` channel as defined in `docs/specs/terminal-state.md`: channel, candidate text, timestamp; or a muted `No title candidates` line. Diagnostic only; it does not change the title priority rules.
- **Port rows** — the TCP ports the pane's process tree binds: a spinner while `getOpenPorts` runs (once per open — reopen to rescan), then one `host:port` row per distinct port (digit accelerator chip first, process name muted beside it), or a muted `no listening ports` / `port scan failed` line.

The menu owns the keyboard while open: it takes DOM focus on mount and restores the previously focused element when a dismissal leaves input ownership unchanged, and it registers as dialog-keyboard-active so command-mode keys don't fire underneath. `1`–`9` activate the corresponding port row; presses while the scan is still running are dropped, not buffered — the spinner explains why nothing happened. `↑`/`↓` rove focus across the port rows (wrapping), `Enter`/`Space` activate the focused row, `Tab`/`Shift+Tab` cycle every focusable element, and `Escape` closes.

Activating a port row (click, digit, or `Enter` on the focused row) reproduces `dor ab open <url>` for that port and closes the menu at once (`docs/specs/dor-browser.md` → Pane Context Menu Connect): the browser surface appears immediately and becomes the selection in passthrough (reattaching first if it was minimized) — the one command-mode gesture whose side effect moves selection off the pane it targeted and exits command mode — and loading/errors surface in the pane, not the menu. On hosts with no `agentBrowserCommand` the rows are inert labels with no digit chips, and digits do nothing. Only terminal panes have this menu. Source of truth: `PaneHeaderContextMenu.tsx`, `TerminalPaneHeader.tsx`, `handle-pane-shortcuts.ts`.

### Pane body

The pane body paints `--color-terminal-bg` on the React pane wrapper and the `TerminalPane` mount point. The persistent xterm host element, `.xterm-screen`, and xterm scroll container are also painted with the concrete background from `getTerminalTheme()`. This is intentional: xterm.js only paints its own rendered terminal surface, and integer row fitting can leave a sub-row remainder at the bottom of the pane. The host background must match the terminal screen exactly and clip to the pane's shared rounded bottom corners so the terminal surface reaches the selection overlay cleanly.

### Spoken-alarm overlay

A terminal Session with transient speech-delivery state gets a pointer-transparent overlay spanning its whole Lath leaf; browser surfaces never render it. It resolves through the tiling engine's per-leaf overlay slot (`docs/specs/tiling-engine.md`), never intercepts pointer/focus routing, and never changes leaf geometry.

It renders as **two layers straddling the header's stacking context** (`.lath-leaf-header` is `position: relative; z-index: 20`):

- **Wash + label at `z-index: 19`** — below the header, so the wash never tints the header band, where `--color-alarm-vs-terminal` (picked against the *terminal body*) carries no contrast guarantee; above terminal content; below the `z-index: 20` pane-corner mouse-override banner, which therefore stays untinted. Both states wash, `SPEAKING` at 20% opacity and `SPOKEN` at half that — `SPOKEN` is unbounded, so its haze has to stay readable-through for that whole window. The solid alarm color lives on a dedicated child whose element opacity supplies those strengths; color-alpha utilities are not used because their emitted `color-mix()` path is unsupported by the standalone Safari 15 / Chrome 105 targets. The label sits `PANE_HEADER_HEIGHT_PX + 4` from the Pane top, centered, in both states.
- **Perimeter ring at `z-index: 25`** — above the header so the treatment still reads as one rounded rectangle around the whole Pane, below the `z-index: 30` sashes. An inset border at the leaf's edge covers nothing. 5px for `SPEAKING`, 3px for `SPOKEN`.

Header popovers are not a factor in this layering: every one of them (pane context menu, title candidates, notification preview, rename warning) portals to `document.body` with `position: fixed`, so they render in the root stacking context above the whole wall regardless of leaf z-indices.

Both layers wear the leaf's own rounding (header radius on top, terminal radius on the bottom). Under `SPEAKING` both pulse when motion is allowed and `cfg.alert.ringingPaused` is not set. Behavior and clearing rules belong to `docs/specs/alert.md`. Source of truth: `AlertSpeechIndicator.tsx`, registered as the `terminal` overlay by `LathHost.tsx`.

### Pane header responsive sizing

A ResizeObserver picks one of three tiers by header width:

- **Full** (>280px): everything.
- **Compact** (>160px): split, zoom, and unzoom hidden.
- **Minimal** (≤160px): also hides the TODO pill and the mouse-override icon, leaving alert, minimize, and kill. The label truncates with ellipsis.

## Baseboard

Below the content area is the baseboard (`h-7`, 28px). It is visible by default and has no top divider. The content area ends 2px above it, leaving a narrow theme-colored gap that keeps rounded pane corners distinct from the baseboard. Its horizontal padding matches the content wrapper's 7px inset, so doors align with the panes above. With no doors and more than 350px of width it shows a platform-aware shortcut hint — `LCmd → RCmd to enter command mode` on macOS, `LShift → RShift to enter command mode` elsewhere.

`Wall` accepts `showBaseboard={false}` for an embedder that exposes no door/minimize workflow: the strip is not rendered, the content wrapper's bottom inset grows from 2px to 7px, and a baseboard drop becomes a no-op. It is a seam, not a shipped configuration — no production host passes it (the mobile Pocket composition is a separate `MobileWall`, see `docs/specs/mobile-terminal-ui.md`), so the app shell always has a baseboard.

The far right of the baseboard is a single flex cluster, right-aligned as a unit: the `N more →` overflow arrow, then the host-supplied `notice` slot (standalone puts the update banner there), then three always-present 24px **Settings** controls. The first is a 16px speaker/slashed-speaker reflecting spoken alarms enabled/disabled; the second is a 16px ringing-bell/slashed-bell reflecting push notifications enabled/disabled; the third is the 16px sliders icon for the dialog itself. Shape and accessible text both carry each state, so the status does not rely on color. All three open the same app-global Settings dialog — theme in `docs/specs/theme.md`, alarms in `docs/specs/alert.md` → Alarm settings; the status controls do not toggle settings directly. Every baseboard-level button shares one class constant in `Baseboard.tsx`. The cluster's always-present part is measured and subtracted from the door-fitting budget below; the overflow arrow stays out of that measurement because its presence is an *output* of the fit, so measuring it would feed back into its own input.

When a session is minimized, it becomes a **door** on the baseboard, showing the same derived label as the pane header plus the alert/TODO/speech badge cluster (`docs/specs/alert.md` → Door owns which badge shows when, and why `SPOKEN` joins the cluster rather than replacing it; both speech states also name themselves in the Door's `title` and accessible name). A Door uses the bottom edge of the window as its bottom border, with left, top, and right borders taking the shared terminal top radius from `lib/src/components/design.tsx` — a mouse hole that matches pane rounding. Dimensions: `min-w-[68px] max-w-[220px] h-6`.

### Door interaction

- **Click** (any mode) or **Enter** (command mode): restore the session into the content area as a pane and enter passthrough; the terminal gets focus immediately.
- **m** / **d** (command mode): restore into a pane but stay in command mode — the inverse of `m`/`d` on a pane, making them toggles.
- **x** / **k** (command mode): restore into a pane, then show the kill confirmation (an untouched Surface is killed outright — see [Kill confirmation](#kill-confirmation)).
- **Arrow keys** navigate to and between doors (see [Spatial navigation](#spatial-navigation)).

A reattach that stays in command mode defers its follow-up (focus, kill, replace) to `requestAnimationFrame` and skips it if the pane vanished in between.

### Baseboard responsive sizing

Doors are measured in a hidden off-screen container first, then fitted:

- Subtract the measured right cluster (notice + the three alarm-settings controls) and its gap from the available width before fitting anything — that space is never available to doors.
- Add doors until no more fit, reserving room for a `N more →` button whenever items remain after the current one. At least one door is always shown, even if it overflows.
- If scrolled, show `← N more` on the left and/or `N more →` on the right. Overflow counts are assumed single-digit (the hidden measurement button is `9 more`).
- Clicking an overflow arrow reveals one door in that direction. A longer title may push more doors off the opposite side.

Extreme case: a single door with a very long title and more doors on both sides — show both arrows with counts, and as much title as fits (ellipsis for the rest).

## Workspaces

> See `docs/specs/glossary.md` for the Workspace / Window containers and `docs/specs/alert.md` for the union status. VS Code's per-webview mapping is in `docs/specs/vscode.md`.

A **Workspace** is one Wall's worth of Surfaces (terminal Sessions and browser surfaces) plus its layout, with a user-facing name. The standalone Window hosts several Workspaces but mounts only one — the **active** Workspace — at a time. Each Workspace owns its own Content (Lath layout) and Baseboard (doors).

What exists today is the in-memory workspace model and its container verbs (`createWorkspace` / `closeWorkspace` / `renameWorkspace` / `setActiveWorkspace` in `lib/src/lib/workspace-store.ts`), the union projection (`computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`), and Window persistence, which is what the `dormouse.flags.workspaces` flag (`WORKSPACES_FLAG_KEY` in `lib/src/lib/feature-flags.ts`, **off by default**) actually gates: `lib/src/lib/window-persistence.ts` is an identity passthrough with the flag off, so the standalone host stores a bare `PersistedSession`, and wraps/unwraps a `PersistedWindow` with it on (`docs/specs/transport.md`). VS Code never goes through it. No production code calls the container verbs yet and `setActiveWorkspace` does not re-render the Wall, so the app runs exactly one implicit Workspace either way.

The strip UI, real switching, and lifecycle UX are staged in [Future](#future) — this spec's `## Future` is the single rollout ledger for the feature; other specs link here.

## Modes

Wall starts in `command` mode by default. Embedders may pass `initialMode="passthrough"` when the first pane is an already-running interactive surface that should receive keyboard input immediately.

### Passthrough mode
- Keyboard input routes to the active session's xterm.js instance, which holds DOM focus.
- Three things are still intercepted: the mode-exit gesture (below), the terminal selection/copy/paste chords (`docs/specs/mouse-and-clipboard.md`), and clipboard chords inside one of Dormouse's own text fields.
- In the VS Code host, selected workbench chords are mirrored: xterm still processes the key, and Dormouse also asks the extension host to run the matching VS Code command. See [the VS Code host spec](vscode.md) for the allowlist.
- Selection overlay shows a 1px solid border.

### Command mode
- Keyboard drives navigation and commands; the Session receives no input.
- Selection overlay shows the animated marching-ants border.

### Mode switching

**Enter passthrough mode:** clicking any pane body or header; `Enter` or `z` on a selected pane; creating a terminal through a manual split (`|` / `%` / `-` / `"`, a header split button) or a host New Terminal action; clicking or pressing `Enter` on a door (restoring the session first). In every case focus is deferred via `requestAnimationFrame` so it lands after the click/mousedown event finishes.

**Enter command mode:** Left Cmd keydown, then Right Cmd keydown within 500ms — or the same left-then-right gesture with Shift.

- Detected in a capture-phase `keydown` listener on `e.key === 'Meta'` (or `'Shift'`) plus `e.location`, so it fires even while xterm holds DOM focus. Anything but `location === 1` counts as the right-hand key.
- The Meta and Shift tracks are independent, so Left Cmd then Right Shift does not trigger. Both tracks are always live: on keyboards with no right Meta key (common on Windows/Linux laptops) the Shift track is the available gesture.
- A bare Meta/Shift press is always consumed by this detector, so no later handler mistakes it for a command key.
- If the focused pane is zoomed, returning keyboard focus to command mode starts unzoom immediately.

## Keyboard shortcuts (command mode)

`docs/specs/shortcuts.md` is the quick-reference table of every binding; this section owns the dispatch behavior behind it.

All keys are handled in one capture-phase `keydown` listener on `window` (`use-wall-keyboard.ts`), which delegates in a fixed order to the modules in `lib/src/components/wall/keyboard/`: dual-tap → editable-field clipboard → mouse-selection keys → *(passthrough stops here)* → *(rename stops here)* → kill confirmation → *(an open dialog stops here)* → pane shortcuts → pane navigation. Every handled key calls `preventDefault()` + `stopPropagation()`.

Two consequences of that order are load-bearing: a rename input suppresses the pane shortcuts but **not** the mode-exit gesture or the field's own clipboard chords; and a staged kill confirmation hijacks *every* key before the dialog gate, so the confirm letter works even though the modal is open.

### Split cwd inheritance

A split initiated from an existing pane (`|`/`%`/`-`/`"` or the header split buttons) spawns the new pane with its source pane's last-known cwd, then selects it and enters passthrough. Host New Terminal actions use the same focus tail. Repeated layout construction therefore requires re-entering command mode between manual splits. Focus-neutral control-plane creation (`dor split -- …`, `dor ensure`, `dor iframe`, `dor ab`) retains its documented background behavior.

The source cwd is read from `getTerminalPaneState(sourceId).cwd`; remote cwds (`isRemote === true`, e.g. an OSC 7 path reported over ssh) are ignored because they aren't usable as a local spawn cwd. When no source cwd is known, when the split has no source pane (initial pane creation), or when the source is remote, the host's default cwd applies. The inherited cwd rides through `setPendingShellOpts` alongside the inherited shell selection and is consumed by `getOrCreateTerminal` on the next `platform.spawnPty`.

### Kill confirmation

Pressing `x`/`k` (or clicking the kill button, which first leaves passthrough) shows a pane-centered semi-transparent overlay (`KillConfirmOverlay` → `KillConfirmModal`) with a random lowercase letter — both kill shortcuts (`x` and `k`) are excluded from the alphabet so a double-tap can't accept itself. Typing that letter confirms the kill. `Escape`, the `Esc to cancel` button, and clicking another panel all cancel. Any other key triggers a 400ms `shake-x` animation and then auto-dismisses.

Confirmation is staged in a ref synchronously, not only in React state: a second confirm keydown arriving before React flushes would otherwise pass the guard and kill twice (`lath.isDying` is the second line of defense).

Untouched sessions skip this confirmation. A newly spawned shell starts `untouched: true`; the first user-originated PTY input flips it to false. Inputs that count include printable keys, Enter, control keys, keyboard CSI such as arrows/history, paste, and file-drop path insertion. Replay-shaped terminal reports and stripped mouse-report-only input do not count (the untouched gate checks `inputIsReplayTerminalReport`; the broader synthetic-report check gates input recording and alert attention, not this flag). Killing an untouched pane runs the normal kill animation/dispose path immediately. Killing an untouched door first reattaches it only far enough to reuse the same pane removal path, then kills it without showing the confirmation overlay.

## Selection overlay

A fixed-positioned element rendered on top of the Lath host. Covers the active element's area inflated by `SELECTION_RING_INFLATE_PX` (4px) for panes; doors are not inflated. The inflate is derived in `lib/src/components/design.tsx` so both ring strokes center on the gutter's midline: the 1px passthrough border spans [3px, 4px] from the pane edge — dead center of the 7px gutter, on whole pixels because the gutter is odd.

- Exactly one pane or door is **active** at a time. One SVG renderer (`SelectionRing`, `variant: 'ants' | 'solid'`) draws both modes.
- **Passthrough:** `variant='solid'` — a 1px solid SVG stroke that replaced the old `border: 1px solid ${color}` CSS border, placed pixel-identically (centerline `strokeWidth/2` inside the div edge for both panes and doors), no glow.
- **Command:** `variant='ants'` — animated marching-ants border (`cfg.marchingAnts`: 10px segment, 60% dash / 40% gap, 0.4s cycle, 2px stroke). Unchanged while the ring travels; the motion smear is a separate layer behind it (see [Ring travel](#ring-travel)). The animation pauses while the window is unfocused, and the whole ring drops to `saturate(0.3)` then.
- Border radius follows DESIGN.md's Concentric-Corners Rule: the pane ring's rect is inflated by `SELECTION_RING_INFLATE_PX`, so its radius is the pane radius plus that offset (`PANE_SELECTION_RING_RADIUS_PX`, with the marching-ants path inset so its stroke centerline sits on the same gutter midline, concentric with the pane corner); doors sit at zero offset and keep `0.5rem 0.5rem 0 0`.
- Color is the resolved `--color-focus-ring`, re-read whenever `document.body`'s class/style changes because the dynamic palette publishes it there (`useFocusRingColor`).
- `z-index: 50`, `pointer-events: none`.

### Ring travel

The ring's rect (and its `{tl,tr,br,bl,inset}` shape) is driven **per-frame by a JS tween**, not a CSS transition — the tween writes true interpolated values each rAF frame, the same pointer-events-none carve-out the Lath animator holds (DESIGN.md's "don't animate layout properties" bans CSS transitions on layout props, not this). Motion is `FOCUS_MOTION_MS` (220ms — half `LATH_MOTION_MS`) on the house curve `cubic-bezier(0.22, 1, 0.36, 1)`. Source of truth: the pure tween core `lib/src/lib/rect-tween.ts` (position and velocity); the pure outline/smear geometry `lib/src/lib/ring-geometry.ts`; the overlay's rAF loop in `WorkspaceSelectionOverlay.tsx`; the SVG shell `lib/src/components/wall/SelectionRing.tsx`.

Per-frame writes are **imperative** — the same React-owns-structure / frame-owns-mutations split LathHost uses for the animator. `SelectionRing` renders a stable shell once (per variant/color/focus change) and lifts its DOM nodes (container div, ring path, smear group) back to the overlay via refs; the rAF loop writes `top/left/width/height`, the path `d`, the marching-ants dash, and every smear piece's `d` / width / opacity directly, and re-applies once after any structural render (pre-paint, so a freshly mounted ring never flashes). Do **not** reintroduce per-frame React state: a per-frame reconcile of this subtree competes with the travel for the frame budget.

- **Identity change → tween.** When the incoming measurement's identity (`${selectedType}:${selectedId}`) differs from the one on screen, the ring glides from its current interpolated position to the new target, clock restarted (arrow-key spam stays responsive).
- **Same identity → snap 1:1.** A same-identity re-measure with no tween in flight (sash drag, window resize, a settled leaf's store commit) writes the new rect directly — the ring tracks the geometry exactly instead of easing behind it.
- **In-flight retarget.** A same-identity re-measure *during* a tween retargets the destination without resetting the clock, so the ring converges on a moving target (select-a-neighbor-during-kill) and still lands on the original completion instant.
- **Snap gate.** `motionIsInstant()` — `!cfg.layout.animate` (Chromatic) or `prefersReducedMotion()` — settles the ring instantly, the same predicate the Lath animator's duration uses, so ring and leaves agree. A ring appearing with nothing on screen also snaps: there is no `from` to glide from.
- **The unfocus-saturate fade is the one CSS transition** (`filter ${FOCUS_MOTION_MS}ms`, set inline by `SelectionRing.tsx`); neither the snap gate nor reduced motion touches it. Chromatic is the single exception: `lib/.storybook/preview.ts` zeroes every transition duration with an author `!important`, which outranks that inline declaration, so a snapshot shows the fade already finished. A missing fade in a Chromatic diff is expected, not a regression.
- Pane↔door selection morphs the corner radii (12px all-round ⇄ `8,8,0,0`) and stroke inset through the same tween, so the shape lerps instead of popping.

#### Directional motion smear

While travelling, each ring edge trails a soft band sized by its own motion. A line smears only by moving *across* itself — sliding along its own length leaves it unchanged — so **a horizontal edge is driven by its vertical speed and a vertical edge by its horizontal speed, and all four edges are independent.** Each speed normalizes against `cfg.focusRing.smearFullSpeed` into a single `t`; width ramps from `strokeWidth` to `smearMaxPx` and alpha from 0 to `smearPeakAlpha`. Both start at zero, so a stationary edge contributes nothing rather than laying a band under the crisp ring. A settled or reduced-motion ring has null speeds and the smear layer is `display: none`, keeping snapshots deterministic. Source of truth: `lib/src/lib/ring-geometry.ts`.

- **Velocity is analytic, and the smear peaks on the opening frame.** `sampleRingVelocity` differentiates the tween: an edge at `from + (to - from) * E(t)` moves at `|to - from| * E'(t) / durationMs`, with `E'` from `LATH_EASING.slope`. The house ease-out peaks at `E'(0) = 4.545x` its average speed, so that is where the blur belongs. **Do not go back to finite-differencing rendered positions**: there is no previous sample on frame one, so the smear was hidden outright for the frame covering ~31% of a 220ms travel; an EMA over it lagged ~1.7 frames; and a backward difference under-reports any decelerating curve, landing the rendered peak mid-travel at ~46% of the true value. Analytic velocity is also jitter-free by construction, so it needs no smoothing.
- **Extent and intensity are deliberately independent.** Alpha is *not* divided by the widening factor: strict ink conservation would tie peak alpha to extent and make the effect impossible to strengthen by widening — a wider band would just spread the same ink thinner. `smearFullSpeed` sets the shape over a travel: low values pin nearly every move at full smear, high values make blur track speed so short hops smear less than long jumps.
- **Per-edge, not per-axis.** Collapsing the four edges to one horizontal and one vertical speed (e.g. from the ring *centre's* velocity) is wrong for ordinary split layouts: moving between panes flush at the top but differing in height, the top edge translates purely sideways and must stay crisp while the bottom edge moves diagonally and smears hard. A centre velocity averages those into the same wrong answer for both.
- **Two layers, because the geometry is incompatible.** The ring is one closed path so the dash phase runs unbroken around the perimeter, and SVG `stroke-width` is a single scalar, so that path cannot carry four widths. The smear is a sibling `<g data-ring="smear">` of eight pieces drawn underneath; the ring (`<path data-ring="outline">`) is never transformed, re-dashed, or re-alpha'd. Keeping all dash bookkeeping on the untouched path is the point of the split.
- **Eight pieces: four edges plus four corners.** Straight edges carry their width in a plain `stroke-width`. A corner has to reach two widths at once, so each corner arc is stroked at unit width and given `transform: scale(a, b)` — `a` the vertical neighbour's width, `b` the horizontal neighbour's — under which a unit stroke renders `b` thick where its tangent is horizontal and `a` thick where vertical, tapering between with no seam at either join; `cornerPath` pre-divides the arc by the same `(a, b)` so the on-screen curve is unchanged. Opacity cannot vary along a stroke, so a corner takes the mean of its two edges'. Every piece is cut from ONE shared point set (`ringPoints`), which is also what `roundedRectPath` walks, so the smear provably tiles the ring; `ring-geometry.test.ts` pins that. The overlay finds each piece by `data-piece`, never by index.
- **Dash length is computed, not measured.** `ringPerimeter` returns the outline's exact length in closed form — straight runs plus `1.6232252401402307 × r` per corner, the arc length of the *quadratic* quarter-turn the path actually draws. Do not substitute `π/2` (the quarter-*circle* value); it is 3% short and would silently shift every dash. `SVGGeometryElement.getTotalLength()` is not to be reinstated: it forces a synchronous style+layout flush on every frame at a cost scaling with the whole document, and it is itself only an approximation (browsers flatten curves to measure) — verified in Safari to agree with the closed form to 6e-4px on a 3253px ring. Dropping it also retired the jsdom `getTotalLength` stubs, so tests assert real dash geometry.
- **The smear replaced an SVG `feGaussianBlur`. Do not go back**: WebKit CPU-rasterizes SVG filters every frame, measured in Safari 26.5 at 25.6ms/frame with 31 of 98 frames over 25ms during travel, versus a locked 16.7ms with zero dropped frames. Stroke widths, scale transforms and opacities are GPU-composited and cost nothing. CSS `filter: blur()` is also free, so the cost is SVG filters specifically, not blur.

### Position tracking

Each pane body registers its DOM element in a `paneElements` Map on mount and removes it on unmount (`usePaneChrome`); the overlay resolves the enclosing Lath leaf (`[data-lath-leaf]`) via `resolvePaneElement` so the ring covers the full leaf (header + body). Doors are registered by the `Baseboard` through `DoorElementsContext` (`[data-door-id]`), and only the *visible* subset — an overflowed door has no element to measure.

Re-measures on: selection change, `ResizeObserver` on the target, every Lath store commit (`revision` via `useSyncExternalStore`), and — while the wall streams animator frames — every frame, so the ring tracks kills, restores, and tweens frame-accurately. If the selected leaf is momentarily absent the overlay bails and holds the last rect.

## Spatial navigation

Arrow navigation resolves against Lath's pure `neighbors(tree, rect, id, direction, opts)` query — no DOM rect scanning; it computes against the same laid-out rects the screen shows (`docs/specs/tiling-engine.md` → "Layout"). The keyboard handlers reach it through the engine-neutral `WallNav` seam (`lib/src/components/wall/keyboard/types.ts`), whose `findInDirection` calls `lath.store.neighborOf`: a candidate must be strictly beyond the leaf's edge on the primary axis; one overlapping on the secondary axis is preferred; ties break on nearest edge-to-edge distance, deterministically; with no overlapping candidate the nearest non-overlapping one wins.

**Back-navigation.** A breadcrumb tracks the last navigation direction and origin pane; pressing the opposite direction returns to the origin instead of doing a spatial lookup. This is what makes asymmetric layouts (tall pane left, stacked panes right) navigate reversibly.

**Pane↔door.** Down from a pane with no pane below it selects the *first* door; Up from a door selects the *last* pane; Left/Right moves between doors. Doors have no spatial query — they are an ordered list.

**`Cmd/Ctrl+Arrow` swap.** Swaps Surface **content** between two panes; the layout shape is unchanged. A single Lath `swap` op trades the two leaf identities, and because per-leaf metadata and terminal-registry entries are keyed by id, the title/params/session follow automatically, with **no** companion title swap. Selection stays on the moved Surface, so the breadcrumb records the *partner* (the pane now holding the old slot) — that way the opposite `Cmd+Arrow` swaps back exactly and a plain opposite arrow selects the partner.

## Minimize and reattach

### Minimize (`m`/`d`, the header button, or a drag onto the baseboard)

`lath.store.doorLeaf(id, { park })` detaches the leaf and returns a JSON-serializable **restore token** (`docs/specs/tiling-engine.md` → "Restore tokens"); the Wall appends `{ id, token }` to its `doors` state and moves selection to the new door in command mode. The Session stays in the registry — nothing is disposed. If this was the *last* pane, the auto-spawn effect fills the emptied Wall while the door keeps selection. A pane dragged onto the baseboard takes the identical path (`onProposeMinimize` → `minimizePane`).

**A runtime Door is `{ id, token }` and carries no metadata at all.** Everything else — title, params, whether the leaf is parked — stays in the Lath store, which keeps changing while the Surface is Doored. So there is no copy to go stale: reattach, `dor` param matching, kill/session teardown, `dor list`, the baseboard chip's label and the session save all read `lath.getMeta(id)`, and the persisted `PersistedDoor` row is materialized from the store at save time.

**A minimized browser Surface parks rather than unmounting** (`shouldParkOnMinimize`): its state lives in the DOM — an `<iframe>`'s document, a screencast canvas — so a plain remove would destroy it and reattach would be a reload. Terminals do not park; their state is in the PTY and the registry replays it. `docs/specs/tiling-engine.md` → "Parked leaves" owns the mechanism, the `MAX_PARKED_SURFACES` cap, and the visibility contract. Parking spans the minimize only — a restart still cold-loads every browser Surface from its persisted URL.

### Reattach (click door, `Enter`/`m`/`d` on door, or drag out)

`lath.restoreLeaf(meta, token, { fallbackRef })` applies the token's three-tier exact/neighbor/fallback policy (`docs/specs/tiling-engine.md` → "Restore tokens"). The Wall supplies the fallback reference — the selected pane if it is live, else the first pane — and, if the restore still fails (no token, empty tree), adds the leaf as the root so a reattach can never be silently swallowed.

A door dragged out of the baseboard skips the token entirely and inserts at the hit-tested drop position the user chose (`onExternalDrop` → `lath.insertLeaf`). Either path unparks a parked Surface in the same commit that re-admits it, so the DOM is never momentarily unmounted.

### Splitting from a Door

`dor split --surface <minimized-ref>` and `dor ensure --surface <minimized-ref>`
create the new terminal Surface directly as a Door instead of rejecting the
reference or restoring it first. The new Door is inserted immediately to the
right of the reference Door in the baseboard, and the response reports
`minimized: true` even when the caller did not pass `--minimize`. A direct
door-split carries a restore token whose neighbor tier points at the reference
Door, so if the reference is restored first, restoring the new Door can still
split beside it. `--auto` resolves to `right` for a Door reference because there
is no visible pane geometry to inspect.

## Inline rename

Triggered by pressing `,` in command mode or clicking the session name in the pane header.

The name `<span>` is replaced by an `InlineEditInput` (shared with the browser URL editor in `docs/specs/dor-browser.md`): same font (`font-mono font-medium`), `bg-transparent`, no border, seeded from the label with the failure glyph stripped. `Enter` confirms, `Escape` cancels, `blur` confirms — whichever lands first settles the edit, so the blur that follows an Enter/Escape unmount cannot submit a second time. It stops propagation on `mousedown`/`click`/`keydown` so the panel click and the header drag never fire.

The field is **controlled by its own draft state**, seeded at mount and untouched by later prop changes, and the `select()` ref callback has a stable identity so it runs exactly once. Pane headers re-render on every activity, terminal-state, and palette change, and an editor that re-derived its value (or re-ran `select()`) on those renders would fight the user mid-word — one re-render between two keystrokes and the second keystroke replaces everything typed so far. Mounting is the reset: the editor exists only while the pane is being renamed, so each rename starts from the current label.

Clipboard chords inside the field are the wall's job on hosts whose webview has no native Edit menu — see `docs/specs/mouse-and-clipboard.md` §8.9.

Submitted values are rejected when empty or when they fail the `setTerminalUserTitle` validation that also guards title seeding — no titles starting with the `<idle>` sentinel (`docs/specs/transport.md`). `<unnamed>` is the default panel placeholder but is otherwise allowed as a deliberate user pin. On rejection the input still closes (so it is not a blocking dialog) and a small warning popover anchored under it names the offending value. The popover dismisses on the next pointerdown, scroll, resize, `Escape`, or after `cfg.overlays.warningAutoDismissMs` (3s). `lib/.storybook/preview.ts` sets that to 0 under Chromatic — a popover that removes itself three seconds after the play function ends is present or absent in the capture depending on how loaded the runner is.

## Session lifecycle and terminal registry

For a terminal Surface the pane ID is its session ID. `TerminalPane` calls `getOrCreateTerminal(id)` on React mount and `unmountElement(id)` on React unmount. The session (xterm.js instance, PTY, DOM element) persists in the registry across mount/unmount cycles — the DOM element is detached from its container but the Registry entry stays `Mounted`. A browser surface's pane ID is a Surface id with no registry entry or PTY (`docs/specs/glossary.md`); its DOM is hosted by LathHost's leaf div and it is reconstructed from persisted params, not from the registry.

- **Create**: `getOrCreateTerminal` spawns xterm.js + UnicodeGraphemesAddon + FitAddon + PTY, returns existing if already created. The xterm instance sets `allowProposedApi: true` because UnicodeGraphemesAddon activates through xterm's proposed Unicode API. The WebGL addon is *not* loaded at create — it is claimed lazily on the session's first mount (see "Renderer" below).
- **Resume**: `resumeTerminal` creates xterm entry and writes replay data without spawning a new PTY. Used when the webview is recreated while the host retains Live PTYs (Link: Severed → Resuming → Live).
- **Restore**: `restoreTerminal` creates xterm entry and spawns a new PTY with the saved cwd. It replays no transcript — scrollback is not persisted (`docs/specs/transport.md` → "What is persisted"). Used on cold start from a saved Snapshot (Link: Cold → Live).
- **Agent resume**: a restored pane the host captured a resume invocation for re-runs it automatically. See "Agent resume on cold restore" below.
- **Untouched**: new `getOrCreateTerminal` sessions start untouched. `isUntouched(id)` exposes the flag, and user-originated PTY input clears it via the registry input paths. Resume/restore seed the persisted flag; missing legacy snapshot data defaults to touched (`false`) so close confirmation remains conservative.
- **Shell selection replacement**: the standalone Settings dialog's Shell row and the VS Code shell picker send `dormouse:new-terminal` with `replaceUntouched` when the selected shell type changes. The standalone picker identifies a shell by its executable path plus ordered arguments, so WSL distributions and Windows Developer shells that share an executable remain distinct. `Wall` always creates a new session id and a fresh `surface:N` ref for that request. If the currently selected pane or door is untouched, the new terminal takes over the same leaf via a Lath `replace` op (an atomic identity swap; doors first reattach through the normal restore path), the old untouched session is disposed, and the replaced Surface's ref is retired. If the selected terminal is touched or no terminal is selected, the request spawns a new pane beside the selected one. Announced shell-selection spawns show a transient pane-anchored notice such as `Switched to zsh` or `Opened bash`.
- During **resume** replay, xterm.js may emit terminal-generated replies for OSC/CSI/DCS queries that were embedded in buffered output. The registry drops those replay-time replies before they reach the new shell. This filter is limited to query/focus reports, and must not swallow user keyboard escape sequences such as arrows, function keys, or bracketed paste.
- **mount / unmount (DOM)**: `mountElement` reparents the persistent DOM element into a container; `unmountElement` removes it. The Registry entry survives.
- **Dispose**: `disposeSession` kills the PTY, disposes xterm, removes the registry entry. Only called on explicit kill (`x`).
- **Swap**: the Cmd/Ctrl+Arrow swap trades two leaf identities via a Lath `swap` op — per-leaf metadata and registry entries are keyed by id, so they follow the swap with no DOM reattach or title swap (see "Cmd/Ctrl+Arrow swap" above).

### Agent resume on cold restore

A cold **restore** spawns a *fresh* shell and replays nothing. What can come back
is the agent the host interrupted on its way down: when the host's boot payload
carries an invocation for that surface (`PlatformAdapter.getRecoveryCommands`;
`docs/specs/transport.md` → "The recovery command"), the restored pane runs it —
no prompt, no button.

- **Restore only.** `restoreSession` passes the command to `restoreTerminal` per
  terminal pane; **resume** never does, because there the agent is still Live and
  has nothing to resume. Browser surfaces are skipped with the rest of the terminal
  restore path.
- **Revalidated, not trusted.** `normalizeResumeCommand` re-checks the invocation
  before it is typed, so a snapshot written by an older detector cannot execute
  something the current grammar would reject.
- **Typed at the prompt, not at spawn**, through the same
  `typeCommandWhenPromptReady` wait as a `dor split` launch, with `commandLine` +
  `commandStart(user_input)` seeded synchronously first
  (`docs/specs/transport.md` → "Consuming it" owns both rules).
- **The pane announces it.** One dim line — `⟲ resuming agent session: <command>` —
  written to xterm, not the PTY. With no transcript to explain the pane, it is the
  only thing saying why an agent appeared, and it marks the discontinuity the
  resume otherwise hides: the interrupted turn did **not** continue. It is a
  notice, not a control; it has no dismiss and no retirement rules.
- **No confirmation gate**, for the reasons recorded in `docs/specs/transport.md`
  → "Consuming it".

Source of truth: `restoreTerminal` in `lib/src/lib/terminal-lifecycle.ts`, called
from `lib/src/lib/session-restore.ts`.

### Renderer

Every terminal renders through stock `@xterm/addon-webgl`, claimed lazily by
`tryEnableWebglRenderer` on a session's **first `mountElement`** — not at creation —
and guarded by `TerminalEntry.webglAttempted` so each session claims at most one GL
context. A GL context is a scarce per-page resource and cold restore builds a session
for every persisted pane *including minimized doors*, which never paint; claiming at
create would spend the budget on invisible surfaces and, since eviction is
oldest-first and one-way, permanently demote the earliest-restored panes. xterm's
built-in DOM renderer is the fallback, never the default.

The DOM renderer emits one `<span>` per style run per row, so a TUI that paints
every cell its own truecolor collapses to one span-with-inline-style *per cell*,
rebuilt every frame. On a 99×25 pane that is ~1150 elements of style recalc plus
layout per frame: measured in Safari 26.5, a single such pane held the whole page
at ~110ms/frame (~9fps) while the rest of the app was idle. The same pane on the
WebGL renderer holds a locked 60fps (16.6ms, zero frames over 25ms).

Fallback to the DOM renderer is automatic and must stay that way, because two
failure modes are expected in the field:

- **No WebGL at all** (headless/jsdom, blocklisted GPU, a host webview with GPU
  disabled). Construction throws; `tryEnableWebglRenderer` swallows it. A
  `typeof WebGL2RenderingContext === 'undefined'` pre-check skips the doomed
  request entirely so unit tests don't log a `getContext` failure per terminal.
- **Context-budget eviction.** Browsers cap live WebGL contexts per page —
  measured at **16 in Safari 26.5**, evicted oldest-first. One context per
  terminal means a Window past ~16 terminals silently drops its *oldest* panes
  back to the DOM renderer. The `onContextLoss` handler disposes the addon,
  which is xterm's documented signal to resume DOM rendering; verified live by
  exhausting the budget and watching the panes keep painting.

Degradation is therefore never worse than the pre-WebGL behavior, but it is also
one-way: a pane that loses its context stays on the DOM renderer even after other
panes close. Re-arming the focused pane after a loss is unbuilt — see `## Future`.

The outcome is recorded as `data-renderer="webgl"|"dom"` on the host element, so it
is inspectable rather than silent — including after a context loss demotes a pane.
`cfg.terminal.webglRenderer` disables the whole path; `lib/.storybook/preview.ts`
pins it off under Chromatic, because a canvas snapshots as an opaque bitmap that
varies with the runner's GPU while styled spans diff deterministically.

Verified in Safari 26.5 (the numbers above) and structurally in Chrome. **Not yet
verified inside Tauri's WKWebView**: same engine as Safari and Tauri does not
disable the GPU, so it is expected to work — read `data-renderer` on a pane's host
element to confirm.

Source of truth: `tryEnableWebglRenderer` in `lib/src/lib/terminal-lifecycle.ts`.
Not to be confused with the SDF fork in `docs/specs/webgl-text.md`, which is a
different addon consumed only by `canopy/`.

### Session persistence

Layout, cwd, minimized items, user-pinned titles, untouched state, and alert state are saved to persistent storage via a debounced save (500ms). **Scrollback is never persisted** (`docs/specs/transport.md` → "Retiring the transcripts already on disk"); a transcript in a pre-upgrade blob is scrubbed on read. The layout persists as the native Lath format (`lathLayout`; `docs/specs/tiling-engine.md` → "Persistence"). Derived command/app labels shown on minimized doors are display-only and are not persisted as user-pinned titles. Every Lath store commit (add/remove/resize/swap/meta, including the active-pane the layout records) *schedules* the debounced save; content changes (terminal output, activity/TODO, pane title/command state, minimized-door changes) only *mark the session dirty*; a 30s heartbeat persists only when the session is dirty, so an idle app stops writing. Saves are flushed immediately and unconditionally on PTY exit, `pagehide`, and extension shutdown requests — the correctness net for any dirty-trigger gap. The dirty-gating mechanism and the store-level identical-value backstop are specified in `docs/specs/standalone.md` §Persistence.

In standalone, each Workspace's snapshot is wrapped in a Window snapshot that records every Workspace (name + layout) and which one is active, so all Workspaces — not just the mounted one — survive a restart. VS Code persists one Workspace per webview exactly as today (one snapshot per `WebviewView` / `WebviewPanel`). The persisted container types (`PersistedWorkspace`, `PersistedWindow`) live in `docs/specs/transport.md`.

Saved snapshots are read through `readPersistedSession()`, which accepts the canonical object shape and defensively parses a JSON-stringified blob before validation. A present-but-unreadable blob is logged and discarded, so malformed storage starts fresh rather than blocking startup, while hosts that hand back serialized JSON instead of the parsed object are still covered.

On startup, recovery is priority-based:
1. **Resume** (webview hidden/shown, live PTYs): request PTY list + replay data from platform, `resumeTerminal()` for each (500ms timeout). Saved pane and door titles are seeded back via `setTerminalUserTitle()` (see `docs/specs/transport.md`) so persisted placeholder labels never replay as user pins. If the saved session covers every live PTY, restore the saved Lath layout when its leaf set matches and reattach saved minimized items as doors. This still counts as a live resume when every live session is minimized, so recovery must not fall through to cold restore just because the visible `paneIds` list is empty.
2. **Restore** (app restart, cold start): the Wall's `seed` hydrates from the restored Lath layout, else falls to (3); `restoreTerminal()` for each pane with its saved cwd and title, spawning each PTY with the current default shell selection. Browser surfaces are rebuilt from their persisted params instead.
3. **Fallback/manual pane creation**: when no saved layout can be safely applied, add multiple panes as splits from the previous pane, and spawn each PTY with the current default shell selection
4. **Empty state**: create a single new pane with the current default shell selection

### Activity state

Each Surface carries an `ActivityState` (`status`, `watchingEnabled`, `todo`, `notification`) whose semantics belong entirely to `docs/specs/alert.md`. Layout's stake in it: the store is synced to React via `useSyncExternalStore`, and state that arrives from the platform *before* a registry entry exists (the resume path) is staged as **primed state** and merged in when the entry is minted — a browser surface, which never gets a registry entry, keeps its activity in a parallel local map instead.

Each terminal Session also carries `TerminalPaneState` from `docs/specs/terminal-state.md`. That store is keyed by pane/session id, and PTY-originated semantic events are resolved through `ptyId`, so a swapped session keeps its CWD and command state with the terminal content.

## Theme

The Lath host styling lives in the `.lath-host` / `.lath-leaf` rules in `lib/src/index.css`: an app-bg host and a terminal-bg body. Each leaf has a 30px header band applied by LathHost from the shared `PANE_HEADER_HEIGHT_PX`. The content area uses a 7px top/sides inset and 2px bottom inset (`px-1.75 pt-1.75 pb-0.5` on wrapper, `inset-x-1.75 top-1.75 bottom-0.5` on container — the bottom becomes 7px too when the baseboard is suppressed); the `LATH_LAYOUT_OPTS` gap of `PANE_GUTTER_PX` is the only visual separator between panes.

The Lath host paints `var(--color-app-bg)` so gutters and rounded pane/header corner cutouts match host chrome. Terminal content backgrounds are painted by the React terminal wrappers and xterm host elements, not by the leaf containers. The two-layer `@theme --color-*` → `var(--vscode-*)` token strategy is `docs/specs/theme.md`'s.

## Animations

All pane motion is owned by the Lath **animator** — a pure function of time that turns committed layout changes into interpolated frames, applied imperatively to the leaf divs by LathHost (`docs/specs/tiling-engine.md` → "Animation"). Default motion is 440ms `cubic-bezier(0.22, 1, 0.36, 1)`; under reduced motion the animator runs the same code with a 0 duration (instant). The selection overlay measures the leaf divs, which carry the interpolated inline geometry, so `getBoundingClientRect` tracks the tween frame-accurately. There are no CSS entrance/exit classes. Terminal panes, by contrast, do not refit every frame: `TerminalPane`'s resize observer throttles `refitSession` (leading edge, then at most one per ~150ms while resizes keep arriving, plus a trailing call at rest), so a motion or sash drag reflows the xterm buffer and fires a PTY resize a handful of times instead of once per animated cell-boundary crossing, while the resting geometry still gets an exact fit.

### Zoom (elevated expansion)

Zoom is presentation-only — the split tree and every tiled rect stay unchanged, and the geometry (the 15px-inset wall rect, the elevated layer, the blurred app-bg halo) belongs to `docs/specs/tiling-engine.md` → "Layout" / "Animation". What layout.md owns is that **zoom is coupled to passthrough focus**: acquiring it enters passthrough and focuses that pane; exiting passthrough, focusing another pane, or selecting a Door starts unzoom immediately.

Only the owner's header shows Unzoom, with its header tokens inverted so the escape action stands out, and only the owner's control toggles zoom *off*. The exposed perimeter leaves other headers reachable, so their Zoom control hands zoom over — focus included — rather than merely unzooming the owner. Source of truth: focus/zoom orchestration and `ZoomedIdContext` in `lib/src/components/Wall.tsx`; `paneZoomButtonClass` in `lib/src/components/design.tsx`.

### Spawn (new pane reveal)

A newly added leaf enters by growing from the boundary it was placed against, at opacity 0 → 1 (a split to the right grows from its left boundary, and so on). The store's mutators derive this **enter hint** from the edge they commit; the auto-spawn refill overrides it to `'top-left'` (the killed last pane shrank toward the bottom-right, so the refill grows from the opposite corner). See `docs/specs/tiling-engine.md` → "Animation" → Enter.

Shell-selection replacement shows a short fixed-position notice over the resulting pane. The notice fades in/out over 1500ms via `.shell-spawn-notice` and is suppressed to a static render for reduced-motion users.

### Kill (two-phase fade + tween reclaim)

`killPaneImmediately` in `Wall.tsx` runs the animator's two-phase exit — fade in place, then commit the removal after `lath.exitMs` so survivors tween into the reclaimed space. The mechanics, the idempotence guard, and the last-pane bottom-right shrink belong to `docs/specs/tiling-engine.md` → "Animation" → Exit.

**Selection tail.** At removal time selection moves to a survivor (`lath.listPanes()[0]`, or `null` → auto-spawn when the last pane goes) **only when the killed pane is still the selected pane** — the check is live, re-read inside the removal timeout. So killing a background surface leaves the user's selection untouched, and a selection move *during* the fade is honored both ways: navigating away from a dying selected pane means the tail no longer yanks selection, and navigating onto a dying pane means the tail adopts a survivor instead of leaving selection dangling. The header kill button is always a selected-pane kill (clicking the header selects the pane before the button's click handler runs); the not-selected cases are `dor kill` of a background surface and ensure's throwaway teardown.

A **doored** Surface has no visible pane to fade, so `killPaneImmediately` takes a separate branch: close any agent-browser session, `forgetLeaf` (which also unmounts a parked DOM), `disposeSession`, drop the door chip. Disposing stops the PTY, which is also what makes a still-armed `typeCommandWhenPromptReady` bail rather than type into a dead surface.

### Auto-spawn refill

A store commit that empties the tree (last pane killed or minimized) triggers the "always keep one pane visible" auto-spawn: a Wall effect subscribed to the store spawns one leaf into the emptied tree (`lib/src/components/Wall.tsx`). It fires re-entrantly on the same commit chain, so the refill appears without a separate delay; the killed pane's fade already sequenced the removal. The refill spawns with the current default shell selection, matching manual splits.

The refill adopts the replacement (`selectPane`) only when the current selection no longer points at anything real: null (the kill tail cleared it after a selected last-pane kill) or dangling (selection still names the just-removed pane). A *valid* selection is left alone — the just-created door on the minimize path (so the door keeps selection across the refill) or a live pane after an unselected kill — because the auto-spawn exists to keep a pane visible, not to steal selection.

## Corner cases

> Numbered for cross-spec reference; the numbers are stable, so append rather than renumber.

1. **xterm steals Meta keys**: the mode-exit gesture listens in the capture phase, so it fires even while xterm has DOM focus.
2. **A focused iframe surface is not a window blur**: it blurs the window while `document.hasFocus()` stays true. Cross-session attention is cleared only on a *real* blur, or focusing an embed would wipe attention across the Wall.
3. **Stable hitboxes across moves**: each pane body registers its DOM element in `paneElements` (`usePaneChrome`), and the selection/kill overlays resolve the enclosing `[data-lath-leaf]` from it, so a leaf measured after a move reports its new rect. Because Lath never re-parents a leaf div, its node identity — and any embedded `<iframe>` — survives every op; there is no re-parent blur to heal and no iframe reload.
4. **Asymmetric back-navigation**: the breadcrumb (see [Spatial navigation](#spatial-navigation)) makes every arrow move reversible even when no spatial query would return you.
5. **Door keeps selection through the auto-spawn refill**: minimizing the last pane selects the new door, then the refill fills the emptied Wall without stealing selection (see [Auto-spawn refill](#auto-spawn-refill)). Explicit user selection of a pane — a click, a drag, or an embed focusing itself — still moves selection off a door.
6. **Focus-neutral surface creation (`dor ensure` / `dor iframe` / `dor ab`)**: unlike `dor split`, these open in the background without moving focus off the caller (`docs/specs/dor-cli.md`, `docs/specs/dor-browser.md`). Under Lath this is inherent — an add never re-parents the caller's subtree or steals activation, so the caller keeps DOM focus and selection with no healing; the create simply does not call `selectPane` (`settleAddSelection` returns false for a focus-neutral, non-selection-replacing add). The one exception: `dor iframe` / `dor ab` replacing the pane the user is *currently selected on* moves selection to the replacement (else it would dangle on the removed leaf); replacing any other pane, or a door selection, is left untouched. A throwaway that never reports OSC 633 integration is torn down with `killPaneImmediately`, whose live selection check leaves the caller's selection intact (a `--minimize` throwaway is already a door, and `killPaneImmediately` disposes it directly).

## Files

| File | Role |
|------|------|
| `lib/src/components/Wall.tsx` | Main layout orchestrator: selected mode/state, session actions, minimize/reattach, provider composition |
| `lib/src/components/wall/wall-types.ts` / `wall-context.tsx` | Shared Wall types and React contexts used by Wall, pane headers, panels, overlays, and the baseboard |
| `lib/src/components/wall/LathHost.tsx` | The tiling engine's HTML adapter: leaf divs, sashes, the pane/door drag gesture, and imperative animator frame application. Engine internals are mapped in `docs/specs/tiling-engine.md`. |
| `lib/src/components/wall/AlertSpeechIndicator.tsx` | Pointer-transparent whole-Pane `SPEAKING` / `SPOKEN` overlay |
| `lib/src/components/wall/TerminalPanel.tsx` | Pane body wrapper; registers the pane's DOM element (`usePaneChrome`) |
| `lib/src/components/wall/TerminalPaneHeader.tsx` | Pane header with rename, alert/TODO, mouse override, split/zoom/minimize/kill controls, and the right-click context menu |
| `lib/src/components/wall/InlineEditInput.tsx` | The inline title/URL editor: draft-owning controlled input, pre-selected once on mount |
| `lib/src/components/wall/IllegalRenameWarning.tsx` | The auto-dismissing popover shown when a submitted rename is rejected |
| `lib/src/components/wall/use-dismiss-overlay.ts` | The shared pane-header popover dismissal contract (outside pointerdown / Escape / resize / external scroll) |
| `lib/src/components/KillConfirm.tsx` | Kill-confirm modal + overlay, the random confirm character, and the shake/confirm exit timings |
| `lib/src/components/wall/PaneHeaderContextMenu.tsx` | Pane-header right-click menu: the `surface:N` handle plus the pane's bound TCP ports; a port click connects it to the default browser (`docs/specs/dor-browser.md`) |
| `lib/src/components/wall/WorkspaceSelectionOverlay.tsx` | Pane/door focus ring: the JS travel tween + rAF loop; re-measures on Lath store commits + animator frames; computes the directional motion-blur velocity |
| `lib/src/components/wall/SelectionRing.tsx` | The SVG shell: one ring path (`solid` passthrough / `ants` command) plus the eight-piece smear group, all driven imperatively |
| `lib/src/lib/ring-geometry.ts` | Pure ring outline + smear-piece path geometry, and the piece/corner taxonomy |
| `lib/src/components/wall/MouseOverrideBanner.tsx` | Temporary mouse override banner shown from the header icon |
| `lib/src/components/wall/use-wall-keyboard.ts` | The single capture-phase `keydown` listener and its fixed delegation order; also feeds the proxy iframe's posted leader chord into the same dispatch |
| `lib/src/components/wall/keyboard/` | The dispatch modules themselves — dual-tap, editable-field clipboard, mouse-selection keys, kill confirm, pane shortcuts, pane navigation — plus the `WallKeyboardCtx` / `WallNav` seams and the platform chord predicates |
| `lib/src/lib/vscode-keybindings.ts` | VS Code-hosted workbench chord mirror allowlist |
| `lib/src/components/wall/use-session-persistence.ts` | Debounced layout/session save, flush requests, pagehide, PTY exit, file-drop paste routing |
| `lib/src/components/wall/use-dor-control.ts` | The `dor` CLI's webview control-plane hook (`useDorControl`): the `dormouse:control-request` handler for `surface.*` methods plus its surface-resolution/param-coercion/command-quoting helpers (`docs/specs/dor-cli.md`) |
| `lib/src/components/wall/use-window-focused.ts` | Window focus tracking hook for header and selection overlay dimming |
| `lib/src/components/Baseboard.tsx` | Always-visible bottom strip with door components, overflow arrows, shortcut hints, and the right cluster (notice slot + three alarm settings/status buttons) |
| `lib/src/components/Door.tsx` | Individual door element — mouse-hole styled button with alert/TODO indicators |
| `lib/src/components/TerminalPane.tsx` | Thin xterm.js mount point — mounts/unmounts persistent session elements |
| `lib/src/lib/terminal-registry.ts` | Public facade preserving registry imports |
| `lib/src/lib/terminal-store.ts` | Registry maps, terminal entry shape, pending shell opts, overlay dimension types |
| `lib/src/lib/terminal-lifecycle.ts` | Session lifecycle: create, resume, restore, mount, unmount, dispose, swap, focus, refit |
| `lib/src/lib/terminal-state.ts` | Pure semantic terminal model: CWD normalization, command reducer, header derivation, grouping helpers |
| `lib/src/lib/terminal-state-store.ts` | React-facing terminal semantic state store and PTY-id to pane-id resolution |
| `lib/src/lib/session-activity-store.ts` | React activity snapshot store, primed alert state, alert/TODO platform delegates |
| `lib/src/lib/terminal-theme.ts` | xterm theme extraction, terminal host painting, theme MutationObserver |
| `lib/src/lib/terminal-report-filter.ts` | Synthetic/replay terminal report detection and replay writer |
| `lib/src/lib/terminal-mouse-router.ts` | Mouse selection routing, smart-token hinting, Alt shape toggle |
| `lib/src/components/wall/resolve-pane-element.ts` | `resolvePaneElement` — climbs a registered pane element to its enclosing `[data-lath-leaf]` for overlay/kill measurement |
| `lib/src/lib/quiesce-detector.ts` | Per-session always-on output/silence detector: output timing → busy/quiet/settled |
| `lib/src/lib/alert-manager.ts` | Manages the detectors + the WATCHING rule set + attention tracking + TODO state per session |
| `lib/src/lib/session-types.ts` | Type definitions for persisted sessions (`PersistedPane`, `PersistedDoor`, `PersistedSession`) |
| `lib/src/lib/session-save.ts` | Serialization: collects layout, cwd, alert state for persistence (never scrollback) |
| `lib/src/lib/session-restore.ts` | Deserialization: loads saved session, calls `restoreTerminal()` for each pane |
| `lib/src/lib/reconnect.ts` | Priority-based recovery: live PTYs first, then saved session, then empty |
| `lib/src/lib/workspace-store.ts` / `workspace-union.ts` | The dormant in-memory Workspace model + container verbs, and the pure union projection |
| `lib/src/lib/window-persistence.ts` | The `PersistedSession` ⇄ `PersistedWindow` translation gated by the workspaces flag, plus the standalone key/value store seam |
| `lib/src/lib/resume-patterns.ts` | Detects an agent resume invocation in a live buffer — rightmost (newest) match in the tail window, rebuilt as invocation + captured id |
| `lib/src/index.css` | Lath host styling — `.lath-host` / `.lath-leaf` / `.lath-sash` / drop-preview layout and background flattening |
| `lib/src/theme.css` | Two-layer VSCode theme token system (`@theme --color-*` → `--vscode-*`) and Tailwind v4 `@theme` integration |

## Maintainer checklist

When changing layout behavior:

- Changing a command-mode binding or the mode-switch gesture: describe the behavior here **and** update the table in `docs/specs/shortcuts.md` in the same edit — that table is the only enumeration of the bindings.
- Pane-header changes: this spec owns placement and sizing only. Bell/TODO behavior and visual states belong to `docs/specs/alert.md`; the mouse-override icon and banner to `docs/specs/mouse-and-clipboard.md`; the derived label to `docs/specs/terminal-state.md`.
- Persisted-shape changes (`PersistedPane` / `PersistedDoor` / layout blobs) belong to `docs/specs/transport.md` — update it there.
- New pane chrome uses tokens from `lib/src/components/design.tsx` (see AGENTS.md Design); never raw color classes.
- Pane spawn/kill/tween motion is owned by the Lath animator (`docs/specs/tiling-engine.md` → "Animation"); layout.md owns only the interaction behavior around it.
- Anything workspace-strip or switching related stays under `## Future` (workspaces-rollout) until built.

## Future

**Scope: workspaces-rollout** — the remaining stages of the multi-Workspace feature. The model, container verbs, Window persistence (behind `dormouse.flags.workspaces`), and union projection are implemented but unwired — see [Workspaces](#workspaces) above; persisted containers in `docs/specs/transport.md`, union projection in `docs/specs/alert.md`. This ledger is the single home for what remains; other specs link here rather than restating it.

### Stage 3 — workspace strip and switching UI (standalone)

The standalone app bar (`standalone/src/AppBar.tsx`) grows a horizontal **workspace strip**: one tab per Workspace, living in the app bar's draggable region at the top of the window. Each tab shows the Workspace `name` and, for **inactive** Workspaces, the union `ringing` bell and `todo` pill from `docs/specs/alert.md`, reusing the Door indicator vocabulary. The **active** Workspace's tab shows no union indicator: its alerts are already visible on its own panes and doors. Exact tab visuals are settled in the Storybook UI pass.

Concrete switch/create/close/rename keyboard shortcuts are chosen alongside the Storybook UI pass. Command mode is the natural home for them, following the tmux *window* bindings the rest of the keymap mirrors (a Dormouse Workspace is the analogue of a tmux window). `docs/specs/shortcuts.md` lists them once bound.

### Stage 4 — real switching and multi-Workspace activation

Activating another Workspace (`switchWorkspace`) mounts the target Workspace's Surfaces into the Wall — rebuilding its Lath layout and reattaching its doors — and unmounts the previously active Workspace's Surfaces. For a terminal Surface this reuses the `mount` / `unmount` registry ops: the Registry entry and PTY survive `unmount`, so Process stays `Live`. A browser surface's backing agent-browser session or proxy grant likewise survives while its viewer resources are released.

Switching **parks** the outgoing Workspace's browser Surfaces rather than unmounting
them, on exactly the terms minimize already does (`docs/specs/tiling-engine.md` →
"Parked leaves"): the switch parks each one and then seeds the incoming Workspace's
tree, which `seed` is already written to survive — it keeps parked leaves except any
the seed itself admits. That is what makes an iframe survive a round trip through
another Workspace, and it is why the parked set is capped: a switch parks a whole
Workspace at a time, so `MAX_PARKED_SURFACES` may need raising (or becoming a
per-Workspace budget) once Stage 4 lands. Terminals keep the `mount` / `unmount` +
replay path. VS Code is out of reach either way — it maps each Workspace to its own
webview (see [Workspaces](#workspaces)), so cross-Workspace DOM survival there is
bounded by webview lifetime, not by anything the Wall does. Because a terminal's Activity keeps flowing while unmounted, an inactive Workspace's tab can begin ringing or showing TODO while the user is elsewhere. Mounting must not fire a fresh ring (glossary I8, mirroring the minimize/reattach rule I3).

Stage 4 also lifts the single-Workspace cap and wires the lifecycle UX:

- **Create** (`createWorkspace`): adds a new Workspace, gives it a default name (`Workspace N`), makes it active, and spawns a single fresh pane — matching the empty-state behavior in Session persistence above.
- **Close** (`closeWorkspace`): `kill`s each member Surface and removes the Workspace. Closing a Workspace that contains touched Surfaces confirms first (reusing the kill-confirm vocabulary); the exact confirmation surface is settled in the Storybook UI pass. The last remaining Workspace cannot be closed — there is always one active Workspace, just as there is always one visible pane (corner case #5).
- **Rename** (`renameWorkspace`): edits the Workspace `name` only. It does not touch any Surface title or the per-pane inline rename.

### Re-arming the WebGL renderer after context loss

A pane that loses its WebGL context (see [Renderer](#renderer)) stays on the DOM
renderer for the rest of its life, even once other panes close and free budget.
The eviction order is also backwards from what a tiling terminal wants: browsers
evict *oldest-first*, but the pane that most deserves the GPU is the focused one.

The fix is to retry `tryEnableWebglRenderer` when a DOM-fallback pane gains
focus. It is unbuilt because the naive version can thrash: past the context cap,
focusing panes in turn would evict and rebuild glyph atlases on every focus
change, which is plausibly worse than sitting still on the DOM renderer. Any
implementation needs a re-arm budget (e.g. at most once per pane, or a cooldown)
and a measurement showing focus-cycling does not regress. Not worth building
until someone actually runs a Window past the cap — 16 concurrent terminals in
one Window is well beyond observed usage.
