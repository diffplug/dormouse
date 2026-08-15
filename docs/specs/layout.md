# Layout Spec

> See `docs/specs/glossary.md` for canonical state names, layer definitions, and transition verbs. This spec uses the glossary's vocabulary throughout.

## Conceptual model

A **Pane** holds a **Surface** — the content in that layout slot. A Surface is either a **terminal Session** or a **browser surface** (`iframe` / agent-browser); `docs/specs/glossary.md` is canonical for the Pane / Surface / Session model and `docs/specs/dor-browser.md` for browser surfaces. This spec uses "Session" where a statement is terminal-specific and "Surface" where it holds for both kinds.

A **Session** is a single PTY instance — a running shell process with its scrollback, environment, and semantic terminal state. Sessions are managed by the terminal registry and persist independently of how they are displayed. Each session also carries Activity state (projected alert status, optional TODO flag, and optional protocol notification detail). CWD, foreground-command lifecycle, command titles, terminal titles, header derivation, and grouping keys are defined in `docs/specs/terminal-state.md`.

A Surface's **View** state places it in one of two containers:

- **Pane** — a visible container in the content area. A terminal Surface renders its output via xterm.js; a browser surface renders through `BrowserPanel`. The pane has a header with controls and acts as the drag handle for layout rearrangement.
- **Door** — a minimized container in the baseboard. The Surface is still alive (a terminal's PTY keeps running and buffering output; a browser surface's backing session or proxy grant stays alive) but not visible. The door shows the Surface's title plus alert and TODO indicators, and looks like a mouse hole cut into the baseboard.

Transitioning between Pane and Door does not alter the Surface in any way.
Minimizing a pane creates a door; reattaching a door creates a pane. Terminal
content, scrollback, and process state are preserved across transitions. For
non-terminal browser surfaces, the backing browser session remains alive while
the visible viewer resources are released: no canvas, screencast WebSocket,
screenshot loop, or input forwarding runs while the surface is a Door.

A **Workspace** is the named group of Surfaces rendered by a single **Wall**, together with their layout (see `docs/specs/glossary.md`). A Window may hold several Workspaces. This spec owns the standalone Workspace presentation; the strip UI and real switching are staged in [Future](#future) (**Scope: workspaces-rollout**). VS Code maps each Workspace to its own webview instead; see `docs/specs/vscode.md`.

## Shell layout

There are two areas:

- **Content** — tiling layout containing Panes, rendered by the **Lath** tiling engine (`docs/specs/tiling-engine.md` owns the engine)
- **Baseboard** — bottom strip containing Doors and shortcut hints. It is visible in the main shell; tightly constrained embedders may suppress it with `Wall showBaseboard={false}` when they do not expose door/minimize workflows.

The user can navigate between all elements using the mouse, or by entering `command` mode and using the keyboard.

```
Wall
├── Context providers (Mode, SelectedId, WallActions, PaneElements, DoorElements, RenamingId, Zoomed, WindowFocused)
│   └── div (h-screen, flex col)
│       ├── Content wrapper (flex-1, 7px top/sides inset, 2px bottom inset)
│       │   ├── LathHost (the tiling engine's HTML adapter)
│       │   │   └── Leaf divs (one Surface per leaf, absolutely positioned, never re-parented)
│       │   │       ├── TerminalPanel → TerminalPane → xterm.js  (or BrowserPanel)
│       │   │       └── TerminalPaneHeader (drag handle)          (or SurfacePaneHeader)
│       │   └── WorkspaceSelectionOverlay (fixed positioned, pointer-events: none)
│       ├── Baseboard (bottom strip, shortcut hints when empty; optional for constrained embedders)
│       │   └── Door components (one per minimized session)
│       └── KillConfirmOverlay (conditional)
```

### What Lath controls
- The split tree, per-leaf rects, sash geometry, and layout (`layout()`)
- Resize sashes between leaves, drag-and-drop rearrangement (hierarchical, pointer-based), zoom
- Native FLIP animation of splits/kills/restores

`docs/specs/tiling-engine.md` is the source of truth for all of the above. This spec owns the interaction model layered on top.

### What the Wall controls
- Focus and selection state (`selectedId`, `selectedType`)
- Passthrough/command mode system
- Keyboard shortcuts and selection overlay rendering
- Session lifecycle: minimize (pane → door), reattach (door → pane), kill
- Terminal lifecycle (via terminal-registry)
- Activity monitoring and alert state
- TODO state management
- Session persistence (save/restore across restarts)

## Content

The content area is a tiling layout of panes rendered by Lath (`docs/specs/tiling-engine.md`). Each pane is one **leaf** in Lath's split tree — a stable, absolutely-positioned div that is never re-parented (so a moved `<iframe>` never reloads and a focused xterm never blurs). Panes are separated by a 7px gap — odd on purpose, so the 1px selection ring can center in it on whole pixels (see Selection overlay). There is no tab stacking: one Surface per leaf, always.

### Tiling constraints

**One Surface per leaf.** The split tree holds only leaves and binary-ish splits; a leaf shows exactly one Surface. Splitting a pane inserts a sibling leaf; removing a pane collapses single-child splits back. Lath enforces the invariants (a split has ≥2 children, never nests a same-direction split); see `docs/specs/tiling-engine.md` → "Core model".

**Center drop = swap.** Dragging a pane onto the *center* of another swaps their Surfaces (same as `Cmd/Ctrl+Arrow`) — a Lath `swap` op that trades leaf identities, so meta and registry entries follow the ids with no companion title swap. Dragging onto an *edge* band splits beside that leaf (or beside an ancestor column/row, chosen by scroll-wheel depth). The full DnD model — depth cycling, the preview-equals-commit rect, baseboard-drop minimize, door drag-out — lives in `docs/specs/tiling-engine.md` → "Hierarchical drag and drop"; the Wall owns only the op commit + selection policy (`onProposeMove` / `onProposeMinimize` / `onExternalDrop` in `Wall.tsx`).

### Pane header

Each pane has a 30px header that doubles as a drag handle (a `pointerdown` on the header, past a 5px threshold, begins a Lath pane drag; below the threshold the header's own click behavior stands). The header uses `cursor-grab` / `active:cursor-grabbing`, `select-none`, and the shared terminal top radius from `lib/src/components/design.tsx`. Background and foreground use the `--color-header-active-*` / `--color-header-inactive-*` token pairs, which map to VSCode file-tree list colors.

The header label is the `DerivedHeader` returned by `deriveHeader(paneState, visiblePanes)` in `docs/specs/terminal-state.md` — that spec is the single source of truth for the priority chain (user-pinned title, app-sent overrides, current command title, `<idle> ${LAST_TITLE}` for finished panes, plain `<idle>` for fresh panes), the disambiguator rule, and which OSC sources contribute. Layout's job is to render the result: the primary label truncates with ellipsis, the secondary label (when present) is shown muted next to it, click renames/pins, right-click — or `>` in command mode — opens the header context menu, which leads with the title-candidates table.

Right-clicking anywhere on the header opens the pane's single **context menu** at the pointer; pressing `>` in command mode opens the same menu for the selected pane, anchored under the header's left edge (the handler finds the header via `data-pane-header-for` and dispatches a synthetic `contextmenu` at that corner, so both paths share one code path; browser surfaces and Doors have no such header, so `>` no-ops there). Only the alert bell owns its own right-click (`stopPropagation`, opening the alert dialog); every other region — including the title span — bubbles to this one menu. It is portaled to `document.body`, viewport-clamped, and dismissed by outside `pointerdown`, `Escape`, `resize`, or capture-phase `scroll` — except scrolls originating inside the menu itself, which must not dismiss it (arrow-key focus moves auto-scroll the overflowing list).

Content, top to bottom:

- **Header row** — the current display title, the pane's `surface:N` handle (`resolveSurfaceRef`, muted), and a close button.
- **Title-candidates table** — the latest entry per `titleCandidates` channel as defined in `docs/specs/terminal-state.md`: channel, latest candidate text, and timestamp per row, or a muted `No title candidates` line. Diagnostic only; it does not change the title priority rules.
- **Port rows** — the TCP ports the pane's process tree binds: a spinner while `getOpenPorts` runs (once per open — reopen to rescan), then one `host:port` row per distinct port (digit accelerator chip first, process name muted beside it), or a muted `no listening ports` / `port scan failed` line.

The menu owns the keyboard while open: it takes DOM focus on mount and restores the previously focused element when a dismissal leaves input ownership unchanged, and it registers as dialog-keyboard-active so command-mode keys don't fire underneath (`use-wall-keyboard.ts`). A port activation instead focuses its destination browser in passthrough. `1`–`9` activate the corresponding port row; presses while the scan is still running are dropped, not buffered — the spinner explains why nothing happened. `↑`/`↓` rove focus across the port rows (wrapping), `Enter`/`Space` activate the focused row, `Tab`/`Shift+Tab` cycle every focusable element, and `Escape` closes.

Activating a port row (click, digit, or `Enter` on the focused row) reproduces `dor ab open <url>` for that port and closes the menu at once (`docs/specs/dor-browser.md` → Pane Context Menu Connect): the browser surface appears immediately and becomes the selection in passthrough (reattaching first if it was minimized) — the one command-mode gesture whose side effect moves selection off the pane it targeted and exits command mode — and loading/errors surface in the pane, not the menu. On hosts that cannot open a browser surface the rows are inert labels with no digit chips, and digits do nothing. Only terminal panes have this menu. Source of truth: `PaneHeaderContextMenu.tsx`, `TerminalPaneHeader.tsx`, `handle-pane-shortcuts.ts`.

Elements from left to right:

- Derived session label (click to rename/pin, right-click opens the header context menu with the title-candidates table, truncates with ellipsis)
- Alert bell button (reflects session activity status)
- TODO pill (if todo state is set; hidden in minimal tier)
- Flexible gap
- Mouse-reporting override icon (only when the inside program requests mouse reporting; hidden in minimal tier)
- SplitHorizontalIcon `split left/right [|]` (full tier only)
- SplitVerticalIcon `split top/bottom [-]` (full tier only)
- ArrowsOutIcon / ArrowsInIcon `zoom [z] / unzoom` (full tier only)
- ArrowLineDownIcon `minimize [m]`
- XIcon `kill [x]` (hover turns error-red)

The alert bell and TODO pill are defined in `docs/specs/alert.md` (visual states, interaction, context menu, and hardening). The mouse-reporting override icon (Phosphor `CursorClickIcon` / `CursorTextIcon`) is defined in `docs/specs/mouse-and-clipboard.md`.

### Pane body

The pane body paints `--color-terminal-bg` on the React pane wrapper and the `TerminalPane` mount point. The persistent xterm host element, `.xterm-screen`, and xterm scroll container are also painted with the concrete background from `getTerminalTheme()`. This is intentional: xterm.js only paints its own rendered terminal surface, and integer row fitting can leave a sub-row remainder at the bottom of the pane. The host background must match the terminal screen exactly and clip to the pane's shared rounded bottom corners so the terminal surface reaches the selection overlay cleanly.

### Pane header responsive sizing

The header adapts to available width via ResizeObserver in three tiers:

- **Full** (>280px): all controls visible — alert, TODO, mouse-override icon, split, zoom, minimize, kill
- **Compact** (160–280px): SplitH/SplitV/Zoom hidden; alert, TODO, mouse-override icon, minimize, kill visible
- **Minimal** (<160px): SplitH/SplitV/Zoom, TODO pill, and mouse-override icon hidden; alert, minimize, kill visible. Session name truncates with ellipsis as needed.

The mouse-override icon only appears when the inside program has requested mouse reporting (per `docs/specs/mouse-and-clipboard.md`); when present, it follows the tier visibility above.

## Baseboard

Below the content area is the baseboard (`h-7`, 28px). It is visible by default and has no top divider. The content area ends 2px above it, leaving a narrow theme-colored gap that keeps rounded pane corners distinct from the baseboard. Its horizontal padding matches the content wrapper's 7px inset, so doors align with the panes above. When empty, it shows keyboard shortcut hints when there are no doors and the container is wider than 350px — platform-aware: `LCmd → RCmd to enter command mode` on macOS, `LShift → RShift to enter command mode` elsewhere (`Baseboard.tsx`).

`Wall` accepts `showBaseboard={false}` for constrained embedders such as the website's mobile Pocket playground, where a separate bottom navigation owns the area below the terminal and door workflows are outside the prototype scope. The main app shell keeps the default `showBaseboard=true`.

The far right of the baseboard is a single flex cluster, right-aligned as a unit: the `N more →` overflow arrow, then the host-supplied `notice` slot (standalone puts the update banner there), then an always-present **Alarm settings** button opening the dialog specified in `docs/specs/alert.md` → Alarm settings. Every baseboard-level button shares one class constant in `Baseboard.tsx`. The cluster's always-present part is measured and subtracted from the door-fitting budget below; the overflow arrow stays out of that measurement because its presence is an *output* of the fit, so measuring it would feed back into its own input.

When a session is minimized, it becomes a **door** on the baseboard. The door displays the same derived terminal label as the pane header, a TODO badge (if set), and an alert bell icon with activity dot. It uses the bottom edge of the window as its bottom border, with left, top, and right borders using the shared terminal top radius from `lib/src/components/design.tsx` — resembling a mouse hole and matching pane rounding. Door dimensions: `min-w-[68px] max-w-[220px] h-6`.

### Door interaction

- **Clicking a door** (in any mode): restores the session into the content area as a pane and enters passthrough mode. The terminal gets focus immediately.
- **Enter** on a door (command mode): same as clicking — restores and enters passthrough mode.
- **m** or **d** on a door (command mode): restores the session into a pane but stays in command mode. This is the inverse of pressing `m`/`d` on a pane (which minimizes it), making them toggles.
- **x** on a door (command mode): restores the session into a pane, then immediately shows the kill confirmation.
- **Arrow keys** can navigate to doors from panes (see Navigation).

### Baseboard responsive sizing

Doors are measured in a hidden off-screen container first:

- Subtract the measured right cluster (notice + alarm settings) and its gap from the available width before fitting anything — that space is never available to doors.
- If they all fit, display them all. If there is remaining space, show the keyboard shortcut hint.
- If they do not all fit:
  - Reserve space for a `N more →` button on the right edge
  - Add doors until no more fit
  - If scrolled, show `← N more` on the left and/or `N more →` on the right
  - Assume single-digit overflow counts

Clicking an overflow arrow reveals one door in that direction. A longer title may push more doors off the opposite side.

Extreme case: a single door with a very long title, with more doors on both sides. Show both arrows with counts, and the single door with as much title as fits (ellipsis for the rest).

## Workspaces

> See `docs/specs/glossary.md` for the Workspace / Window containers and `docs/specs/alert.md` for the union status. VS Code's per-webview mapping is in `docs/specs/vscode.md`.

A **Workspace** is one Wall's worth of Surfaces (terminal Sessions and browser surfaces) plus its layout, with a user-facing name. The standalone Window hosts several Workspaces but mounts only one — the **active** Workspace — at a time. Each Workspace owns its own Content (Lath layout) and Baseboard (doors).

What exists today lives behind the `dormouse.flags.workspaces` flag (`WORKSPACES_FLAG_KEY` in `lib/src/lib/feature-flags.ts`, **off by default**): the in-memory workspace model and its container verbs (`createWorkspace` / `closeWorkspace` / `renameWorkspace` / `setActiveWorkspace` in `lib/src/lib/workspace-store.ts`), the union projection (`computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`), and Window persistence (`PersistedWindow`, `docs/specs/transport.md`). `setActiveWorkspace` changes the active id in the model but does not yet re-render the Wall, and the single-Workspace cap is still in place. With the flag off, the app persists a bare `PersistedSession` and runs exactly one implicit Workspace.

The strip UI, real switching, and lifecycle UX are staged in [Future](#future) — this spec's `## Future` is the single rollout ledger for the feature; other specs link here.

## Modes

Wall starts in `command` mode by default. Embedders may pass `initialMode="passthrough"` when the first pane is an already-running interactive surface that should receive keyboard input immediately.

### Passthrough mode
- All keyboard input routes to the active session's xterm.js instance
- Only the mode-exit gesture (LCmd → RCmd, or LShift → RShift) is intercepted
- In the VS Code host, selected workbench chords are mirrored: xterm still processes the key, and Dormouse also asks the extension host to run the matching VS Code command. See [the VS Code host spec](vscode.md) for the allowlist.
- Selection overlay shows a 1px solid border
- Terminal has DOM focus

### Command mode
- Keyboard drives navigation and commands (see Shortcuts)
- Session does not receive keyboard input
- Selection overlay shows animated marching-ants SVG border (2px stroke, dashed pattern animated at 0.4s cycle)

### Mode switching

**Enter passthrough mode:**
- Click any pane body or header
- Press `Enter` on a selected pane in command mode
- Create a terminal through a manual split (`|` / `%` / `-` / `"`, a header split button) or a host New Terminal action; the new pane is selected and focused immediately
- Press `z` on a selected pane in command mode (also zooms it)
- Click or press `Enter` on a door (restores session first)
- Focus is deferred via `requestAnimationFrame` so it lands after the click/mousedown event finishes

**Enter command mode:**
- Left Cmd keydown, then Right Cmd keydown within 500ms — or the same left-then-right gesture with Shift (Left Shift, then Right Shift within 500ms)
- Detected via capture-phase `keydown` listener on `e.key === 'Meta'` (or `e.key === 'Shift'`) and `e.location` (1 = left, 2 = right). The Meta and Shift tracks are independent, so a Left Cmd followed by a Right Shift does not trigger.
- Works even when xterm has DOM focus because listener uses capture phase
- On keyboards without a right Meta key (common on Windows/Linux laptops), the Shift track is the available gesture; both tracks are always active.
- If the focused pane is zoomed, returning keyboard focus to command mode starts unzoom immediately.

## Keyboard shortcuts (command mode)

All handled in a single capture-phase `keydown` listener on `window`. Every handled key calls `preventDefault()` + `stopPropagation()`. While a rename input is active, all shortcuts are bypassed.

| Key | On pane | On door |
|-----|---------|---------|
| `\|` / `%` | Horizontal split — new pane to the right, then enter passthrough | — |
| `-` / `"` | Vertical split — new pane below, then enter passthrough | — |
| Arrow keys | Spatial navigation between panes | Left/Right between doors, Up to panes |
| `Cmd/Ctrl+Arrow` | Swap session content with neighbor | — |
| `Enter` | Enter passthrough mode | Restore session + enter passthrough |
| `,` | Inline rename | — |
| `x` / `k` | Kill with confirmation | Restore session + kill confirmation |
| `m` / `d` | Minimize to door | Restore session (stay in command) |
| `z` | Zoom pane and enter passthrough | — |
| `t` | Toggle TODO flag | — |
| `a` | Dismiss or toggle alert | — |

### Split cwd inheritance

When a split is initiated from an existing pane (via `|`/`%`/`-`/`"`, the header split buttons, or `Cmd/Ctrl+Click` on a split icon), the new pane spawns with its source pane's last-known cwd as the spawn directory, then becomes selected and enters passthrough immediately. Host New Terminal actions use the same focus tail. Repeated layout construction therefore requires re-entering command mode between manual splits. Focus-neutral control-plane creation (`dor split -- …`, `dor ensure`, `dor iframe`, `dor ab`) retains its documented background behavior. The source cwd is read from `getTerminalPaneState(sourceId).cwd`; remote cwds (`isRemote === true`, e.g. an OSC 7 path reported over ssh) are ignored because they aren't usable as a local spawn cwd. When no source cwd is known, when the split has no source pane (initial pane creation), or when the source is remote, the host's default cwd applies. The inherited cwd rides through `setPendingShellOpts` alongside the inherited shell selection and is consumed by `getOrCreateTerminal` on the next `platform.spawnPty`.

### Kill confirmation

Pressing `x` (or clicking the kill button) enters command mode and shows a pane-centered semi-transparent overlay (`KillConfirmOverlay` → `KillConfirmModal`) with a random lowercase letter (a-z, excluding x). Typing that letter confirms the kill (destroys session, removes pane). Cancel with Escape key, clicking the `[ESC] to cancel` button, or clicking another panel. Any other key triggers a shake animation (400ms `shake-x` keyframe) then auto-dismisses the confirmation.

Untouched sessions skip this confirmation. A newly spawned shell starts `untouched: true`; the first user-originated PTY input flips it to false. Inputs that count include printable keys, Enter, control keys, keyboard CSI such as arrows/history, paste, and file-drop path insertion. Replay-shaped terminal reports and stripped mouse-report-only input do not count (the untouched gate checks `inputIsReplayTerminalReport`; the broader synthetic-report check gates input recording and alert attention, not this flag). Killing an untouched pane runs the normal kill animation/dispose path immediately. Killing an untouched door first reattaches it only far enough to reuse the same pane removal path, then kills it without showing the confirmation overlay.

## Selection overlay

A fixed-positioned element rendered on top of the Lath host. Covers the active element's area inflated by `SELECTION_RING_INFLATE_PX` (4px) for panes; doors are not inflated. The inflate is derived in `lib/src/components/design.tsx` so both ring strokes center on the gutter's midline: the 1px passthrough border spans [3px, 4px] from the pane edge — dead center of the 7px gutter, on whole pixels because the gutter is odd.

- A pane or door can be **active** or **inactive**. Only one element is active at a time.
- One SVG renderer (`SelectionRing`, `variant: 'ants' | 'solid'`) draws both modes:
- **Passthrough:** `variant='solid'` — a 1px solid SVG stroke that replaced the old `border: 1px solid ${color}` CSS border, placed pixel-identically (centerline `strokeWidth/2` inside the div edge for both panes and doors), no glow
- **Command:** `variant='ants'` — animated SVG marching-ants border, rounded rectangle path with `stroke-dasharray` animation (10px segment, 60% dash / 40% gap, 0.4s cycle, 2px stroke). Unchanged while the ring travels; the motion smear is a separate layer behind it (see "Ring travel")
- Border radius follows DESIGN.md's Concentric-Corners Rule: the pane ring's rect is inflated by `SELECTION_RING_INFLATE_PX`, so its radius is the pane radius plus that offset (`PANE_SELECTION_RING_RADIUS_PX` in `lib/src/components/design.tsx`, with the marching-ants path inset so its stroke centerline sits on the same gutter midline, concentric with the pane corner); doors sit at zero offset and keep `0.5rem 0.5rem 0 0`
- Color from CSS custom property `--mt-selection-terminal`
- `z-index: 50`, `pointer-events: none`

### Ring travel

The ring's rect (and its `{tl,tr,br,bl,inset}` shape) is driven **per-frame by a JS tween**, not a CSS transition — the tween writes true interpolated values each rAF frame, the same pointer-events-none carve-out the Lath animator holds (DESIGN.md's "don't animate layout properties" bans CSS transitions on layout props, not this). Motion is `FOCUS_MOTION_MS` (220ms — half `LATH_MOTION_MS`) on the house curve `cubic-bezier(0.22, 1, 0.36, 1)`. Source of truth: the pure tween core `lib/src/lib/rect-tween.ts` (position and velocity); the pure outline/smear geometry `lib/src/lib/ring-geometry.ts`; the overlay's rAF loop in `WorkspaceSelectionOverlay.tsx`; the SVG shell `lib/src/components/wall/SelectionRing.tsx`.

Per-frame writes are **imperative** — the same React-owns-structure / frame-owns-mutations split LathHost uses for the animator. `SelectionRing` renders a stable shell once (per variant/color/focus change) and lifts its DOM nodes (container div, ring path, smear group) back to the overlay via refs; the rAF loop writes `top/left/width/height`, the path `d`, the marching-ants dash, and every smear piece's `d` / width / opacity directly, and re-applies once after any structural render (pre-paint, so a freshly mounted ring never flashes). Do **not** reintroduce per-frame React state: a per-frame reconcile of this subtree competes with the travel for the frame budget.

- **Identity change → tween.** When the incoming measurement's identity (`${selectedType}:${selectedId}`) differs from the one on screen, the ring glides from its current interpolated position to the new target, clock restarted (arrow-key spam stays responsive).
- **Same identity → snap 1:1.** A same-identity re-measure with no tween in flight (sash drag, window resize, a settled leaf's store commit) writes the new rect directly — the ring tracks the geometry exactly instead of easing behind it.
- **In-flight retarget.** A same-identity re-measure *during* a tween retargets the destination without resetting the clock, so the ring converges on a moving target (select-a-neighbor-during-kill) and still lands on the original completion instant.
- **Snap gate.** `!cfg.layout.animate` (Chromatic) or `prefersReducedMotion()` → the ring settles instantly, mirroring the animator's 0-duration path (`lath-wall-engine.ts`). Only the unfocus-saturate fade keeps a CSS transition (`filter ${FOCUS_MOTION_MS}ms`), unconditionally.
- Pane↔door selection morphs the corner radii (12px all-round ⇄ `8,8,0,0`) and stroke inset through the same tween, so the shape lerps instead of popping.
- **Directional motion smear.** While travelling, each ring edge trails a soft band sized by its own motion. A line smears only by moving *across* itself — sliding along its own length leaves it unchanged — so **a horizontal edge is driven by its vertical speed and a vertical edge by its horizontal speed, and all four edges are independent.** Speeds come from `sampleRingVelocity` — the tween's **analytic derivative**, not a difference of rendered frames. Each edge's position is `from + (to - from) * E(t)`, so its speed is `|to - from| * E'(t) / durationMs`, with `E'` supplied by `LATH_EASING.slope`. Each speed normalizes against `cfg.focusRing.smearFullSpeed` into a single `t`, and extent and intensity are independent linear ramps off it — width from `strokeWidth` to `smearMaxPx`, alpha from 0 to `smearPeakAlpha`. Both start at zero, so an edge that is not moving contributes nothing rather than laying a band under the crisp ring. A settled or reduced-motion ring has null speeds and the smear layer is `display: none`, so snapshots stay deterministic.
  - **Invariant: the smear is strongest on the opening frame and decays from there.** The house ease-out peaks at `E'(0) = 4.545x` its average speed, so that is where the blur belongs. **Do not go back to finite-differencing rendered positions**: it has no previous sample to difference on the first frame, so the smear was hidden outright for the frame covering ~31% of a 220ms travel; an EMA over it lagged ~1.7 frames, under-reporting at launch and lingering after the ring had parked; and a backward difference under-reports any decelerating curve. The rendered peak landed mid-travel at ~46% of true peak velocity — visibly wrong, and the reason this is analytic now. Analytic velocity is also jitter-free by construction (it never differences wall-clock timestamps), so it needs no smoothing.
  - **Extent and intensity are deliberately independent.** `smearMaxPx` is how far the smear reaches, `smearPeakAlpha` how strongly it reads, and `smearFullSpeed` the speed at which both max out. Alpha is *not* divided by the widening factor: strict ink conservation ties peak alpha to the extent, which makes the effect impossible to strengthen by widening — a wider band just spreads the same ink thinner. `smearFullSpeed` sets the shape over a travel: low values pin nearly every move at full smear (uniform blur), high values make blur track speed so short hops smear less than long jumps.
  - **Per-edge, not per-axis.** Collapsing the four edges to one horizontal and one vertical speed (e.g. from the ring *centre's* velocity) is wrong for ordinary split layouts: moving between panes that are flush at the top but differ in height, the top edge translates purely sideways and must stay crisp while the bottom edge moves diagonally and smears hard. A centre velocity averages those into the same wrong answer for both.
  - **Two layers, because the geometry is incompatible.** The ring is one closed path so the marching-ants dash phase runs unbroken around the perimeter; SVG `stroke-width` is a single scalar, so that one path cannot carry four different widths. The smear is therefore a sibling `<g data-ring="smear">` of eight solid pieces drawn underneath, and the ring (`<path data-ring="outline">`) is never transformed, re-dashed, or re-alpha'd — it renders exactly as it did before any smear existed. Keeping all dash bookkeeping on the untouched path is the point of the split.
  - **Dash length is computed, not measured.** `ringPerimeter` returns the outline's exact length in closed form — straight runs plus `1.6232252401402307 × r` per corner, the arc length of the *quadratic* quarter-turn the path actually draws. Do not substitute `π/2` (the quarter-*circle* value); it is 3% short and would silently shift every dash. `SVGGeometryElement.getTotalLength()` was the previous source and is not to be reinstated: it forces a synchronous style+layout flush on every frame of a travel, at a cost scaling with the whole document rather than this one path, and it is itself only an approximation (browsers flatten curves to measure). Verified in Safari to agree with `getTotalLength()` to 6e-4px on a 3253px ring — the residual is WebKit's flattening error, not ours. Removing it also let the jsdom `getTotalLength` stubs go, so tests assert real dash geometry instead of a fabricated perimeter.
  - **Eight pieces: four edges plus four corners.** Straight edges carry their width in a plain `stroke-width` and need no transform. A corner cannot — it has to reach two different widths at once — so each corner arc is stroked at unit width and given `transform: scale(a, b)` with `a` the vertical neighbour's width and `b` the horizontal neighbour's. Under that scale a unit stroke renders `b` thick where its tangent is horizontal and `a` thick where vertical, interpolating between, so the corner tapers between its two edges with no seam at either join; `cornerPath` pre-divides the arc by the same `(a, b)` so the on-screen curve is unchanged. Opacity cannot vary along a stroke, so a corner takes the mean of its two edges'. Every piece is cut from ONE shared point set (`ringPoints`), which is also what `roundedRectPath` walks — so the smear provably tiles the ring rather than agreeing with it by inspection, and `ring-geometry.test.ts` pins that. The overlay finds each piece by its `data-piece` attribute, never by index, so render order stays presentational. Source of truth: `lib/src/lib/ring-geometry.ts`.
  - This replaced an SVG `feGaussianBlur`. **Do not go back**: WebKit CPU-rasterizes SVG filters every frame, measured in Safari 26.5 at 25.6ms/frame with 31 of 98 frames over 25ms during travel, versus a locked 16.7ms with zero dropped frames. Stroke widths, scale transforms and opacities are GPU-composited and cost nothing. CSS `filter: blur()` is also free, so the cost is SVG filters specifically, not blur.

### Position tracking
- Each pane body registers its DOM element in a `paneElements` Map on mount and removes it on unmount (`usePaneChrome`); the overlay resolves the enclosing Lath leaf (`[data-lath-leaf]`) via `resolvePaneElement` so the ring covers the full leaf (header + body)
- Door elements are registered by the `Baseboard` via `DoorElementsContext` from `components/wall/wall-context.tsx` (queries `[data-door-id]` attributes)
- Re-measures on: selection change, resize (`ResizeObserver`), every Lath store commit (`revision` via `useSyncExternalStore`), and — while the wall streams animator frames — every frame (so the ring tracks kills, restores, and tweens frame-accurately). If the selected leaf is momentarily absent the overlay bails and holds the last rect.

## Spatial navigation

### Direction detection

Lath's pure `neighbors(tree, rect, id, direction, opts)` query resolves the nearest pane in an arrow's direction — no DOM rect scanning; it computes against the same laid-out rects the screen shows (`docs/specs/tiling-engine.md` → "Layout"). The keyboard handlers reach it through the engine-neutral `WallNav` seam (`lib/src/components/wall/keyboard/types.ts`), whose `findInDirection` calls `lath.store.neighborOf`. The semantics:

1. **Edge-based direction check**: candidate must be strictly beyond the leaf's edge on the primary axis
2. **Overlap requirement**: candidate overlapping on the secondary axis is preferred
3. **Distance**: nearest edge-to-edge on the primary axis, with deterministic tie-breaks
4. **Fallback**: if no overlapping candidate, nearest non-overlapping candidate

### Back-navigation

A breadcrumb tracks the last navigation direction and origin pane. Pressing the opposite direction returns to the origin instead of spatial lookup. This handles asymmetric layouts (tall pane left, stacked panes right).

### Pane-to-door navigation

Down from the bottom-most pane navigates to the first door in the baseboard. Up from a door navigates to the last pane. Left/Right navigates between doors.

### Cmd/Ctrl+Arrow swap

Swaps session **content** between two panes — the layout shape is unchanged. A single Lath `swap` op trades the two leaf identities: because per-leaf metadata and terminal-registry entries are keyed by id, the title/params/session follow the ids automatically, with **no** companion title swap. Selection follows the moved session. Uses the same back-navigation breadcrumb as arrow keys.

## Minimize and reattach

### Minimize (`m` key or minimize header button)
1. `lath.removeLeaf(id)` removes the leaf and returns a JSON-serializable **restore token** capturing the leaf's ancestry (sibling id, split-sibling leaf set/fingerprint when needed, edge, weight, child index, and a structure-only fingerprint of the parent split post-removal — `docs/specs/tiling-engine.md` → "Restore tokens").
2. Add to `doors` state → door appears in baseboard, carrying the `token`. The door stores only the stable component/title for persistence; its visible label is derived from live terminal semantic state at render time. (A pane dragged onto the baseboard minimizes the same way — the drag proposes `onProposeMinimize`, which calls the same `minimizePane`.)
3. Session stays in registry (not disposed).
4. Selection moves to the new door (stays in command mode). If this was the *last* pane, the auto-spawn effect fills the emptied Wall while the door keeps selection.

### Reattach (click door, Enter/d on door)

`lath.restoreLeaf(meta, token, { fallbackRef })` applies a three-tier policy from the token (`docs/specs/tiling-engine.md` → "Restore tokens"):

- **Exact** — the fingerprinted context still exists around the sibling: reinsert at the original index with the original weight (existing siblings shrink proportionally).
- **Neighbor** — the sibling still exists: split beside it on the original edge (at 50/50).
- **Fallback** — split beside a caller-supplied live reference (the selected pane, else the first pane) via `autoEdge`; into an empty tree the leaf becomes the root.

A door dragged out of the baseboard skips the token entirely and inserts at the hit-tested drop position the user chose (`onExternalDrop` → `lath.insertLeaf`).

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

The name `<span>` is replaced by an `<input>` with:
- Same font (`font-mono font-medium`), `bg-transparent`, no border
- Text pre-selected on mount
- `Enter` confirms, `Escape` cancels, `blur` confirms
- `stopPropagation` on `mousedown`/`click`/`keydown` to prevent panel click or drag
- All command-mode shortcuts are bypassed while renaming

Submitted values are rejected when empty or when they fail the `setTerminalUserTitle` validation that also guards title seeding — no titles starting with the `<idle>` sentinel (`docs/specs/transport.md`). `<unnamed>` is the default panel placeholder but is otherwise allowed as a deliberate user pin. When the user submits a rejected value, the input still closes (so it is not a blocking dialog) and a small auto-dismissing warning popover anchored under the input names the offending value. The popover dismisses on the next pointerdown, scroll, resize, `Escape`, or after 3s.

## Session lifecycle and terminal registry

For a terminal Surface the pane ID is its session ID. `TerminalPane` calls `getOrCreateTerminal(id)` on React mount and `unmountElement(id)` on React unmount. The session (xterm.js instance, PTY, DOM element) persists in the registry across mount/unmount cycles — the DOM element is detached from its container but the Registry entry stays `Mounted`. A browser surface's pane ID is a Surface id with no registry entry or PTY (`docs/specs/glossary.md`); its DOM is hosted by LathHost's leaf div and it is reconstructed from persisted params, not from the registry.

- **Create**: `getOrCreateTerminal` spawns xterm.js + UnicodeGraphemesAddon + FitAddon + PTY, returns existing if already created. The xterm instance sets `allowProposedApi: true` because UnicodeGraphemesAddon activates through xterm's proposed Unicode API. The WebGL addon is *not* loaded at create — it is claimed lazily on the session's first mount (see "Renderer" below).
- **Resume**: `resumeTerminal` creates xterm entry and writes replay data without spawning a new PTY. Used when the webview is recreated while the host retains Live PTYs (Link: Severed → Resuming → Live).
- **Restore**: `restoreTerminal` creates xterm entry and spawns a new PTY with saved cwd and scrollback. Used on cold start from a saved Snapshot (Link: Cold → Live).
- **Resume offer**: a restored pane whose snapshot carried a `resumeCommand` (`docs/specs/transport.md`) offers to run it — the replayed scrollback ends in an agent's resume hint, but the process that wrote it is gone and the pane now holds a fresh shell. See "Resume offer" below.
- **Untouched**: new `getOrCreateTerminal` sessions start untouched. `isUntouched(id)` exposes the flag, and user-originated PTY input clears it via the registry input paths. Resume/restore seed the persisted flag; missing legacy snapshot data defaults to touched (`false`) so close confirmation remains conservative.
- **Shell selection replacement**: the standalone shell dropdown and VS Code shell picker send `dormouse:new-terminal` with `replaceUntouched` when the selected shell type changes. `Wall` always creates a new session id and a fresh `surface:N` ref for that request. If the currently selected pane or door is untouched, the new terminal takes over the same leaf via a Lath `replace` op (an atomic identity swap; doors first reattach through the normal restore path), the old untouched session is disposed, and the replaced Surface's ref is retired. If the selected terminal is touched or no terminal is selected, the request spawns a new pane beside the selected one. Announced shell-selection spawns show a transient pane-anchored notice such as `Switched to zsh` or `Opened bash`.
- During resume/restore replay, xterm.js may emit terminal-generated replies for OSC/CSI/DCS queries that were embedded in saved output. The registry drops those replay-time replies before they reach the new shell. This filter is limited to query/focus reports, and must not swallow user keyboard escape sequences such as arrows, function keys, or bracketed paste.
- **mount / unmount (DOM)**: `mountElement` reparents the persistent DOM element into a container; `unmountElement` removes it. The Registry entry survives.
- **Dispose**: `disposeSession` kills the PTY, disposes xterm, removes the registry entry. Only called on explicit kill (`x`).
- **Swap**: the Cmd/Ctrl+Arrow swap trades two leaf identities via a Lath `swap` op — per-leaf metadata and registry entries are keyed by id, so they follow the swap with no DOM reattach or title swap (see "Cmd/Ctrl+Arrow swap" above).

### Resume offer

A cold **restore** replays a Session's saved scrollback into a *fresh* shell. When that scrollback ended in an agent's resume hint, the snapshot carries the command as `PersistedPane.resumeCommand` (`docs/specs/transport.md`), and the restored pane offers to run it: two buttons at the pane's bottom-right, `Run <invocation>` and `Dismiss`.

- **Seeded by restore only.** `restoreSession` seeds the offer per terminal pane; **resume** never does, because there the process is still Live and has nothing to resume. Browser surfaces are skipped with the rest of the terminal restore path.
- **Retired** by taking it, dismissing it, the user's first input into the pane (the same non-replay input branch that clears `untouched`), or session dispose. It does not survive into the next save — the offer lives only in the runtime store, and the next restore re-seeds from the snapshot.
- **Untouched is not the gate.** A Session that ran an agent is touched by definition, so `isUntouched` would suppress the offer in exactly the case it exists for. Retirement keys off *post-restore* input instead.
- **Hidden, not retired, while a command is running** (`activity.kind === 'running'`): the offer types into the shell, and a shell with a foreground process is not listening. Shells without OSC integration report `unknown` and keep the offer.
- **Taking it** writes `<command>\r` straight to the PTY and marks the Session touched. Not a bracketed paste — bracketing exists to stop an embedded newline from executing, which is the opposite of the intent. A click landing before the fresh shell has drawn its first prompt can still be swallowed by shell startup, the same hazard `typeCommandWhenPromptReady` guards for launched commands; the offer accepts it rather than delaying the button, since restore-then-click is far slower than spawn-then-type.
- **The button carries the invocation, not the command.** `Run claude --resume`, never `Run claude --resume <uuid>` — the session id is already on screen in the replayed scrollback directly above. The full command is the button's tooltip.

Source of truth: `lib/src/lib/resume-offers.ts` (store), `runResumeCommand` in `lib/src/lib/terminal-lifecycle.ts`, `lib/src/components/wall/ResumeBanner.tsx` (the pane-mounted offer + its presentational `ResumeBannerView`), seeded in `lib/src/lib/session-restore.ts`.

### Renderer

Every terminal renders through stock `@xterm/addon-webgl`, claimed lazily by
`tryEnableWebglRenderer` on a session's first `mountElement` — not in
`createXtermHost` — and guarded by `webglAttempted` so each session claims at
most one GL context. First paint is the earliest point worth the context: a
session created but never mounted (e.g. a minimized door awaiting restore) never
allocates one, keeping scarce GL contexts for terminals that are actually shown.
xterm's built-in DOM renderer is the fallback, never the default.

The DOM renderer emits one `<span>` per style run per row, so a TUI that paints
every cell its own truecolor collapses to one span-with-inline-style *per cell*,
rebuilt every frame. On a 99×25 pane that is ~1150 elements of style recalc plus
layout per frame: measured in Safari 26.5, a single such pane held the whole page
at ~110ms/frame (~9fps) while the rest of the app was idle. The same pane on the
WebGL renderer holds a locked 60fps (16.6ms, zero frames over 25ms) — the grid
rasterizes from a glyph atlas and the DOM stays untouched.

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

The addon is loaded on a session's **first mount**, not at creation. A GL context
is a scarce per-page resource, and cold restore builds a session for every
persisted pane *including minimized doors*, which never paint — claiming contexts
at create would spend the budget on invisible surfaces and, since eviction is
oldest-first and one-way, permanently demote the earliest-restored panes.
`TerminalEntry.webglAttempted` keeps it to once per session.

Which renderer a terminal ended up on is recorded as `data-renderer="webgl"|"dom"`
on its host element, so the outcome is inspectable rather than silent — including
after a context loss demotes a pane. `cfg.terminal.webglRenderer` disables the
whole path; `.storybook/preview.ts` pins it off under Chromatic, because a canvas
snapshots as an opaque bitmap that varies with the runner's GPU while styled spans
diff deterministically.

Verified in Safari 26.5 (the numbers above) and structurally in Chrome. **Not yet
verified inside Tauri's WKWebView**: same engine as Safari and Tauri does not
disable the GPU, so it is expected to work — read `data-renderer` on a pane's host
element to confirm.

Source of truth: `tryEnableWebglRenderer` in `lib/src/lib/terminal-lifecycle.ts`.
Not to be confused with the SDF fork in `docs/specs/webgl-text.md`, which is a
different addon consumed only by `canopy/`.

### Session persistence

Layout, scrollback, cwd, minimized items, user-pinned titles, untouched state, and alert state are saved to persistent storage via a debounced save (500ms). The layout persists as the native Lath format (`lathLayout`; `docs/specs/tiling-engine.md` → "Persistence"). Derived command/app labels shown on minimized doors are display-only and are not persisted as user-pinned titles. Every Lath store commit (add/remove/resize/swap/meta, including the active-pane the layout records) *schedules* the debounced save; content changes (terminal output, activity/TODO, pane title/command state, minimized-door changes) only *mark the session dirty*; a 30s heartbeat persists only when the session is dirty, so an idle app stops writing. Saves are flushed immediately and unconditionally on PTY exit, `pagehide`, and extension shutdown requests — the correctness net for any dirty-trigger gap. The dirty-gating mechanism and the store-level identical-value backstop are specified in `docs/specs/standalone.md` §Persistence.

In standalone, each Workspace's snapshot is wrapped in a Window snapshot that records every Workspace (name + layout) and which one is active, so all Workspaces — not just the mounted one — survive a restart. VS Code persists one Workspace per webview exactly as today (one snapshot per `WebviewView` / `WebviewPanel`). The persisted container types (`PersistedWorkspace`, `PersistedWindow`) live in `docs/specs/transport.md`.

Saved snapshots are read through `readPersistedSession()`, which accepts the canonical object shape and defensively parses a JSON-stringified blob before validation. A present-but-unreadable blob is logged and discarded, so malformed storage starts fresh rather than blocking startup, while hosts that hand back serialized JSON instead of the parsed object are still covered.

On startup, recovery is priority-based:
1. **Resume** (webview hidden/shown, live PTYs): request PTY list + replay data from platform, `resumeTerminal()` for each (500ms timeout). Saved pane and door titles are seeded back via `setTerminalUserTitle()` (see `docs/specs/transport.md`) so persisted placeholder labels never replay as user pins. If the saved session covers every live PTY, restore the saved Lath layout when its leaf set matches and reattach saved minimized items as doors. This still counts as a live resume when every live session is minimized, so recovery must not fall through to cold restore just because the visible `paneIds` list is empty.
2. **Restore** (app restart, cold start): the Wall's `seed` hydrates from the restored Lath layout, else falls to (3); `restoreTerminal()` for each pane with saved cwd + scrollback, spawning each PTY with the current default shell selection
3. **Fallback/manual pane creation**: when no saved layout can be safely applied, add multiple panes as splits from the previous pane, and spawn each PTY with the current default shell selection
4. **Empty state**: create a single new pane with the current default shell selection

### Activity state

Each session carries `ActivityState` with `status: SessionStatus`, `watchingEnabled: boolean`, `todo: boolean`, and `notification: ActivityNotification | null`. `status` is the projected public status from the timer-based WATCHING track, terminal-report protocol track, and command-exit track described in `docs/specs/alert.md`; it may be `OSC_NOTIF_BUSY` when OSC progress has cocked the bell or `COMMAND_EXIT_ARMED` when a foreground command is running after attention was lost with WATCHING off. `watchingEnabled` reports whether the running command matches a WATCHING rule, which stays accurate when `status` is projected to a stronger protocol state. These are synced to React via `useSyncExternalStore`. State that arrives from the platform before a registry entry exists (resume scenario) is held as "primed state" and applied when the registry entry is created.

Each session also carries `TerminalPaneState` from `docs/specs/terminal-state.md`. The frontend store is keyed by the current pane/session id, and PTY-originated semantic events are resolved through `ptyId` so swapped sessions keep their CWD and command state with the terminal content.

## Theme

The Lath host styling lives in the `.lath-host` / `.lath-leaf` rules in `lib/src/index.css`: an app-bg host and a terminal-bg body. Each leaf has a 30px header band applied by LathHost from the shared `PANE_HEADER_HEIGHT_PX` in `lib/src/components/design.tsx`. The content area uses a 7px top/sides inset and 2px bottom inset (`px-1.75 pt-1.75 pb-0.5` on wrapper, `inset-x-1.75 top-1.75 bottom-0.5` on container); the `LATH_LAYOUT_OPTS` gap of 7px (`PANE_GUTTER_PX`) is the only visual separator between panes.

Colors use a two-layer CSS variable strategy: `@theme --color-*` tokens → `var(--vscode-*)`. VSCode provides host theme variables in extension mode; standalone and website mode apply bundled or installed theme variables before rendering. Tailwind v4 `@theme` block registers `--color-*` tokens as Tailwind colors (e.g., `bg-app-bg`, `text-app-fg`, `border-border`). See `theme.css` for the full token map.

The Lath host paints `var(--color-app-bg)` so gutters and rounded pane/header corner cutouts match host chrome. Terminal content backgrounds are painted by the React terminal wrappers and xterm host elements, not by the leaf containers.

## Animations

All pane motion is owned by the Lath **animator** — a pure function of time that turns committed layout changes into interpolated frames, applied imperatively to the leaf divs by LathHost (`docs/specs/tiling-engine.md` → "Animation"). Default motion is 440ms `cubic-bezier(0.22, 1, 0.36, 1)`; under reduced motion the animator runs the same code with a 0 duration (instant). The selection overlay measures the leaf divs, which carry the interpolated inline geometry, so `getBoundingClientRect` tracks the tween frame-accurately. There are no CSS entrance/exit classes. Terminal panes, by contrast, do not refit every frame: `TerminalPane`'s resize observer throttles `refitSession` (leading edge, then at most one per ~150ms while resizes keep arriving, plus a trailing call at rest), so a motion or sash drag reflows the xterm buffer and fires a PTY resize a handful of times instead of once per animated cell-boundary crossing, while the resting geometry still gets an exact fit.

### Zoom (elevated expansion)

Zoom is presentation-only: the split tree and every tiled rect remain unchanged. It is coupled to passthrough focus: acquiring zoom enters passthrough and focuses that pane; exiting passthrough, focusing another pane, or selecting a Door starts unzoom immediately. Only the zoom owner's header shows Unzoom, with its foreground/background header tokens inverted so the escape action stands out; partially exposed panes retain their normal Zoom control. Only the owner's control toggles zoom off — the perimeter leaves other headers reachable, and their Zoom control hands zoom over (focus included) rather than merely unzooming the owner. The chosen pane rises above the tiled/dying bands and sashes before expanding from its tiled rect to the Wall rect inset by half the 30px pane-header height (15px). The perimeter exposes the tiled layout beneath, while a blurred `--color-app-bg` shadow separates the elevated edge from the content below. Unzoom reverses the geometry while keeping the pane elevated and shadowed for the whole return; both elevation effects clear only on the settled frame. Source of truth: focus/zoom orchestration and `ZoomedIdContext` in `lib/src/components/Wall.tsx`; `paneZoomButtonClass` and `PANE_HEADER_HEIGHT_PX` in `lib/src/components/design.tsx`; `presentationTargets`, `LATH_ZOOM_MARGIN`, `LATH_ZOOM_SHADOW`, and the layer-to-z-index mapping in `lib/src/components/wall/LathHost.tsx`; discrete layer lifetime in `lib/src/lib/lath/animator.ts`.

### Spawn (new pane reveal)

A newly added leaf enters by growing from the boundary it was placed against, at opacity 0 → 1 (a split to the right grows from its left boundary, and so on). The store's mutators derive this **enter hint** from the edge they commit; the auto-spawn refill overrides it to `'top-left'` (the killed last pane shrank toward the bottom-right, so the refill grows from the opposite corner). See `docs/specs/tiling-engine.md` → "Animation" → Enter.

Shell-selection replacement shows a short fixed-position notice over the resulting pane. The notice fades in/out over 1500ms via `.shell-spawn-notice` and is suppressed to a static render for reduced-motion users.

### Kill (two-phase fade + tween reclaim)

Kill is the animator's two-phase exit (`docs/specs/tiling-engine.md` → "Animation" → Exit). `killPaneImmediately` in `Wall.tsx` runs it after the user confirms:

1. `lath.markDying(id, { shrinkTowardBottomRight })` freezes the pane geometry and fades it in place (a last-pane kill also shrinks it toward its bottom-right corner). The mounted terminal DOM remains in the dying leaf for the fade; dying leaves get `pointer-events: none`.
2. After `lath.exitMs`, `disposeSession(id)` runs and `lath.removeLeaf(id)` commits — survivors tween into the reclaimed space on the resulting retarget. A second kill of the same pane mid-fade is a no-op (`lath.isDying`). A mid-tween re-kill of a *different* pane retargets cleanly from the current interpolated frame (the animator is interruptible by construction).

Selection tail: at removal time, selection moves to a survivor (`lath.listPanes()[0]`, or `null` → auto-spawn when the last pane goes) **only when the killed pane is still the selected pane** — the check is live (`selectedType === 'pane' && selectedId === killedId` re-read inside the removal timeout), so killing a background surface leaves the user's selection untouched, and a selection move *during* the fade is honored: navigating away from a dying selected pane means the tail no longer yanks selection, and navigating onto a dying pane means the tail adopts a survivor instead of leaving selection dangling. The header kill button is always a selected-pane kill (clicking the header selects the pane before the button's click handler runs); the not-selected cases are `dor kill` of a background surface (`dor kill surface:3`) and ensure's throwaway teardown.

### Auto-spawn refill

A store commit that empties the tree (last pane killed or minimized) triggers the "always keep one pane visible" auto-spawn: a Wall effect subscribed to the store spawns one leaf into the emptied tree (`lib/src/components/Wall.tsx`). It fires re-entrantly on the same commit chain, so the refill appears without a separate delay; the killed pane's fade already sequenced the removal. The refill spawns with the current default shell selection, matching manual splits and the standalone `[+]` action.

The refill adopts the replacement (`selectPane`) only when the current selection no longer points at anything real: null (the kill tail cleared it after a selected last-pane kill) or dangling (selection still names the just-removed pane). A *valid* selection is left alone — the just-created door on the minimize path (so the door keeps selection across the refill) or a live pane after an unselected kill — because the auto-spawn exists to keep a pane visible, not to steal selection.

## Corner cases

1. **xterm steals Meta keys**: the mode-exit gesture uses `capture: true` on the window keydown listener, so it fires even while xterm has DOM focus.
2. **Click focus timing**: entering passthrough defers `focusSession` to `requestAnimationFrame` so it lands after the click/mousedown event finishes (`enterTerminalMode`).
3. **Stable hitboxes across moves**: each pane body registers its DOM element in `paneElements` (`usePaneChrome`), and the selection/kill overlays resolve the enclosing `[data-lath-leaf]` from it, so a leaf measured after a move reports its new rect. Because Lath never re-parents a leaf div, its node identity — and any embedded `<iframe>` — survives every op; there is no re-parent blur to heal and no iframe reload.
4. **Asymmetric back-navigation**: a breadcrumb tracks last direction + origin for opposite-direction return.
5. **Door keeps selection through the auto-spawn refill**: minimizing the last pane selects the new door, then the auto-spawn refill fills the emptied Wall. The refill only adopts selection when it points at nothing real (null or dangling), so a live door selection is left alone — the door keeps its highlight. Explicit user selection of a pane (a click, a drag, or an embed focusing itself) still moves selection off a door. See "Auto-spawn refill" under Animations.
6. **Focus-neutral surface creation (`dor ensure` / `dor iframe` / `dor ab`)**: unlike `dor split`, these open in the background without moving focus off the caller (`docs/specs/dor-cli.md`, `docs/specs/dor-browser.md`). Under Lath this is inherent — an add never re-parents the caller's subtree or steals activation, so the caller keeps DOM focus and selection with no healing; the create simply does not call `selectPane` (`settleAddSelection` returns false for a focus-neutral, non-selection-replacing add). The one exception: `dor iframe` / `dor ab` replacing the pane the user is *currently selected on* moves selection to the replacement (else it would dangle on the removed leaf); replacing any other pane, or a door selection, is left untouched. A throwaway that never reports OSC 633 integration is torn down with `killPaneImmediately`, whose live selection check leaves the caller's selection intact (a `--minimize` throwaway is already a door, and `killPaneImmediately` disposes it directly).

## Files

| File | Role |
|------|------|
| `lib/src/components/Wall.tsx` | Main layout orchestrator: selected mode/state, session actions, minimize/reattach, provider composition |
| `lib/src/components/wall/wall-types.ts` / `wall-context.tsx` | Shared Wall types and React contexts used by Wall, pane headers, panels, overlays, and the baseboard |
| `lib/src/components/wall/LathHost.tsx` | The tiling engine's HTML adapter: leaf divs, sashes, the pane/door drag gesture, and imperative animator frame application. Engine internals are mapped in `docs/specs/tiling-engine.md`. |
| `lib/src/components/wall/TerminalPanel.tsx` | Pane body wrapper; registers the pane's DOM element (`usePaneChrome`) |
| `lib/src/components/wall/TerminalPaneHeader.tsx` | Pane header with rename, alert/TODO, mouse override, split/zoom/minimize/kill controls, and the right-click context menu |
| `lib/src/components/wall/PaneHeaderContextMenu.tsx` | Pane-header right-click menu: the `surface:N` handle plus the pane's bound TCP ports; a port click connects it to the default browser (`docs/specs/dor-browser.md`) |
| `lib/src/components/wall/WorkspaceSelectionOverlay.tsx` | Pane/door focus ring: the JS travel tween + rAF loop; re-measures on Lath store commits + animator frames; computes the directional motion-blur velocity |
| `lib/src/components/wall/SelectionRing.tsx` | The SVG shell: one ring path (`solid` passthrough / `ants` command) plus the eight-piece smear group, all driven imperatively |
| `lib/src/lib/ring-geometry.ts` | Pure ring outline + smear-piece path geometry, and the piece/corner taxonomy |
| `lib/src/components/wall/MouseOverrideBanner.tsx` | Temporary mouse override banner shown from the header icon |
| `lib/src/components/wall/use-wall-keyboard.ts` | Capture-phase keyboard dispatch for mode switching, pane/door commands, copy/paste, selection drag keys |
| `lib/src/lib/vscode-keybindings.ts` | VS Code-hosted workbench chord mirror allowlist |
| `lib/src/components/wall/use-session-persistence.ts` | Debounced layout/session save, flush requests, pagehide, PTY exit, file-drop paste routing |
| `lib/src/components/wall/use-dor-control.ts` | The `dor` CLI's webview control-plane hook (`useDorControl`): the `dormouse:control-request` handler for `surface.*` methods plus its surface-resolution/param-coercion/command-quoting helpers (`docs/specs/dor-cli.md`) |
| `lib/src/components/wall/use-window-focused.ts` | Window focus tracking hook for header and selection overlay dimming |
| `lib/src/components/Baseboard.tsx` | Always-visible bottom strip with door components, overflow arrows, shortcut hints, and the right cluster (notice slot + alarm settings button) |
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
| `lib/src/lib/activity-monitor.ts` | Per-session activity state machine: output timing → alert escalation |
| `lib/src/lib/alert-manager.ts` | Manages ActivityMonitors + attention tracking + TODO state per session |
| `lib/src/lib/session-types.ts` | Type definitions for persisted sessions (`PersistedPane`, `PersistedDoor`, `PersistedSession`) |
| `lib/src/lib/session-save.ts` | Serialization: collects layout, scrollback, cwd, alert state for persistence |
| `lib/src/lib/session-restore.ts` | Deserialization: loads saved session, calls `restoreTerminal()` for each pane |
| `lib/src/lib/reconnect.ts` | Priority-based recovery: live PTYs first, then saved session, then empty |
| `lib/src/lib/resume-patterns.ts` | Detects resumable commands (`claude --resume`, etc.) in scrollback, newest line first, and labels them with the invocation alone |
| `lib/src/lib/resume-offers.ts` | Pending resume offers per Session — seeded by cold restore, retired on take/dismiss/input/dispose |
| `lib/src/components/wall/ResumeBanner.tsx` | The restored pane's `Run <invocation>` / `Dismiss` offer |
| `lib/src/index.css` | Lath host styling — `.lath-host` / `.lath-leaf` / `.lath-sash` / drop-preview layout and background flattening |
| `lib/src/theme.css` | Two-layer VSCode theme token system (`@theme --color-*` → `--vscode-*`) and Tailwind v4 `@theme` integration |

## Maintainer checklist

When changing layout behavior:

- Changing a command-mode binding or the mode-switch gesture: update the shortcut table here **and** `docs/specs/shortcuts.md` in the same edit.
- Pane-header changes: this spec owns placement and sizing only. Bell/TODO behavior and visual states belong to `docs/specs/alert.md`; the mouse-override icon and banner to `docs/specs/mouse-and-clipboard.md`; the derived label to `docs/specs/terminal-state.md`.
- Persisted-shape changes (`PersistedPane` / `PersistedDoor` / layout blobs) belong to `docs/specs/transport.md` — update it there.
- New pane chrome uses tokens from `lib/src/components/design.tsx` (see AGENTS.md Design); never raw color classes.
- Pane spawn/kill/tween motion is owned by the Lath animator (`docs/specs/tiling-engine.md` → "Animation"); layout.md owns only the interaction behavior around it.
- Anything workspace-strip or switching related stays under `## Future` (workspaces-rollout) until built.

## Future

**Scope: workspaces-rollout** — the remaining stages of the multi-Workspace feature. The model, container verbs, persistence, and union projection are implemented, dormant behind `dormouse.flags.workspaces` (see [Workspaces](#workspaces) above; persisted containers in `docs/specs/transport.md`, union projection in `docs/specs/alert.md`). This ledger is the single home for what remains; other specs link here rather than restating it.

### Stage 3 — workspace strip and switching UI (standalone)

The standalone app bar (`standalone/src/AppBar.tsx`) grows a horizontal **workspace strip**: one tab per Workspace, living in the app bar's draggable region at the top of the window. Each tab shows the Workspace `name` and, for **inactive** Workspaces, the union `ringing` bell and `todo` pill from `docs/specs/alert.md`, reusing the Door indicator vocabulary. The **active** Workspace's tab shows no union indicator: its alerts are already visible on its own panes and doors. Exact tab visuals are settled in the Storybook UI pass.

Concrete switch/create/close/rename keyboard shortcuts are chosen alongside the Storybook UI pass. Command mode is the natural home for them, following the tmux *window* bindings the rest of the keymap mirrors (a Dormouse Workspace is the analogue of a tmux window). `docs/specs/shortcuts.md` lists them once bound.

### Stage 4 — real switching and multi-Workspace activation

Activating another Workspace (`switchWorkspace`) mounts the target Workspace's Surfaces into the Wall — rebuilding its Lath layout and reattaching its doors — and unmounts the previously active Workspace's Surfaces. For a terminal Surface this reuses the `mount` / `unmount` registry ops: the Registry entry and PTY survive `unmount`, so Process stays `Live`. A browser surface's backing agent-browser session or proxy grant likewise survives while its viewer resources are released. Because a terminal's Activity keeps flowing while unmounted, an inactive Workspace's tab can begin ringing or showing TODO while the user is elsewhere. Mounting must not fire a fresh ring (glossary I8, mirroring the minimize/reattach rule I3).

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
