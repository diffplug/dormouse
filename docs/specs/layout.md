# Layout Spec

> See `docs/specs/glossary.md` for canonical state names, layer definitions, and transition verbs. This spec uses the glossary's vocabulary throughout.
>
> **Owns:** the interaction model on top of Lath — modes and keyboard dispatch, navigation, minimize/reattach, kill/rename, the selection overlay, session lifecycle + persistence recovery, and the workspaces-rollout ledger. Pane chrome: placement and sizing only.
>
> **Defers:** engine internals (split tree, rects, DnD, animator) to `docs/specs/tiling-engine.md`; alert/TODO/speech behavior and visual states to `docs/specs/alert.md`; per-Session semantic state (CWD, command lifecycle, title candidates, header derivation, grouping keys) to `docs/specs/terminal-state.md`; browser surfaces to `docs/specs/dor-browser.md`; selection/copy/paste and the mouse-override icon to `docs/specs/mouse-and-clipboard.md`; persisted shapes to `docs/specs/transport.md`; tokens to `docs/specs/theme.md`.
>
> **Convention:** "Session" where a statement is terminal-specific, "Surface" where it holds for both.

## Conceptual model

A Wall renders one Workspace's Surfaces as Panes in Content or Doors on the Baseboard. Pane↔Door preserves the Surface; a Doored browser Surface keeps its backing session while releasing its viewer resources (see [Minimize and reattach](#minimize-and-reattach)). The standalone Workspace strip and switching are staged in [Future](#future) (**Scope: workspaces-rollout**); VS Code maps each Workspace to a webview (`docs/specs/vscode.md`).

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

**The Wall owns** focus and selection state (`selectedId` / `selectedType`), the passthrough/command mode system, keyboard dispatch and selection-overlay rendering, the minimize/reattach/kill lifecycle, terminal lifecycle via the registry, Activity + TODO state, and session persistence. Its shared types and React contexts live in `lib/src/components/wall/wall-types.ts` / `wall-context.tsx`.

## Content

Each pane is one **leaf** in Lath's split tree — a stable, absolutely-positioned div that is **never re-parented**, so a moved `<iframe>` never reloads and a focused xterm never blurs. There is no tab stacking: one Surface per leaf, always. Splitting a pane inserts a sibling leaf; removing a pane collapses single-child splits back.

Panes are separated by a 7px gap (`PANE_GUTTER_PX`) — odd on purpose, so the 1px selection ring can center in it on whole pixels (see [Selection overlay](#selection-overlay)).

**Center drop = swap.** Dragging a pane onto the *center* of another swaps their Surfaces, exactly as `Cmd/Ctrl+Arrow` does (see [Spatial navigation](#spatial-navigation)). Dragging onto an *edge* band splits beside that leaf (or beside an ancestor column/row, chosen by scroll-wheel depth). The full DnD model — depth cycling, the preview-equals-commit rect, baseboard-drop minimize, door drag-out — lives in `docs/specs/tiling-engine.md` → "Hierarchical drag and drop"; the Wall owns only the op commit + selection policy (`onProposeMove` / `onProposeMinimize` / `onExternalDrop` in `Wall.tsx`). A baseboard drop is a no-op when `showBaseboard={false}` — there is nowhere to minimize into.

### Pane header

Each pane has a 30px header that doubles as a drag handle (a `pointerdown` on the header, past a 5px threshold, begins a Lath pane drag; below the threshold the header's own click behavior stands). The header uses `cursor-grab` / `active:cursor-grabbing`, `select-none`, and the shared terminal top radius from `lib/src/components/design.tsx`. Background and foreground use the `--color-header-active-*` / `--color-header-inactive-*` token pairs, which map to VSCode file-tree list colors.

Elements from left to right: the derived label; the alert bell; the TODO pill (compact+ tiers); a flexible gap; the mouse-reporting override icon (only when the inside program requests mouse reporting, compact+ tiers); split left/right, split top/bottom, and zoom/unzoom (full tier only); minimize; kill (hover turns error-red).

The label is the `DerivedHeader` from `deriveHeader(...)` (`docs/specs/terminal-state.md` owns the priority chain and the disambiguator rule). Layout renders the result: the primary label truncates with ellipsis, the secondary is shown muted beside it, and a failed last command appends an error-colored glyph. Click renames/pins; right-click — or `>` in command mode — opens the header context menu.

#### Header context menu

Right-clicking anywhere on the header opens the pane's single **context menu** at the pointer; `>` in command mode opens the same menu for the selected pane, anchored under the header's left edge (found via `data-pane-header-for`, then a synthetic `contextmenu` at that corner, so both paths share one code path). Browser surfaces and Doors have no header, so `>` no-ops there. Only the alert bell owns its own right-click (`stopPropagation`, opening the alert dialog); every other region — including the title span — bubbles to this one menu. It is portaled to `document.body`, viewport-clamped, and dismissed by outside `pointerdown`, `Escape`, `resize`, or capture-phase `scroll` — but **never by a scroll originating inside the menu**, since arrow-key focus moves auto-scroll the overflowing list.

Content, top to bottom:

- **Header row** — the current display title, the pane's `surface:N` handle (`resolveSurfaceRef`, muted), and a close button.
- **Title-candidates table** — the latest entry per `titleCandidates` channel as defined in `docs/specs/terminal-state.md`: channel, candidate text, timestamp; or a muted `No title candidates` line. Diagnostic only; it does not change the title priority rules.
- **Port rows** — the TCP ports the pane's process tree binds: a spinner while `getOpenPorts` runs (once per open — reopen to rescan), then one `host:port` row per distinct port (digit accelerator chip first, process name muted beside it), or a muted `no listening ports` / `port scan failed` line.

The menu owns the keyboard while open: it takes DOM focus on mount and restores the previously focused element when a dismissal leaves input ownership unchanged, and it registers as dialog-keyboard-active so command-mode keys don't fire underneath. `1`–`9` activate the corresponding port row; presses while the scan is still running are dropped, not buffered — the spinner explains why nothing happened. `↑`/`↓` rove focus across the port rows (wrapping), `Enter`/`Space` activate the focused row, `Tab`/`Shift+Tab` cycle every focusable element, and `Escape` closes.

Activating a port row (click, digit, or `Enter` on the focused row) reproduces `dor ab open <url>` for that port and closes the menu at once (`docs/specs/dor-browser.md` → Pane Context Menu Connect): the browser surface appears immediately and becomes the selection in passthrough (reattaching first if it was minimized) — the one command-mode gesture whose side effect moves selection off the pane it targeted and exits command mode — and loading/errors surface in the pane, not the menu. On hosts with no `agentBrowserCommand` the rows are inert labels with no digit chips, and digits do nothing. Only terminal panes have this menu. Source of truth: `PaneHeaderContextMenu.tsx`, `TerminalPaneHeader.tsx`, `handle-pane-shortcuts.ts`.

### Pane body

The pane body paints `--color-terminal-bg` on the React pane wrapper and the `TerminalPane` mount point; the persistent xterm host element, `.xterm-screen`, and the xterm scroll container also carry the concrete background from `getTerminalTheme()`. **The host background must match the terminal screen exactly** and clip to the pane's shared rounded bottom corners — xterm.js paints only its own rendered surface, and integer row fitting can leave a sub-row remainder at the bottom of the pane.

Source of truth: `lib/src/components/wall/TerminalPanel.tsx` and
`lib/src/components/TerminalPane.tsx`.

### Spoken-alarm overlay

A terminal Session with transient speech-delivery state gets a pointer-transparent overlay spanning its whole Lath leaf; browser surfaces never render it. It resolves through the tiling engine's per-leaf overlay slot (`docs/specs/tiling-engine.md`) and **must never intercept pointer/focus routing or change leaf geometry**.

It renders as **two layers straddling the header's stacking context** (`.lath-leaf-header` is `position: relative; z-index: 20`):

- **Wash + label at `z-index: 19`** — below the header, so the wash never tints the header band, where `--color-alarm-vs-terminal` (picked against the *terminal body*) carries no contrast guarantee; above terminal content; below the `z-index: 20` pane-corner mouse-override banner, which therefore stays untinted. Both states wash, `SPEAKING` at 20% opacity and `SPOKEN` at half that — `SPOKEN` is unbounded, so its haze has to stay readable-through for that whole window. **Never use color-alpha utilities here** — their emitted `color-mix()` path is unsupported by the standalone Safari 15 / Chrome 105 targets; the solid alarm color lives on a dedicated child whose element opacity supplies those strengths. The label sits `PANE_HEADER_HEIGHT_PX + 4` from the Pane top, centered, in both states.
- **Perimeter ring at `z-index: 25`** — above the header so the treatment still reads as one rounded rectangle around the whole Pane, below the `z-index: 30` sashes. An inset border at the leaf's edge covers nothing. 5px for `SPEAKING`, 3px for `SPOKEN`.

Header popovers are not a factor: every one (pane context menu, title candidates, notification preview, rename warning) portals to `document.body` with `position: fixed`, rendering in the root stacking context above the whole wall regardless of leaf z-indices.

Both layers wear the leaf's own rounding (header radius on top, terminal radius on the bottom). Under `SPEAKING` both pulse when motion is allowed and `cfg.alert.ringingPaused` is not set. Source of truth: `AlertSpeechIndicator.tsx`, registered as the `terminal` overlay by `LathHost.tsx`.

### Pane header responsive sizing

A ResizeObserver picks one of three tiers by header width:

- **Full** (>280px): everything.
- **Compact** (>160px): split, zoom, and unzoom hidden.
- **Minimal** (≤160px): also hides the TODO pill and the mouse-override icon, leaving alert, minimize, and kill. The label truncates with ellipsis.

## Baseboard

Below the content area is the baseboard (`h-7`, 28px). It is visible by default and has no top divider. The content area ends 2px above it, leaving a narrow theme-colored gap that keeps rounded pane corners distinct from the baseboard. Its horizontal padding matches the content wrapper's 7px inset, so doors align with the panes above. With no doors and more than 350px of width it shows a platform-aware shortcut hint — `LCmd → RCmd to enter command mode` on macOS, `LShift → RShift to enter command mode` elsewhere.

`Wall` accepts `showBaseboard={false}` for an embedder that exposes no door/minimize workflow: the strip is not rendered, the content wrapper's bottom inset grows from 2px to 7px, and a baseboard drop becomes a no-op. It is a seam, not a shipped configuration — no production host passes it (the mobile Pocket composition is a separate `MobileWall`, see `docs/specs/mobile-terminal-ui.md`), so the app shell always has a baseboard.

The far right of the baseboard is a single flex cluster, right-aligned as a unit: the `N more →` overflow arrow, then the host-supplied `notice` slot (standalone puts the update banner there), then three always-present 24px **Settings** controls. The first is a 16px speaker/slashed-speaker reflecting spoken alarms enabled/disabled; the second is a 16px ringing-bell/slashed-bell reflecting push notifications enabled/disabled; the third is the 16px sliders icon for the dialog itself. **Shape and accessible text both carry each state**, so status never relies on color. All three open the same app-global Settings dialog — alarms in `docs/specs/alert.md` → Alarm settings; the status controls do not toggle settings directly. Every baseboard-level button shares one class constant in `Baseboard.tsx`. Only the cluster's always-present part is measured and subtracted from the door-fitting budget below: **never measure the overflow arrow into it**, since its presence is an *output* of that fit.

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

Source of truth: `lib/src/components/Baseboard.tsx` and
`lib/src/components/Door.tsx`.

## Workspaces

The standalone Window hosts several Workspaces but mounts only one — the **active** Workspace — at a time. Each Workspace owns its own Content (Lath layout) and Baseboard (doors). The union status is `docs/specs/alert.md`'s; VS Code's per-webview mapping is `docs/specs/vscode.md`'s.

What exists today: the in-memory model and its container verbs (`createWorkspace` / `closeWorkspace` / `renameWorkspace` / `setActiveWorkspace` in `lib/src/lib/workspace-store.ts`), the union projection (`computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`), and Window persistence — the only thing the `dormouse.flags.workspaces` flag (`WORKSPACES_FLAG_KEY` in `lib/src/lib/feature-flags.ts`, **off by default**) actually gates: `lib/src/lib/window-persistence.ts` is an identity passthrough with the flag off, so the standalone host stores a bare `PersistedSession`, and wraps/unwraps a `PersistedWindow` with it on (`docs/specs/transport.md`). VS Code never goes through it. No production code calls the container verbs yet and `setActiveWorkspace` does not re-render the Wall, so the app runs exactly one implicit Workspace either way.

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

Two consequences of that order: a rename input suppresses the pane shortcuts but **not** the mode-exit gesture or the field's own clipboard chords; and a staged kill confirmation hijacks *every* key before the dialog gate, so the confirm letter works even though the modal is open.

### Split cwd inheritance

A split initiated from an existing pane (`|`/`%`/`-`/`"` or the header split buttons) spawns the new pane with its source pane's last-known cwd, then selects it and enters passthrough. Host New Terminal actions use the same focus tail. Repeated layout construction therefore requires re-entering command mode between manual splits. Focus-neutral control-plane creation (`dor split -- …`, `dor ensure`, `dor iframe`, `dor ab`) retains its documented background behavior.

The source cwd is read from `getTerminalPaneState(sourceId).cwd`. **Never inherit a remote cwd** (`isRemote === true`, e.g. an OSC 7 path reported over ssh) — it is not a usable local spawn cwd. The host default applies when the source cwd is unknown, remote, or absent (initial pane creation). The inherited cwd rides through `setPendingShellOpts` alongside the inherited shell selection and is consumed by `getOrCreateTerminal` on the next `platform.spawnPty`.

### Kill confirmation

Pressing `x`/`k` (or clicking the kill button, which first leaves passthrough) shows a pane-centered semi-transparent overlay (`KillConfirmOverlay` → `KillConfirmModal`) with a random lowercase letter — both kill shortcuts (`x` and `k`) are excluded from the alphabet so a double-tap can't accept itself. Typing that letter confirms the kill. `Escape`, the `Esc to cancel` button, and clicking another panel all cancel. Any other key triggers a 400ms `shake-x` animation and then auto-dismisses.

**Confirmation must be staged in a ref synchronously, not only in React state** — a second confirm keydown arriving before React flushes would otherwise pass the guard and kill twice (`lath.isDying` is the second line of defense). Source of truth: `acceptKill` in `lib/src/components/Wall.tsx` and the modal in `lib/src/components/KillConfirm.tsx`.

**Only untouched plain terminals skip this confirmation.** A new shell starts `untouched: true`; the first user-originated PTY input flips it to false. Inputs that count: printable keys, Enter, control keys, keyboard CSI such as arrows/history, paste, and file-drop path insertion. Replay-shaped terminal reports and stripped mouse-report-only input do not count (the untouched gate checks `inputIsReplayTerminalReport`; the broader synthetic-report check gates input recording and alert attention, not this flag). Killing one runs the normal kill animation/dispose path immediately; killing its door first reattaches only far enough to reuse that path, then kills it without an overlay. Tools track untouched but never take this fast path; they may own live resources before input (`docs/specs/dor-tool.md` → "The tool capability set").

## Selection overlay

A fixed-positioned element rendered on top of the Lath host. Covers the active element's area inflated by `SELECTION_RING_INFLATE_PX` (4px) for panes; doors are not inflated. The inflate is derived in `lib/src/components/design.tsx` so both ring strokes center on the gutter's midline: the 1px passthrough border spans [3px, 4px] from the pane edge — dead center of the 7px gutter, on whole pixels because the gutter is odd.

- Exactly one pane or door is **active** at a time. One SVG renderer (`SelectionRing`, `variant: 'ants' | 'solid'`) draws both modes.
- **Passthrough:** `variant='solid'` — a 1px solid SVG stroke, centerline `strokeWidth/2` inside the div edge for both panes and doors, no glow (rationale).
- **Command:** `variant='ants'` — animated marching-ants border (`cfg.marchingAnts`: 10px segment, 60% dash / 40% gap, 0.4s cycle, 2px stroke). Unchanged while the ring travels; the motion smear is a separate layer behind it (see [Ring travel](#ring-travel)). The animation pauses while the window is unfocused, and the whole ring drops to `saturate(0.3)` then.
- Border radius follows DESIGN.md's Concentric-Corners Rule: the pane ring's rect is inflated by `SELECTION_RING_INFLATE_PX`, so its radius is the pane radius plus that offset (`PANE_SELECTION_RING_RADIUS_PX`, with the marching-ants path inset so its stroke centerline sits on the same gutter midline, concentric with the pane corner); doors sit at zero offset and keep `0.5rem 0.5rem 0 0`.
- Color is the resolved `--color-focus-ring`, re-read whenever `document.body`'s class/style changes because the dynamic palette publishes it there (`useFocusRingColor`).
- `z-index: 50`, `pointer-events: none`.

### Ring travel

The ring's rect (and its `{tl,tr,br,bl,inset}` shape) is driven **per-frame by a JS tween**, not a CSS transition — the tween writes true interpolated values each rAF frame, the same pointer-events-none carve-out the Lath animator holds (DESIGN.md's "don't animate layout properties" bans CSS transitions on layout props, not this). Motion is `FOCUS_MOTION_MS` (220ms — half `LATH_MOTION_MS`) on the house curve `cubic-bezier(0.22, 1, 0.36, 1)`. Source of truth: the pure tween core `lib/src/lib/rect-tween.ts` (position and velocity); the pure outline/smear geometry `lib/src/lib/ring-geometry.ts`; the overlay's rAF loop in `WorkspaceSelectionOverlay.tsx`; the SVG shell `lib/src/components/wall/SelectionRing.tsx`.

Per-frame writes are **imperative** — the same React-owns-structure / frame-owns-mutations split LathHost uses for the animator. `SelectionRing` renders a stable shell once (per variant/color/focus change) and lifts its DOM nodes (container div, ring path, smear group) back to the overlay via refs; the rAF loop writes rect, path `d`, marching-ants dash, and every smear piece's `d`/width/opacity directly, then re-applies once after any structural render (pre-paint, so a freshly mounted ring never flashes). **Never reintroduce per-frame React state** — reconciling this subtree every frame competes with the travel for the frame budget.

- **Identity change → tween.** When the incoming measurement's identity (`${selectedType}:${selectedId}`) differs from the one on screen, the ring glides from its current interpolated position to the new target, clock restarted (arrow-key spam stays responsive).
- **Same identity → snap 1:1.** A same-identity re-measure with no tween in flight (sash drag, window resize, a settled leaf's store commit) writes the new rect directly — the ring tracks the geometry exactly instead of easing behind it.
- **In-flight retarget.** A same-identity re-measure *during* a tween retargets the destination without resetting the clock, so the ring converges on a moving target (select-a-neighbor-during-kill) and still lands on the original completion instant.
- **Snap gate.** `motionIsInstant()` — `!cfg.layout.animate` (Chromatic) or `prefersReducedMotion()` — settles the ring instantly, the same predicate the Lath animator's duration uses, so ring and leaves agree. A ring appearing with nothing on screen also snaps: there is no `from` to glide from.
- **The unfocus-saturate fade is the one CSS transition** (`filter ${FOCUS_MOTION_MS}ms`, set inline by `SelectionRing.tsx`); neither the snap gate nor reduced motion touches it. Under Chromatic it snapshots already finished (pinned in `lib/.storybook/preview.ts`).
- Pane↔door selection morphs the corner radii (12px all-round ⇄ `8,8,0,0`) and stroke inset through the same tween, so the shape lerps instead of popping.

#### Directional motion smear

While travelling, each ring edge trails a soft band sized by its own motion. A line smears only by moving *across* itself — sliding along its own length leaves it unchanged — so **a horizontal edge is driven by its vertical speed and a vertical edge by its horizontal speed, and all four edges are independent.** Each speed normalizes against `cfg.focusRing.smearFullSpeed` into a single `t`; width ramps from `strokeWidth` to `smearMaxPx` and alpha from 0 to `smearPeakAlpha`. Both start at zero, so a stationary edge contributes nothing rather than laying a band under the crisp ring. A settled or reduced-motion ring has null speeds and the smear layer is `display: none`, keeping snapshots deterministic. Source of truth: `lib/src/lib/ring-geometry.ts`.

- **Velocity is analytic, and the smear peaks on the opening frame.** `sampleRingVelocity` differentiates the tween (`E'` from `LATH_EASING.slope`), so the blur peaks exactly where the ease-out is fastest — frame one — and is jitter-free by construction, needing no smoothing. **Never finite-difference rendered positions**: frame one has no previous sample, and a backward difference under-reports any decelerating curve (rationale).
- **Extent and intensity are independent.** Alpha is *not* divided by the widening factor: ink conservation would tie peak alpha to extent, making the effect impossible to strengthen by widening. `smearFullSpeed` sets the shape over a travel — low values pin nearly every move at full smear, high values make blur track speed.
- **Per-edge, not per-axis.** Never collapse the four edge speeds to one horizontal and one vertical (e.g. from the ring *centre's* velocity): edges of the same ring move differently at the same moment, and an averaged speed is wrong for every one of them (rationale).
- **Two layers, because the geometry is incompatible.** The ring is one closed path so the dash phase runs unbroken around the perimeter, and SVG `stroke-width` is a single scalar, so that path cannot carry four widths. The smear is a sibling `<g data-ring="smear">` of eight pieces drawn underneath; **the ring (`<path data-ring="outline">`) is never transformed, re-dashed, or re-alpha'd.**
- **Eight pieces: four edges plus four corners.** A straight edge carries its width in a plain `stroke-width`; a corner must reach two widths at once, so it is stroked at unit width under `transform: scale(a, b)` — `a` the vertical neighbour's width, `b` the horizontal neighbour's — and `cornerPath` pre-divides the arc by the same pair so the on-screen curve is unchanged (the taper mechanism is documented at `cornerPath`). Opacity cannot vary along a stroke, so a corner takes the mean of its two edges'. Every piece is cut from ONE shared point set (`ringPoints`), which `roundedRectPath` also walks, so the smear provably tiles the ring — pinned by `ring-geometry.test.ts`. **Find each piece by `data-piece`, never by index.**
- **Dash length is computed, not measured.** `ringPerimeter` returns the outline's exact length in closed form — straight runs plus `1.6232252401402307 × r` per corner, the arc length of the *quadratic* quarter-turn the path actually draws. Do not substitute `π/2` (the quarter-*circle* value — 3% short, silently shifting every dash), and do not reinstate `SVGGeometryElement.getTotalLength()`, which forces a synchronous style+layout flush on every frame (rationale).
- **The smear replaced an SVG `feGaussianBlur`. Do not go back**: WebKit CPU-rasterizes SVG filters every frame, and the cost is SVG filters specifically, not blur — stroke widths, scale transforms, opacities, and CSS `filter: blur()` are all GPU-composited and free (rationale).

### Position tracking

Each pane body registers its DOM element in a `paneElements` Map on mount and removes it on unmount (`usePaneChrome`); the overlay resolves the enclosing Lath leaf (`[data-lath-leaf]`) via `resolvePaneElement` so the ring covers the full leaf (header + body). Doors are registered by the `Baseboard` through `DoorElementsContext` (`[data-door-id]`), and only the *visible* subset — an overflowed door has no element to measure.

Re-measures on: selection change, `ResizeObserver` on the target, every Lath store commit (`revision` via `useSyncExternalStore`), and — while the wall streams animator frames — every frame, so the ring tracks kills, restores, and tweens frame-accurately. If the selected leaf is momentarily absent the overlay bails and holds the last rect.

Source of truth: `lib/src/components/wall/WorkspaceSelectionOverlay.tsx`,
`lib/src/components/wall/resolve-pane-element.ts`, and the window-focus
tracking in `lib/src/components/wall/use-window-focused.ts`.

## Spatial navigation

Arrow navigation resolves against Lath's pure `neighbors(tree, rect, id, direction, opts)` query — no DOM rect scanning; it computes against the same laid-out rects the screen shows (`docs/specs/tiling-engine.md` → "Layout"). The keyboard handlers reach it through the engine-neutral `WallNav` seam (`lib/src/components/wall/keyboard/types.ts`), whose `findInDirection` calls `lath.store.neighborOf`: a candidate must be strictly beyond the leaf's edge on the primary axis; one overlapping on the secondary axis is preferred; ties break on nearest edge-to-edge distance, deterministically; with no overlapping candidate the nearest non-overlapping one wins.

**Back-navigation.** A breadcrumb tracks the last navigation direction and origin pane; pressing the opposite direction returns to the origin instead of doing a spatial lookup. This is what makes asymmetric layouts (tall pane left, stacked panes right) navigate reversibly.

**Pane↔door.** Down from a pane with no pane below it selects the *first* door; Up from a door selects the *last* pane; Left/Right moves between doors. Doors have no spatial query — they are an ordered list.

**`Cmd/Ctrl+Arrow` swap.** Swaps Surface **content** between two panes; the layout shape is unchanged. One Lath `swap` op trades the two leaf identities, and because per-leaf metadata and terminal-registry entries are keyed by id, title/params/session follow automatically — **never write a companion title swap**, and there is no DOM reattach. Selection stays on the moved Surface, so the breadcrumb records the *partner* (the pane now holding the old slot): the opposite `Cmd+Arrow` swaps back exactly and a plain opposite arrow selects the partner.

## Minimize and reattach

### Minimize (`m`/`d`, the header button, or a drag onto the baseboard)

`lath.store.doorLeaf(id, { park })` detaches the leaf and returns a JSON-serializable **restore token** (`docs/specs/tiling-engine.md` → "Restore tokens"); the Wall appends `{ id, token }` to its `doors` state and moves selection to the new door in command mode. The Session stays in the registry — nothing is disposed. If this was the *last* pane, the auto-spawn effect fills the emptied Wall while the door keeps selection. A pane dragged onto the baseboard takes the identical path (`onProposeMinimize` → `minimizePane`).

**A runtime Door is `{ id, token }` and carries no metadata.** Everything else — title, params, whether the leaf is parked — stays in the Lath store, which keeps changing while the Surface is Doored, so there is no copy to go stale: reattach, `dor` param matching, kill/session teardown, `dor list`, the baseboard chip's label and the session save all read `lath.getMeta(id)`, and the persisted `PersistedDoor` row is materialized from the store at save time.

**A minimized browser Surface parks rather than unmounting** (`shouldParkOnMinimize`): its state lives in the DOM — an `<iframe>`'s document, a screencast canvas — so a plain remove would destroy it and reattach would be a reload. Terminals do not park; their state is in the PTY and the registry replays it. Parking spans the minimize only — a restart still cold-loads every browser Surface from its persisted URL. `docs/specs/tiling-engine.md` → "Parked leaves" owns the mechanism, the `MAX_PARKED_SURFACES` cap, and the visibility contract.

### Reattach (click door, `Enter`/`m`/`d` on door, or drag out)

`lath.restoreLeaf(meta, token, { fallbackRef })` applies the token's three-tier exact/neighbor/fallback policy (`docs/specs/tiling-engine.md` → "Restore tokens"). The Wall supplies the fallback reference — the selected pane if it is live, else the first pane — and, if the restore still fails (no token, empty tree), adds the leaf as the root so a reattach can never be silently swallowed.

A door dragged out of the baseboard skips the token entirely and inserts at the hit-tested drop position the user chose (`onExternalDrop` → `lath.insertLeaf`). Either path unparks a parked Surface in the same commit that re-admits it, so the DOM is never momentarily unmounted.

### Splitting from a Door

`dor split --surface <minimized-ref>` and `dor ensure --surface <minimized-ref>`
**create the new terminal Surface directly as a Door** rather than rejecting the
reference or restoring it first. It is inserted immediately to the right of the
reference Door, and the response reports `minimized: true` even when the caller
did not pass `--minimize`. Its restore token's neighbor tier points at the
reference Door, so restoring the new Door can still split beside the reference
if that was restored first. `--auto` resolves to `right` for a Door reference —
there is no visible pane geometry to inspect.

## Inline rename

Triggered by pressing `,` in command mode or clicking the session name in the pane header.

The name `<span>` is replaced by an `InlineEditInput` (shared with the browser URL editor in `docs/specs/dor-browser.md`): same font (`font-mono font-medium`), `bg-transparent`, no border, seeded from the label with the failure glyph stripped. `Enter` confirms, `Escape` cancels, `blur` confirms — whichever lands first settles the edit, so the blur that follows an Enter/Escape unmount cannot submit a second time. It stops propagation on `mousedown`/`click`/`keydown` so the panel click and the header drag never fire.

The field is **controlled by its own draft state**, seeded at mount and untouched by later prop changes, and the `select()` ref callback has a stable identity so it runs exactly once — pane headers re-render constantly, and an editor that re-derived its value on those renders would fight the user mid-word (rationale). Mounting is the reset: the editor exists only while the pane is being renamed, so each rename starts from the current label.

Clipboard chords inside the field are the wall's job on hosts whose webview has no native Edit menu — see `docs/specs/mouse-and-clipboard.md` §8.9.

Submitted values are rejected when empty or when they fail the `setTerminalUserTitle` validation that also guards title seeding — no titles starting with the `<idle>` sentinel (`docs/specs/transport.md`). `<unnamed>` is the default panel placeholder but is otherwise allowed as a user pin. **On rejection the input still closes** (it is not a blocking dialog) and a small warning popover anchored under it names the offending value. The popover dismisses on the next pointerdown, scroll, resize, `Escape`, or after `cfg.overlays.warningAutoDismissMs` (3s); that delay is 0 under Chromatic (pinned in `lib/.storybook/preview.ts`).

Source of truth: `lib/src/components/wall/IllegalRenameWarning.tsx` and
`lib/src/components/wall/use-dismiss-overlay.ts`.

## Session lifecycle and terminal registry

For a terminal Surface the pane ID is its session ID. `TerminalPane` calls `getOrCreateTerminal(id)` on React mount and `unmountElement(id)` on React unmount. The session (xterm.js instance, PTY, DOM element) persists in the registry across mount/unmount cycles; an unmounted element leaves the entry `Orphaned`. A browser surface's pane ID is a Surface id with no registry entry or PTY (`docs/specs/glossary.md`); its DOM is hosted by LathHost's leaf div and it is reconstructed from persisted params, not from the registry.

- **Create**: `getOrCreateTerminal` spawns xterm.js + UnicodeGraphemesAddon + FitAddon + PTY, returns existing if already created. The xterm instance sets `allowProposedApi: true` because UnicodeGraphemesAddon activates through xterm's proposed Unicode API. The WebGL addon is *not* loaded at create — it is claimed lazily on the session's first mount (see "Renderer" below).
- **Resume**: `resumeTerminal` creates xterm entry and writes replay data without spawning a new PTY. Used when the webview is recreated while the host retains Live PTYs (Link: Severed → Resuming → Live).
- **Restore**: `restoreTerminal` creates xterm entry and spawns a new PTY with the saved cwd. It replays no transcript — scrollback is not persisted (`docs/specs/transport.md` → "What is persisted"). Used on cold start from a saved Snapshot (Link: Cold → Live).
- **Agent resume**: a restored pane the host captured a resume invocation for re-runs it automatically. See "Agent resume on cold restore" below.
- **Untouched**: new `getOrCreateTerminal` sessions start untouched. `isUntouched(id)` exposes the flag, and user-originated PTY input clears it via the registry input paths. Resume/restore seed the persisted flag; missing legacy snapshot data defaults to touched (`false`) so close confirmation remains conservative.
- **Shell selection replacement**: the standalone Settings dialog's Shell row and the VS Code shell picker send `dormouse:new-terminal` with `replaceUntouched` when the selected shell type changes. **A shell is identified by executable path plus ordered arguments**, so WSL distributions and Windows Developer shells sharing an executable stay distinct. `Wall` always mints a new session id and a fresh `surface:N` ref. If an untouched plain-terminal pane or door is selected, the new terminal takes over its leaf via a Lath `replace` op (an atomic identity swap; doors first reattach through the normal restore path), the old session is disposed, and its ref is retired. Tools are never shell-replaced. If the selected terminal is touched or nothing is selected, the request spawns a new pane beside the selection. Announced spawns show a transient pane-anchored notice such as `Switched to zsh` or `Opened bash`.
- **Replay-time terminal reports must be dropped; user input must not be.** During **resume** replay xterm.js may emit replies to OSC/CSI/DCS queries embedded in buffered output, and the registry drops those before they reach the new shell. The filter covers query/focus reports only — never arrows, function keys, or bracketed paste.
- **mount / unmount (DOM)**: `mountElement` reparents the persistent DOM element into a container; `unmountElement` removes it. The Registry entry survives.
- **Dispose**: `disposeSession` kills the PTY, disposes xterm, removes the registry entry. Only called on explicit kill (`x`).
- **Swap**: `Cmd/Ctrl+Arrow` trades two leaf identities via a Lath `swap` op; registry entries follow the ids (see [Spatial navigation](#spatial-navigation)).

Source of truth: the registry maps and pending shell opts in `lib/src/lib/terminal-store.ts`, imported directly (including by `lib/src/remote/host/`); the lifecycle ops in `lib/src/lib/terminal-lifecycle.ts`, re-exported with the shared types through the `lib/src/lib/terminal-registry.ts` facade.

### Agent resume on cold restore

On cold restore, a terminal pane with a host-captured recovery invocation runs it automatically; `docs/specs/transport.md` owns the restore-only gate, validation, and prompt-ready typing. Layout writes one dim `⟲ resuming agent session: <command>` line to xterm, never the PTY, to mark the discontinuity; it is a passive notice with no dismiss or lifecycle. Source of truth: `restoreTerminal` in `lib/src/lib/terminal-lifecycle.ts`, called from `lib/src/lib/session-restore.ts`.

### Renderer

Every terminal renders through stock `@xterm/addon-webgl`. **Claim the GL context on
a session's first `mountElement`, never at creation**, guarded by
`TerminalEntry.webglAttempted` so each session claims at most one — cold restore
builds a session for every persisted pane *including minimized doors*, which never
paint, and the context budget evicts oldest-first and one-way (rationale).
**xterm's built-in DOM renderer is the fallback, never the default** — its per-cell
span rebuild makes a truecolor-dense TUI slower than WebGL by an order of magnitude
(rationale).

**Fallback to the DOM renderer must stay automatic** — two failure modes are
expected in the field:

- **No WebGL at all** (headless/jsdom, blocklisted GPU, a host webview with GPU
  disabled). Construction throws; `tryEnableWebglRenderer` swallows it. A
  `typeof WebGL2RenderingContext === 'undefined'` pre-check skips the doomed
  request entirely so unit tests don't log a `getContext` failure per terminal.
- **Context-budget eviction.** Browsers cap live WebGL contexts per page — on
  the order of **16**, evicted oldest-first (rationale). One context per
  terminal means a Window past the cap silently drops its *oldest* panes back
  to the DOM renderer. The `onContextLoss` handler disposes the addon, which
  is xterm's documented signal to resume DOM rendering.

Degradation is never worse than the pre-WebGL behavior, but it is one-way: a
demoted pane stays on the DOM renderer even after other panes close. Re-arming
after a loss is unbuilt — see `## Future`.

The outcome is recorded as `data-renderer="webgl"|"dom"` on the host element, so it
is inspectable rather than silent — including after a context loss demotes a pane.
`cfg.terminal.webglRenderer` disables the whole path, and it is off under Chromatic
(pinned in `lib/.storybook/preview.ts`).

Source of truth: `tryEnableWebglRenderer` in `lib/src/lib/terminal-lifecycle.ts`.
Not to be confused with the SDF fork in `docs/specs/webgl-text.md`, which is a
different addon consumed only by `canopy/`.

### Session persistence

Layout, cwd, minimized items, user-pinned titles, untouched state, and alert state are saved to persistent storage via a debounced save (500ms). **Scrollback is never persisted** (`docs/specs/transport.md` → "Retiring the transcripts already on disk"); a transcript in a pre-upgrade blob is scrubbed on read. The layout persists as the native Lath format (`lathLayout`; `docs/specs/tiling-engine.md` → "Persistence"). **Derived command/app labels on minimized doors are display-only** — never persisted as user-pinned titles.

Three save triggers, in ascending urgency:

- Every Lath store commit (add/remove/resize/swap/meta, including the active pane the layout records) **schedules** the debounced save.
- Content changes (terminal output, activity/TODO, pane title/command state, minimized-door changes) only **mark the session dirty**; a 30s heartbeat persists only when dirty, so an idle app stops writing.
- PTY exit, `pagehide`, and extension shutdown requests **flush immediately and unconditionally** — the correctness net for any dirty-trigger gap.

The dirty-gating mechanism and the store-level identical-value backstop are specified in `docs/specs/standalone.md` §Persistence.

In standalone, with `dormouse.flags.workspaces` on, each Workspace's snapshot is wrapped in a Window snapshot that records every Workspace (name + layout) and which one is active, so all Workspaces — not just the mounted one — survive a restart; with the flag off (the default) the store holds a bare `PersistedSession` (see [Workspaces](#workspaces)). VS Code persists one Workspace per webview exactly as today (one snapshot per `WebviewView` / `WebviewPanel`). The persisted container types (`PersistedWorkspace`, `PersistedWindow`) live in `docs/specs/transport.md`.

Saved snapshots are read through `readPersistedSession()`, which accepts the canonical object shape and defensively parses a JSON-stringified blob before validation (some hosts hand back serialized JSON, not the parsed object). **A present-but-unreadable blob is logged and discarded**, so malformed storage starts fresh rather than blocking startup.

On startup, recovery is priority-based:
1. **Resume** (webview hidden/shown, live PTYs): request PTY list + replay data from platform, `resumeTerminal()` for each (500ms timeout). Saved pane and door titles are seeded back via `setTerminalUserTitle()` (see `docs/specs/transport.md`) so persisted placeholder labels never replay as user pins. If the saved session covers every live PTY, restore the saved Lath layout when its leaf set matches and reattach saved minimized items as doors. **Never fall through to cold restore just because the visible `paneIds` list is empty** — a wall whose live sessions are all minimized is still a live resume.
2. **Restore** (app restart, cold start): the Wall's `seed` hydrates from the restored Lath layout, else falls to (3); `restoreTerminal()` for each pane with its saved cwd and title, spawning each PTY with the current default shell selection. Browser surfaces are rebuilt from their persisted params instead.
3. **Fallback/manual pane creation**: when no saved layout can be safely applied, add multiple panes as splits from the previous pane, and spawn each PTY with the current default shell selection
4. **Empty state**: create a single new pane with the current default shell selection

Source of truth: `lib/src/components/wall/use-session-persistence.ts` (save triggers and flushes), `lib/src/lib/session-save.ts` (serialization), `lib/src/lib/reconnect.ts` (recovery priority).

### Activity state

Each Surface carries an `ActivityState` (`status`, `watchingEnabled`, `todo`, `notification`). Layout's stake: the store is synced to React via `useSyncExternalStore`, and state arriving from the platform *before* a registry entry exists (the resume path) is staged as **primed state** and merged in when the entry is minted — a browser surface, which never gets a registry entry, keeps its activity in a parallel local map instead.

Each terminal Session also carries `TerminalPaneState` from `docs/specs/terminal-state.md`. That store is keyed by pane/session id, and PTY-originated semantic events are resolved through `ptyId`, so a swapped session keeps its CWD and command state with the terminal content.

Source of truth: `lib/src/lib/session-activity-store.ts` (the React snapshot store and the primed-state merge).

## Theme

The Lath host styling lives in the `.lath-host` / `.lath-leaf` rules in `lib/src/index.css`: an app-bg host and a terminal-bg body. Each leaf has a 30px header band applied by LathHost from the shared `PANE_HEADER_HEIGHT_PX`. The content area uses a 7px top/sides inset and 2px bottom inset (`px-1.75 pt-1.75 pb-0.5` on wrapper, `inset-x-1.75 top-1.75 bottom-0.5` on container); the `LATH_LAYOUT_OPTS` gap of `PANE_GUTTER_PX` is the only visual separator between panes.

The Lath host paints `var(--color-app-bg)` so gutters and rounded pane/header corner cutouts match host chrome. Terminal content backgrounds are painted by the React terminal wrappers and xterm host elements, not by the leaf containers. The two-layer `@theme --color-*` → `var(--vscode-*)` token strategy is `docs/specs/theme.md`'s.

## Animations

All pane motion is owned by the Lath **animator** — a pure function of time that turns committed layout changes into interpolated frames, applied imperatively to the leaf divs by LathHost (`docs/specs/tiling-engine.md` → "Animation"). Default motion is 440ms `cubic-bezier(0.22, 1, 0.36, 1)`; under reduced motion the animator runs the same code with a 0 duration (instant). The selection overlay measures the leaf divs, which carry the interpolated inline geometry, so `getBoundingClientRect` tracks the tween frame-accurately. There are no CSS entrance/exit classes. **Terminal panes do not refit every frame:** `TerminalPane`'s resize observer throttles `refitSession` (leading edge, at most one per ~150ms while resizes keep arriving, plus a trailing call at rest), so a motion or sash drag costs a handful of xterm reflows and PTY resizes instead of one per animated cell-boundary crossing, while the resting geometry still gets an exact fit.

### Zoom (elevated expansion)

Zoom is presentation-only — the split tree and every tiled rect stay unchanged, and the geometry (the 15px-inset wall rect, the elevated layer, the blurred app-bg halo) belongs to `docs/specs/tiling-engine.md` → "Layout" / "Animation". **Zoom is coupled to passthrough focus**: acquiring it enters passthrough and focuses that pane; exiting passthrough, focusing another pane, or selecting a Door starts unzoom immediately.

Only the owner's header shows Unzoom, with its header tokens inverted so the escape action stands out, and only the owner's control toggles zoom *off*. The exposed perimeter leaves other headers reachable, so their Zoom control **hands zoom over — focus included** — rather than merely unzooming the owner. Source of truth: focus/zoom orchestration and `ZoomedIdContext` in `lib/src/components/Wall.tsx`; `paneZoomButtonClass` in `lib/src/components/design.tsx`.

### Spawn (new pane reveal)

A newly added leaf enters by growing from the boundary it was placed against, at opacity 0 → 1 (a split to the right grows from its left boundary, and so on). The store's mutators derive this **enter hint** from the edge they commit; the auto-spawn refill overrides it to `'top-left'` (the killed last pane shrank toward the bottom-right, so the refill grows from the opposite corner). See `docs/specs/tiling-engine.md` → "Animation" → Enter.

Shell-selection replacement shows a short fixed-position notice over the resulting pane. The notice fades in/out over 1500ms via `.shell-spawn-notice` and is suppressed to a static render for reduced-motion users.

### Kill (two-phase fade + tween reclaim)

`killPaneImmediately` in `Wall.tsx` runs the animator's two-phase exit — fade in place, then commit the removal after `lath.exitMs` so survivors tween into the reclaimed space. The mechanics, the idempotence guard, and the last-pane bottom-right shrink belong to `docs/specs/tiling-engine.md` → "Animation" → Exit.

**Selection tail.** At removal time selection moves to a survivor (`lath.listPanes()[0]`, or `null` → auto-spawn when the last pane goes) **only when the killed pane is still the selected pane** — the check is live, re-read inside the removal timeout. So a background kill leaves the user's selection untouched, and a selection move *during* the fade is honored both ways: navigate away from a dying selected pane and the tail no longer yanks selection; navigate onto a dying pane and the tail adopts a survivor instead of leaving selection dangling. The header kill button is always a selected-pane kill (clicking the header selects the pane before the button's click handler runs); the not-selected cases are `dor kill` of a background surface and ensure's throwaway teardown.

A **doored** Surface has no visible pane to fade, so `killPaneImmediately` takes a separate branch: close any agent-browser session, `forgetLeaf` (which also unmounts a parked DOM), `disposeSession`, drop the door chip. Disposing stops the PTY, which is also what makes a still-armed `typeCommandWhenPromptReady` bail rather than type into a dead surface.

### Auto-spawn refill

A store commit that empties the tree (last pane killed or minimized) triggers the "always keep one pane visible" auto-spawn: a Wall effect subscribed to the store spawns one leaf into the emptied tree (`lib/src/components/Wall.tsx`). It fires re-entrantly on the same commit chain, so the refill appears without a separate delay; the killed pane's fade already sequenced the removal. The refill spawns with the current default shell selection, matching manual splits.

**The refill adopts the replacement (`selectPane`) only when the current selection points at nothing real** — null (the kill tail cleared it after a selected last-pane kill) or dangling (still naming the just-removed pane). A *valid* selection is left alone — the just-created door on the minimize path, or a live pane after an unselected kill — because the auto-spawn exists to keep a pane visible, not to steal selection.

## Corner cases

> Numbered for cross-spec reference; the numbers are stable, so append rather than renumber.

1. **xterm steals Meta keys**: the mode-exit gesture listens in the capture phase, so it fires even while xterm has DOM focus.
2. **A focused iframe surface is not a window blur**: it blurs the window while `document.hasFocus()` stays true. Cross-session attention is cleared only on a *real* blur, or focusing an embed would wipe attention across the Wall.
3. **Stable hitboxes across moves**: each pane body registers its DOM element in `paneElements` (`usePaneChrome`), and the selection/kill overlays resolve the enclosing `[data-lath-leaf]` from it, so a leaf measured after a move reports its new rect. Lath never re-parents a leaf div, so its node identity — and any embedded `<iframe>` — survives every op: no re-parent blur to heal, no iframe reload.
4. **Asymmetric back-navigation**: the breadcrumb (see [Spatial navigation](#spatial-navigation)) makes every arrow move reversible even when no spatial query would return you.
5. **Door keeps selection through the auto-spawn refill**: minimizing the last pane selects the new door, then the refill fills the emptied Wall without stealing selection (see [Auto-spawn refill](#auto-spawn-refill)). Explicit user selection of a pane — a click, a drag, or an embed focusing itself — still moves selection off a door.
6. **Focus-neutral surface creation (`dor ensure` / `dor iframe` / `dor ab`)**: unlike `dor split`, these open in the background without moving focus off the caller (`docs/specs/dor-cli.md`, `docs/specs/dor-browser.md`). Under Lath this is inherent — an add never re-parents the caller's subtree or steals activation, and the create simply does not call `selectPane` (`settleAddSelection` returns false for a focus-neutral, non-selection-replacing add). The one exception: `dor iframe` / `dor ab` replacing the pane the user is *currently selected on* moves selection to the replacement (else it would dangle on the removed leaf); replacing any other pane, or a door selection, is left untouched. A throwaway that never reports OSC 633 integration is torn down with `killPaneImmediately`, whose live selection check leaves the caller's selection intact (a `--minimize` throwaway is already a door, and `killPaneImmediately` disposes it directly).

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
