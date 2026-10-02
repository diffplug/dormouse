# Layout Spec

> See `docs/specs/glossary.md` for canonical state names, layer definitions, and transition verbs. This spec uses the glossary's vocabulary throughout.
>
> **Owns:** the interaction model on top of Lath — modes and keyboard dispatch, navigation, minimize/reattach, kill/rename, the selection overlay, session lifecycle + persistence recovery, and the Workspace model. Pane chrome: placement and sizing only.
>
> **Defers:** engine internals (split tree, rects, DnD, animator) to `docs/specs/tiling-engine.md`; alert/TODO/speech behavior and visual states to `docs/specs/alert.md`; per-Session semantic state (CWD, command lifecycle, title candidates, header derivation, grouping keys) to `docs/specs/terminal-state.md`; browser surfaces to `docs/specs/dor-browser.md`; selection/copy/paste and the mouse-override icon to `docs/specs/mouse-and-clipboard.md`; persisted shapes to `docs/specs/transport.md`; tokens to `docs/specs/theme.md`.
>
> **Convention:** "Session" where a statement is terminal-specific, "Surface" where it holds for both.

## Conceptual model

A Wall renders one Workspace's Surfaces as Panes in Content or Doors on the Baseboard. Pane↔Door preserves the Surface; a Doored browser or Tool Surface keeps its backing session while releasing its viewer resources ([Minimize and reattach](#minimize-and-reattach)). Standalone mounts one Wall per Workspace and switches between them ([Workspaces](#workspaces)). VS Code maps each Workspace to a webview (`docs/specs/vscode.md`).

## Shell layout

Two areas: **Content**, the tiling layout of Panes rendered by the **Lath** engine, and **Baseboard**, the bottom strip of Doors and shortcut hints, always present in the app shell.

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

**A pane drag's depth model — center swap, edge split, ancestor levels by scroll wheel — belongs to `docs/specs/tiling-engine.md` → "Hierarchical drag and drop"**; the Wall owns only the op commit and the selection policy after it, a center drop landing exactly where `Cmd/Ctrl+Arrow` would ([Spatial navigation](#spatial-navigation)). Source of truth: `onProposeMove` / `onProposeMinimize` / `onExternalDrop` in `lib/src/components/Wall.tsx`.

### Pane header

**Must keep a Tool's unsaved-change dot visible in its Pane header and minimized Door**, across header widths and faces. Use inherited foreground, without animation; label and tooltip it “Unsaved changes”. In a Pane the dot replaces Kill’s glyph on the same button, with an accessible unsaved-state description, until hover or keyboard focus reveals the X; where the header tier or the rename editor hides Kill, it sits at the right edge. State semantics belong to `docs/specs/dor-tool.md` → Unsaved changes.

**Must mark the Workspace's preview slot with an italic label alone in its Pane header and Door**, naming it Preview in the label's tooltip and the Door's accessible name (rationale). **Must keep the slot on a double-click of its Pane header whose first press lands in the header itself, off its controls** (every button, and an open rename; rationale). **Must offer Keep open in its terminal context too**, beside the Tool status and only while it is the slot: the keyboard path to the same pin. Slot semantics belong to `docs/specs/dor-tool.md` → Preview slot.

**Must hold the slot's header while a switch holds its ghost** (`docs/specs/dor-tool.md` → Switching the slot): the ghost's face and Display glyph stay until the new view is ready. A terminal face's label keeps its name until the retarget, then shows the Tool's name (`docs/specs/dor-tool.md` → Naming); derivation resumes once ready. A serving Tool's name, read from its params, needs no hold (rationale).

A 30px header doubling as a drag handle: **a `pointerdown` past a 5px threshold begins a Lath pane drag**; below the threshold the header's own click behavior stands. It uses `cursor-grab` / `active:cursor-grabbing`, `select-none`, the shared terminal top radius from `lib/src/components/design.tsx`, and the `--color-header-active-*` / `--color-header-inactive-*` token pairs (VSCode file-tree list colors).

**Never give a Tool navigation, an address, or a dev-server chip** (rationale). **Must keep every Tool header control inside the header's palette**, Terminal Context included. A serving Tool's header, left to right: Display (`docs/specs/dor-browser.md` → Browser Chrome); Terminal Context; its name (`docs/specs/dor-tool.md` → Naming), renamed as a terminal label is; flexible gap; split buttons (full only); the pane-action group. A port conflict's terminal header leads with Terminal Context; the terminal face, which shows that terminal, has none. Tool composition belongs to `docs/specs/dor-tool.md` → Lifecycle.

A terminal header's elements left to right: derived label; TODO pill (compact+); flexible gap; mouse-reporting override icon (compact+, only while the inside program requests mouse reporting); split left/right, split top/bottom (full only); then the pane-action group: zoom/unzoom, minimize, kill (hover turns error-red).

The label is the `DerivedHeader` from `deriveHeader(...)`; `docs/specs/terminal-state.md` owns the priority chain and disambiguator. Layout renders it: primary truncates with ellipsis, secondary muted beside it, a failed last command appends an error-colored glyph. Click renames, except on a preview slot, whose label is drag area; right-click — or `>` in command mode — opens the header context menu.

Source of truth: `useHeldWhile` in `lib/src/components/wall/preview-transition.ts`; `SurfacePaneHeader` in `lib/src/components/wall/SurfacePaneHeader.tsx`; `TerminalPaneHeader` in `lib/src/components/wall/TerminalPaneHeader.tsx`; `ToolPaneHeader` in `lib/src/components/wall/ToolPaneHeader.tsx`; `TerminalContextButton` in `lib/src/components/wall/PaneActionButtons.tsx`; `usePreviewKeep` in `lib/src/components/wall/preview-keep.ts`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`. Tests: `lib/src/components/wall/ToolPaneHeader.test.tsx`; `keeps the slot on a double-click` in `lib/src/components/wall/TerminalPaneHeader.test.tsx`; `in its header, one element in one type` and `pins from Keep open in its terminal context` in `lib/src/components/wall/preview-slot.test.tsx`; `offers Keep open only for a preview slot` in `lib/src/components/wall/TerminalContext.test.tsx`.

#### Header context menu

**Must open the terminal context from terminal header, body, and command-mode `a` and `>` entry points.** Browser-only Surfaces and Doors have no context. Tool context displays its primary terminal; `docs/specs/terminal-context.md` → Tool context owns that composition. Application mouse ownership follows `docs/specs/mouse-and-clipboard.md` → Terminal context input.

**Must render one context per Wall in a stable Wall-level overlay**, with a theme-derived edge and raised shadow. Anchor it to the invoking source and follow its painted bounds without resizing panes or remounting the helper. Outside pointer press and explicit close dismiss it; its copy editors count as inside (`anchoredTarget` in `lib/src/lib/dom.ts`).

**Must choose placement on opening and retain its side while usable.** Never reposition in response to terminal output. Minimized panes do not count; zoom uses single-pane placement.

| Layout | Placement |
|---|---|
| Multiple visible panes | Beside the source with 16px overlap; match its size where possible. Above helpers overlap 4px and extend 32px farther upward over peer headers. Choose the largest usable candidate, ties right / left / bottom / top. Align the other axis with the source, shifting only to stay inside the Wall. |
| No usable adjacent candidate; single or zoomed pane | Source's top or bottom half, inset 16px on every side, opposite its visible terminal cursor sampled on opening; unknown, offscreen, or midpoint cursor defaults to top. |
| Small source or Wall | Expand the half-pane fallback to the minimum usable size, clamped inside the Wall's 16px inset; shrink below the minimum when necessary to preserve the inset. |

Popups share the zoomed pane’s app-background halo.

**Must group available side buttons beside Close at the context header’s right edge**, with destination tooltips, accessible labels, and selected state. Remember manual choices per source for the mounted Wall's lifetime; clear on source removal. Preserve terminal focus on pointer repositioning. An unavailable choice falls back automatically; no preference is persisted to disk.

**Must always show source title, directory actions, ports, alerts, and helper actions**, with title explanation available through Explain. Wrap header and detail actions within the panel; scroll bounded details and warnings while reserving 64px for terminal content.

**Must reveal the context from the opening pointer position, clamped to its bounds, over 320ms.** Command-mode `a` and `>` use the header's bottom-left; openings without a position use the context's top-left. Keep final layout dimensions throughout the reveal. Start helper creation, settings reads, and port scanning immediately on mount; fade mounted content, including detail dialogs, in over 140ms after 160ms. Reduced motion or disabled layout animation skips both animations and the delay.

**Must contract dismissals toward the opening origin over 180ms, fading content over 100ms**, starting from the current reveal when interrupted. Make the closing context inert and pause helper polling immediately; release focus without waiting for removal. Reopening cancels pending removal. Reduced motion dismisses immediately; promotion, source removal, and replacement by another context retain their immediate lifecycle transitions.

| Row | Content |
|---|---|
| Title | Derived display title, icon-only Explain bug immediately beside the title, copyable source Surface ref and close at right |
| Dir | Home-abbreviated directory, its unlabeled absolute-path copy, native explorer action |
| Ports | One scan per opening; scanning/empty/failure states; one port inline, multiple ports in a dropdown with count beside it; labeled launch actions |
| Alerts | Source Watch and TODO controls; notification details directly below |
| Helper | Remaining space; one-line status, Modify/Reset and Promote; hide its name below 48rem container width |

**Must keep port actions on one line to the right of the port display**, moving trailing actions into a dropdown as measured available width shrinks; all targets remain reachable. **Must launch from that dropdown only on a choice from its open list**: arrow keys open it, since Chromium on Windows and Linux otherwise changes a closed select's value.

**Must write visible action text in the Title, Dir, and Ports rows in lowercase**, since `iframe` and `agent-browser` cannot be capitalized; proper nouns such as Finder, tooltips, and accessible names keep their case.

**Must keep the title and its icon-only Explain bug on one line**, with the bug immediately beside the title. In Window hosts, wrap the copyable ref and Move to workspace picker together below the title; keep Dir on one line. Title: the title truncates to 8 characters, the Surface ref drops to its copy icon (the tooltip keeps it), then the title truncates further. Dir: the explorer action drops its label before the directory truncates from its start, keeping its end.

**Must focus context controls on opening.** Explicit entry into helper xterm gives it terminal keys; Escape there belongs to its program. Escape from controls closes the innermost disclosure, then context. Terminal clipboard routing uses the focused helper rather than the selected source. Actions use subdued link color and shared compact `OnOffSwitch` controls.

**Must tint the copyable Surface ref as an action and confirm each successful context copy in its button** with a checkmark, and “copied” where the button has a label, for 1.4 seconds, preserving button width and keeping the context open. Failed copies show the action error without success feedback.

**Must suppress context action hover and focus highlights while the window is unfocused**, including after opening a native explorer or system browser. **Must also withhold hover from an in-flight action, which stays focusable and `aria-disabled` rather than `disabled`** so the innermost disclosure keeps a focused descendant for Escape and Tab.

**Must show a spinner in the directory explorer button, with “opening…” while its label shows, during launch and for at least 0.75 seconds**, preserving width and keyboard focus while blocking repeat clicks. Stop immediately on failure and show the action error. Respect reduced motion by keeping the spinner static.

**Must promote by adopting the helper Session into a new split beside the source**, preserving identity and focusing it. Helper lifetime and source closure are owned by `docs/specs/terminal-context.md`.

Source of truth: `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`; `TerminalContextOverlay` in `lib/src/components/wall/TerminalContextOverlay.tsx`; `placeTerminalContext` in `lib/src/components/wall/terminal-context-placement.ts`; `TerminalPanel` in `lib/src/components/wall/TerminalPanel.tsx`; `TerminalPaneHeader` in `lib/src/components/wall/TerminalPaneHeader.tsx`; `useWallKeyboard` in `lib/src/components/wall/use-wall-keyboard.ts`; `.terminal-context-enter` / `.terminal-context-content` in `lib/src/theme.css`. Tests: `lib/src/components/wall/TerminalContext.test.tsx`, `lib/src/components/wall/TerminalContextOverlay.test.tsx`, `lib/src/components/wall/terminal-context-placement.test.ts`, `lib/src/components/Wall.test.tsx`.

### Pane body

The pane body paints `--color-terminal-bg` on the React pane wrapper and the `TerminalPane` mount point; the persistent xterm host element, `.xterm-screen`, and the xterm scroll container also carry the concrete background from `getTerminalTheme()`. **The host background must match the terminal screen exactly** and clip to the pane's shared rounded bottom corners (rationale). Source of truth: `lib/src/components/wall/TerminalPanel.tsx`, `lib/src/components/TerminalPane.tsx`.

**Must share scroll-safe pane messages across iframe status, Tool approval, and port conflicts**, wrapping long content and keeping all controls reachable in small panes. Center content only when it fits.

**Must pin a held pane's strip to the body's bottom-right corner** — "Sized for \<label\>" and Take back, as one `PopupButtonRow` at `z-index: 20` that truncates the label within the pane rather than wrapping, and never in the header. Hold and Take back semantics belong to `docs/specs/remote-api.md` → "Size authority: last-attach-wins".

Source of truth: `PaneMessage` in `lib/src/components/design.tsx`; `SizeHoldStrip` in `lib/src/components/wall/SizeHoldStrip.tsx`. Visual regression cases: `lib/src/stories/ToolApproval.stories.tsx`, `SizedForPhone` / `SizedForLongLabel` in `lib/src/stories/TerminalPane.stories.tsx`.

### Alarm overlay

A ringing terminal Session gets an overlay spanning its whole Lath leaf; browser surfaces never render it. It resolves through the tiling engine's per-leaf overlay slot (`docs/specs/tiling-engine.md`) and **must never intercept pointer/focus routing or change geometry**.

**Two layers straddling the header's stacking context** (`.lath-leaf-header` is `position: relative; z-index: 20`):

- **Wash + label at `z-index: 19`** — above terminal content, below the header and the `z-index: 20` pane-corner mouse-override banner and held-pane strip, so none is tinted (rationale). **Never use color-alpha utilities here** — their `color-mix()` is unsupported by the standalone Safari 15 / Chrome 105 targets; the solid alarm color lives on a child whose element opacity supplies those strengths. The label sits `PANE_HEADER_HEIGHT_PX + 4` from the Pane top, centered.
- **Perimeter ring at `z-index: 25`** — above the header so the treatment reads as one rounded rectangle around the Pane, below the `z-index: 30` sashes (rationale).

Three strengths, by speech state over the latched ring. `SPOKEN` is unbounded, so its wash stays light enough to read text through:

| State | Wash | Ring | Label |
|---|---|---|---|
| ringing | 10% | 3px | none |
| `SPEAKING` | 20% | 5px | `SPEAKING` + speaker icon |
| `SPOKEN` | 10% | 3px | `SPOKEN` + speaker icon |

Both layers wear the leaf's own rounding (header radius on top, terminal radius on the bottom). **Only the perimeter ring animates**, compositing one layer rather than two; `docs/specs/alert.md` → Pane Header owns the motion. Source of truth: `AlertRingIndicator` in `lib/src/components/wall/AlertRingIndicator.tsx`, registered as the `terminal` overlay by `lib/src/components/wall/LathHost.tsx`.

### Pane header responsive sizing

**Must measure each header's own border-box width, never the viewport, retaining its tier at zero width** (rationale). **Each terminal boundary below compact is the width at which the next-lowest-priority element would start eating the group's padding** (rationale).

**The pane-action group yields last, and zoom last within it** (to the popover where there is one), since zooming restores everything the header dropped. Terminal tiers:

- **Full** (>293px): everything.
- **Compact** (>173px): split hidden.
- **Minimal** (>98px): also hides the TODO pill and the mouse-override icon. The label truncates with ellipsis.
- **Tiny** (≤98px): minimize and kill go too.

A browser header collapses by border-box width:

| Below | Change |
|---|---|
| 420px | Split hidden. |
| 360px | Navigation hidden. |
| 180px | Chrome moves into a viewport-clamped popover behind one trigger. |
| 94px | Minimize and kill join the popover. |

A serving Tool's header has no popover; each boundary reserves the widest Display glyph (rationale):

| Below | Change |
|---|---|
| 356px | Split hidden. |
| 161px | Display hidden. |
| 125px | Minimize and kill hidden. |

A port conflict's terminal header adds its Terminal Context button's 26px to each terminal boundary, re-tiering at an unchanged width as the conflict comes and goes.

**Must reclamp the popover on content resize and keep it keyboard reachable** (focus enters on open, Tab stays inside, Escape returns it to the trigger) **and dismiss it on resize, returning focus to the trigger when a focused minimize or kill moves into it, or when its Surface is hidden (without restoring focus)**; `lib/src/components/wall/use-dismiss-overlay.ts` handles other dismissal, and controls dismiss only after acting. Keys and connection labels truncate before controls, and a connection label only once the URL has given up all its width.

Source of truth: `SurfacePaneHeader` in `lib/src/components/wall/SurfacePaneHeader.tsx`; `TerminalPaneHeader` in `lib/src/components/wall/TerminalPaneHeader.tsx`; `ToolPaneHeader` in `lib/src/components/wall/ToolPaneHeader.tsx`; `PaneActionGroup` in `lib/src/components/wall/PaneActionButtons.tsx`; `useHeaderTier` in `lib/src/components/wall/use-header-tier.ts`; `lib/src/components/wall/SurfacePaneHeader.test.tsx`; `lib/src/components/wall/TerminalPaneHeader.test.tsx`; `lib/src/components/wall/ToolPaneHeader.test.tsx`; `lib/src/stories/BrowserChromeHeader.stories.tsx`.

## Baseboard

The baseboard (`h-7`, 28px) sits below content, with no top divider. A 2px theme-colored gap preserves pane corners; 7px horizontal padding aligns doors with panes. With no doors above 350px wide, it shows `LCmd → RCmd to enter command mode` on macOS and `LShift → RShift to enter command mode` elsewhere.

**Must group the right-hand controls**: the `N more →` overflow arrow, the host-supplied `notice` slot, the one-time connection indicator (`docs/specs/one-time.md` -> "Laptop UI"), then three always-present 24px square Settings buttons with 2px gaps. Their 16px icons are speaker/slashed-speaker for spoken alarms, filled `VibrateIcon`/`DeviceMobileSlashIcon` for push, and sliders for Settings. **Must expose each state through shape and `aria-pressed`.** The status buttons toggle their respective alarm settings; sliders opens Settings (`docs/specs/alert.md` → Settings dialog). **Must use the shared `chromeButton` hover treatment** for Settings and overflow buttons, except a flagged overflow arrow, which like a Door has none.

A minimized session becomes a **door**, showing its label plus the alert/TODO/speech badge cluster (`docs/specs/alert.md` → Door owns which badge shows when; both speech states also name themselves in the Door's `title` and accessible name). **A Door's label is header-derived only for a terminal-backed Surface** (`hasTerminal`); any other keeps its stored title, and a browser Door adds the display glyphs from `docs/specs/dor-browser.md` → "Browser Chrome". A Door uses the window's bottom edge as its bottom border, with left, top, and right borders taking the shared terminal top radius from `lib/src/components/design.tsx` — a mouse hole matching pane rounding. Dimensions: `min-w-[68px] max-w-[220px] h-6`.

### Door interaction

- **Click** (any mode) or **Enter** (command mode): restore the session as a pane and enter passthrough; the terminal gets focus immediately.
- **m** / **d** (command mode): restore into a pane but stay in command mode — the inverse of `m`/`d` on a pane, making them toggles.
- **x** / **k** (command mode): restore into a pane, then show the kill confirmation (an untouched Surface is killed outright — [Kill confirmation](#kill-confirmation)).
- **Arrow keys** navigate to and between doors ([Spatial navigation](#spatial-navigation)).

**A reattach that stays in command mode defers its follow-up** (focus, kill, replace) to `requestAnimationFrame` and skips it if the pane vanished in between.

### Baseboard responsive sizing

Doors are measured in a hidden off-screen container first, then fitted:

- **Subtract the measured right cluster and its gap before fitting anything** — that space is never available to doors. Measure only its always-present part (notice, one-time indicator, and the three settings controls): **never the overflow arrow**, whose presence is an *output* of the fit.
- Add doors until no more fit, reserving room for a `N more →` button whenever items remain after the current one. **At least one door is always shown**, even if it overflows.
- If scrolled, show `← N more` on the left and/or `N more →` on the right. Overflow counts are assumed single-digit (the hidden measurement button is `9 more TODO`).
- **An arrow hiding a ringing or TODO Door must say so**, since that Door is otherwise gone from the baseboard: it wears the Door shape and ground, a static `door` alarm inset while one rings, and a static TODO pill while one has TODO, and its accessible name counts them (`3 more, 1 ringing, 1 TODO`). **Every arrow must reserve the measured width of the TODO one**, so the fit never depends on which Doors an arrow hides. Pinned by `Baseboard overflow alerts` in `lib/src/components/Baseboard.test.tsx`.
- Clicking an overflow arrow reveals one door in that direction; a longer title may push more doors off the opposite side. **Must reveal the selected Door when selection or membership changes**, without overriding manual overflow scrolling (`lib/src/components/Baseboard.test.tsx`).
- Extreme case — one door with a very long title and more doors on both sides: show both arrows with counts and as much title as fits, ellipsis for the rest.

Source of truth: `lib/src/components/Baseboard.tsx`, `lib/src/components/Door.tsx`.

## Workspaces

### Workspace tabs

- **Must size tabs to their contents using the shared Door geometry**: 24px high, 68–220px wide, terminal top radius, Door typography and label/action padding, with 6px gaps. Shrink to the minimum before scrolling.
- **Must use active and inactive pane-header foreground/background pairs** on the corresponding tabs, over the app background. **Must join the active tab directly to a full-width vertical gradient**, active-header background at the top to app background at the bottom. Reserve one `PANE_GUTTER_PX` band for the gradient above the Wall's normal top gutter, keeping it clear of the focus ring. **Must fade inactive tabs into that same app background below their label.**
- **Must show `×` only on the active tab**, outside rename. Middle-click may close an inactive tab. Reveal the active tab after its width changes on activation.
- **Must reuse `HEADER_PALETTE_TRANSITION_CLASS` for tab palette tweening and reduced motion.**
- **Must activate inactive tabs in command mode on click; clicking the active tab renames without changing mode.** Pinned by `lib/src/components/WorkspaceWindow.test.tsx`.
- **Must make a tab's TODO pill (`docs/specs/alert.md` → Workspace union) its own button, beside the tab's and never inside it.** Its click activates the Workspace and enters the next member with a TODO after the current selection — panes in tree pre-order, then Doors in baseboard order — wrapping. **It enters that member as a click on it would**, unlike the tab's click: passthrough, reattaching a Door (rationale). **With no TODO left it only activates in command mode, never renaming.** Pinned by `enters a Workspace's TODO pane from its tab pill in passthrough, keyboard focus included, hidden or visible` in `lib/src/components/WorkspaceWindow.test.tsx` and `enters each TODO member in turn as a click on it would, reattaching a Door, never clearing a TODO` in `lib/src/components/Wall.test.tsx`.
- **Must draw the tab's TODO pill borderless**, as text on a rounded hit area inside the tab's height, with a pointer, a hover wash, a stronger pressed wash, and a current-coloured focus-visible outline. Its tooltip names the Surface a click enters as its header or Door shows it, re-read on hover, focus, and each click; that Surface plays the landing spotlight (`docs/specs/alert.md` → Pane Header). Pinned by `draws the pill borderless, with hover, press, pointer, and focus-visible states` and `names the Surface the click will enter in the pill tooltip` in `lib/src/components/WorkspaceStrip.test.tsx`.
- **Must enter the Workspace `+` creates in passthrough, keyboard focus included, after mount, unless the user has switched away.** Pinned by `clicking + enters the new terminal in passthrough and moves keyboard focus off the button` in `lib/src/components/WorkspaceWindow.test.tsx`. Deactivation restores a Wall's chrome selection to its last live pane. External removal of the highlighted Workspace selects a live pane.
- **Must route command-mode `x` / `k` on a highlighted Workspace tab through the tab’s `×` close action**, including inactive tabs. Pinned by `reveals and confirms a requested workspace close, then selects the next tab` in `lib/src/components/WorkspaceWindow.test.tsx`.
- **Must reveal a Workspace in command mode before a user close or its confirmation.** Successful user closure selects the next Workspace tab in command mode (previous at the end). Silent command closures remain focus-neutral. Pinned by `reveals and confirms a requested workspace close, then selects the next tab` in `lib/src/components/WorkspaceWindow.test.tsx`.

Source of truth: `DOOR_TAB_CLASS` in `lib/src/components/design.tsx`; `WorkspaceStrip` in `lib/src/components/WorkspaceStrip.tsx`; `AppBar` in `standalone/src/AppBar.tsx`; `enterNextTodo` and `peekNextTodo` in `lib/src/components/Wall.tsx` over `nextTodoMember` in `lib/src/lib/workspace-union.ts`. Close visibility: `activates on click` in `lib/src/components/WorkspaceStrip.test.tsx`.

### Workspace names

A Workspace's name is **auto**, italic (`AUTO_NAME_CLASS`) and derived from its terminals, until a user renames it; an empty rename or `dor workspace rename --auto` hands it back.

- **One vote per member terminal**, Doored ones included, with `cwdAtStart` while a command runs, else `cwd`; browsers do not vote.
- **Any vote inside a git repository wins**: the name is the most common `<repo> @ <branch>`, and directories outside a repository are ignored. `<repo>` is origin's repository name, else the main checkout's folder, so every worktree shares it; a detached HEAD shows a short hash.
- **Otherwise the most common directory**, counted by `cwdIdentity` and shown by basename: `~` for local home, a remote one with its host.
- **A tie keeps the current name when it is among the tied**, else takes the earliest member's (Lath leaf order, then Doors).
- **Must hold the current name for a never-answered path until three consecutive unanswered lookups** (rationale), then vote "no repository" so the Workspace names itself from its healthy members, else its folder; `Workspace N` until a terminal reports a directory.
- **Never ask git about a remote cwd.** **Must re-ask after a command finishes** (rationale). A host without `gitInfo` names by directory.
- **A path absent from a `gitInfo` answer is unanswered, never "no repository"**, as is every path of a rejected request. **A host failure must reject**, never answer `{}`. An unanswered path keeps its last answer, else holds the name, and is re-asked after a delay doubling per miss.
- **An untouched editor never submits**: it submits on blur, and opening it must not pin an auto-name, even one that changed while it was open.
- **Must run only `rev-parse` and `config --get`, reading `HEAD` directly**, so `core.fsmonitor` never runs; a lookup past its deadline is left out of the answer.

Source of truth: `deriveWorkspaceAutoName` in `lib/src/lib/workspace-autoname.ts`; `installWorkspaceAutoNaming` in `lib/src/lib/workspace-autoname-controller.ts`; `renameWorkspace` / `resumeAutoWorkspaceName` / `setAutoWorkspaceName` in `lib/src/lib/workspace-store.ts`; `finishRename` in `lib/src/components/WorkspaceStrip.tsx`; `gitInfo` in `lib/src/host/git-info.ts`.

### Workspace motion

- **Must expand the visible Workspace from its tab on activation, creation, and arrival**, using `LATH_MOTION_MS` and `LATH_EASING`, including opacity. Keep its layout box full-size throughout; skip motion without a measurable tab or under `motionIsInstant()`.
- **Must keep the outgoing Workspace visible and inert beneath the incoming Workspace during a switch**, dimming linearly to 50% opacity over `LATH_MOTION_MS`. Hide it and detach its terminal elements when its fade finishes; a rapid switch back resumes from the displayed frame.
- **Must collapse a closing Workspace before disposing its Surfaces or removing its tab**, then expand the successor. Hidden departures finish instantly; refusal restores active Workspaces; inactive ones stay hidden until activation. Hold the closure guard during collapse and omit the subsequent pane exit delay. Transfer sequencing is `docs/specs/standalone.md` → Transfer.
- **Must reverse interrupted motion from its displayed progress and settle departures even when backgrounded frames stop.** Disposal cancels callbacks. Pinned by `lib/src/components/workspace-motion.test.ts` and `lib/src/components/WorkspaceWindow.test.tsx`.
- **Must render the selection ring outside the transformed Workspace and remeasure on its animation frames.** Its opacity follows the selected target's Workspace.

Source of truth: `createWorkspaceMotion` in `lib/src/components/workspace-motion.ts`; `WorkspaceMotion` in `lib/src/components/WorkspaceMotion.tsx`; `closeAll` in `lib/src/components/Wall.tsx`.

### Moving Surfaces between Workspaces

- **Must move a Pane or Door on release over another Workspace tab**, inserting beside the destination's last selected live pane. Never activate on hover; highlight valid targets. A header/ Door press owns a pane drag; a tab press owns reorder and cross-Window tear-out. Strip gaps, the source tab, and disabled targets consume the drop without a layout move or tear-out. Escape and pointer cancellation change nothing.
- **Must offer `+` and New workspace only when the source has more than one Surface**, counting Panes and Doors; create a receiving Wall with only the moved Surface. Disable the picker item and `+` drop otherwise, and refuse CLI `--new`.
- **Must offer Move to workspace in terminal and Tool context** (placement: the Title row above), using the same coordinator as dragging. **Never add a browser context menu. Never add a command-mode move binding.** Browser Surfaces move by dragging or CLI.
- **Must retain stable Surface identity and Session state while remounting in the destination Wall**: terminals keep their registry instance, browser automation reconnects, and a retained helper follows its source. Never close a departing Session. Pin a moved preview slot by removing its preview mark.
- **Must confirm plain iframe and serving iframe Tool moves before creating a destination or changing membership**, with a stable random character over the Window content area ([one pending confirmation](#workspace-lifecycle)). Doors remain minimized while waiting. Show “moving this iframe will trigger a refresh and reopen at its saved URL, possibly losing page state or returning to an earlier page”; the prompted character confirms, anything else cancels. Saved URLs are last-known URLs, not necessarily the page's current location. CLI consent follows `docs/specs/dor-cli.md` → dor move.
- **Must refuse dirty Tools, pending Tool approval, browser startup, closing Surfaces/Workspaces and helper promotion**, rechecking after consent and asynchronous preparation. Dirty/pending refusals cannot be bypassed by iframe consent.
- **Must follow a GUI move into destination passthrough** (acknowledgement: `docs/specs/alert.md` → Workspace union); CLI focus policy follows `docs/specs/dor-cli.md` → dor move. Remove a source with no Panes or Doors; if Doors remain but no pane does, refill normally.
- **Must prepare before departure and roll back failed adoption**, restoring layout, Doors, parked state, selection, zoom, metadata and refs. Ref allocation belongs to `docs/specs/dor-cli.md` → Handle Model; coordinated durable publication belongs to `docs/specs/transport.md` → Persisted session types; Activity follows `docs/specs/alert.md` → Workspace union.

Source of truth: `moveSurface` in `lib/src/components/wall/surface-move.ts`; `surfaceWorkspaceDrag` in `lib/src/components/wall/surface-workspace-drag.ts`; `MoveWorkspaceAction` in `lib/src/components/wall/MoveWorkspaceAction.tsx`; `prepareSurfaceMove` / `adoptSurfaceMove` in `lib/src/components/Wall.tsx`. Tests: `lib/src/components/WorkspaceWindow.test.tsx`, `lib/src/components/wall/LathHost.test.tsx`.

### Workspace lifecycle

Each Wall renders one Workspace's Content and Baseboard (doors). Standalone mounts one Wall **per Workspace**; VS Code and the website playground mount a bare Wall with no Workspace id, which behaves exactly as a single-Workspace Window (VS Code's per-webview mapping is `docs/specs/vscode.md`).

- **Must mount every Workspace's Wall in one grid cell**, inactive Walls `inert`, then `visibility:hidden` after their fade and never `display:none` (rationale).
- **Must preserve mounted leaves across switches**: no re-seed, no re-parent, no leaf unmount, and no `resumeTerminal` / `restoreTerminal`; the only mount work is the terminal reattach below, which replays nothing, so I8 holds by construction (`lib/src/components/WorkspaceWindow.test.tsx`).
- **A hidden Wall's terminals hold no element and no GL context**: completion of the outgoing fade runs `unmountElement` on every terminal pane, exactly as minimize does ([Renderer](#renderer)); activation runs `mountElement` and fits through the [Animations](#animations) gate, so an unchanged grid sends no PTY resize (`lib/src/components/TerminalPane.test.tsx`). Browser Surfaces keep their live documents (rationale).
- **A hidden Wall consumes no window input**: every listener that dispatches, forwards, or `preventDefault`s window input is gated on `active`, keyboard and custom events alike, so a hidden Wall neither mounts chrome nor refits a detached element in answer to one. **Only the active Wall renders the modal hosts and the overlays that trap keys** — the kill confirmation and a terminal's copy editor (rationale): a staged prompt survives the switch and is answered only where the user can see it.
- **Exactly one Wall answers a `dor` request**, chosen by `docs/specs/dor-cli.md` → "Handle Model". Every Wall registers a handle, a bare one under `DEFAULT_WORKSPACE_ID`, so the router always finds one.
- **Never unmount a Wall before its Surfaces are disposed** — `closeAll` waits for the kill fade to commit, bounded by the engine's exit duration, since unmounting mid-fade would leave `Orphaned` Registry entries (`docs/specs/glossary.md` → "Invariants" I4). **The deadline refuses rather than reporting clean**, and the walk re-reads membership until nothing is left, so a Surface born behind it is closed too.
- **A closing Workspace takes no new Surfaces**: while `closeAll` walks, this Wall answers every Surface-creating `dor` verb with an error (`docs/specs/dor-cli.md` → "Handle Model"), **rechecked after any host round trip the verb makes before creating** (`CREATING_CONTROL_METHODS` in `lib/src/components/wall/use-dor-control.ts`; `lib/src/components/WorkspaceWindow.test.tsx`).
- **Must reject duplicate Workspace IDs before mutating the model** (`lib/src/lib/workspace-store.test.ts`).
- **Must retain mode and selection across switches unless the [activation gesture](#workspace-tabs) changes them.** Deactivation blurs the pane; activation focuses it one frame later.

**A Workspace may leave the Window and arrive in another one** — torn out into
its own window, or dropped onto an existing one — carrying its Surfaces, its
Sessions with it, and killing nothing on the way
(`docs/specs/standalone.md` → Transfer). Leaving is not a close and arriving is
not a create: a Workspace that arrives mounts from the record it brought.
**Must confirm before a move that would destroy an iframe's page state**: a
plain iframe or serving iframe Tool's document cannot leave its webview, so it reopens at its
saved URL, and a Workspace holding one — Doored ones included — asks with the
Close's typed confirmation before it leaves; agent-browser Surfaces reconnect and ask
nothing (`iframeSurfaceRefs` on the Wall handle; `standalone/src/workspace-drag.test.ts`).

**Must show drag refusals over Window content in a dialog** until dismissal, retry, or Workspace departure. Source of truth: `onDropOnOtherWindow` in `standalone/src/workspace-drag.ts`; `lib/src/components/WorkspaceStrip.test.tsx`.

- **Create** adds an auto-named Workspace, `Workspace N` until its terminals name it ([Workspace names](#workspace-names)), makes it active, and gives its Wall no restored record, so Lath's fresh branch spawns one default-shell pane.
- **Close** confirms first when the Workspace holds touched Surfaces or running work, with a kill-confirm letter over the Window's content area, then closes every member Surface. **Must atomically replace the last closed Workspace with a fresh one and select its tab**, after disposing the old Surfaces (`lib/src/components/WorkspaceWindow.test.tsx`). **Must serialize closes across the Window.**
- **A Workspace whose Wall has not registered is refused** (`workspace '<ref>' is still mounting`, one wording for every caller), never closed past — the Wall walks the member Surfaces, so dropping it would leave its Sessions running unheld (`docs/specs/glossary.md` → "Invariants" I4). **A gesture waits out the registration gap first**, as `dor workspace close` does, so `×` right after a create closes rather than silently doing nothing.
- **Rename** edits the Workspace `name` only — no Surface title, and not the per-pane inline rename — and pins it ([Workspace names](#workspace-names)).
- **Reorder** moves a tab in the strip and renumbers `workspace:<n>` refs with it only where they are positional (`docs/specs/dor-cli.md` → "Handle Model"); **a press inside the open rename editor never starts a reorder**.
- **Must drop the closing Workspace’s rename editor and pending confirmation, and no other’s** (`releases the rename lease when the tab being renamed is middle-clicked closed` in `lib/src/components/WorkspaceStrip.test.tsx`; `preserves another Workspace’s rename and close confirmation when closing a sibling` in `lib/src/components/wall/workspace-lifecycle.test.ts`).
- **Every Workspace verb runs outside the strip**, which renders the rename editor and confirmation from a store, so tab gestures and `dor` commands take one path.

**Must use `WorkspaceKillConfirm` for Workspace close, the iframe move gates,
and host termination confirmations**, titled “Confirm kill workspace” except the
move gates: **a bare matching letter confirms, another bare key cancels, and a
modifier or chord never answers**, so `Cmd+Q` still quits. **Must ignore
the close confirmation's key while that Workspace transfers.**
**Must hold at most one pending Workspace confirmation** (close, cross-Window
move gate, Surface move iframe consent), **answered no when a newer one is
raised or any close, cross-Window move, or Surface move starts**, by gesture or
`dor`, even one that refuses. **Must abandon superseded preparation while awaiting a Wall, window probe or editor decision**, so an older verb cannot later act or replace the newer question. A move refusal waits behind it and rename
(`lib/src/components/WorkspaceWindow.test.tsx`, `lib/src/lib/workspace-ui-store.test.ts`).
A successful transfer dismisses only the departing Workspace's pending
confirmation and rename UI; a failed transfer retains them. No pending kill follows a Workspace to its
destination. Pinned by `does not accept a pending kill during transfer and releases its keyboard lease on departure`
in `lib/src/components/WorkspaceStrip.test.tsx` and `keeps the pending kill until commit, then dismisses only the departing Workspace`
in `lib/src/components/wall/workspace-transfer.test.ts`.
Source of truth: `requestConfirmation` / `cancelPendingConfirmation` / `dismissWorkspaceUi` in `lib/src/lib/workspace-ui-store.ts`;
`prepareWorkspaceTransfer` in `lib/src/components/wall/workspace-transfer.ts`.

The union projection and its indicators are owned by `docs/specs/alert.md` → Workspace union; the strip that renders them by `docs/specs/standalone.md` → AppBar. Persisted containers are owned by `docs/specs/transport.md`: standalone stores one `PersistedWindow` per window, so a relaunch restores every Workspace ([Session persistence](#session-persistence)).

Source of truth: `WorkspaceWindow` in `lib/src/components/WorkspaceWindow.tsx`; `registerWallHandle` in `lib/src/components/wall/wall-handles.ts`; `closeAll` in `lib/src/components/Wall.tsx`; `requestWorkspaceClose` in `lib/src/components/wall/workspace-lifecycle.ts`; `WorkspaceKillConfirm` in `lib/src/components/WorkspaceKillConfirm.tsx`; `createWorkspace` / `closeWorkspace` / `renameWorkspace` / `moveWorkspace` / `setActiveWorkspace` in `lib/src/lib/workspace-store.ts`; `getWorkspaceUiSnapshot` in `lib/src/lib/workspace-ui-store.ts`; `setWorkspaceSurfaces` in `lib/src/lib/workspace-surfaces.ts`.

**Every Workspace verb has a `dor` counterpart** (`docs/specs/dor-cli.md` → "dor workspace"), taking the same route as the strip: a command close raises no confirmation, refusing instead, and closes its member Surfaces silently.

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

**Enter passthrough mode:** clicking any pane body or header; `Enter` or `z` on a selected pane; creating a terminal through a manual split (`|` / `%` / `-` / `"`, a header split button) or a host New Terminal action; clicking or pressing `Enter` on a door (restoring the session first); clicking a Workspace tab's TODO pill ([Workspace tabs](#workspace-tabs)). **Focus is always deferred via `requestAnimationFrame`** so it lands after the click/mousedown event finishes.

**Enter command mode:** Left Cmd keydown, then Right Cmd keydown less than 500ms later — or the same left-then-right gesture with Shift.

- Detected in a capture-phase `keydown` listener on `e.key === 'Meta'` (or `'Shift'`) plus `e.location`, so it fires even while xterm holds DOM focus. **Anything but `location === 1` counts as the right-hand key.**
- **The Meta and Shift tracks are independent** — Left Cmd then Right Shift does not trigger — and **both are always live** (rationale).
- **A bare Meta/Shift press outside the terminal context is always consumed by this detector**, so no later handler mistakes it for a command key; a key targeted inside the context never reaches it ([Keyboard shortcuts](#keyboard-shortcuts-command-mode)).
- **Must cancel a pending in-Wall mode-exit gesture when any non-Meta/Shift key intervenes.** Pinned by `cancels an interrupted %s leader without leaving passthrough` in `lib/src/components/Wall.test.tsx`.
- A zoomed focused pane starts unzoom immediately when keyboard focus returns to command mode.

## Keyboard shortcuts (command mode)

`docs/specs/shortcuts.md` tables every binding; this section owns the dispatch behavior behind it.

**Must use `,` to rename the selected terminal pane or Workspace tab in command mode**, without activating an inactive Workspace. The `+` button has no rename action. Pinned by `comma edits the highlighted Workspace without switching, then returns to navigation` in `lib/src/components/WorkspaceWindow.test.tsx`.

**Must support Workspace navigation in command mode through bare `1`–`9`, arrows, and `Enter`.** Digits select by strip position; out-of-range positions are consumed without switching. **Never bind `c`, `n`/`p`, `$`, or `&`.** Rename inputs and confirmation dialogs retain their own controls. Pinned by `lib/src/components/wall/keyboard/handle-workspace-shortcuts.test.ts` and `lib/src/components/WorkspaceWindow.test.tsx`.

All keys are handled in one capture-phase `keydown` listener on `window` (`use-wall-keyboard.ts`), which delegates in a fixed order to the modules in `lib/src/components/wall/keyboard/`: *(an inactive Workspace or an answered key stops here)* → dual-tap → editable-field clipboard → mouse-selection keys → *(passthrough stops here)* → *(a rename or the chrome lease stops here)* → kill confirmation → *(an open dialog stops here)* → Workspace shortcuts → pane shortcuts → pane navigation. **A key whose target sits inside `[data-terminal-context]` leaves that chain before dual-tap**: it reaches diagnostic-text copy, editable-field clipboard, then mouse-selection keys against the focused context terminal, and stops — so no Wall gesture, the mode-exit dual-tap included, fires from inside an open context. **Must let one Wall answer each key**, even a key that activates another Workspace (`answers a key from one Wall even when that key activates another` in `lib/src/components/WorkspaceWindow.test.tsx`). **Must prevent default and stop propagation for handled command keys.** Bare Meta/Shift presses stop only internal dispatch; the detector leaves their DOM event untouched.

That order is load-bearing twice: a rename input suppresses the pane shortcuts but **not** the mode-exit gesture or the field's own clipboard chords; and a staged kill confirmation hijacks each key reaching it before the dialog gate, so the confirm letter works even though the modal is open.

**Every open dialog holds its own reference-counted lease on that gate**, and command-mode dispatch resumes only once the last lease is released — so a dialog closing over another cannot lift the survivor's suppression (`createDialogKeyboardCoordinator` in `lib/src/components/wall/wall-context.tsx`).

**Must defer the pending Workspace confirmation while an inline Workspace rename editor is open**, leaving its keys to the input; it appears after rename ends. Pinned by `defers the %s gate while another Workspace is being renamed` in `lib/src/components/WorkspaceStrip.test.tsx`.

**Chrome outside every Wall takes the chrome keyboard lease instead**: the Workspace strip's rename editor and close confirmation live in the app bar, where `stopPropagation` cannot reach a capture-phase window listener. **The Workspace branch is inert on a Wall with no Workspace id**, which is what leaves those keys unbound on a bare Wall. Source of truth: `acquireChromeKeyboardLease` in `lib/src/components/wall/chrome-keyboard-lease.ts`; `handleWorkspaceShortcuts` in `lib/src/components/wall/keyboard/handle-workspace-shortcuts.ts`.

**Must leave Escape and Tab to IME composition in modal/popover focus traps and terminal-context dialogs, and Enter/Escape in shared inline editors**, including WebKit's composition-ending key (`isComposing` false, `keyCode` 229).

Source of truth: `isComposingKey` in `lib/src/lib/dom.ts`; `usePopoverFocusTrap` in `lib/src/components/use-popover-focus-trap.ts`; `TerminalContextView` in `lib/src/components/wall/TerminalContextView.tsx`; `useModalFocusTrap` in `lib/src/components/design.tsx`; `InlineEditInput` in `lib/src/components/wall/InlineEditInput.tsx`. Tests: `lib/src/components/use-popover-focus-trap.test.tsx`; `lib/src/components/wall/TerminalContext.test.tsx`; `lib/src/components/ModalOverlay.test.tsx`; `lib/src/components/wall/InlineEditInput.test.tsx`.

### Split cwd inheritance

A split from an existing pane (`|`/`%`/`-`/`"` or the header split buttons) spawns the new pane with its source pane's last-known cwd, then selects it and enters passthrough; host New Terminal actions share that focus tail (rationale). Focus-neutral control-plane creation (`dor split -- …`, `dor ensure`, `dor iframe`, `dor agent-browser`) keeps its documented background behavior.

The source cwd is read from `getInheritableCwd(sourceId)`. **Never inherit a remote cwd** (`isRemote === true`, e.g. an OSC 7 path reported over ssh) — it is not a usable local spawn cwd. The host default applies when the source cwd is unknown, remote, or absent (initial pane creation). The inherited cwd rides `setPendingShellOpts` alongside the inherited shell selection, consumed by `getOrCreateTerminal` on the next `platform.spawnPty`.

### Kill confirmation

Dirty Tool close consent is `docs/specs/dor-tool.md` → Closing unsaved Tools.

`x`/`k` (or the kill button, which first leaves passthrough) shows a pane-centered semi-transparent overlay (`KillConfirmOverlay` → `KillConfirmModal`) with a random lowercase letter (`cfg.killConfirm.char` pins it for visual snapshots); typing it confirms the kill. **`x` and `k` are excluded from that alphabet** so a double-tap can't accept itself. `Escape`, the `Esc to cancel` button, and clicking another panel cancel; any other key runs a 400ms `shake-x` animation and then auto-dismisses.

**Confirmation must be staged in a ref synchronously, not only in React state** — a second confirm keydown arriving before React flushes would otherwise pass the guard and kill twice (`lath.isDying` is the second line of defense).

**Must return keyboard selection to the next surviving Door after killing a revealed Door**, falling back to previous Doors, then a pane only if no Doors remain. Apply this to confirmed and untouched kills only while the revealed pane is still selected in command mode; cancellation, refusal, or navigating away discards the return target. Pinned by `returns keyboard focus from deleted Door %s to %s (confirm: %s)` in `lib/src/components/Wall.test.tsx`.

**Untouched plain terminal sessions skip this confirmation; Tools still require it.** A newly spawned shell starts `untouched: true`; the first user-originated PTY input flips it to false. Counted: printable keys, Enter, control keys, keyboard CSI such as arrows/history, paste, file-drop path insertion, forwarded mouse reports. Not counted: replay-shaped terminal reports and mouse reports removed by an override. Killing an untouched pane runs the normal kill animation/dispose path immediately; killing an untouched door first reattaches it only far enough to reuse that removal path, then kills it with no overlay.

Source of truth: `requestKill` (every kill gesture: Door reattach, untouched fast path, or staging the overlay) and `acceptKill` in `lib/src/components/Wall.tsx`, `lib/src/components/KillConfirm.tsx`; `wireXtermHandlers` in `lib/src/lib/terminal-lifecycle.ts` (untouched input gate).

## Selection overlay

**Must outline the union of the invoking source Pane and its open helper**, following their outer contour without an internal seam or enclosing unused neighboring space. Track helper repositioning and resize without replacing its terminal; restore the source-only ring on close. The context container has no native focus outline; its controls retain their keyboard focus indicators.

A fixed-positioned element on top of the Lath host, covering the active element's area inflated by `SELECTION_RING_INFLATE_PX` (4px) for panes; doors are not inflated. **The inflate is derived in `lib/src/components/design.tsx` so both ring strokes center on the gutter's midline** (rationale).

- **Exactly one pane or door is active at a time**, drawn by one SVG renderer (`SelectionRing`, `variant: 'ants' | 'solid'`).
- **Passthrough:** `variant='solid'` — a 1px solid SVG stroke, centerline `strokeWidth/2` inside the div edge for panes and doors alike, no glow (rationale).
- **Command:** `variant='ants'` — marching-ants border (`cfg.marchingAnts`: 10px segment, 60% dash, 0.4s cycle, 2px stroke). **March for as long as command mode lasts** (test: `marches for as long as command mode lasts, across selection changes` in `lib/src/components/wall/WorkspaceSelectionOverlay.test.tsx`; rationale). **Never restart or retime the march for travel** — only the dash resizes, refitted to the moving perimeter so segments stay even — and draw the smear separately ([Ring travel](#ring-travel)). **While unfocused, pause it and apply `saturate(0.3)` to the ring.**
- **Never pause the ants in a focused window except during Workspace title editing**, resuming when editing ends without changing mode, **under reduced motion**, which holds a still dashed ring, **or under `cfg.marchingAnts.paused`** (visual snapshots set it in `lib/.storybook/preview.ts`). Pinned by `pauses while a workspace is renamed, then resumes marching` and `holds the ants still under reduced motion` in `lib/src/components/wall/WorkspaceSelectionOverlay.test.tsx`.
- Border radius follows DESIGN.md's Concentric-Corners Rule: the pane ring's radius is the pane radius plus the inflate (`PANE_SELECTION_RING_RADIUS_PX`), with the marching-ants path inset so its stroke centerline sits on the same gutter midline; doors sit at zero offset and keep `0.5rem 0.5rem 0 0`.
- Color is the resolved `--color-focus-ring`, **re-read whenever `document.body`'s class/style changes**, because the dynamic palette publishes it there (`useFocusRingColor`).
- `z-index: SELECTION_RING_Z_INDEX` (50), `pointer-events: none`. Under `WorkspaceWindow` it renders into `document.body`, outside the Workspace's transform and stacking context.
- **Every modal must render into `document.body` too, at a `MODAL_LAYERS` value above the ring's** (`ModalOverlay`), or the ring crosses it — by value, never insertion order. Pinned by `lib/src/components/ModalOverlay.test.tsx`.

Source of truth: `rectUnionOutline` in `lib/src/lib/rect-union-outline.ts` and `WorkspaceSelectionOverlay` in `lib/src/components/wall/WorkspaceSelectionOverlay.tsx`.

### Ring travel

The ring's rect and shape are driven **per-frame by a JS tween, never a CSS transition**; DESIGN.md's ban on animating layout properties does not reach it (rationale). Motion is `FOCUS_MOTION_MS` (220ms — half `LATH_MOTION_MS`) on the house curve `cubic-bezier(0.22, 1, 0.36, 1)`.

Per-frame writes are **imperative**: `SelectionRing` gives the overlay refs to its stable shell; the rAF loop writes rect, path `d`, marching dash, and smear geometry, then **re-applies after structural renders, pre-paint**, so fresh nodes do not flash. **Never reintroduce per-frame React state** — reconciling this subtree competes with travel for the frame budget (rationale).

- **Identity change → tween.** A measurement whose identity (`${selectedType}:${selectedId}`) differs from the one on screen glides from the current interpolated position to the new target, **clock restarted**, so arrow-key spam stays responsive.
- **Helper side is identity.** An open helper appends its side, so opening, closing and switching sides tween the union’s two rectangles from the painted frame, including interrupted motion; same-side motion follows the same-identity rules below.
- **Same identity → snap 1:1.** A same-identity re-measure with no tween in flight (sash drag, window resize, a settled leaf's store commit) writes the new rect directly, tracking the geometry exactly instead of easing behind it.
- **In-flight retarget.** A same-identity re-measure *during* a tween retargets the destination **without resetting the clock**, so the ring converges on a moving target (select-a-neighbor-during-kill) and still lands on the original completion instant.
- **Snap gate.** `motionIsInstant()` — `!cfg.layout.animate` (visual snapshots) or `prefersReducedMotion()` — settles the ring instantly; it is the same predicate the Lath animator's duration uses, so ring and leaves agree. **A ring appearing with nothing on screen also snaps**: there is no `from` to glide from.
- **The unfocus-saturate fade is the one CSS transition** (`filter ${FOCUS_MOTION_MS}ms`, set inline by `SelectionRing.tsx`); neither the snap gate nor reduced motion touches it. Visual snapshots capture it already finished (pinned in `lib/.storybook/preview.ts`).
- Pane↔door selection morphs the corner radii (12px all-round ⇄ `8,8,0,0`) and stroke inset through the same tween, so the shape lerps instead of popping.
- **Must continue from the last painted frame across Workspace activation**, not the incoming Wall's stale frame. Hidden Walls neither animate nor publish ring geometry. Tabs use Door geometry; `+` uses its button rectangle and 4px corners. Pinned by `carries the last visible ring across Walls instead of their stale pane positions` in `lib/src/components/wall/WorkspaceSelectionOverlay.test.tsx`.

Source of truth: `lib/src/lib/rect-tween.ts` (position and velocity), `lib/src/lib/ring-geometry.ts` (outline/smear geometry), `lib/src/components/wall/WorkspaceSelectionOverlay.tsx` (the rAF loop), `lib/src/components/wall/SelectionRing.tsx` (the SVG shell).

#### Directional motion smear

**Must smear each travelling edge by its own perpendicular analytic velocity**, with zero alpha for stationary edges and no smear when settled, under reduced motion, or around a source/helper union. **Must keep smear separate from the crisp, unbroken outline**; extent and intensity remain independent (rationale).

**Must compute dash length from the rendered path's geometry**, never a DOM path measurement or a quarter-circle approximation (rationale). **Never use an SVG `feGaussianBlur` here** (rationale).

Source of truth: `sampleRingVelocity` in `lib/src/lib/rect-tween.ts`; `writeSmear` in `lib/src/components/wall/WorkspaceSelectionOverlay.tsx`; `ringPoints` / `cornerPath` / `ringPerimeter` in `lib/src/lib/ring-geometry.ts`. Tests: `lib/src/lib/ring-geometry.test.ts`; `lib/src/components/wall/WorkspaceSelectionOverlay.test.tsx`.

### Position tracking

Each pane body registers its DOM element in a `paneElements` Map while mounted (`usePaneChrome`); the overlay resolves the enclosing Lath leaf (`[data-lath-leaf]`) via `resolvePaneElement`, so the ring covers header + body. Doors are registered by the `Baseboard` through `DoorElementsContext` (`[data-door-id]`), **only the *visible* subset** — an overflowed door has no element to measure.

Re-measures on: selection change, target resize, an ancestor's scroll, window resize, Workspace changes, every Lath store commit, and each Lath animation frame. **Must hold the last painted frame when the target is missing, detached, or zero-sized**, including stale Door observer notifications during restore. Pinned by `restores from the last painted Door through a %s target` in `lib/src/components/wall/WorkspaceSelectionOverlay.test.tsx`.

Source of truth: `lib/src/components/wall/WorkspaceSelectionOverlay.tsx`; `subscribePaneMotion` in `lib/src/components/wall/pane-motion.ts`; `resolvePaneElement` in `lib/src/components/wall/resolve-pane-element.ts`; `WindowFocusedContext` in `lib/src/components/wall/wall-context.tsx`, which the overlay reads and the Wall fills from `useWindowFocused` in `lib/src/components/wall/use-window-focused.ts`.

## Spatial navigation

**Must resolve arrow navigation through the engine-neutral `WallNav` seam to Lath's `neighborOf`, never a DOM rect scan.** Neighbor eligibility and precedence belong to `docs/specs/tiling-engine.md` → "Layout".

**Back-navigation.** A breadcrumb tracks the last navigation direction and origin pane; **the opposite direction returns to the origin instead of doing a spatial lookup**, which is what makes asymmetric layouts navigate reversibly.

**Pane↔door.** Down from a pane with no pane below it selects the *first* door; Up from a door selects the *last* pane; Left/Right moves between doors. **Doors have no spatial query** — they are an ordered list.

**Must let Up from a top-edge pane highlight the active Workspace tab when a strip is mounted.** Left/Right traverses tabs in strip order and then `+`, stopping at either end; Down returns to the originating live pane, or the first live pane if it disappeared. Clear pane backtracking on entry to either chrome row. Scroll highlighted tabs into view; highlighting changes neither the active Workspace nor DOM focus. Pinned by `lib/src/components/wall/keyboard/handle-pane-navigation.test.ts`.

**Must keep Workspace tabs and `+` command-mode-only selection targets.** `Enter` on an inactive tab activates it and retains tab selection in command mode; on the active tab it enters the last live pane in passthrough, falling back to the first. `Enter` on `+` creates a Workspace and enters its terminal after mount. Workspace close and rename follow [Workspace tabs](#workspace-tabs) and [Workspace lifecycle](#workspace-lifecycle); other pane actions and terminal clipboard operations are inert there. Every passthrough entry selects a live pane. Pinned by `navigates Workspace tabs with arrows and Enter, entering the active tab or creating from +` in `lib/src/components/WorkspaceWindow.test.tsx`.

**`Cmd/Ctrl+Arrow` swap.** Swaps Surface **content** between two panes, leaving the layout shape unchanged. One Lath `swap` op trades the two leaf identities, and because per-leaf metadata and terminal-registry entries are keyed by id, title/params/session follow automatically — **never write a companion title swap** — with no DOM reattach. Selection stays on the moved Surface, so **the breadcrumb records the *partner*** (the pane now holding the old slot): the opposite `Cmd+Arrow` swaps back exactly and a plain opposite arrow selects the partner.

**Must ignore swap chords while non-pane chrome is selected**, including when a prior pane move left a breadcrumb (`lib/src/components/wall/keyboard/handle-pane-shortcuts.test.ts`). Source of truth: `WallNav` in `lib/src/components/wall/keyboard/types.ts`; `nav` in `lib/src/components/Wall.tsx`; `handlePaneShortcuts` in `lib/src/components/wall/keyboard/handle-pane-shortcuts.ts`; `handlePaneNavigation` in `lib/src/components/wall/keyboard/handle-pane-navigation.ts`.

## Minimize and reattach

### Minimize (`m`/`d`, the header button, or a drag onto the baseboard)

`lath.store.doorLeaf(id, { park })` detaches the leaf and returns a JSON-serializable **restore token** (`docs/specs/tiling-engine.md` → "Restore tokens"); the Wall appends `{ id, token }` to its `doors` state and moves selection to the new door in command mode. **The Session stays in the registry — nothing is disposed.** Minimizing the *last* pane also triggers the refill ([Auto-spawn refill](#auto-spawn-refill)). A pane dragged onto the baseboard takes the identical path (`onProposeMinimize` → `minimizePane`).

**A runtime Door is `{ id, token }` and carries no metadata.** Title, params and parked-ness stay in the Lath store, which keeps changing while the Surface is Doored, so no copy can go stale: **every reader — reattach, `dor` param matching, kill/session teardown, `dor list`, the baseboard chip's label, the session save — goes through `lath.getMeta(id)`**, and the persisted `PersistedDoor` row is materialized from the store at save time.

**A minimized browser or Tool Surface parks rather than unmounting** (`shouldParkOnMinimize`); terminals do not. `docs/specs/tiling-engine.md` → "Parked leaves" owns the mechanism, who parks, and the visibility contract.

### Reattach (click door, `Enter`/`m`/`d` on door, or drag out)

`lath.restoreLeaf(meta, token, { fallbackRef })` applies the token's three-tier exact/neighbor/fallback policy (`docs/specs/tiling-engine.md` → "Restore tokens"). The Wall supplies the fallback reference — the selected pane if live, else the first pane — and, if the restore still fails (no token, empty tree), adds the leaf as the root, so **a reattach is never silently swallowed**.

A door dragged out of the baseboard skips the token entirely and inserts at the hit-tested drop position the user chose (`onExternalDrop` → `lath.insertLeaf`). **Either path unparks in the same commit that re-admits the Surface**, so the DOM is never momentarily unmounted.

### Splitting from a Door

`dor split --surface <minimized-ref>` and `dor ensure --surface <minimized-ref>` **create the new terminal Surface directly as a Door** rather than rejecting the reference or restoring it first. It is inserted immediately to the right of the reference Door, and **the response reports `minimized: true` even without `--minimize`**. Its restore token's neighbor tier points at the reference Door, so restoring the new Door can still split beside the reference if that was restored first. **`--auto` resolves to `right` for a Door reference** — there is no visible pane geometry to inspect.

## Inline rename

Triggered by `,` in command mode or by clicking the session name in the pane header.

**Must consume `,` without starting a rename on a Door or browser Surface.** Only a terminal or Tool pane, on every face, mounts the title editor. Pinned by `lib/src/components/wall/keyboard/handle-pane-shortcuts.test.ts`.

The name `<span>` is replaced by an `InlineEditInput` (shared with the browser URL editor in `docs/specs/dor-browser.md`): same font (`font-mono font-medium`), `bg-transparent`, no border, seeded from the label with the failure glyph stripped. `Enter` confirms, `Escape` cancels, `blur` confirms — **whichever lands first settles the edit**, so the blur following an Enter/Escape unmount cannot submit a second time. It stops propagation on `mousedown`/`click`/`keydown` so the panel click and the header drag never fire.

**Must seed each rename from the current label and preserve the user's draft and selection across header re-renders** (rationale). Clipboard chords follow `docs/specs/mouse-and-clipboard.md` §8.9.

Submitted values are rejected when empty or when they fail the `setTerminalUserTitle` validation that also guards title seeding (`docs/specs/terminal-state.md` → Supported OSC Inputs). `<unnamed>` is the default panel placeholder but is otherwise allowed as a user pin. **On rejection the input still closes** — it is not a blocking dialog — and a warning popover anchored under it names the offending value, dismissing on the next pointerdown, scroll, resize, `Escape`, or after `cfg.overlays.warningAutoDismissMs` (3s; 0 under visual snapshots, pinned in `lib/.storybook/preview.ts`).

Source of truth: `InlineEditInput` in `lib/src/components/wall/InlineEditInput.tsx`; `usePaneRename` in `lib/src/components/wall/use-pane-rename.tsx`; `IllegalRenameWarning` in `lib/src/components/wall/IllegalRenameWarning.tsx`; `useDismissOverlay` in `lib/src/components/wall/use-dismiss-overlay.ts`.

## Session lifecycle and terminal registry

**Must use one stable Session id for a terminal Surface, its registry key, and its platform PTY.** Layout moves and swaps change position only. `TerminalPane` calls `getOrCreateTerminal(id)` on React mount and `unmountElement(id)` on React unmount; **the session (xterm.js instance, PTY, DOM element) persists in the registry across mount/unmount cycles**, and an unmounted element leaves the entry `Orphaned`. A browser surface's pane ID is a Surface id with no registry entry or PTY (`docs/specs/glossary.md`); its DOM is hosted by LathHost's leaf div and rebuilt from persisted params, never from the registry.

| Op | Behavior |
|---|---|
| **Create** `getOrCreateTerminal` | Creates xterm.js through `createXtermHost` and a PTY; reuses an existing entry. **The WebGL addon is not loaded here** ([Renderer](#renderer)). |
| **Resume** `resumeTerminal` | Creates the xterm entry and writes replay data, spawning no PTY. Webview recreated over retained Live or Exited PTYs (Link: Severed → Resuming → Live). |
| **Restore** `restoreTerminal` | Creates the xterm entry and spawns a new PTY with the saved cwd; **replays no transcript** (`docs/specs/transport.md` → "What is persisted"). Cold start from a saved Snapshot (Link: Cold → Live). |
| **mount / unmount** | `mountElement` reparents the persistent DOM element into a container, `unmountElement` removes it. **The Registry entry survives**, and **neither fits the terminal** — the caller owns fitting ([Animations](#animations)). |
| **Dispose** `disposeSession` | Kills the PTY, disposes xterm, removes the registry entry on kill or Surface replacement. **Never on minimize.** |
| **Swap** | Registry entries follow the traded leaf ids ([Spatial navigation](#spatial-navigation)). |

- **Untouched**: new `getOrCreateTerminal` sessions start untouched; `isUntouched(id)` exposes the flag, user-originated PTY input clears it, and resume/restore seed the persisted one. **Missing legacy snapshot data defaults to touched (`false`)**, keeping close confirmation conservative.
- **Shell selection replacement**: the standalone Settings dialog's Shell row and the VS Code shell picker send `dormouse:new-terminal` with `replaceUntouched` when the selected shell type changes. **A shell is identified by executable path plus ordered arguments**, so WSL distributions and Windows Developer shells sharing an executable stay distinct. **`Wall` always mints a new session id and a fresh `surface:N` ref.** An untouched selected plain terminal pane or door has the new terminal take over its leaf via a Lath `replace` op (an atomic identity swap; doors reattach through the normal restore path first), the old session disposed and its ref retired; a touched selection, or none, spawns a new pane beside it. Announced spawns show a transient pane-anchored notice (`Switched to zsh`, `Opened bash`).
- **Replay-time terminal reports must be dropped; user input must not be** — during **resume** replay the registry drops the replies xterm.js emits to queries embedded in buffered output, before they reach the retained PTY (`docs/specs/transport.md` → "Report filtering on the input side").

Source of truth: `lib/src/lib/terminal-store.ts` (registry maps and pending shell opts, imported directly, including by `lib/src/remote/burrow/`), `lib/src/lib/terminal-lifecycle.ts` (the ops), `lib/src/lib/terminal-registry.ts` (the facade).

### Agent resume on cold restore

On cold restore, a terminal pane with a host-captured recovery invocation runs it automatically; `docs/compatible-agents.md` → "Cold restore" owns the restore-only gate, validation, and prompt-ready typing. Layout writes one dim `⟲ resuming agent session: <command>` line **to xterm, never the PTY**, to mark the discontinuity — a passive notice with no dismiss or lifecycle. Source of truth: `restoreTerminal` in `lib/src/lib/terminal-lifecycle.ts`, called from `lib/src/lib/session-restore.ts`.

### Renderer

**Must use `@xterm/addon-webgl` for mounted terminals when available**, falling back to xterm's DOM renderer on unsupported WebGL, activation failure, or context-budget eviction. `cfg.terminal.webglRenderer` disables WebGL and is off under visual snapshots. ImageAddon owns its separate canvas layers ([Inline graphics](#inline-graphics)). (rationale)

- **Must acquire GPU resources at mount, never at Session creation**, and keep a successfully activated renderer when context capture or explicit loss is unavailable. (rationale)
- **Must dispose the addon on unmount/minimize, Workspace deactivation, helper parking, and Session disposal**, then explicitly lose its context when captured and supported. Report addon or extension failures without aborting teardown. Minimize preserves the xterm, grid, buffers, PTY, and other addons.
- **Must load a fresh addon on reattachment without resizing the terminal for the renderer swap.** Terminal fitting follows "Animations". A stale mount's cleanup must not release a newer mount's renderer.
- **Must attempt WebGL at most once per mount.** Failure or context loss stays on DOM until the next unmount/remount; focus and metadata changes never retry. Focus-based recovery remains under `## Future`.
- **Must preserve the addon's shared atlas cache.** Compatible mounted terminals share rasterized atlas canvases; GPU texture copies remain per context. Releasing one renderer releases only its atlas ownership; the last owner releases the cache. (rationale)

**Must report the active renderer as `data-renderer="webgl"|"dom"`** on the persistent terminal host.

Source of truth: `TerminalWebglRenderer` in `lib/src/lib/terminal-webgl.ts`; `mountElement` / `unmountElement` / `parkElement` / `disposeSession` in `lib/src/lib/terminal-lifecycle.ts`. Tests: `lib/src/lib/terminal-webgl.test.ts`, `lib/src/lib/terminal-registry.alert.test.ts`.

### Inline graphics

**Must support SIXEL (`DCS ... q ... ST`), iTerm IIP (`OSC 1337 ; File=` and its multipart forms), and Kitty graphics (`APC G ... ST`) in every Session through stock `@xterm/addon-image`**, gated by `cfg.terminal.inlineImages`; Kitty support follows the addon's alpha-quality subset. **Must load the addon at Session creation, never on the first image**: it answers the DA1, XTSMGRAPHICS, and cell-size probes a program reads before sending one (rationale).

**Must bound each Session to 8,388,608 pixels per image, 33,554,432 bytes per SIXEL/IIP/Kitty sequence, and 34 MB of FIFO image storage** (rationale). **Dormouse forwards only the bytes carried in the sequence and resolves no filename**; ImageAddon discards a transfer without `inline=1`.

**Every host's CSP must grant `'wasm-unsafe-eval'`, never `'unsafe-eval'`** — the addon compiles a vendored WebAssembly SIXEL decoder from `activate()`, making this a Session-creation requirement rather than a first-image one (rationale).

Source of truth: `IMAGE_ADDON_OPTIONS` in `lib/src/lib/terminal-lifecycle.ts`; `OSC1337_FORWARDED` in `lib/src/lib/terminal-protocol.ts`; `getWebviewHtml` in `vscode-ext/src/webview-html.ts`, `app.security.csp` in `standalone/src-tauri/tauri.conf.json`, `pocketContentSecurityPolicy` in `remote-lib-common/src/remote/relay-common.ts`.

### Session persistence

**Must coalesce scheduled saves into one 500ms timer without restarting it on later commits.** The snapshot stores its layout in the native Lath format (`lathLayout`; `docs/specs/tiling-engine.md` → "Persistence"); `docs/specs/transport.md` → "Persistence policy" lists what is persisted and owns the never-persist rules. **Derived command/app labels on minimized doors are display-only** — never persisted as user-pinned titles.

Three save triggers, in ascending urgency:

- Any Lath store commit (add/remove/resize/swap/meta, including the active pane the layout records) **schedules** the save.
- Content changes with no Lath commit — `onPtyData` (terminal output, OSC CWD, title candidates), activity/TODO, pane title/command state, minimized-door changes — only **mark the session dirty**; a 30s heartbeat persists only when dirty, so an idle app stops writing.
- PTY exit, `onRequestSessionFlush`, `pagehide`, unmount, and extension shutdown requests **flush immediately and unconditionally** — the correctness net for any dirty-trigger gap (a program calling `chdir()` emits no event, so its persisted CWD may go stale until the next output — accepted).

`docs/specs/standalone.md` §Persistence owns the dirty-gating mechanism and the store-level identical-value backstop.

**Under a Workspace, a Wall publishes its record to the Window aggregator instead of the platform slot**, and compares each save against its own Workspace's previous record — container shapes and the aggregator's rules are `docs/specs/transport.md` → "Persisted session types" ([Workspaces](#workspaces)). **A Wall marks itself dirty only for Surfaces it owns**: both content stores are Window-global and name the Surface that changed, so an idle Workspace does not rebuild its record — a `getCwd` per pane — whenever another Workspace moves. VS Code persists one Workspace per webview (`WebviewView` / `WebviewPanel`).

Snapshots are read through `readPersistedSession()`, which tolerates a stringified blob and logs-and-discards an unreadable one so malformed storage starts fresh rather than blocking startup (`docs/specs/transport.md` → "Persisted session types").

Startup recovery is priority-based:
**A Window plans once per Workspace off one live-PTY list**: `collectLivePtys` runs the single PTY-list round trip for the whole webview, and each Workspace takes the slice its own saved panes name, so one host answer restores N Workspaces (`docs/specs/standalone.md` → Persistence). A single-Wall host reaches the same behavior through `resumeOrRestore`.

1. **Resume** (webview recreated, retained Live or Exited PTYs): request PTY list + replay data from the platform, `resumeTerminal()` each (500ms timeout). **Saved pane and door titles are seeded back via `setTerminalUserTitle()`** (`docs/specs/transport.md`), so persisted placeholder labels never replay as user pins. If the saved session covers every retained PTY, restore the saved Lath layout when its leaf set matches and reattach saved minimized items as doors. **Never fall through to cold restore just because the visible `paneIds` list is empty** — a wall whose retained sessions are all minimized is still a resume.
2. **Restore** (app restart, cold start): the Wall's `seed` hydrates from the restored Lath layout, else falls to (3); `restoreTerminal()` per pane with its saved cwd and title, plus the single-use agent resume invocation the host captured (`docs/compatible-agents.md` → "Cold restore") and the pane's persisted TODO, which rides the spawn (`docs/specs/alert.md` → Public State). Browser surfaces are rebuilt from their persisted params instead.
3. **Fallback/manual pane creation**: with no saved layout safely applicable, add panes as splits from the previous pane.
4. **Empty state**: one new pane.

Every PTY spawned by (2)–(4) uses the current default shell selection.

Source of truth: `lib/src/components/wall/use-session-persistence.ts` (save triggers and flushes), `lib/src/lib/session-save.ts` (serialization), `collectLivePtys` / `resumeOrRestoreFrom` in `lib/src/lib/reconnect.ts` (recovery priority), `restoreWindowOrFresh` in `standalone/src/window-restore.ts` (the per-Workspace boot).

### Activity state

Renderer Activity storage is owned by `docs/specs/alert.md` → Public State.

## Theme

`.lath-host` / `.lath-leaf` in `lib/src/index.css` give an app-bg host, a terminal-bg body, and a 30px header band per leaf, applied by LathHost from the shared `PANE_HEADER_HEIGHT_PX`. The content area uses a 7px top/sides inset and 2px bottom inset (`px-1.75 pt-1.75 pb-0.5` on wrapper, `inset-x-1.75 top-1.75 bottom-0.5` on container); **the `LATH_LAYOUT_OPTS` gap of `PANE_GUTTER_PX` is the only visual separator between panes**. The host paints `var(--color-app-bg)` so gutters and rounded pane/header corner cutouts match host chrome; **terminal content backgrounds are painted by the React terminal wrappers and xterm host elements, never by the outer leaf containers**. The two-layer `@theme --color-*` → `var(--vscode-*)` token strategy is `docs/specs/theme.md`'s.

## Animations

All pane motion is owned by the Lath **animator** (`docs/specs/tiling-engine.md` → "Animation"), whose interpolated inline geometry on the leaf divs is what lets the selection overlay measure the tween ([Position tracking](#position-tracking)). **Never resize terminals to intermediate animation or sash-preview dimensions.** Fit after the final geometry is painted, including a sash commit at its last preview size; canceled sash drags preserve the original grid, and same-size reattachment sends no PTY resize. Outside layout motion, debounce container resizes by 150ms; unmount cancels pending fitting (rationale).

Source of truth: `TerminalPane` in `lib/src/components/TerminalPane.tsx`; `TerminalResizeContext` in `lib/src/components/wall/wall-context.tsx`, supplied by `LathHost` in `lib/src/components/wall/LathHost.tsx`. Tests: `lib/src/components/TerminalPane.test.tsx`.

### Zoom (elevated expansion)

**Zoom is presentation-only** — the split tree and every tiled rect stay unchanged; the geometry (the 15px-inset wall rect, the elevated layer, the blurred app-bg halo) belongs to `docs/specs/tiling-engine.md`. **Zoom is coupled to passthrough focus**: acquiring it enters passthrough and focuses that pane; exiting passthrough, focusing another pane, or selecting a Door or a Workspace tab starts unzoom immediately.

**Only the owner's header shows Unzoom**, header tokens inverted so the escape action stands out, and only the owner's control toggles zoom *off*. The exposed perimeter leaves other headers reachable, so their Zoom control **hands zoom over — focus included** — rather than merely unzooming the owner. Source of truth: `zoomedId` / `setZoomed` in `lib/src/components/wall/lath-wall-store.ts`; `onZoom` / `releaseZoomExcept` in `lib/src/components/Wall.tsx`; `ZoomedIdContext` in `lib/src/components/wall/wall-context.tsx`; `paneZoomButtonClass` in `lib/src/components/design.tsx`.

### Spawn (new pane reveal)

A newly added leaf grows in from the boundary it was placed against; `docs/specs/tiling-engine.md` → "Animation" → Enter owns the hint and its precedence.

Shell-selection replacement shows a fixed-position notice over the resulting pane, fading in/out over 1500ms via `.shell-spawn-notice`, suppressed to a static render under reduced motion. Surface moves reuse it in alternate-screen programs (`docs/specs/dor-cli.md` → Handle Model).

### Kill (two-phase fade + tween reclaim)

Every kill gesture runs the animator's two-phase exit; `docs/specs/tiling-engine.md` → "Animation" → Exit owns the mechanics, the idempotence guard, and the last-pane bottom-right shrink.

**Selection tail.** At removal time selection moves to a survivor (`lath.listPanes()[0]`, or `null` → auto-spawn when the last pane goes) **only when the killed pane is still the selected pane** — a live check, re-read inside the removal timeout, so a background kill leaves selection untouched and a selection move *during* the fade is honored both ways (rationale).

**A doored Surface has no visible pane to fade**, so the kill branches: close any agent-browser session, `forgetLeaf` (which also unmounts a parked DOM), `disposeSession`, drop the door chip. Disposing stops the PTY, which also makes a still-armed `typeCommandWhenPromptReady` bail rather than type into a dead surface.

Source of truth: `killPaneImmediately` in `lib/src/components/Wall.tsx`.

### Auto-spawn refill

A store commit that empties the tree (last pane killed or minimized) triggers the "always keep one pane visible" auto-spawn: a Wall effect subscribed to the store spawns one leaf into the emptied tree (`lib/src/components/Wall.tsx`), **re-entrantly on the same commit chain**, so the refill appears with no separate delay (rationale). Like a split, it takes the default shell selection and **the departing pane's local cwd**.

**The refill adopts the replacement (`selectPane`) only when the current selection points at nothing real** — null (the kill tail cleared it after a selected last-pane kill) or dangling (still naming the just-removed pane). **A valid selection is left alone** — the just-created door on the minimize path, or a live pane after an unselected kill — because the auto-spawn exists to keep a pane visible, not to steal selection. Only an explicit user selection of a pane — a click, a drag, or an embed focusing itself — moves selection off that door afterwards.

## Corner cases

> Numbered for cross-spec reference; the numbers are stable, so append rather than renumber and leave a retired one retired.

- **#2 — A focused iframe surface is not a window blur**: it blurs the window while `document.hasFocus()` stays true, so **presence ends only on a *real* blur** (`docs/specs/alert.md` → Engagement) — otherwise focusing an embed would end it across the window. Source of truth: `subscribeWindowFocus` in `lib/src/lib/window-focus.ts`.
- **#6 — Focus-neutral surface creation (`dor ensure` / `dor iframe` / `dor agent-browser`)**: unlike `dor split`, these open in the background without moving focus off the caller (`docs/specs/dor-cli.md`, `docs/specs/dor-browser.md`). An add never re-parents the caller's subtree or steals activation, and the create does not call `selectPane` (`settleAddSelection` returns false for a focus-neutral, non-selection-replacing add). **The one exception**: `dor iframe` / `dor agent-browser` replacing the pane the user is *currently selected on* moves selection to the replacement, else it would dangle on the removed leaf; any other pane, or a door selection, is left untouched. Any completed teardown preserves the caller's live selection.

## Future

### Re-arming the WebGL renderer after context loss

A mounted pane that loses its WebGL context ([Renderer](#renderer)) stays on the DOM renderer until it is unmounted and mounted again, even once other panes close and free budget. The eviction order is also backwards for a tiling terminal: browsers evict *oldest-first*, but the pane that most deserves the GPU is the focused one.

The future policy permits another WebGL attempt when a DOM-fallback pane gains focus. Unbuilt because the naive version thrashes: past the context cap, focusing panes in turn would evict and rebuild glyph atlases on every focus change, plausibly worse than sitting still on the DOM renderer. Any implementation needs a re-arm budget (at most once per pane, or a cooldown) and a measurement showing focus-cycling does not regress.
