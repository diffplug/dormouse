# Mobile Terminal UI

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

The mobile terminal composition: `MobileTerminalUi` (the wrapper owning touch
modes, input modes, and the keyboard reserve) around `MobileWall` (one visible
terminal Session at a time, with session switching). The core idea:

```text
Stable terminal viewport + mobile session viewport + explicit touch mode + explicit input mode.
```

Touch modes make pane touches explicit; input modes make the reserve area
explicit. Desktop `Wall` remains the tiling workspace layout; mobile does not
expose split-pane layout or multiple Workspaces.

Three consumers compose these components today: the website Pocket playground
(`website/src/components/PocketTerminalExperience.tsx` on `FakePtyAdapter`; page
wiring in `docs/specs/tutorial.md`), the real Pocket app
(`lib/src/remote/pocket-app/PocketWall.tsx` on `RemotePtyAdapter`;
`docs/specs/pocket-app.md`), and Storybook. The composition was designed and
validated through the website `/playground/pocket` prototype (originally specced
as `mobile-ui.md`; see git history).

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

The wrapper owns the two selectors and the fixed-height reserve; the header and
pane content come from `MobileWall`.

Chrome rules:

* One divider, between the Touch and Input rows — none above Touch, none below
  Input.
* The Touch row and its selector tray sit on `terminal-bg`, so they read as part
  of the terminal surface above. The Input row and the reserve area sit on
  `header-inactive-bg` / `header-inactive-fg`, so the lower input controls are
  distinct from the terminal while still following the selected theme.
* The mobile session header is a flush bar: it does not use the desktop terminal
  title corner radius. The alert bell sits immediately after the title, before
  secondary title detail; the TODO pill, minimize, and (unless the consumer sets
  `showKillButton={false}`, as Pocket does) kill follow. Both consumers wire
  minimize to opening the Sessions reserve rather than creating a desktop Door.
* Because the mobile composition never mounts the desktop `Wall`,
  `MobileTerminalUi` publishes the shared dynamic palette itself
  (`useDynamicPalette`) before rendering gesture UI that depends on those tokens,
  `--color-focus-ring` included.
* `MobileTerminalUi` provides `TouchUiContext` = true, so shared selection UI
  omits physical-keyboard shortcut hints (`docs/specs/mouse-and-clipboard.md`).

The reserve area's height is a fixed CSS height and the root is `h-screen` (when
`fillViewport`) or `h-full` — never a height recomputed from
`window.visualViewport`. The reserve is intentionally stable so the terminal
region does not bounce while the OS keyboard animates. When the OS keyboard is
hidden the reserve shows the selected app keyboard UI; when it is visible the OS
keyboard may cover or occupy that same physical area, which is preferred over
resizing the whole app around the keyboard.

## Touch mode selector

The touch selector controls what happens when the user touches the pane content
area. It is always visible between the terminal content and the input mode
selector. It must be self-labeling through segmented buttons carrying both an
icon and a short mode label — icon-only touch controls are too hard to discover.

Source of truth: `TOUCH_MODES` in `lib/src/components/MobileTerminalUi.tsx`.

| Mode (button label) | Availability | Behavior |
| --- | --- | --- |
| Gestures | Always | Pane-content touches, pen presses, and primary mouse/trackpad clicks open the Gesture mode radial menu. |
| Text selection (`Select`) | Always | Touch, pen, and primary mouse/trackpad drags use the same terminal text selection and copy/paste behavior as desktop. If a mounted pane's TUI is capturing mouse events, Dormouse activates mouse override for that pane. |
| Mouse | Only when the active TUI is capturing mouse events | Touches are passed through as terminal mouse input. |

Default touch mode is **Gestures**. If Mouse mode is active and the active pane
stops capturing mouse events, the selector falls back to Gestures.

Touch mode is a global mobile UI state, so each mounted pane's mouse override is
a pure function of that global mode and the pane's *own* mouse-reporting state
(`selection` + reporting ≠ `none` → `permanent`, otherwise `off`), applied to
every pane rather than only the active one — a pane switched away from must not
be left in a stale override. The consumer owns this wiring; source of truth:
`PocketWall.tsx` and `PocketTerminalExperience.tsx`.

Select mode routes touch and pen drags through the shared terminal
mouse-selection router, not a mobile-only selection implementation, so selection
geometry, smart token extension, copy popups, rewrapped copy, and TUI
mouse-capture override rules match desktop
(`docs/specs/mouse-and-clipboard.md`). Paste rides the native browser/OS paste
flow; there is no mobile clipboard manager and no multi-line paste review.

Scroll-like and touch event routing, by mode:

* **Gestures / Select** — `wheel` and `touchmove` in the pane content are
  consumed in the capture phase before xterm can translate them into mouse
  reports, alternate-screen arrow keys, or scrollback motion.
* **Mouse** — `touchstart` / `touchmove` / `touchend` / `touchcancel` are all
  consumed instead, and primary touch and pen pointers synthesize left-button
  mouse events on the element under the pointer: pointerdown → `mousedown`,
  pointermove → `mousemove`, pointerup or pointercancel → `mouseup`. Suppressing
  the native touch gesture is what makes a tap or drag reach the TUI rather than
  browser panning, browser selection, or xterm's native touch-scroll fallback.
  `wheel` is left alone so it still reaches the terminal, and real mouse pointers
  fall through untouched.

Gesture mode intentionally consumes primary mouse/trackpad clicks in addition to
touch input, which keeps the composition usable in desktop browsers, narrow
desktop viewports, and Storybook without a touchscreen. Such a click starts
radial gesture handling, calls `preventDefault()`, stops propagation, and
captures the pointer; it is never passed through to the embedded `Wall`, xterm,
or the tiling engine for focus, selection, or pane interaction. Non-primary
mouse buttons are ignored so their browser or host behavior can continue. Users
who want terminal selection or TUI mouse input must choose Select or Mouse mode
explicitly.

## Gesture mode

Gesture mode is the default pane-content touch behavior. Touching the pane
content opens a radial menu offset from the touch origin, in the opposite
diagonal from the user's thumb so the compass rose fills the visible area away
from the touch point: a lower-right thumb press opens the rose up and left, a
lower-left press opens it up and right. The offset is clamped inside the pane;
on an axis shorter than twice the clamp margin the rose centers on that axis
instead. Source of truth: `displayOriginAwayFromThumb` in
`lib/src/lib/mobile-gesture-menu.ts`.

As the user drags, the UI draws only the offset guide line inside the visible
compass rose — never a line directly under the user's thumb. The guide line is
solid and fully opaque, and the offset rose center renders a small fully opaque
circle.

Source of truth: `RADIUS_LAYOUT`, `RADIUS_SELECT`, `RADIUS_FADE_START`, and
`RADIUS_HIGHLIGHT` in `lib/src/lib/mobile-gesture-menu.ts` define the radii used
below (`FADE_START` < `HIGHLIGHT` < `SELECT` < `LAYOUT`).

| Variable | Behavior |
| --- | --- |
| `RADIUS_LAYOUT` | Base circular radius for exploded option anchors around the offset compass rose origin. Diagonal exploded labels use normalized compass vectors, so their x/y offsets are `RADIUS_LAYOUT * Math.SQRT1_2`. Root labels use separate packed square-keypad geometry so long labels do not overlap; the quit submenu draws at its own tighter `QUIT_RADIUS`. |
| `RADIUS_SELECT` | Visible circle drawn around the offset compass rose origin. When the mirrored drag reaches this distance, the closest compass direction is selected. |
| `RADIUS_FADE_START` | No directional root-group fading happens before this drag distance. |
| `RADIUS_HIGHLIGHT` | No circle is drawn. When the drag reaches this distance, the closest compass direction is highlighted, but not selected. |

Gesture menu item state uses the same palette as pane headers. Idle groups and
options use inactive header background/foreground; highlighted or selected ones
use active header background/foreground plus an inset `color-focus-ring` ring.
Layout-affecting borders must not be used to indicate gesture selection state.
Inactive chips get only a quiet shadow; the heavier elevation is reserved for
active chips. The select circle and its eight compass-direction ticks render at
full opacity, with a thicker tick on the current highlighted or selected
direction so the circle and label clusters read as one gesture system.

When the rose opens on touch-down, root labels fade in with a subtle scale-in and
the select circle grows from zero radius to `RADIUS_SELECT`. This is a short
state-reveal motion, not an ongoing decoration; reduced-motion users get the
final state immediately.

While the user is still choosing a root group, all root groups stay fully opaque
until the drag exceeds `RADIUS_FADE_START`; past that threshold each group fades
by its alignment with the drag vector, reaching its full per-direction opacity at
`RADIUS_SELECT` (the group being dragged toward stays brightest; the group
opposite the drag reaches zero). Source of truth: `rootGroupOpacity()` in
`lib/src/components/MobileGestureRadialMenu.tsx`.

### Root layout

Root labels are laid out as a square keypad, not on a circle. The four cardinal
arrow chips use one shared `GAP_CARDINAL_RING` from the select circle edge. Each
diagonal group renders as three separate labels placed close together at
`GAP_CLUSTER`, not as one combined pill: the group's first option is the cluster
center, and its inward corner is aligned with the diagonal tick mark at the same
ring gap, scaled so it reads as the same horizontal/vertical visual gap rather
than a longer diagonal distance. The diagonal center corner contract is: SE
aligns Enter's top-left corner, NE aligns Backspace's bottom-left corner, SW
aligns Tab's top-right corner, and NW aligns Esc's bottom-right corner. NE and SE
place their two secondary options to the right of the center option, one above
and one below; NW and SW place theirs to the left. The pack stays close to the
select circle while preserving room for long labels like Backspace. Source of
truth: `GAP_CARDINAL_RING`, `GAP_CLUSTER`, and `rootOptionLayout()` in
`lib/src/components/MobileGestureRadialMenu.tsx`.

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
sending input immediately. It uses the same reset-center, highlight-radius, and
select-radius rules as normal option selection, and the same expand-and-fade
completion feedback.

Root labels use compact key glyphs: `⌃` for Ctrl, `⬆︎` for Shift, and
`▲`/`▼`/`◀`/`▶` for arrow keys. Enter and Backspace stay spelled out.

Source of truth: `MOBILE_TERMINAL_KEY_SEQUENCES` in
`lib/src/components/MobileTerminalUi.tsx` maps actions to byte sequences;
`MOBILE_GESTURE_GROUPS` and `MOBILE_GESTURE_QUIT_GROUP` in
`lib/src/lib/mobile-gesture-menu.ts` define the root and quit actions.

### Selection stages

Cardinal directions are a one-stage gesture:

1. Touch down to open the menu.
2. Drag to `RADIUS_HIGHLIGHT` to preview the closest compass point.
3. Drag to `RADIUS_SELECT` on N, S, E, or W to immediately send the matching
   arrow key. The app must not wait for touch release.
4. The menu then remains for a short completion animation: removed labels fade
   out, and the selected label expands and fades out for positive confirmation
   before the overlay clears.

Diagonal directions are a two-stage gesture: steps 1–2 as above, then

3. Drag to `RADIUS_SELECT` to choose that diagonal group.
4. The other seven groups fade out.
5. The compass center resets to the point where the drag intersected the
   `RADIUS_SELECT` circle.
6. The group's three labels tween from their root positions to exploded
   positions around the reset center — the center option explodes back along the
   exact opposite compass direction, the two secondaries ±45° off it. They must
   not fade out and be replaced by newly spawned labels.
7. Drag from the reset center to `RADIUS_HIGHLIGHT` to preview an option, and to
   `RADIUS_SELECT` to choose and immediately send it, again without waiting for
   release, and again followed by the completion animation.

Releasing after the group selection but before choosing an exploded option
cancels the gesture.

Two details keep the second stage usable when the drag overshoots the group
selection. The option origin ratchets *outward* along the opening direction as
the drag keeps pushing that way, so the user does not have to drag all the way
back through the overshoot before a move in another direction registers; and the
compass stays visually collapsed while that outward push is brisk, then latches
expanded once the drag settles (`OPTION_EXPAND_RELEASE`), so it does not flicker
mid-overshoot. Source of truth: `advanceOptionOrigin()` in
`lib/src/lib/mobile-gesture-menu.ts`.

Source of truth: `MOBILE_GESTURE_OPTION_DIRECTIONS` in
`lib/src/lib/mobile-gesture-menu.ts` defines exploded-option directions per
group.

Examples:

* Right arrow: tap, drag right to `RADIUS_SELECT`; it sends immediately.
* Enter: tap, drag down-right to choose the SE group, then drag up-left from the
  reset center until it sends.
* Shift+Enter: tap, drag down-right to choose the SE group, then drag up from the
  reset center until it sends.

## Input mode selector

The input mode selector controls what appears in the reserve area. It is always
visible, has four items (`Sessions | Recent | Type | Draft`), and is
self-labeling with both an icon and a short mode label.

Source of truth: `KEYBOARD_MODES` and `RESERVE_PLACEHOLDER_COPY` in
`lib/src/components/MobileTerminalUi.tsx` define input-mode button labels, icons,
and placeholder copy.

| Mode | Reserve area content |
| --- | --- |
| Sessions | Mobile session rows with active, alert, and TODO state. Selecting a session makes it the single visible terminal. |
| Recent | The Recent reserve placeholder copy, filling the reserve. |
| Type | The Type reserve placeholder copy, as a button that focuses the hidden terminal input. Every typed key is echoed into the terminal as it happens. |
| Draft | The Draft reserve placeholder copy, filling the reserve. |

Default input mode is **Type**. Recent and Draft are placeholder-only today —
the real features are staged (see [Future](#future)).

Tapping the **Type** selector focuses the hidden input synchronously during the
tap/click handler — the user-gesture-linked call is what makes mobile browsers
open the native keyboard; focus deferred to `requestAnimationFrame` or a timer
may be treated as not user-initiated and refused. A follow-up effect
additionally re-asserts focus via rAF and staggered timers as best effort — it
helps after re-renders, and is the only focus path when Type is the initial mode
with no tap (where strict browsers may keep the keyboard closed until the first
real tap). Switching away from Type blurs the hidden input so the app keyboard
UI is visible again.

## Type mode input

Typing goes through a visually hidden `<textarea>` configured for terminal-style
input: `autocapitalize`, `autocomplete`, and `autocorrect` off, `spellcheck`
false, `inputmode="text"`, `enterkeyhint="enter"`.

Required behavior:

* Normal characters are sent to the active terminal immediately.
* Enter sends terminal Enter; Backspace works; physical `Ctrl+C` sends `\x03`.
* Input supports mobile keyboard behavior and IME composition — composed text is
  buffered until `compositionend`, so the app does not depend only on `keydown`.

## Keyboard focus invariant

Pane-content touches must never open the native keyboard. The pane content area
may focus the terminal internally for key routing or mouse handling, but the
wrapper configures every text input created by the terminal surface as a
non-keyboard target (`inputmode="none"`, readonly, not tab-reachable — kept true
for later-mounted inputs by a `MutationObserver`) and blurs it when the touch
starts there. Since `Wall` may defer xterm focus to `requestAnimationFrame`, the
wrapper repeats that blur across a rAF and staggered timers, and cancels the
pending retries on unmount. The only mobile UI surfaces that may open the native
keyboard are the Type selector and the Type reserve area.

## Files

| File | Role |
|------|------|
| `lib/src/components/MobileTerminalUi.tsx` | The mobile wrapper: touch/input mode state, selectors, keyboard reserve, hidden Type input, key sequences (`MOBILE_TERMINAL_KEY_SEQUENCES`) |
| `lib/src/components/MobileWall.tsx` | One-active-session mobile wall composition and session-row helpers (`useMobileWallSessionItems`) |
| `lib/src/components/MobileGestureRadialMenu.tsx` | Radial menu rendering: keypad layout, group opacity, completion animation, confirm dialog |
| `lib/src/lib/mobile-gesture-menu.ts` | Gesture state machine, geometry (radii, option directions), and root/quit action groups |
| `lib/src/theme.css` | The `mobile-gesture-*-spawn` reveal animations and their reduced-motion opt-out |

Tests: `lib/src/lib/mobile-gesture-menu.test.ts` (state machine + geometry),
`lib/src/components/MobileTerminalUi.test.tsx` (touch-mode event routing),
`lib/src/components/MobileWall.test.tsx`.

## Future

Potential later additions:

* Real recent commands (the Recent reserve is placeholder copy today).
* Draft scratchpad (the Draft reserve is placeholder copy today).
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* Multi-session support (more than one visible session).
