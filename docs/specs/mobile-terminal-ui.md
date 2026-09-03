# Mobile Terminal UI

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

The mobile terminal composition: `MobileTerminalUi` (the wrapper owning touch
modes, input modes, and the keyboard reserve) around `MobileWall` (one visible
terminal Session at a time, with session switching). **Mobile exposes no
split-pane layout and no multiple Workspaces.**

Three consumers compose them: the website Pocket playground
(`website/src/components/PocketTerminalExperience.tsx` on `FakePtyAdapter`;
`docs/specs/tutorial.md`), the Pocket app
(`lib/src/remote/pocket-app/PocketWall.tsx` on `RemotePtyAdapter`;
`docs/specs/pocket-app.md`), and Storybook.

## Core layout

```text
┌─────────────────────────┐
│ Mobile session header    │ MobileWall, fixed/small
├─────────────────────────┤
│ Pane content             │ MobileWall, flexible terminal area
├─────────────────────────┤
│ Touch mode selector      │ always visible
├─────────────────────────┤
│ Input mode selector      │ always visible
├─────────────────────────┤
│ Reserve area             │ stable height
│                         │
│ Shows app keyboard UI    │ when OS keyboard hidden
│ Occupied by OS keyboard  │ when OS keyboard visible
└─────────────────────────┘
```

Chrome rules:

* One divider, between the Touch and Input rows — none above Touch, none below
  Input.
* The Touch row and its selector tray sit on `terminal-bg`; the Input row and
  the reserve area on `header-inactive-bg` / `header-inactive-fg` (rationale).
* The mobile session header is a flush bar — **never** the desktop title corner
  radius. Order: title, alert bell, secondary detail, TODO pill, minimize, kill
  (suppressed by `showKillButton={false}`, as Pocket does). Both consumers wire
  minimize to the Sessions reserve, not a desktop Door.
* **`MobileTerminalUi` publishes the shared dynamic palette itself**
  (`useDynamicPalette`, `docs/specs/theme.md`) before rendering gesture UI that
  needs those tokens, `--color-focus-ring` included — it never mounts the
  desktop `Wall`.
* `MobileTerminalUi` provides `TouchUiContext` = true, so shared selection UI
  omits physical-keyboard shortcut hints (`docs/specs/mouse-and-clipboard.md`).

**Never recompute height from `window.visualViewport`**: the reserve is a fixed
CSS height and the root `h-screen` (when `fillViewport`) or `h-full`, so the
terminal region does not bounce as the OS keyboard animates (rationale).

## Touch mode selector

The touch selector controls what a pane-content touch does. **Always visible**,
and **must be self-labeling** — segmented buttons carrying both an icon and a
short mode label (rationale).

| Mode (button label) | Availability | Behavior |
| --- | --- | --- |
| Gestures | Always | Pane-content touches, pen presses, and primary clicks open the Gesture mode radial menu. |
| Text selection (`Select`) | Always | Touch, pen, and primary drags select terminal text as on desktop; a capturing pane gets mouse override. |
| Mouse | Active TUI capturing mouse events | Touches are passed through as terminal mouse input. |

Default **Gestures**. **Mouse mode falls back to Gestures when the active pane
stops capturing mouse events.**

Touch mode is global, so **each mounted pane's mouse override is a pure function
of that mode and the pane's *own* mouse-reporting state** (`selection` +
reporting ≠ `none` → `permanent`, else `off`), recomputed for **every** pane,
not just the active one — a pane switched away from must not keep a stale
override. The consumer owns this wiring.

Select mode **must route touch and pen drags through the shared terminal
mouse-selection router**, never a mobile-only one, so every selection and copy
behavior matches desktop (`docs/specs/mouse-and-clipboard.md`). **Paste rides
the native browser/OS flow** — no mobile clipboard manager, no multi-line paste
review.

Event routing, by mode:

* **Gestures / Select** — `wheel` and `touchmove` in the pane content are
  consumed in the capture phase, before xterm can act on them (rationale).
* **Mouse** — `touchstart` / `touchmove` / `touchend` / `touchcancel` are
  consumed instead, and primary touch and pen pointers synthesize left-button
  mouse events on the element under the pointer (pointerdown / pointermove /
  pointerup-or-cancel → `mousedown` / `mousemove` / `mouseup`). `wheel` is left
  alone so it still reaches the terminal, and real mouse pointers fall through
  untouched. (rationale)

Gesture mode also consumes primary mouse/trackpad clicks (rationale): the click
starts radial gesture handling, `preventDefault()`s, stops propagation, captures
the pointer, and **must never reach the embedded `Wall`, xterm, or the tiling
engine** for focus, selection, or pane interaction. **Non-primary mouse buttons
are ignored**, so their browser or host behavior continues.

Source of truth: `TOUCH_MODES` in `lib/src/components/MobileTerminalUi.tsx`;
per-pane override wiring in `lib/src/remote/pocket-app/PocketWall.tsx` and
`website/src/components/PocketTerminalExperience.tsx`.

## Gesture mode

Touching the pane content opens a radial menu offset from the touch origin, in
the opposite diagonal from the user's thumb (rationale). **The offset is clamped
inside the pane**; on an axis shorter than twice the clamp margin the rose
centers on that axis instead.

**Draw only the offset guide line inside the visible compass rose** — never one
under the user's thumb. It is solid and fully opaque; the offset rose center
renders a small fully opaque circle.

The radii order `RADIUS_FADE_START` < `RADIUS_HIGHLIGHT` < `RADIUS_SELECT` <
`RADIUS_LAYOUT`.

| Variable | Behavior |
| --- | --- |
| `RADIUS_LAYOUT` | Circular radius for exploded option anchors around the offset rose origin; diagonal ones use normalized compass vectors, so their x/y offsets are `RADIUS_LAYOUT * Math.SQRT1_2`. Root labels use packed square-keypad geometry instead ([Root layout](#root-layout)); the quit submenu uses its own tighter `QUIT_RADIUS`. |
| `RADIUS_SELECT` | Visible circle around the offset rose origin; the mirrored drag reaching it selects the closest compass direction. |
| `RADIUS_FADE_START` | No directional root-group fading before this drag distance. |
| `RADIUS_HIGHLIGHT` | No circle drawn; the drag reaching it highlights the closest compass direction without selecting it. |

Gesture menu items reuse the pane-header palette: idle takes inactive header
bg/fg, highlighted or selected takes active header bg/fg plus an inset
`color-focus-ring` ring. **Never indicate gesture selection state with a
layout-affecting border.** Inactive chips get a quiet shadow only; heavier
elevation is reserved for active chips. The select circle and its eight compass
ticks render at full opacity, thickening the tick on the highlighted or selected
direction.

On touch-down, root labels fade in with a subtle scale-in and the select circle
grows from zero to `RADIUS_SELECT` — a state reveal, never a loop.
**Reduced-motion users get the final state immediately.**

**While a root group is still being chosen, all root groups stay fully opaque
until the drag exceeds `RADIUS_FADE_START`**; past it each fades by its
alignment with the drag vector, reaching full per-direction opacity at
`RADIUS_SELECT` — brightest toward the drag, zero opposite.

Source of truth: `displayOriginAwayFromThumb` and the `RADIUS_*` constants above
in `lib/src/lib/mobile-gesture-menu.ts`; `rootGroupOpacity()` and `QUIT_RADIUS`
in `lib/src/components/MobileGestureRadialMenu.tsx`.

### Root layout

Root labels are laid out as a square keypad, not on a circle (rationale). The
four cardinal arrow chips share one `GAP_CARDINAL_RING` from the select circle
edge. **Each diagonal group renders as three separate labels at `GAP_CLUSTER`,
never one combined pill**: its first option is the cluster center, that option's
inward corner aligned with the diagonal tick at the same ring gap, scaled to
read as the same horizontal/vertical gap rather than a longer diagonal one.
Diagonal center corners — SE aligns Enter's top-left, NE Backspace's
bottom-left, SW Tab's top-right, NW Esc's bottom-right. NE and SE place their
two secondaries right of the center option, one above and one below; NW and SW
place theirs left.

| Group | Center | Secondary (above) | Secondary (below) |
| --- | --- | --- | --- |
| NW | Esc | ⌃C\* | Quit\*\* |
| N | ▲ | — | — |
| NE | Backspace | Paste\* | n |
| W | ◀ | — | — |
| E | ▶ | — | — |
| SW | Tab | ⬆︎Tab | Space |
| S | ▼ | — | — |
| SE | Enter | ⬆︎Enter | y |

\* `⌃C` and `Paste` require an in-pane confirmation modal before they run.
\*\* `Quit` opens a second exploded-option menu (`q` | `⌃X` | `:q↵`) instead of
sending input, under the same reset-center, highlight, select, and
expand-and-fade completion rules as normal option selection.

Root labels use compact key glyphs: `⌃` for Ctrl, `⬆︎` for Shift, and
`▲`/`▼`/`◀`/`▶` for arrow keys. Enter and Backspace stay spelled out.

Source of truth: `GAP_CARDINAL_RING`, `GAP_CLUSTER`, and `rootOptionLayout()` in
`lib/src/components/MobileGestureRadialMenu.tsx`;
`MOBILE_TERMINAL_KEY_SEQUENCES` in `lib/src/components/MobileTerminalUi.tsx`;
`MOBILE_GESTURE_GROUPS` and `MOBILE_GESTURE_QUIT_GROUP` in
`lib/src/lib/mobile-gesture-menu.ts`.

### Selection stages

Cardinal directions are a one-stage gesture:

1. Touch down to open the menu.
2. Drag to `RADIUS_HIGHLIGHT` to preview the closest compass point.
3. Drag to `RADIUS_SELECT` on N, S, E, or W to send the matching arrow key
   immediately — **never wait for touch release**.
4. The menu remains for a short completion animation: removed labels fade out;
   the selected label expands and fades out before the overlay clears.

Diagonal directions are a two-stage gesture: steps 1–2 as above, then

3. Drag to `RADIUS_SELECT` to choose that diagonal group.
4. The other seven groups fade out.
5. The compass center resets to the point where the drag intersected the
   `RADIUS_SELECT` circle.
6. The group's three labels **tween** from root to exploded positions around the
   reset center — the center option back along the exact opposite compass
   direction, the secondaries ±45° off it. **They must not fade out and be
   replaced by newly spawned labels.**
7. From the reset center, `RADIUS_HIGHLIGHT` previews an option and
   `RADIUS_SELECT` chooses and sends it — again without waiting for release,
   again followed by the completion animation.

**Releasing after the group selection but before choosing an exploded option
cancels the gesture.**

Overshoot handling: **the option origin ratchets *outward* along the opening
direction while the drag keeps pushing that way**, and **the compass stays
visually collapsed while that push is brisk, latching expanded once the drag
settles** (`OPTION_EXPAND_RELEASE`). (rationale)

Source of truth: `advanceOptionOrigin` / `MOBILE_GESTURE_OPTION_DIRECTIONS` in
`lib/src/lib/mobile-gesture-menu.ts` — the ratchet, and exploded-option
directions per group.

## Input mode selector

The input mode selector controls what appears in the reserve area. **Always
visible**, four items (`Sessions | Recent | Type | Draft`), self-labeling on the
same rule as the touch selector.

| Mode | Reserve area content |
| --- | --- |
| Sessions | Session rows with active, alert, and TODO state; selecting one makes it the single visible terminal. |
| Recent | Recent reserve copy, filling the reserve. |
| Type | Type reserve copy, as a button focusing the hidden terminal input — the way back from a dismissed keyboard. Typed keys echo into the terminal as they happen. |
| Draft | Draft reserve copy, filling the reserve. |

Default input mode is **Type**. Recent and Draft are placeholder-only today and
say so in the reserve — the real features are staged (see [Future](#future)).

**Tapping the Type selector must focus the hidden input synchronously inside the
tap/click handler** — a deferred focus may be refused as not user-initiated,
leaving the keyboard closed (rationale). A follow-up effect re-asserts focus via
rAF and staggered timers as best effort. **Switching away from Type blurs the
hidden input**, so the app keyboard UI returns.

Source of truth: `KEYBOARD_MODES` and `RESERVE_COPY` in
`lib/src/components/MobileTerminalUi.tsx`.

## Type mode input

Typing goes through a visually hidden `<textarea>` configured for terminal-style
input: `autocapitalize`, `autocomplete`, and `autocorrect` off, `spellcheck`
false, `inputmode="text"`, `enterkeyhint="enter"`.

* Normal characters go to the active terminal immediately; Enter sends terminal
  Enter, Backspace works, and physical `Ctrl+C` sends `\x03`.
* **Composed text is buffered until `compositionend`** — the path must not
  depend only on `keydown`, or IME and mobile keyboard behavior breaks.

## Keyboard focus invariant

**Pane-content touches must never open the native keyboard.** The pane content
area may focus the terminal internally for key routing or mouse handling, but
the wrapper marks every text input the terminal surface creates as a
non-keyboard target (`inputmode="none"`, readonly, not tab-reachable — kept true
for later-mounted inputs by a `MutationObserver`) and blurs it when the touch
starts there. **That blur repeats across a rAF and staggered timers, and the
pending retries are cancelled on unmount** (rationale). **The only mobile UI
surfaces that may open the native keyboard are the Type selector and the Type
reserve area.**

Source of truth: the non-keyboard-target and blur plumbing is in
`lib/src/components/MobileTerminalUi.tsx`, the session composition in
`lib/src/components/MobileWall.tsx`; pinned by
`lib/src/components/MobileTerminalUi.test.tsx`,
`lib/src/components/MobileWall.test.tsx`, and
`lib/src/lib/mobile-gesture-menu.test.ts`.

## Future

Potential later additions:

* Real recent commands and a Draft scratchpad (both reserves are placeholder
  copy today).
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* Multi-session support (more than one visible session).
