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

- **Content** — tiling layout containing Panes, powered by dockview
- **Baseboard** — bottom strip containing Doors and shortcut hints. It is visible in the main shell; tightly constrained embedders may suppress it with `Wall showBaseboard={false}` when they do not expose door/minimize workflows.

The user can navigate between all elements using the mouse, or by entering `command` mode and using the keyboard.

```
Wall
├── Context providers (Mode, SelectedId, WallActions, PanelElements, DoorElements, RenamingId, Zoomed, WindowFocused)
│   └── div (h-screen, flex col)
│       ├── Dockview wrapper (flex-1, 6px top/sides inset, 2px bottom inset)
│       │   ├── DockviewReact (tiling layout engine, singleTabMode="fullwidth")
│       │   │   └── Groups (one session per group, no tab stacking)
│       │   │       ├── TerminalPanel → TerminalPane → xterm.js
│       │   │       └── TerminalPaneHeader (tab component, drag handle)
│       │   └── WorkspaceSelectionOverlay (fixed positioned, pointer-events: none)
│       ├── Baseboard (bottom strip, shortcut hints when empty; optional for constrained embedders)
│       │   └── Door components (one per minimized session)
│       └── KillConfirmOverlay (conditional)
```

### What dockview controls
- Spatial arrangement of groups in a grid
- Resize sashes between groups
- Drag-and-drop rearrangement via pane headers
- Group sizing and positioning

### What we control
- Focus and selection state (`selectedId`, `selectedType`)
- Passthrough/command mode system
- Keyboard shortcuts and selection overlay rendering
- Session lifecycle: minimize (pane → door), reattach (door → pane), kill
- Terminal lifecycle (via terminal-registry)
- Activity monitoring and alert state
- TODO state management
- Session persistence (save/restore across restarts)

## Content

The content area is a tiling layout of panes, powered by dockview. Each pane occupies its own group (no tab stacking). Panes are separated by a 6px gap. DockviewReact uses `singleTabMode="fullwidth"` so tabs stretch to fill the header.

### Tiling constraints

**One session per group.** Dockview supports multiple panels per group (tabs), but we enforce one-panel-per-group to behave like a tiling window manager.

**No tab stacking.** Prevented via:
- `onWillShowOverlay`: `event.kind === 'tab'` → blocked
- `group.model.onWillDrop`: `event.position === 'center'` → intercepted and converted to a **swap**
- All other positions and kinds are allowed — these create splits

**Center drop = swap.** Dropping a pane onto the center of another swaps their session content (same as `Cmd/Ctrl+Arrow`). The overlay is allowed so the user sees a valid drop target, but `group.model.onWillDrop` intercepts it, calls `swapTerminals()` + swaps titles, then `preventDefault()` to block the merge.

### Pane header

Each pane has a 30px header that doubles as a drag handle. The header uses `cursor-grab` / `active:cursor-grabbing`, `select-none`, and the shared terminal top radius from `lib/src/components/design.tsx`. Background and foreground use the `--color-header-active-*` / `--color-header-inactive-*` token pairs, which map to VSCode file-tree list colors. Dockview's default close button and right-actions container are hidden via CSS.

The header label is the `DerivedHeader` returned by `deriveHeader(paneState, visiblePanes)` in `docs/specs/terminal-state.md` — that spec is the single source of truth for the priority chain (user-pinned title, app-sent overrides, current command title, `<idle> ${LAST_TITLE}` for finished panes, plain `<idle>` for fresh panes), the disambiguator rule, and which OSC sources contribute. Layout's job is to render the result: the primary label truncates with ellipsis, the secondary label (when present) is shown muted next to it, click renames/pins, right-click opens the diagnostic popup.

The diagnostic popup lists the latest entry per `titleCandidates` channel as defined in `docs/specs/terminal-state.md`. Each row shows the channel, latest candidate text, and timestamp. The popup is diagnostic only; it does not change the title priority rules.

Elements from left to right:

- Derived session label (click to rename/pin, right-click to inspect title candidates, truncates with ellipsis)
- Alert bell button (reflects session activity status)
- TODO pill (if todo state is set; hidden in minimal tier)
- Flexible gap
- Mouse-reporting override icon (only when the inside program requests mouse reporting; hidden in minimal tier)
- SplitHorizontalIcon `split left/right [|]` (full tier only)
- SplitVerticalIcon `split top/bottom [-]` (full tier only)
- ArrowsOutIcon / ArrowsInIcon `zoom / unzoom [z]` (full tier only)
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

Below the content area is the baseboard (`h-7`, 28px). It is visible by default and has no top divider. The dockview area ends 2px above it, leaving a narrow theme-colored gap that keeps rounded pane corners distinct from the baseboard. Its horizontal padding matches the Dockview wrapper's 6px inset, so doors align with the panes above. When empty, it shows keyboard shortcut hints when there are no doors and the container is wider than 350px — platform-aware: `LCmd → RCmd to enter command mode` on macOS, `LShift → RShift to enter command mode` elsewhere (`Baseboard.tsx`).

`Wall` accepts `showBaseboard={false}` for constrained embedders such as the website's mobile Pocket playground, where a separate bottom navigation owns the area below the terminal and door workflows are outside the prototype scope. The main app shell keeps the default `showBaseboard=true`.

When a session is minimized, it becomes a **door** on the baseboard. The door displays the same derived terminal label as the pane header, a TODO badge (if set), and an alert bell icon with activity dot. It uses the bottom edge of the window as its bottom border, with left, top, and right borders using the shared terminal top radius from `lib/src/components/design.tsx` — resembling a mouse hole and matching pane rounding. Door dimensions: `min-w-[68px] max-w-[220px] h-6`.

### Door interaction

- **Clicking a door** (in any mode): restores the session into the content area as a pane and enters passthrough mode. The terminal gets focus immediately.
- **Enter** on a door (command mode): same as clicking — restores and enters passthrough mode.
- **m** or **d** on a door (command mode): restores the session into a pane but stays in command mode. This is the inverse of pressing `m`/`d` on a pane (which minimizes it), making them toggles.
- **x** on a door (command mode): restores the session into a pane, then immediately shows the kill confirmation.
- **Arrow keys** can navigate to doors from panes (see Navigation).

### Baseboard responsive sizing

Doors are measured in a hidden off-screen container first:

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

A **Workspace** is one Wall's worth of Surfaces (terminal Sessions and browser surfaces) plus its layout, with a user-facing name. The standalone Window hosts several Workspaces but mounts only one — the **active** Workspace — at a time. Each Workspace owns its own Content (dockview layout) and Baseboard (doors).

What exists today lives behind the `dormouse.flags.workspaces` flag (`WORKSPACES_FLAG_KEY` in `lib/src/lib/feature-flags.ts`, **off by default**): the in-memory workspace model and its container verbs (`createWorkspace` / `closeWorkspace` / `renameWorkspace` / `setActiveWorkspace` in `lib/src/lib/workspace-store.ts`), the union projection (`computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`), and Window persistence (`PersistedWindow`, `docs/specs/transport.md`). `setActiveWorkspace` changes the active id in the model but does not yet re-render the Wall, and the single-Workspace cap is still in place. With the flag off, the app persists a bare `PersistedSession` and runs exactly one implicit Workspace — byte-identical to pre-workspace behavior.

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
- Click or press `Enter` on a door (restores session first)
- Focus is deferred via `requestAnimationFrame` to prevent dockview from stealing it

**Enter command mode:**
- Left Cmd keydown, then Right Cmd keydown within 500ms — or the same left-then-right gesture with Shift (Left Shift, then Right Shift within 500ms)
- Detected via capture-phase `keydown` listener on `e.key === 'Meta'` (or `e.key === 'Shift'`) and `e.location` (1 = left, 2 = right). The Meta and Shift tracks are independent, so a Left Cmd followed by a Right Shift does not trigger.
- Works even when xterm has DOM focus because listener uses capture phase
- On keyboards without a right Meta key (common on Windows/Linux laptops), the Shift track is the available gesture; both tracks are always active.

## Keyboard shortcuts (command mode)

All handled in a single capture-phase `keydown` listener on `window`. Every handled key calls `preventDefault()` + `stopPropagation()`. While a rename input is active, all shortcuts are bypassed.

| Key | On pane | On door |
|-----|---------|---------|
| `\|` / `%` | Horizontal split — new pane to the right | — |
| `-` / `"` | Vertical split — new pane below | — |
| Arrow keys | Spatial navigation between panes | Left/Right between doors, Up to panes |
| `Cmd/Ctrl+Arrow` | Swap session content with neighbor | — |
| `Enter` | Enter passthrough mode | Restore session + enter passthrough |
| `,` | Inline rename | — |
| `x` / `k` | Kill with confirmation | Restore session + kill confirmation |
| `m` / `d` | Minimize to door | Restore session (stay in command) |
| `z` | Toggle maximize/restore | — |
| `t` | Toggle TODO flag | — |
| `a` | Dismiss or toggle alert | — |

### Split cwd inheritance

When a split is initiated from an existing pane (via `|`/`%`/`-`/`"`, the header split buttons, or `Cmd/Ctrl+Click` on a split icon), the new pane spawns with its source pane's last-known cwd as the spawn directory. The source cwd is read from `getTerminalPaneState(sourceId).cwd`; remote cwds (`isRemote === true`, e.g. an OSC 7 path reported over ssh) are ignored because they aren't usable as a local spawn cwd. When no source cwd is known, when the split has no source pane (initial pane creation), or when the source is remote, the host's default cwd applies. The inherited cwd rides through `setPendingShellOpts` alongside the inherited shell selection and is consumed by `getOrCreateTerminal` on the next `platform.spawnPty`.

### Kill confirmation

Pressing `x` (or clicking the kill button) enters command mode and shows a pane-centered semi-transparent overlay (`KillConfirmOverlay` → `KillConfirmModal`) with a random lowercase letter (a-z, excluding x). Typing that letter confirms the kill (destroys session, removes pane). Cancel with Escape key, clicking the `[ESC] to cancel` button, or clicking another panel. Any other key triggers a shake animation (400ms `shake-x` keyframe) then auto-dismisses the confirmation.

Untouched sessions skip this confirmation. A newly spawned shell starts `untouched: true`; the first user-originated PTY input flips it to false. Inputs that count include printable keys, Enter, control keys, keyboard CSI such as arrows/history, paste, and file-drop path insertion. Replay-shaped terminal reports and stripped mouse-report-only input do not count (the untouched gate checks `inputIsReplayTerminalReport`; the broader synthetic-report check gates input recording and alert attention, not this flag). Killing an untouched pane runs the normal kill animation/dispose path immediately. Killing an untouched door first reattaches it only far enough to reuse the same pane removal path, then kills it without showing the confirmation overlay.

## Selection overlay

A fixed-positioned element rendered on top of dockview. Covers the active element's area inflated by 3px (half the 6px gap) for panes; doors are not inflated.

- A pane or door can be **active** or **inactive**. Only one element is active at a time.
- **Passthrough:** `border: 1px solid ${color}` — no glow
- **Command:** animated SVG marching-ants border — rounded rectangle path with `stroke-dasharray` animation (10px segment, 60% dash / 40% gap, 0.4s cycle, 2px stroke)
- Border radius: shared terminal radius from `lib/src/components/design.tsx`: full `0.5rem` for panes, `0.5rem 0.5rem 0 0` for doors
- Color from CSS custom property `--mt-selection-terminal`
- `z-index: 50`, `pointer-events: none`, `transition: 150ms`

### Position tracking
- `components/wall/TerminalPanel.tsx` registers its DOM element in a `paneElements` Map on mount, removes on unmount
- Door elements are registered by the `Baseboard` via `DoorElementsContext` from `components/wall/wall-context.tsx` (queries `[data-door-id]` attributes)
- Updates on: selection change, resize (`ResizeObserver`), layout change (`api.onDidLayoutChange`)

## Spatial navigation

### Direction detection

Uses DOM positions of pane elements (registered in `paneElements` Map). For each candidate:

1. **Edge-based direction check**: candidate must be entirely in the correct direction on the primary axis
2. **Overlap requirement**: candidate must overlap on the secondary axis
3. **Distance**: edge-to-edge on the primary axis
4. **Fallback**: if no overlapping candidate, nearest non-overlapping candidate

### Back-navigation

A breadcrumb tracks the last navigation direction and origin pane. Pressing the opposite direction returns to the origin instead of spatial lookup. This handles asymmetric layouts (tall pane left, stacked panes right).

### Pane-to-door navigation

Down from the bottom-most pane navigates to the first door in the baseboard. Up from a door navigates to the last pane. Left/Right navigates between doors.

### Cmd/Ctrl+Arrow swap

Swaps session **content** between two panes — the layout shape is unchanged. Uses `swapTerminals()` from terminal-registry which swaps registry entries and reattaches DOM elements to each other's containers. Also swaps dockview panel titles. Selection follows the moved session. Uses the same back-navigation breadcrumb as arrow keys.

## Minimize and reattach

### Minimize (`m` key or minimize header button)
1. Capture reattach context before removing:
   - `neighborId` and `direction`: spatial position relative to nearest neighbor
   - `remainingPaneIds`: sorted IDs of panes that stay
   - `layoutAtMinimize`: full layout snapshot
   - `layoutAtMinimizeSignature`: structural fingerprint (ignores sizes)
2. Remove pane from dockview (`api.removePanel`)
3. Add to `doors` state → door appears in baseboard. The door stores only the stable dockview/user title for persistence; its visible label is derived from live terminal semantic state at render time.
4. Session stays in registry (not disposed)
5. Selection moves to the new door (stays in command mode)

### Reattach (click door, Enter/d on door)
Three strategies based on layout state:

**Exact reattach** (layout structure signature matches AND same panes exist):
- Deserialize the saved layout snapshot with `reuseExistingPanels: true`
- Preserves exact split ratios from before minimize

**Neighbor reattach** (neighbor still exists AND pane set matches `remainingPaneIds`):
- `addPanel` with `position: { referencePanel: neighborId, direction }`
- Restores original position relative to neighbor

**Aspect-ratio split** (layout changed):
- Split the currently selected pane
- Direction: wider than tall → split right, otherwise split below

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

For a terminal Surface the pane ID is its session ID. `TerminalPane` calls `getOrCreateTerminal(id)` on React mount and `unmountElement(id)` on React unmount. The session (xterm.js instance, PTY, DOM element) persists in the registry across mount/unmount cycles — the DOM element is detached from its container but the Registry entry stays `Mounted`. A browser surface's pane ID is a Surface id with no registry entry or PTY (`docs/specs/glossary.md`); its DOM is owned by dockview and it is reconstructed from persisted params, not from the registry.

- **Create**: `getOrCreateTerminal` spawns xterm.js + UnicodeGraphemesAddon + FitAddon + PTY, returns existing if already created. The xterm instance sets `allowProposedApi: true` because UnicodeGraphemesAddon activates through xterm's proposed Unicode API.
- **Resume**: `resumeTerminal` creates xterm entry and writes replay data without spawning a new PTY. Used when the webview is recreated while the host retains Live PTYs (Link: Severed → Resuming → Live).
- **Restore**: `restoreTerminal` creates xterm entry and spawns a new PTY with saved cwd and scrollback. Used on cold start from a saved Snapshot (Link: Cold → Live).
- **Untouched**: new `getOrCreateTerminal` sessions start untouched. `isUntouched(id)` exposes the flag, and user-originated PTY input clears it via the registry input paths. Resume/restore seed the persisted flag; missing legacy snapshot data defaults to touched (`false`) so close confirmation remains conservative.
- **Shell selection replacement**: the standalone shell dropdown and VS Code shell picker send `dormouse:new-terminal` with `replaceUntouched` when the selected shell type changes. `Wall` always creates a new session id for that request. If the currently selected pane or door is untouched, the new terminal is inserted in the same dockview position (`direction: 'within'`; doors first reattach through the normal restore path), the old untouched session is disposed, and the old panel is removed without kill confirmation. If the selected terminal is touched or no terminal is selected, the request spawns a new pane near the active panel. Announced shell-selection spawns show a transient pane-anchored notice such as `Switched to zsh` or `Opened bash`.
- During resume/restore replay, xterm.js may emit terminal-generated replies for OSC/CSI/DCS queries that were embedded in saved output. The registry drops those replay-time replies before they reach the new shell. This filter is limited to query/focus reports, and must not swallow user keyboard escape sequences such as arrows, function keys, or bracketed paste.
- **mount / unmount (DOM)**: `mountElement` reparents the persistent DOM element into a container; `unmountElement` removes it. The Registry entry survives.
- **Dispose**: `disposeSession` kills the PTY, disposes xterm, removes the registry entry. Only called on explicit kill (`x`).
- **Swap**: `swapTerminals` swaps two registry entries and reattaches DOM elements to each other's containers.

### Session persistence

Layout, scrollback, cwd, minimized items, user-pinned titles, untouched state, and alert state are saved to persistent storage via a debounced save (500ms). Derived command/app labels shown on minimized doors are display-only and are not persisted as user-pinned titles. Saves are triggered by layout changes, panel add/remove, and a 30s periodic interval. Saves are flushed immediately on PTY exit, `pagehide`, and extension shutdown requests.

In standalone, each Workspace's snapshot is wrapped in a Window snapshot that records every Workspace (name + layout) and which one is active, so all Workspaces — not just the mounted one — survive a restart. VS Code persists one Workspace per webview exactly as today (one snapshot per `WebviewView` / `WebviewPanel`). The persisted container types (`PersistedWorkspace`, `PersistedWindow`) and their migration live in `docs/specs/transport.md`.

Saved snapshots are read through `readPersistedSession()`, which accepts the canonical object shape and defensively parses a JSON-stringified blob before validation and migration. This keeps malformed storage inert while covering hosts that hand back serialized JSON instead of the parsed object.

On startup, recovery is priority-based:
1. **Resume** (webview hidden/shown, live PTYs): request PTY list + replay data from platform, `resumeTerminal()` for each (500ms timeout). Saved pane and door titles are seeded back via `setTerminalUserTitle()` (see `docs/specs/transport.md`) so persisted placeholder labels never replay as user pins. If the saved session covers every live PTY, restore the saved dockview layout when its visible panel set matches and reattach saved minimized items as doors. This still counts as a live resume when every live session is minimized, so recovery must not fall through to cold restore just because the visible `paneIds` list is empty.
2. **Restore** (app restart, cold start): restore layout from serialized dockview state, `restoreTerminal()` for each pane with saved cwd + scrollback, and spawn each PTY with the current default shell selection
3. **Fallback/manual pane creation**: when no saved layout can be safely applied, add multiple panes as splits from the previous pane rather than tabs, and spawn each PTY with the current default shell selection
4. **Empty state**: create a single new pane with the current default shell selection

### Activity state

Each session carries `ActivityState` with `status: SessionStatus`, `watchingEnabled: boolean`, `todo: boolean`, and `notification: ActivityNotification | null`. `status` is the projected public status from the timer-based WATCHING track, terminal-report protocol track, and command-exit track described in `docs/specs/alert.md`; it may be `OSC_NOTIF_BUSY` when OSC progress has cocked the bell or `COMMAND_EXIT_ARMED` when a watched foreground command is running after attention was lost. `watchingEnabled` keeps the WATCHING toggle accurate when `status` is projected to a stronger protocol or command-exit state. These are synced to React via `useSyncExternalStore`. State that arrives from the platform before a registry entry exists (resume scenario) is held as "primed state" and applied when the registry entry is created.

Each session also carries `TerminalPaneState` from `docs/specs/terminal-state.md`. The frontend store is keyed by the current pane/session id, and PTY-originated semantic events are resolved through `ptyId` so swapped sessions keep their CWD and command state with the terminal content.

## Theme

Custom `dormouseTheme` extends dockview's `themeAbyss`. Source of truth:
`dormouseTheme` in `lib/src/components/Wall.tsx` defines gap and dnd overlay
settings; `lib/src/index.css` defines dockview CSS-var overrides such as pane
header height. The dockview area uses a 6px top/sides inset and 2px bottom
inset (`px-1.5 pt-1.5 pb-0.5` on wrapper, `inset-x-1.5 top-1.5 bottom-0.5` on
container).

Colors use a two-layer CSS variable strategy: `@theme --color-*` tokens → `var(--vscode-*)`. VSCode provides host theme variables in extension mode; standalone and website mode apply bundled or installed theme variables before rendering. Tailwind v4 `@theme` block registers `--color-*` tokens as Tailwind colors (e.g., `bg-app-bg`, `text-app-fg`, `border-border`). See `theme.css` for the full token map.

Dockview's separator borders, sash handles, and groupview borders are all set to transparent/none — the 6px gap is the only visual separator between panes. Dockview infrastructure paints `var(--color-app-bg)` so gutters and rounded pane/header corner cutouts match host chrome. Terminal content backgrounds are painted by the React terminal wrappers and xterm host elements, not by dockview containers.

## Animations

All pane-related motion is 440ms with `cubic-bezier(0.22, 1, 0.36, 1)` and uses `clip-path` (not `transform`) so `getBoundingClientRect` remains accurate during animation — the selection overlay measures the real post-animation bounds without lag. Reduced-motion users skip every animation described below.

### Spawn (new pane reveal)

When a pane is added, its dockview group element gets a directional `.pane-spawning-from-{left,top,top-left}` class. The clip-path starts fully closed from the opposite edge(s) and reveals to `inset(0)`. Direction is chosen by how the pane was born:

- **Horizontal split** (new pane on the right) → reveal from the left edge.
- **Vertical split** (new pane below) → reveal from the top edge.
- **Auto-spawn after last-pane kill/minimize** → reveal from the top-left corner.

The direction is carried via `FreshlySpawnedContext` — a `Map<paneId, SpawnDirection>` written by the spawn call site and consumed once by `TerminalPanel`'s `useLayoutEffect` on first mount.

Shell-selection replacement uses the same pane add/remove primitives but also shows a short fixed-position notice over the resulting pane. The notice fades in/out over 1500ms via `.shell-spawn-notice` and is suppressed to a static render for reduced-motion users.

### Kill (in-place fade + FLIP reclaim)

`orchestrateKill(api, killedId, wasSelected, …, onRemoved?)` in `lib/src/lib/kill-animation.ts` runs on kill confirmation. `Wall.tsx` owns the command dispatch and calls it after the user confirms. The optional `onRemoved` callback fires once, on every path, immediately after `removePanel`: collapsing a branch can re-parent and blur the surviving selected pane, so `killPaneImmediately` uses it to re-assert that pane's DOM focus (through the shared `reassertPaneFocus` guard, see corner case #12). It fades the real pane element in place (its content dissolves against the same-colored background), then removes the panel and FLIP-reveals the survivors:

1. Add `.pane-fading-out` (or `.pane-fading-and-shrinking-to-br` for a last-pane kill) to the killed pane's group element. Block pointer events during the fade.
2. On `animationend`, snapshot `getBoundingClientRect` for every surviving panel's group element.
3. `disposeSession` + `api.removePanel`; dockview snaps the layout.
4. Measure post-rects. Any panel whose rect grew is a "grower."
5. For each grower, apply an inline `clip-path: inset(...)` with the newly-claimed territory clipped off, force a reflow, then transition to `inset(0)`. This reveals the grower into the vacated space without affecting `getBoundingClientRect`. Clears on `transitionend`.

Case handling is purely rect-based (measure before and after removal), so 2-pane splits, linear 3+ rows/columns, and nested splits all fall through the same code path with no per-case branching.

Selection tail: after removal, `orchestrateKill` moves selection to a survivor (`panels[0]`, or `null` → auto-spawn when the last pane goes) **only when `wasSelected`** — the killed pane was the selected one. `killPaneImmediately` computes `wasSelected = selectedId === killedId`, so killing a background surface (`dor kill surface:3`, or the header kill button on an unselected pane) leaves the user's selection untouched.

### Auto-spawn delay

When `onDidRemovePanel` triggers the "always keep one pane visible" auto-spawn (see corner case #10), the `api.addPanel` call is deferred by 440ms **for the minimize path** — letting the selection-overlay slide to the door finish before the replacement's reveal starts. The kill path uses no extra delay (0ms): kill sequencing is already handled inside `orchestrateKill`, which removes the panel only after the fade's `animationend`. Reduced-motion users also get 0ms. The deferred spawn re-checks `totalPanels` at fire time and becomes a no-op if anything repopulated the pane area during the delay (e.g. a door reattach). If it does create a replacement pane, that pane spawns with the current default shell selection, matching manual splits and the standalone `[+]` action.

The deferred spawn also only calls `selectPane` if selection is null. Killing the *selected* last pane clears selection to null (`orchestrateKill`'s `wasSelected` tail), so the new pane takes focus; killing an unselected pane leaves selection where it was. The minimize flow sets selection to the just-created door; preserving that door focus across the delay is the point.

## Corner cases

1. **Dual React instance**: dockview bundles its own React. Fixed with `resolve.dedupe: ['react', 'react-dom']` in Vite config.
2. **White screen on boot**: `DockviewReact` needs pixel dimensions. Fixed with relative wrapper + absolute inner container.
3. **Theme as prop**: dockview v5 uses `theme={themeObject}` prop, not a CSS class.
4. **xterm steals Meta keys**: mode-exit gesture uses `capture: true` on the window keydown listener.
5. **Click doesn't focus terminal**: focus deferred to `requestAnimationFrame` to prevent dockview from stealing it.
6. **Stale hitboxes after DnD**: each `TerminalPanel` registers its own DOM element in a Map for overlay/navigation.
7. **Asymmetric back-navigation**: breadcrumb tracks last direction + origin for opposite-direction return.
8. **Center drop merges panels**: intercepted at group-level `model.onWillDrop` and converted to a swap.
9. **Group drag has null panelId**: falls back to `api.getGroup(groupId).activePanel.id`.
10. **Auto-spawn on empty**: `onDidRemovePanel` creates a new session whenever the last visible pane is removed, whether or not doors exist — there is always a pane visible. The `addPanel` call is delayed 440ms on the minimize path (see "Auto-spawn delay" under Animations); the kill path is sequenced by `orchestrateKill` instead.
11. **Door focus survives auto-spawn**: `api.addPanel` auto-activates the new panel, firing `onDidActivePanelChange`. When the current selection is a door (e.g., just-minimized last pane), that listener must not flip `selectedId` to the new pane — otherwise `selectedType === 'door'` + `selectedId === newPaneId` desyncs and the door loses its highlight while the `WorkspaceSelectionOverlay` is stuck on the stale door rect. The listener early-returns when `selectedType === 'door'`.
12. **Focus-neutral surface creation (`dor ensure` / `dor iframe` / `dor ab`)**: unlike `dor split`, these must never move focus off the caller (`docs/specs/dor-cli.md`, `docs/specs/dor-browser.md`). Adding the pane `inactive` does **not** work: dockview renders and lays out a pane only once it becomes its group's active panel (a new group's `setActive` runs `doSetActivePanel`), so an `inactive` add — which skips both — leaves the pane behind a blank tile until the first click activates it. Instead the shared `runSurfaceAdd(focusNeutral, add)` helper adds the pane **active** (so it renders), then `add` hands the active group straight back to the caller via `settleFocusAfterAdd` (`caller.api.setActive()`); the new pane stays active *within its own group* and keeps rendering. The helper sets `suppressActivationSelectRef` to gate the `onDidActivePanelChange` listener (#11) across both activations so `selectedId`/mode never leave the caller. But adding the pane re-parents the caller's grid subtree in the DOM, which **blurs its xterm textarea** — and since `selectedId` never changed, `TerminalPanel`'s focus effect does not re-run to reclaim it, so the caller would silently stop receiving keystrokes until clicked. So the helper re-asserts the selected pane's focus with a deferred `focusSession` through the shared `reassertPaneFocus` rAF helper (deferred to beat dockview's post-split focus handling, like the click-focus rAF in `enterTerminalMode`), gated on three conditions: the pane is still the selected pane in passthrough (the condition `TerminalPanel` uses for `isFocused`, so a legitimate selection move makes it a no-op); the window still has focus (`document.hasFocus()` — a background `dor` command must never yank cross-frame focus out of the host editor, e.g. VS Code); and DOM focus is not in an in-page editable control (the inline-rename input, a non-terminal `<input>`/`<textarea>`/contenteditable — re-parent blur drops focus to `<body>`, so a focused control means the user put it there; the terminal's own `xterm-helper-textarea` is exempt since re-focusing it is idempotent). Callers skip `selectPane`; the `--minimize` case passes `select: false` to `minimizePane` so it creates the door without stealing selection or switching to command mode. (`dor iframe` / `dor ab` replacing the pane the user is *currently selected on* are the exception: selection follows to the replacement, since it would otherwise dangle on the removed panel. Replacing an active-but-unselected pane leaves the user's selection — including a door selection — untouched.) If a freshly created shell never reports OSC 633 integration, ensure tears the throwaway pane down with `killPaneImmediately`; because the focus-neutral create never selected it, `orchestrateKill`'s `wasSelected` gate (see the kill "Selection tail" above) leaves the caller's selection intact.

## Files

| File | Role |
|------|------|
| `lib/src/components/Wall.tsx` | Main layout orchestrator: selected mode/state, session actions, minimize/reattach, provider composition |
| `lib/src/components/wall/wall-types.ts` / `wall-context.tsx` | Shared Wall types and React contexts used by Wall, pane headers, panels, overlays, and the baseboard |
| `lib/src/components/wall/TerminalPanel.tsx` | Dockview panel body wrapper; registers pane DOM elements and plays spawn animation |
| `lib/src/components/wall/TerminalPaneHeader.tsx` | Custom dockview tab/header with rename, alert/TODO, mouse override, split/zoom/minimize/kill controls |
| `lib/src/components/wall/WorkspaceSelectionOverlay.tsx` | Pane/door focus ring and marching-ants overlay |
| `lib/src/components/wall/MarchingAntsRect.tsx` | SVG marching-ants border path and dash sizing |
| `lib/src/components/wall/MouseOverrideBanner.tsx` | Temporary mouse override banner shown from the header icon |
| `lib/src/components/wall/use-dockview-ready.ts` | Dockview ready/setup handler: restore/create panels, DnD swap wiring, active panel sync, auto-spawn |
| `lib/src/components/wall/use-wall-keyboard.ts` | Capture-phase keyboard dispatch for mode switching, pane/door commands, copy/paste, selection drag keys |
| `lib/src/lib/vscode-keybindings.ts` | VS Code-hosted workbench chord mirror allowlist |
| `lib/src/components/wall/use-session-persistence.ts` | Debounced layout/session save, flush requests, pagehide, PTY exit, file-drop paste routing |
| `lib/src/components/wall/use-window-focused.ts` | Window focus tracking hook for header and selection overlay dimming |
| `lib/src/components/Baseboard.tsx` | Always-visible bottom strip with door components, overflow arrows, and shortcut hints |
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
| `lib/src/lib/spatial-nav.ts` | Spatial navigation (`findPaneInDirection`) and reattach-neighbor detection (`findReattachNeighbor`) |
| `lib/src/lib/layout-snapshot.ts` | Layout cloning (`cloneLayout`) and structural signature (`getLayoutStructureSignature`) for restore comparison |
| `lib/src/lib/activity-monitor.ts` | Per-session activity state machine: output timing → alert escalation |
| `lib/src/lib/alert-manager.ts` | Manages ActivityMonitors + attention tracking + TODO state per session |
| `lib/src/lib/session-types.ts` | Type definitions for persisted sessions (`PersistedPane`, `PersistedDoor`, `PersistedSession`) |
| `lib/src/lib/session-save.ts` | Serialization: collects layout, scrollback, cwd, alert state for persistence |
| `lib/src/lib/session-restore.ts` | Deserialization: loads saved session, calls `restoreTerminal()` for each pane |
| `lib/src/lib/reconnect.ts` | Priority-based recovery: live PTYs first, then saved session, then empty |
| `lib/src/lib/resume-patterns.ts` | Detects resumable commands (`claude --resume`, etc.) in scrollback |
| `lib/src/index.css` | Dockview theme overrides — separator/sash/border removal, background flattening |
| `lib/src/theme.css` | Two-layer VSCode theme token system (`@theme --color-*` → `--vscode-*`) and Tailwind v4 `@theme` integration |

## Maintainer checklist

When changing layout behavior:

- Changing a command-mode binding or the mode-switch gesture: update the shortcut table here **and** `docs/specs/shortcuts.md` in the same edit.
- Pane-header changes: this spec owns placement and sizing only. Bell/TODO behavior and visual states belong to `docs/specs/alert.md`; the mouse-override icon and banner to `docs/specs/mouse-and-clipboard.md`; the derived label to `docs/specs/terminal-state.md`.
- Persisted-shape changes (`PersistedPane` / `PersistedDoor` / layout blobs) belong to `docs/specs/transport.md` — add the migration note there.
- New pane chrome uses tokens from `lib/src/components/design.tsx` (see AGENTS.md Design); never raw color classes.
- Pane animations stay on `clip-path`, not `transform`, so `getBoundingClientRect` remains accurate for the selection overlay; respect reduced-motion.
- Anything workspace-strip or switching related stays under `## Future` (workspaces-rollout) until built.

## Future

**Scope: workspaces-rollout** — the remaining stages of the multi-Workspace feature. The model, container verbs, persistence, and union projection are implemented, dormant behind `dormouse.flags.workspaces` (see [Workspaces](#workspaces) above; persisted containers in `docs/specs/transport.md`, union projection in `docs/specs/alert.md`). This ledger is the single home for what remains; other specs link here rather than restating it.

### Stage 3 — workspace strip and switching UI (standalone)

The standalone app bar (`standalone/src/AppBar.tsx`) grows a horizontal **workspace strip**: one tab per Workspace, living in the app bar's draggable region at the top of the window. Each tab shows the Workspace `name` and, for **inactive** Workspaces, the union `ringing` bell and `todo` pill from `docs/specs/alert.md`, reusing the Door indicator vocabulary. The **active** Workspace's tab shows no union indicator: its alerts are already visible on its own panes and doors. Exact tab visuals are settled in the Storybook UI pass.

Concrete switch/create/close/rename keyboard shortcuts are chosen alongside the Storybook UI pass. Command mode is the natural home for them, following the tmux *window* bindings the rest of the keymap mirrors (a Dormouse Workspace is the analogue of a tmux window). `docs/specs/shortcuts.md` lists them once bound.

### Stage 4 — real switching and multi-Workspace activation

Activating another Workspace (`switchWorkspace`) mounts the target Workspace's Surfaces into the Wall — rebuilding its dockview layout and reattaching its doors — and unmounts the previously active Workspace's Surfaces. For a terminal Surface this reuses the `mount` / `unmount` registry ops: the Registry entry and PTY survive `unmount`, so Process stays `Live`. A browser surface's backing agent-browser session or proxy grant likewise survives while its viewer resources are released. Because a terminal's Activity keeps flowing while unmounted, an inactive Workspace's tab can begin ringing or showing TODO while the user is elsewhere. Mounting must not fire a fresh ring (glossary I8, mirroring the minimize/reattach rule I3).

Stage 4 also lifts the single-Workspace cap and wires the lifecycle UX:

- **Create** (`createWorkspace`): adds a new Workspace, gives it a default name (`Workspace N`), makes it active, and spawns a single fresh pane — matching the empty-state behavior in Session persistence above.
- **Close** (`closeWorkspace`): `kill`s each member Surface and removes the Workspace. Closing a Workspace that contains touched Surfaces confirms first (reusing the kill-confirm vocabulary); the exact confirmation surface is settled in the Storybook UI pass. The last remaining Workspace cannot be closed — there is always one active Workspace, just as there is always one visible pane (corner case #10).
- **Rename** (`renameWorkspace`): edits the Workspace `name` only. It does not touch any Surface title or the per-pane inline rename.
