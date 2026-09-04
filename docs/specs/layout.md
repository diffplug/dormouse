# Layout Spec

> See `docs/specs/glossary.md` for canonical state names, layer definitions, and transition verbs. This spec uses the glossary's vocabulary throughout.
>
> **Owns:** the interaction model on top of Lath — modes and keyboard dispatch, navigation, minimize/reattach, kill/rename, the selection overlay, session lifecycle + persistence recovery, and the workspaces-rollout ledger. Pane chrome: placement and sizing only.
>
> **Defers:** engine internals (split tree, rects, DnD, animator) to `docs/specs/tiling-engine.md`; alert/TODO/speech behavior and visual states to `docs/specs/alert.md`; per-Session semantic state (CWD, command lifecycle, title candidates, header derivation, grouping keys) to `docs/specs/terminal-state.md`; browser surfaces to `docs/specs/dor-browser.md`; selection/copy/paste and the mouse-override icon to `docs/specs/mouse-and-clipboard.md`; persisted shapes to `docs/specs/transport.md`; tokens to `docs/specs/theme.md`.
>
> **Convention:** "Session" where a statement is terminal-specific, "Surface" where it holds for both.

## Conceptual model

A Wall renders one Workspace's Surfaces as Panes in Content or Doors on the Baseboard. Pane↔Door preserves the Surface; a Doored browser Surface keeps its backing session while releasing its viewer resources ([Minimize and reattach](#minimize-and-reattach)). The standalone Workspace strip and switching are staged in [Future](#future) (**Scope: workspaces-rollout**); VS Code maps each Workspace to a webview (`docs/specs/vscode.md`).

## Shell layout

Two areas: **Content**, the tiling layout of Panes rendered by the **Lath** engine, and **Baseboard**, the bottom strip of Doors and shortcut hints — always present in the app shell, suppressible with `Wall showBaseboard={false}`.

```
Wall
├── Context providers (Mode, SelectedId, WallActions, PaneWrite, PaneElements,
│   │                  DoorElements, RenamingId, Zoomed, WindowFocused, DialogKeyboard)
│   └── div (flex-1, flex col)
│       ├── Content wrapper
│       │   ├── LathHost (the tiling engine's HTML adapter)
│       │   │   └── Leaf divs (one per Surface)
│       │   │       ├── TerminalPanel → TerminalPane → xterm.js  (or BrowserPanel)
│       │   │       └── TerminalPaneHeader (drag handle)          (or SurfacePaneHeader)
│       │   └── WorkspaceSelectionOverlay
│       ├── Baseboard
│       │   └── Door components (one per minimized session)
│       └── KillConfirmOverlay / ShellSpawnNotice / modal hosts (conditional)
```

**Lath owns** the split tree, per-leaf rects, sashes and `layout()`; resize, hierarchical drag-and-drop, zoom geometry; and the FLIP animation of splits/kills/restores.

**The Wall owns** focus and selection state (`selectedId` / `selectedType`), the passthrough/command mode system, keyboard dispatch and selection-overlay rendering, the minimize/reattach/kill lifecycle, terminal lifecycle via the registry, Activity + TODO state, and session persistence. Source of truth: `lib/src/components/wall/wall-types.ts`, `lib/src/components/wall/wall-context.tsx`.

## Content

Each pane is one **leaf** in Lath's split tree — a stable, absolutely-positioned div that is **never re-parented** (`docs/specs/tiling-engine.md` → "The HTML adapter (LathHost)"). **One Surface per leaf, always**; there is no tab stacking. Splitting inserts a sibling leaf; removing collapses single-child splits back.

Panes are separated by a 7px gap (`PANE_GUTTER_PX`), odd so the 1px selection ring centers in it on whole pixels ([Selection overlay](#selection-overlay)).

**Center drop = swap, edge drop = split.** Dragging a pane onto another's *center* swaps their Surfaces exactly as `Cmd/Ctrl+Arrow` does ([Spatial navigation](#spatial-navigation)); onto an *edge* band splits beside that leaf, or beside an ancestor column/row chosen by scroll-wheel depth. `docs/specs/tiling-engine.md` → "Hierarchical drag and drop" owns the model; the Wall owns only the op commit + selection policy. **A baseboard drop is a no-op when `showBaseboard={false}`** — there is nowhere to minimize into. Source of truth: `onProposeMove` / `onProposeMinimize` / `onExternalDrop` in `lib/src/components/Wall.tsx`.

### Pane header

A 30px header doubling as a drag handle: **a `pointerdown` past a 5px threshold begins a Lath pane drag**; below the threshold the header's own click behavior stands. It uses `cursor-grab` / `active:cursor-grabbing`, `select-none`, the shared terminal top radius from `lib/src/components/design.tsx`, and the `--color-header-active-*` / `--color-header-inactive-*` token pairs (VSCode file-tree list colors).

Elements left to right: derived label; alert bell; TODO pill (compact+); flexible gap; mouse-reporting override icon (compact+, only while the inside program requests mouse reporting); split left/right, split top/bottom, zoom/unzoom (full only); minimize; kill (hover turns error-red).

The label is the `DerivedHeader` from `deriveHeader(...)`; `docs/specs/terminal-state.md` owns the priority chain and disambiguator. Layout renders it: primary truncates with ellipsis, secondary muted beside it, a failed last command appends an error-colored glyph. Click renames/pins; right-click — or `>` in command mode — opens the header context menu.

#### Header context menu

**One menu per pane, opened by right-click anywhere on the header or by `>` in command mode** — at the pointer, or under the header's left edge (`data-pane-header-for` plus a synthetic `contextmenu`, so both paths share one code path). **Only terminal panes have it**; browser surfaces and Doors have no header, so `>` no-ops there. Only the alert bell owns its own right-click (`stopPropagation`, opening the alert dialog); every other region, the title span included, bubbles here. It is portaled to `document.body`, viewport-clamped, and dismissed by outside `pointerdown`, `Escape`, `resize`, or capture-phase `scroll` — **never by a scroll originating inside the menu**, since arrow-key focus moves auto-scroll the overflowing list.

Content, top to bottom:

- **Header row** — display title, the pane's `surface:N` handle (`resolveSurfaceRef`, muted), close button.
- **Title-candidates table** — latest entry per `titleCandidates` channel (`docs/specs/terminal-state.md`): channel, text, timestamp; else a muted `No title candidates`. **Diagnostic only** — it changes no title priority rule.
- **Port rows** — the TCP ports the pane's process tree binds, scanned by `getOpenPorts` **once per open** (reopen to rescan): a spinner, then one `host:port` row per distinct port (digit chip first, process name muted beside it), else a muted `no listening ports` / `port scan failed`.

**The menu owns the keyboard while open**: DOM focus on mount, the previously focused element restored when a dismissal leaves input ownership unchanged, and registration as dialog-keyboard-active so command-mode keys don't fire underneath. `1`–`9` activate the matching port row and **presses during the scan are dropped, never buffered**; `↑`/`↓` rove the rows (wrapping), `Enter`/`Space` activate the focused row, `Tab`/`Shift+Tab` cycle every focusable element, `Escape` closes.

Activating a port row reproduces `dor ab open <url>` for that port and closes the menu at once (`docs/specs/dor-browser.md` → Pane Context Menu Connect): the browser surface becomes the selection in passthrough, reattaching first if minimized — **the one command-mode gesture that moves selection off the pane it targeted and exits command mode** — with loading/errors surfacing in the pane, not the menu. With no `agentBrowserCommand` the rows are inert labels with no digit chips. Source of truth: `lib/src/components/wall/PaneHeaderContextMenu.tsx`, `lib/src/components/wall/TerminalPaneHeader.tsx`, `lib/src/components/wall/keyboard/handle-pane-shortcuts.ts`.

### Pane body

The pane body paints `--color-terminal-bg` on the React pane wrapper and the `TerminalPane` mount point; the persistent xterm host element, `.xterm-screen`, and the xterm scroll container also carry the concrete background from `getTerminalTheme()`. **The host background must match the terminal screen exactly** and clip to the pane's shared rounded bottom corners (rationale). Source of truth: `lib/src/components/wall/TerminalPanel.tsx`, `lib/src/components/TerminalPane.tsx`.

### Spoken-alarm overlay

A terminal Session with transient speech-delivery state gets a pointer-transparent overlay spanning its whole Lath leaf; browser surfaces never render it. It resolves through the tiling engine's per-leaf overlay slot (`docs/specs/tiling-engine.md`) and **must never intercept pointer/focus routing or change leaf geometry**.

**Two layers straddling the header's stacking context** (`.lath-leaf-header` is `position: relative; z-index: 20`):

- **Wash + label at `z-index: 19`** — above terminal content, below the header and below the `z-index: 20` pane-corner mouse-override banner, so neither is tinted (rationale). Both states wash, `SPEAKING` at 20% opacity and `SPOKEN` at half that — `SPOKEN` is an unbounded window, so its haze must stay light enough to read terminal text through. **Never use color-alpha utilities here** — their emitted `color-mix()` is unsupported by the standalone Safari 15 / Chrome 105 targets; the solid alarm color lives on a dedicated child whose element opacity supplies those strengths. The label sits `PANE_HEADER_HEIGHT_PX + 4` from the Pane top, centered, in both states.
- **Perimeter ring at `z-index: 25`** — above the header so the treatment reads as one rounded rectangle around the whole Pane, below the `z-index: 30` sashes (rationale). 5px for `SPEAKING`, 3px for `SPOKEN`.

Both layers wear the leaf's own rounding (header radius on top, terminal radius on the bottom). Under `SPEAKING` both pulse when motion is allowed and `cfg.alert.ringingPaused` is not set. Source of truth: `lib/src/components/wall/AlertSpeechIndicator.tsx`, registered as the `terminal` overlay by `lib/src/components/wall/LathHost.tsx`.

### Pane header responsive sizing

A ResizeObserver picks one of three tiers by header width:

- **Full** (>280px): everything.
- **Compact** (>160px): split, zoom, and unzoom hidden.
- **Minimal** (≤160px): also hides the TODO pill and the mouse-override icon, leaving alert, minimize, and kill. The label truncates with ellipsis.

## Baseboard

The baseboard (`h-7`, 28px) sits below the content area, visible by default, with no top divider. The content area ends 2px above it, leaving a theme-colored gap that keeps rounded pane corners distinct; its horizontal padding matches the content wrapper's 7px inset, so doors align with the panes above. With no doors and more than 350px of width it shows a platform-aware shortcut hint — `LCmd → RCmd to enter command mode` on macOS, `LShift → RShift to enter command mode` elsewhere.

`Wall showBaseboard={false}` serves an embedder with no door/minimize workflow: no strip, the content wrapper's bottom inset grown from 2px to 7px, a baseboard drop a no-op. **It is a seam, not a shipped configuration** — no production host passes it (rationale), so the app shell always has a baseboard.

The far right is one right-aligned flex cluster: the `N more →` overflow arrow, the host-supplied `notice` slot (standalone puts the update banner there), then three always-present 24px **Settings** controls — 16px speaker/slashed-speaker for spoken alarms, 16px ringing-bell/slashed-bell for push notifications, 16px sliders for the dialog itself. **Shape and accessible text both carry each state**, so status never relies on color. All three open the same app-global Settings dialog (`docs/specs/alert.md` → Alarm settings); **the status controls never toggle settings directly**. Every baseboard-level button shares one class constant in `Baseboard.tsx`.

A minimized session becomes a **door**, showing the pane header's derived label plus the alert/TODO/speech badge cluster (`docs/specs/alert.md` → Door owns which badge shows when; both speech states also name themselves in the Door's `title` and accessible name). A Door uses the window's bottom edge as its bottom border, with left, top, and right borders taking the shared terminal top radius from `lib/src/components/design.tsx` — a mouse hole matching pane rounding. Dimensions: `min-w-[68px] max-w-[220px] h-6`.

### Door interaction

- **Click** (any mode) or **Enter** (command mode): restore the session as a pane and enter passthrough; the terminal gets focus immediately.
- **m** / **d** (command mode): restore into a pane but stay in command mode — the inverse of `m`/`d` on a pane, making them toggles.
- **x** / **k** (command mode): restore into a pane, then show the kill confirmation (an untouched Surface is killed outright — [Kill confirmation](#kill-confirmation)).
- **Arrow keys** navigate to and between doors ([Spatial navigation](#spatial-navigation)).

**A reattach that stays in command mode defers its follow-up** (focus, kill, replace) to `requestAnimationFrame` and skips it if the pane vanished in between.

### Baseboard responsive sizing

Doors are measured in a hidden off-screen container first, then fitted:

- **Subtract the measured right cluster and its gap before fitting anything** — that space is never available to doors. Measure only its always-present part (notice + the three settings controls): **never the overflow arrow**, whose presence is an *output* of the fit.
- Add doors until no more fit, reserving room for a `N more →` button whenever items remain after the current one. **At least one door is always shown**, even if it overflows.
- If scrolled, show `← N more` on the left and/or `N more →` on the right. Overflow counts are assumed single-digit (the hidden measurement button is `9 more`).
- Clicking an overflow arrow reveals one door in that direction; a longer title may push more doors off the opposite side.
- Extreme case — one door with a very long title and more doors on both sides: show both arrows with counts and as much title as fits, ellipsis for the rest.

Source of truth: `lib/src/components/Baseboard.tsx`, `lib/src/components/Door.tsx`.

## Workspaces

Each Workspace owns its own Content (Lath layout) and Baseboard (doors); the standalone Window holds several but mounts only the **active** one. Union status is `docs/specs/alert.md`'s; VS Code's per-webview mapping is `docs/specs/vscode.md`'s.

What exists today: the in-memory model and its container verbs (`createWorkspace` / `closeWorkspace` / `renameWorkspace` / `setActiveWorkspace` in `lib/src/lib/workspace-store.ts`), the union projection (`computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`), and Window persistence — the only thing `dormouse.flags.workspaces` (`WORKSPACES_FLAG_KEY` in `lib/src/lib/feature-flags.ts`, **off by default**) actually gates: `lib/src/lib/window-persistence.ts` is an identity passthrough with the flag off, so the standalone host stores a bare `PersistedSession`, and wraps/unwraps a `PersistedWindow` with it on (`docs/specs/transport.md`); VS Code never goes through it. No production code calls the container verbs yet, and `setActiveWorkspace` does not re-render the Wall, so the app runs exactly one implicit Workspace either way.

The strip UI, real switching, and lifecycle UX are staged in [Future](#future) — this spec's `## Future` is the single rollout ledger; other specs link here.

## Modes

Wall starts in `command` mode. Embedders may pass `initialMode="passthrough"` when the first pane is an already-running interactive surface that should receive keyboard input immediately.

### Passthrough mode
- Keyboard input routes to the active session's xterm.js instance, which holds DOM focus.
- **Three interceptions only**: the mode-exit gesture (below), the terminal selection/copy/paste chords (`docs/specs/mouse-and-clipboard.md`), and clipboard chords inside one of Dormouse's own text fields.
- In VS Code, selected workbench chords are mirrored: xterm still processes the key and Dormouse also asks the extension host to run the matching VS Code command; [the VS Code host spec](vscode.md) owns the allowlist.
- Selection overlay: 1px solid border.

### Command mode
- Keyboard drives navigation and commands; the Session receives no input.
- Selection overlay: the animated marching-ants border.

### Mode switching

**Enter passthrough mode:** clicking any pane body or header; `Enter` or `z` on a selected pane; creating a terminal through a manual split (`|` / `%` / `-` / `"`, a header split button) or a host New Terminal action; clicking or pressing `Enter` on a door (restoring the session first). **Focus is always deferred via `requestAnimationFrame`** so it lands after the click/mousedown event finishes.

**Enter command mode:** Left Cmd keydown, then Right Cmd keydown within 500ms — or the same left-then-right gesture with Shift.

- Detected in a capture-phase `keydown` listener on `e.key === 'Meta'` (or `'Shift'`) plus `e.location`, so it fires even while xterm holds DOM focus. **Anything but `location === 1` counts as the right-hand key.**
- **The Meta and Shift tracks are independent** — Left Cmd then Right Shift does not trigger — and **both are always live** (rationale).
- **A bare Meta/Shift press is always consumed by this detector**, so no later handler mistakes it for a command key.
- A zoomed focused pane starts unzoom immediately when keyboard focus returns to command mode.

## Keyboard shortcuts (command mode)

`docs/specs/shortcuts.md` tables every binding; this section owns the dispatch behavior behind it.

All keys are handled in one capture-phase `keydown` listener on `window` (`use-wall-keyboard.ts`), which delegates in a fixed order to the modules in `lib/src/components/wall/keyboard/`: dual-tap → editable-field clipboard → mouse-selection keys → *(passthrough stops here)* → *(rename stops here)* → kill confirmation → *(an open dialog stops here)* → pane shortcuts → pane navigation. **Every handled key calls `preventDefault()` + `stopPropagation()`.**

That order is load-bearing twice: a rename input suppresses the pane shortcuts but **not** the mode-exit gesture or the field's own clipboard chords; and a staged kill confirmation hijacks *every* key before the dialog gate, so the confirm letter works even though the modal is open.

### Split cwd inheritance

A split from an existing pane (`|`/`%`/`-`/`"` or the header split buttons) spawns the new pane with its source pane's last-known cwd, then selects it and enters passthrough; host New Terminal actions share that focus tail (rationale). Focus-neutral control-plane creation (`dor split -- …`, `dor ensure`, `dor iframe`, `dor ab`) keeps its documented background behavior.

The source cwd is read from `getTerminalPaneState(sourceId).cwd`. **Never inherit a remote cwd** (`isRemote === true`, e.g. an OSC 7 path reported over ssh) — it is not a usable local spawn cwd. The host default applies when the source cwd is unknown, remote, or absent (initial pane creation). The inherited cwd rides `setPendingShellOpts` alongside the inherited shell selection, consumed by `getOrCreateTerminal` on the next `platform.spawnPty`.

### Kill confirmation

`x`/`k` (or the kill button, which first leaves passthrough) shows a pane-centered semi-transparent overlay (`KillConfirmOverlay` → `KillConfirmModal`) with a random lowercase letter; typing it confirms the kill. **`x` and `k` are excluded from that alphabet** so a double-tap can't accept itself. `Escape`, the `Esc to cancel` button, and clicking another panel cancel; any other key runs a 400ms `shake-x` animation and then auto-dismisses.

**Confirmation must be staged in a ref synchronously, not only in React state** — a second confirm keydown arriving before React flushes would otherwise pass the guard and kill twice (`lath.isDying` is the second line of defense).

**Untouched sessions skip this confirmation.** A newly spawned shell starts `untouched: true`; the first user-originated PTY input flips it to false. Counted: printable keys, Enter, control keys, keyboard CSI such as arrows/history, paste, file-drop path insertion. Not counted: replay-shaped terminal reports and stripped mouse-report-only input — **the gate checks `inputIsReplayTerminalReport`**, the broader synthetic-report check gating input recording and alert attention, not this flag. Killing an untouched pane runs the normal kill animation/dispose path immediately; killing an untouched door first reattaches it only far enough to reuse that removal path, then kills it with no overlay.

Source of truth: `acceptKill` in `lib/src/components/Wall.tsx`, `lib/src/components/KillConfirm.tsx`.

## Selection overlay

A fixed-positioned element on top of the Lath host, covering the active element's area inflated by `SELECTION_RING_INFLATE_PX` (4px) for panes; doors are not inflated. **The inflate is derived in `lib/src/components/design.tsx` so both ring strokes center on the gutter's midline** (rationale).

- **Exactly one pane or door is active at a time**, drawn by one SVG renderer (`SelectionRing`, `variant: 'ants' | 'solid'`).
- **Passthrough:** `variant='solid'` — a 1px solid SVG stroke, centerline `strokeWidth/2` inside the div edge for panes and doors alike, no glow (rationale).
- **Command:** `variant='ants'` — marching-ants border (`cfg.marchingAnts`: 10px segment, 60% dash, four 0.4s cycles, 2px stroke). **Run the burst on command entry or identity change, then hold still** (test: `starts a finite burst on command entry and remounts the outline on a selection change` in `lib/src/components/wall/WorkspaceSelectionOverlay.test.tsx`; rationale). Keep it unchanged during travel and draw the smear separately ([Ring travel](#ring-travel)). **While unfocused, pause it and apply `saturate(0.3)` to the ring.**
- Border radius follows DESIGN.md's Concentric-Corners Rule: the pane ring's radius is the pane radius plus the inflate (`PANE_SELECTION_RING_RADIUS_PX`), with the marching-ants path inset so its stroke centerline sits on the same gutter midline; doors sit at zero offset and keep `0.5rem 0.5rem 0 0`.
- Color is the resolved `--color-focus-ring`, **re-read whenever `document.body`'s class/style changes**, because the dynamic palette publishes it there (`useFocusRingColor`).
- `z-index: 50`, `pointer-events: none`.

### Ring travel

The ring's rect (and its `{tl,tr,br,bl,inset}` shape) is driven **per-frame by a JS tween, never a CSS transition**; DESIGN.md's ban on animating layout properties does not reach it (rationale). Motion is `FOCUS_MOTION_MS` (220ms — half `LATH_MOTION_MS`) on the house curve `cubic-bezier(0.22, 1, 0.36, 1)`.

Per-frame writes are **imperative**: `SelectionRing` gives the overlay refs to its stable shell; the rAF loop writes rect, path `d`, marching dash, and smear geometry, then **re-applies after structural renders, pre-paint**, so fresh nodes do not flash. **Never reintroduce per-frame React state** — reconciling this subtree competes with travel for the frame budget (rationale).

- **Identity change → tween.** A measurement whose identity (`${selectedType}:${selectedId}`) differs from the one on screen glides from the current interpolated position to the new target, **clock restarted**, so arrow-key spam stays responsive.
- **Same identity → snap 1:1.** A same-identity re-measure with no tween in flight (sash drag, window resize, a settled leaf's store commit) writes the new rect directly, tracking the geometry exactly instead of easing behind it.
- **In-flight retarget.** A same-identity re-measure *during* a tween retargets the destination **without resetting the clock**, so the ring converges on a moving target (select-a-neighbor-during-kill) and still lands on the original completion instant.
- **Snap gate.** `motionIsInstant()` — `!cfg.layout.animate` (Chromatic) or `prefersReducedMotion()` — settles the ring instantly; it is the same predicate the Lath animator's duration uses, so ring and leaves agree. **A ring appearing with nothing on screen also snaps**: there is no `from` to glide from.
- **The unfocus-saturate fade is the one CSS transition** (`filter ${FOCUS_MOTION_MS}ms`, set inline by `SelectionRing.tsx`); neither the snap gate nor reduced motion touches it. Under Chromatic it snapshots already finished (pinned in `lib/.storybook/preview.ts`).
- Pane↔door selection morphs the corner radii (12px all-round ⇄ `8,8,0,0`) and stroke inset through the same tween, so the shape lerps instead of popping.

Source of truth: `lib/src/lib/rect-tween.ts` (position and velocity), `lib/src/lib/ring-geometry.ts` (outline/smear geometry), `lib/src/components/wall/WorkspaceSelectionOverlay.tsx` (the rAF loop), `lib/src/components/wall/SelectionRing.tsx` (the SVG shell).

#### Directional motion smear

Each travelling edge trails a soft band sized by its own motion. A line smears only by moving *across* itself, so **a horizontal edge is driven by its vertical speed and a vertical edge by its horizontal speed, and all four edges are independent.** Each speed normalizes against `cfg.focusRing.smearFullSpeed` into a single `t`; width ramps from `strokeWidth` to `smearMaxPx`, alpha from 0 to `smearPeakAlpha`. **Both start at zero**, so a stationary edge lays no band under the crisp ring. A settled or reduced-motion ring has null speeds and the smear layer is `display: none`, keeping snapshots deterministic.

- **Velocity is analytic**: `sampleRingVelocity` differentiates the tween (`E'` from `LATH_EASING.slope`), so the smear peaks on the opening frame and needs no smoothing. **Never finite-difference rendered positions** (rationale).
- **Never divide alpha by the widening factor** — extent and intensity are independent knobs, and `smearFullSpeed` alone shapes a travel (rationale).
- **Never collapse the four edge speeds to one horizontal and one vertical**, e.g. from the ring *centre's* velocity (rationale).
- **Two layers**, because one closed path cannot carry four widths (rationale): the smear is a sibling `<g data-ring="smear">` of eight pieces drawn underneath, and **the ring (`<path data-ring="outline">`) is never transformed, re-dashed, or re-alpha'd.**
- **Eight pieces: four edges plus four corners**, every one cut from ONE shared point set (`ringPoints`) that `roundedRectPath` also walks, so the smear provably tiles the ring — pinned by `ring-geometry.test.ts`. A corner reaches two widths at once through a `scale` transform that `cornerPath` compensates for, and takes the mean of its two edges' opacity (rationale; mechanism documented at `cornerPath`). **Find each piece by `data-piece`, never by index.**
- **Dash length is computed, never measured.** `ringPerimeter` returns the outline's exact length in closed form — straight runs plus `1.6232252401402307 × r` per corner. **Never substitute `π/2`** (the quarter-*circle* value: 3% short, silently shifting every dash) **or reinstate `SVGGeometryElement.getTotalLength()`** (a synchronous style+layout flush every frame) (rationale).
- **Never reintroduce an SVG `feGaussianBlur` here** — WebKit CPU-rasterizes SVG filters every frame. The cost is SVG filters specifically: stroke widths, scale transforms, opacities and CSS `filter: blur()` are all GPU-composited and free (rationale).

Source of truth: `lib/src/lib/ring-geometry.ts`.

### Position tracking

Each pane body registers its DOM element in a `paneElements` Map on mount and removes it on unmount (`usePaneChrome`); the overlay resolves the enclosing Lath leaf (`[data-lath-leaf]`) via `resolvePaneElement`, so the ring covers header + body. Doors are registered by the `Baseboard` through `DoorElementsContext` (`[data-door-id]`), **only the *visible* subset** — an overflowed door has no element to measure.

Re-measures on: selection change, `ResizeObserver` on the target, every Lath store commit (`revision` via `useSyncExternalStore`), and — while the wall streams animator frames — every frame, so the ring tracks kills, restores and tweens frame-accurately. **If the selected leaf is momentarily absent the overlay bails and holds the last rect.**

Source of truth: `lib/src/components/wall/WorkspaceSelectionOverlay.tsx`, `lib/src/components/wall/resolve-pane-element.ts`, `lib/src/components/wall/use-window-focused.ts`.

## Spatial navigation

**Arrow navigation resolves against Lath's pure `neighbors(tree, rect, id, direction, opts)` query, never a DOM rect scan** — the same laid-out rects the screen shows (`docs/specs/tiling-engine.md` → "Layout"). The keyboard handlers reach it through the engine-neutral `WallNav` seam (`lib/src/components/wall/keyboard/types.ts`), whose `findInDirection` calls `lath.store.neighborOf`: a candidate must be strictly beyond the leaf's edge on the primary axis; one overlapping on the secondary axis is preferred; ties break deterministically on nearest edge-to-edge distance; with no overlapping candidate the nearest non-overlapping one wins.

**Back-navigation.** A breadcrumb tracks the last navigation direction and origin pane; **the opposite direction returns to the origin instead of doing a spatial lookup**, which is what makes asymmetric layouts navigate reversibly.

**Pane↔door.** Down from a pane with no pane below it selects the *first* door; Up from a door selects the *last* pane; Left/Right moves between doors. **Doors have no spatial query** — they are an ordered list.

**`Cmd/Ctrl+Arrow` swap.** Swaps Surface **content** between two panes, leaving the layout shape unchanged. One Lath `swap` op trades the two leaf identities, and because per-leaf metadata and terminal-registry entries are keyed by id, title/params/session follow automatically — **never write a companion title swap** — with no DOM reattach. Selection stays on the moved Surface, so **the breadcrumb records the *partner*** (the pane now holding the old slot): the opposite `Cmd+Arrow` swaps back exactly and a plain opposite arrow selects the partner.

## Minimize and reattach

### Minimize (`m`/`d`, the header button, or a drag onto the baseboard)

`lath.store.doorLeaf(id, { park })` detaches the leaf and returns a JSON-serializable **restore token** (`docs/specs/tiling-engine.md` → "Restore tokens"); the Wall appends `{ id, token }` to its `doors` state and moves selection to the new door in command mode. **The Session stays in the registry — nothing is disposed.** Minimizing the *last* pane also triggers the refill ([Auto-spawn refill](#auto-spawn-refill)). A pane dragged onto the baseboard takes the identical path (`onProposeMinimize` → `minimizePane`).

**A runtime Door is `{ id, token }` and carries no metadata.** Title, params and parked-ness stay in the Lath store, which keeps changing while the Surface is Doored, so no copy can go stale: **every reader — reattach, `dor` param matching, kill/session teardown, `dor list`, the baseboard chip's label, the session save — goes through `lath.getMeta(id)`**, and the persisted `PersistedDoor` row is materialized from the store at save time.

**A minimized browser Surface parks rather than unmounting** (`shouldParkOnMinimize`); terminals do not. `docs/specs/tiling-engine.md` → "Parked leaves" owns the mechanism, who parks, the `MAX_PARKED_SURFACES` cap, and the visibility contract.

### Reattach (click door, `Enter`/`m`/`d` on door, or drag out)

`lath.restoreLeaf(meta, token, { fallbackRef })` applies the token's three-tier exact/neighbor/fallback policy (`docs/specs/tiling-engine.md` → "Restore tokens"). The Wall supplies the fallback reference — the selected pane if live, else the first pane — and, if the restore still fails (no token, empty tree), adds the leaf as the root, so **a reattach is never silently swallowed**.

A door dragged out of the baseboard skips the token entirely and inserts at the hit-tested drop position the user chose (`onExternalDrop` → `lath.insertLeaf`). **Either path unparks in the same commit that re-admits the Surface**, so the DOM is never momentarily unmounted.

### Splitting from a Door

`dor split --surface <minimized-ref>` and `dor ensure --surface <minimized-ref>` **create the new terminal Surface directly as a Door** rather than rejecting the reference or restoring it first. It is inserted immediately to the right of the reference Door, and **the response reports `minimized: true` even without `--minimize`**. Its restore token's neighbor tier points at the reference Door, so restoring the new Door can still split beside the reference if that was restored first. **`--auto` resolves to `right` for a Door reference** — there is no visible pane geometry to inspect.

## Inline rename

Triggered by `,` in command mode or by clicking the session name in the pane header.

The name `<span>` is replaced by an `InlineEditInput` (shared with the browser URL editor in `docs/specs/dor-browser.md`): same font (`font-mono font-medium`), `bg-transparent`, no border, seeded from the label with the failure glyph stripped. `Enter` confirms, `Escape` cancels, `blur` confirms — **whichever lands first settles the edit**, so the blur following an Enter/Escape unmount cannot submit a second time. It stops propagation on `mousedown`/`click`/`keydown` so the panel click and the header drag never fire.

The field is **controlled by its own draft state**, seeded at mount and untouched by later prop changes, and **the `select()` ref callback has a stable identity** so it runs exactly once (rationale). **Mounting is the reset** — the editor exists only during a rename, so each one starts from the current label. Clipboard chords inside the field are the wall's job on hosts whose webview has no native Edit menu (`docs/specs/mouse-and-clipboard.md` §8.9).

Submitted values are rejected when empty or when they fail the `setTerminalUserTitle` validation that also guards title seeding (`docs/specs/terminal-state.md` → Supported OSC Inputs). `<unnamed>` is the default panel placeholder but is otherwise allowed as a user pin. **On rejection the input still closes** — it is not a blocking dialog — and a warning popover anchored under it names the offending value, dismissing on the next pointerdown, scroll, resize, `Escape`, or after `cfg.overlays.warningAutoDismissMs` (3s; 0 under Chromatic, pinned in `lib/.storybook/preview.ts`).

Source of truth: `lib/src/components/wall/IllegalRenameWarning.tsx`, `lib/src/components/wall/use-dismiss-overlay.ts`.

## Session lifecycle and terminal registry

For a terminal Surface the pane ID is its session ID. `TerminalPane` calls `getOrCreateTerminal(id)` on React mount and `unmountElement(id)` on React unmount; **the session (xterm.js instance, PTY, DOM element) persists in the registry across mount/unmount cycles**, and an unmounted element leaves the entry `Orphaned`. A browser surface's pane ID is a Surface id with no registry entry or PTY (`docs/specs/glossary.md`); its DOM is hosted by LathHost's leaf div and rebuilt from persisted params, never from the registry.

| Op | Behavior |
|---|---|
| **Create** `getOrCreateTerminal` | Spawns xterm.js + UnicodeGraphemesAddon + FitAddon + PTY; returns the existing entry if already created. `allowProposedApi: true`, since UnicodeGraphemesAddon needs xterm's proposed Unicode API. **The WebGL addon is not loaded here** ([Renderer](#renderer)). |
| **Resume** `resumeTerminal` | Creates the xterm entry and writes replay data, spawning no PTY. Webview recreated while the host retains Live PTYs (Link: Severed → Resuming → Live). |
| **Restore** `restoreTerminal` | Creates the xterm entry and spawns a new PTY with the saved cwd; **replays no transcript** (`docs/specs/transport.md` → "What is persisted"). Cold start from a saved Snapshot (Link: Cold → Live). |
| **mount / unmount** | `mountElement` reparents the persistent DOM element into a container, `unmountElement` removes it. **The Registry entry survives.** |
| **Dispose** `disposeSession` | Kills the PTY, disposes xterm, removes the registry entry. **Only on explicit kill (`x`).** |
| **Swap** | `Cmd/Ctrl+Arrow` trades two leaf identities via a Lath `swap`; registry entries follow the ids ([Spatial navigation](#spatial-navigation)). |

- **Untouched**: new `getOrCreateTerminal` sessions start untouched; `isUntouched(id)` exposes the flag, user-originated PTY input clears it, and resume/restore seed the persisted one. **Missing legacy snapshot data defaults to touched (`false`)**, keeping close confirmation conservative.
- **Shell selection replacement**: the standalone Settings dialog's Shell row and the VS Code shell picker send `dormouse:new-terminal` with `replaceUntouched` when the selected shell type changes. **A shell is identified by executable path plus ordered arguments**, so WSL distributions and Windows Developer shells sharing an executable stay distinct. **`Wall` always mints a new session id and a fresh `surface:N` ref.** An untouched selected pane or door has the new terminal take over its leaf via a Lath `replace` op (an atomic identity swap; doors reattach through the normal restore path first), the old session disposed and its ref retired; a touched selection, or none, spawns a new pane beside it. Announced spawns show a transient pane-anchored notice (`Switched to zsh`, `Opened bash`).
- **Replay-time terminal reports must be dropped; user input must not be** — during **resume** replay the registry drops the replies xterm.js emits to queries embedded in buffered output, before they reach the new shell (`docs/specs/terminal-escapes.md` → "Report filtering on the input side").

Source of truth: `lib/src/lib/terminal-store.ts` (registry maps and pending shell opts, imported directly, including by `lib/src/remote/host/`), `lib/src/lib/terminal-lifecycle.ts` (the ops), `lib/src/lib/terminal-registry.ts` (the facade).

### Agent resume on cold restore

On cold restore, a terminal pane with a host-captured recovery invocation runs it automatically; `docs/specs/transport.md` owns the restore-only gate, validation, and prompt-ready typing. Layout writes one dim `⟲ resuming agent session: <command>` line **to xterm, never the PTY**, to mark the discontinuity — a passive notice with no dismiss or lifecycle. Source of truth: `restoreTerminal` in `lib/src/lib/terminal-lifecycle.ts`, called from `lib/src/lib/session-restore.ts`.

### Renderer

Every terminal renders through stock `@xterm/addon-webgl`. **Claim the GL context on a session's first `mountElement`, never at creation**, guarded by `TerminalEntry.webglAttempted` so each session claims at most one (rationale). **xterm's built-in DOM renderer is the fallback, never the default** — its per-cell span rebuild makes a truecolor-dense TUI an order of magnitude slower (rationale).

**Fallback to the DOM renderer must stay automatic** — two expected failure modes:

- **No WebGL at all** (headless/jsdom, blocklisted GPU, a host webview with GPU disabled): construction throws and `tryEnableWebglRenderer` swallows it, behind a `typeof WebGL2RenderingContext === 'undefined'` pre-check that skips the doomed request entirely (rationale).
- **Context-budget eviction**: browsers cap live WebGL contexts per page — on the order of **16**, evicted oldest-first (rationale) — so one context per terminal means a Window past the cap silently drops its *oldest* panes back to the DOM renderer. The `onContextLoss` handler disposes the addon, xterm's documented signal to resume DOM rendering.

**Degradation is one-way**: a demoted pane stays on the DOM renderer even after other panes close. Re-arming is unbuilt — see `## Future`. The outcome is recorded as `data-renderer="webgl"|"dom"` on the host element, including after a context loss demotes a pane. `cfg.terminal.webglRenderer` disables the whole path, and it is off under Chromatic (pinned in `lib/.storybook/preview.ts`).

Source of truth: `tryEnableWebglRenderer` in `lib/src/lib/terminal-lifecycle.ts`. Not the SDF fork of `docs/specs/webgl-text.md`, a different addon consumed only by `canopy/`.

### Session persistence

The snapshot is written through a debounced (500ms) save, its layout in the native Lath format (`lathLayout`; `docs/specs/tiling-engine.md` → "Persistence"); `docs/specs/transport.md` → "Persistence policy" lists what is persisted and owns the never-persist rules. **Derived command/app labels on minimized doors are display-only** — never persisted as user-pinned titles.

Three save triggers, in ascending urgency:

- Any Lath store commit (add/remove/resize/swap/meta, including the active pane the layout records) **schedules** the debounced save.
- Content changes with no Lath commit — `onPtyData` (terminal output, OSC CWD, title candidates), activity/TODO, pane title/command state, minimized-door changes — only **mark the session dirty**; a 30s heartbeat persists only when dirty, so an idle app stops writing.
- PTY exit, `onRequestSessionFlush`, `pagehide`, unmount, and extension shutdown requests **flush immediately and unconditionally** — the correctness net for any dirty-trigger gap (a program calling `chdir()` emits no event, so its persisted CWD may go stale until the next output — accepted).

`docs/specs/standalone.md` §Persistence owns the dirty-gating mechanism and the store-level identical-value backstop.

Container shapes and the `dormouse.flags.workspaces` wrapping are `docs/specs/transport.md` → "Persisted session types" ([Workspaces](#workspaces)); VS Code persists one Workspace per webview (`WebviewView` / `WebviewPanel`).

Snapshots are read through `readPersistedSession()`, which tolerates a stringified blob and logs-and-discards an unreadable one so malformed storage starts fresh rather than blocking startup (`docs/specs/transport.md` → "Persisted session types").

Startup recovery is priority-based:
1. **Resume** (webview hidden/shown, live PTYs): request PTY list + replay data from the platform, `resumeTerminal()` each (500ms timeout). **Saved pane and door titles are seeded back via `setTerminalUserTitle()`** (`docs/specs/transport.md`), so persisted placeholder labels never replay as user pins. If the saved session covers every live PTY, restore the saved Lath layout when its leaf set matches and reattach saved minimized items as doors. **Never fall through to cold restore just because the visible `paneIds` list is empty** — a wall whose live sessions are all minimized is still a live resume.
2. **Restore** (app restart, cold start): the Wall's `seed` hydrates from the restored Lath layout, else falls to (3); `restoreTerminal()` per pane with its saved cwd and title. Browser surfaces are rebuilt from their persisted params instead.
3. **Fallback/manual pane creation**: with no saved layout safely applicable, add panes as splits from the previous pane.
4. **Empty state**: one new pane.

Every PTY spawned by (2)–(4) uses the current default shell selection.

Source of truth: `lib/src/components/wall/use-session-persistence.ts` (save triggers and flushes), `lib/src/lib/session-save.ts` (serialization), `lib/src/lib/reconnect.ts` (recovery priority).

### Activity state

Each Surface carries an `ActivityState` (`status`, `watchingEnabled`, `todo`, `notification`), synced to React via `useSyncExternalStore`. **State arriving from the platform *before* a registry entry exists** (the resume path) is staged as **primed state** and merged in when the entry is minted; a browser surface, which never gets a registry entry, keeps its activity in a parallel local map.

Each terminal Session also carries `TerminalPaneState` (`docs/specs/terminal-state.md`), keyed by pane/session id, with PTY-originated semantic events resolved through `ptyId` — so a swapped session keeps its CWD and command state with the terminal content.

Source of truth: `lib/src/lib/session-activity-store.ts` (the React snapshot store and the primed-state merge).

## Theme

`.lath-host` / `.lath-leaf` in `lib/src/index.css` give an app-bg host, a terminal-bg body, and a 30px header band per leaf, applied by LathHost from the shared `PANE_HEADER_HEIGHT_PX`. The content area uses a 7px top/sides inset and 2px bottom inset (`px-1.75 pt-1.75 pb-0.5` on wrapper, `inset-x-1.75 top-1.75 bottom-0.5` on container); **the `LATH_LAYOUT_OPTS` gap of `PANE_GUTTER_PX` is the only visual separator between panes**. The host paints `var(--color-app-bg)` so gutters and rounded pane/header corner cutouts match host chrome; **terminal content backgrounds are painted by the React terminal wrappers and xterm host elements, never by the leaf containers**. The two-layer `@theme --color-*` → `var(--vscode-*)` token strategy is `docs/specs/theme.md`'s.

## Animations

All pane motion is owned by the Lath **animator**, applied imperatively to the leaf divs by LathHost (`docs/specs/tiling-engine.md` → "Animation"): 440ms `cubic-bezier(0.22, 1, 0.36, 1)`, a 0 duration under reduced motion. **There are no CSS entrance/exit classes.** Those leaf divs carry the interpolated inline geometry, which is what lets the selection overlay measure the tween ([Position tracking](#position-tracking)). **Terminal panes must not refit every frame**: `TerminalPane`'s resize observer throttles `refitSession` — leading edge, at most one per ~150ms while resizes keep arriving, plus a trailing call at rest, so the resting geometry still gets an exact fit (rationale).

### Zoom (elevated expansion)

**Zoom is presentation-only** — the split tree and every tiled rect stay unchanged; the geometry (the 15px-inset wall rect, the elevated layer, the blurred app-bg halo) belongs to `docs/specs/tiling-engine.md`. **Zoom is coupled to passthrough focus**: acquiring it enters passthrough and focuses that pane; exiting passthrough, focusing another pane, or selecting a Door starts unzoom immediately.

**Only the owner's header shows Unzoom**, header tokens inverted so the escape action stands out, and only the owner's control toggles zoom *off*. The exposed perimeter leaves other headers reachable, so their Zoom control **hands zoom over — focus included** — rather than merely unzooming the owner. Source of truth: `ZoomedIdContext` in `lib/src/components/Wall.tsx`, `paneZoomButtonClass` in `lib/src/components/design.tsx`.

### Spawn (new pane reveal)

A newly added leaf enters by growing from the boundary it was placed against, at opacity 0 → 1. The store's mutators derive this **enter hint** from the edge they commit; **the auto-spawn refill overrides it to `'top-left'`**, since the killed last pane shrank toward the bottom-right (`docs/specs/tiling-engine.md` → "Animation" → Enter).

Shell-selection replacement shows a short fixed-position notice over the resulting pane, fading in/out over 1500ms via `.shell-spawn-notice`, suppressed to a static render under reduced motion.

### Kill (two-phase fade + tween reclaim)

`killPaneImmediately` in `Wall.tsx` runs the animator's two-phase exit — fade in place, then commit the removal after `lath.exitMs` so survivors tween into the reclaimed space. `docs/specs/tiling-engine.md` → "Animation" → Exit owns the mechanics, the idempotence guard, and the last-pane bottom-right shrink.

**Selection tail.** At removal time selection moves to a survivor (`lath.listPanes()[0]`, or `null` → auto-spawn when the last pane goes) **only when the killed pane is still the selected pane** — a live check, re-read inside the removal timeout, so a background kill leaves selection untouched and a selection move *during* the fade is honored both ways (rationale).

**A doored Surface has no visible pane to fade**, so `killPaneImmediately` branches: close any agent-browser session, `forgetLeaf` (which also unmounts a parked DOM), `disposeSession`, drop the door chip. Disposing stops the PTY, which also makes a still-armed `typeCommandWhenPromptReady` bail rather than type into a dead surface.

### Auto-spawn refill

A store commit that empties the tree (last pane killed or minimized) triggers the "always keep one pane visible" auto-spawn: a Wall effect subscribed to the store spawns one leaf into the emptied tree (`lib/src/components/Wall.tsx`), **re-entrantly on the same commit chain**, so the refill appears with no separate delay (rationale). It spawns with the current default shell selection, matching manual splits.

**The refill adopts the replacement (`selectPane`) only when the current selection points at nothing real** — null (the kill tail cleared it after a selected last-pane kill) or dangling (still naming the just-removed pane). **A valid selection is left alone** — the just-created door on the minimize path, or a live pane after an unselected kill — because the auto-spawn exists to keep a pane visible, not to steal selection.

## Corner cases

> Numbered for cross-spec reference; the numbers are stable, so append rather than renumber.

1. **xterm steals Meta keys**: the mode-exit gesture listens in the capture phase, so it fires even while xterm has DOM focus.
2. **A focused iframe surface is not a window blur**: it blurs the window while `document.hasFocus()` stays true, so **cross-session attention is cleared only on a *real* blur** — otherwise focusing an embed would wipe attention across the Wall.
3. **Stable hitboxes across moves**: a leaf measured after a move reports its new rect ([Position tracking](#position-tracking)), and Lath never re-parents a leaf div, so its node identity — and any embedded `<iframe>` — survives every op.
4. **Asymmetric back-navigation**: the breadcrumb ([Spatial navigation](#spatial-navigation)) makes every arrow move reversible even where no spatial query would return you.
5. **Door keeps selection through the auto-spawn refill** ([Auto-spawn refill](#auto-spawn-refill)). Explicit user selection of a pane — a click, a drag, or an embed focusing itself — still moves selection off a door.
6. **Focus-neutral surface creation (`dor ensure` / `dor iframe` / `dor ab`)**: unlike `dor split`, these open in the background without moving focus off the caller (`docs/specs/dor-cli.md`, `docs/specs/dor-browser.md`). An add never re-parents the caller's subtree or steals activation, and the create does not call `selectPane` (`settleAddSelection` returns false for a focus-neutral, non-selection-replacing add). **The one exception**: `dor iframe` / `dor ab` replacing the pane the user is *currently selected on* moves selection to the replacement, else it would dangle on the removed leaf; any other pane, or a door selection, is left untouched. A throwaway that never reports OSC 633 integration is torn down with `killPaneImmediately`, whose live selection check leaves the caller's selection intact (a `--minimize` throwaway is already a door, disposed directly).

## Future

**Scope: workspaces-rollout** — the remaining stages of the multi-Workspace feature. The model, container verbs, Window persistence (behind `dormouse.flags.workspaces`), and union projection are implemented but unwired ([Workspaces](#workspaces); persisted containers in `docs/specs/transport.md`, union projection in `docs/specs/alert.md`). This ledger is the single home for what remains; other specs link here rather than restating it.

### Stage 3 — workspace strip and switching UI (standalone)

The standalone app bar (`standalone/src/AppBar.tsx`) grows a horizontal **workspace strip**: one tab per Workspace, in the bar's draggable region. Each tab shows the Workspace `name` and, for **inactive** Workspaces only, the union `ringing` bell and `todo` pill from `docs/specs/alert.md`, reusing the Door indicator vocabulary — the active tab needs no union indicator, its alerts already being visible on its own panes and doors. Exact tab visuals settle in the Storybook UI pass.

Switch/create/close/rename shortcuts are chosen alongside that pass. Command mode is their natural home, following the tmux *window* bindings the rest of the keymap mirrors (a Dormouse Workspace is the analogue of a tmux window). `docs/specs/shortcuts.md` lists them once bound.

### Stage 4 — real switching and multi-Workspace activation

`switchWorkspace` mounts the target Workspace's Surfaces — rebuilding its Lath layout, reattaching its doors — and unmounts the previously active Workspace's. Terminals keep the `mount` / `unmount` + replay path: the Registry entry and PTY survive `unmount`, so Process stays `Live`. A browser surface's backing agent-browser session or proxy grant likewise survives while its viewer resources are released.

Switching **parks** the outgoing Workspace's browser Surfaces rather than unmounting them, on exactly the terms minimize already does (`docs/specs/tiling-engine.md` → "Parked leaves"): the switch parks each one, then seeds the incoming Workspace's tree, which `seed` is already written to survive — it keeps parked leaves except any the seed itself admits. That is what makes an iframe survive a round trip through another Workspace. Open question: a switch parks a whole Workspace at a time, so `MAX_PARKED_SURFACES` may need raising, or becoming a per-Workspace budget. VS Code is out of reach either way — one webview per Workspace ([Workspaces](#workspaces)) bounds cross-Workspace DOM survival by webview lifetime, not by anything the Wall does. Because a terminal's Activity keeps flowing while unmounted, an inactive Workspace's tab can begin ringing or showing TODO while the user is elsewhere; **mounting must not fire a fresh ring** (glossary I8, mirroring the minimize/reattach rule I3).

Stage 4 also lifts the single-Workspace cap and wires the lifecycle UX:

- **Create** (`createWorkspace`): adds a Workspace, names it `Workspace N`, makes it active, and spawns a single fresh pane — matching the empty-state behavior in Session persistence.
- **Close** (`closeWorkspace`): `kill`s each member Surface and removes the Workspace. Closing one holding touched Surfaces confirms first, reusing the kill-confirm vocabulary; the confirmation surface settles in the Storybook UI pass. **The last remaining Workspace cannot be closed** — there is always one active Workspace, as there is always one visible pane (corner case #5).
- **Rename** (`renameWorkspace`): edits the Workspace `name` only — no Surface title, and not the per-pane inline rename.

### Re-arming the WebGL renderer after context loss

A pane that loses its WebGL context ([Renderer](#renderer)) stays on the DOM renderer for the rest of its life, even once other panes close and free budget. The eviction order is also backwards for a tiling terminal: browsers evict *oldest-first*, but the pane that most deserves the GPU is the focused one.

The fix is to retry `tryEnableWebglRenderer` when a DOM-fallback pane gains focus. Unbuilt because the naive version thrashes: past the context cap, focusing panes in turn would evict and rebuild glyph atlases on every focus change, plausibly worse than sitting still on the DOM renderer. Any implementation needs a re-arm budget (at most once per pane, or a cooldown) and a measurement showing focus-cycling does not regress. Not worth building until someone runs a Window past the cap — 16 concurrent terminals is well beyond observed usage.
