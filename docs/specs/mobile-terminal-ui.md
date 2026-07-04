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
(`FakePtyAdapter`; page wiring in `docs/specs/tutorial.md`), the real Pocket
app (`RemotePtyAdapter`; `docs/specs/pocket-app.md`), and Storybook stories.

> History: this component was designed and validated through the website
> `/playground/pocket` prototype (originally specced as `mobile-ui.md`; see git
> history). The prototype's goals and success criteria are retired; the
> page-level wiring lives in `docs/specs/tutorial.md`.

## Core layout

The mobile UI is split into fixed and flexible regions:

```text
┌─────────────────────────┐
│ Mobile session header     │ fixed/small
├─────────────────────────┤
│ Pane content             │ flexible terminal area
├─────────────────────────┤
│ Touch mode selector      │ always visible
├─────────────────────────┤
│ Reserve mode selector    │ always visible
├─────────────────────────┤
│ Reserve area             │ stable height
│                         │
│ Shows app keyboard UI    │ when OS keyboard hidden
│ Occupied by OS keyboard  │ when OS keyboard visible
└─────────────────────────┘
```

The mobile session header and pane content come from `MobileWall`, a mobile
composition that displays one active terminal session at a time. The mobile
wrapper owns the two selectors and the fixed-height reserve. The selector
block should use one divider between the Touch and Input rows, with no divider
above Touch and no divider below Input. The mobile session header should not
use the desktop terminal title corner radius; it is a flush mobile bar. The
alert bell sits immediately after the title before secondary title detail. The
mobile header keeps a minimize button; in the website Pocket playground that
action opens the Sessions reserve instead of creating a desktop Door. The
Touch row and its selector tray should sit on `terminal-bg` so they read as
part of the terminal surface above. The Input row and reserve area should sit
on `header-inactive-bg` with `header-inactive-fg`, so the lower input controls
are distinct from the terminal while still following the selected theme.

The root height must not be recalculated from `window.visualViewport` on every
keyboard resize. The reserve area is intentionally stable so the terminal
region does not bounce while the OS keyboard animates.

## Touch mode selector

The touch selector controls what happens when the user touches the pane content
area. It is always visible between the terminal content and the input mode
selector.

The selector must be self-labeling through segmented buttons that include both
an icon and a short mode label. Icon-only touch controls are too hard to
discover.

Source of truth: `TOUCH_MODES` in `lib/src/components/MobileTerminalUi.tsx`
defines touch-mode button labels and icons.

| Mode | Availability | Behavior |
| --- | --- | --- |
| Gestures | Always available | Pane-content touches, pen presses, and primary mouse/trackpad clicks open the Gesture mode radial menu. |
| Text selection | Always available | Pane-content touch, pen, and primary mouse/trackpad drags use the same terminal text selection and copy/paste behavior as desktop. If a mounted pane's TUI is capturing mouse events, Dormouse activates mouse override for that pane. |
| Mouse | Only when the active TUI is capturing mouse events | Touches are passed through as terminal mouse input. |

Default touch mode is **Gestures**.

Touch mode is a global mobile UI state. Select mode derives each mounted pane's
mouse override from that global touch mode and the pane's own mouse-reporting
state, so switching sessions cannot leave an inactive pane stuck in a stale
override.

If Mouse mode is active and the active pane stops capturing mouse events, the
selector must fall back to Gestures.

Wheel, trackpad-scroll, and touchmove events in the pane content are terminal
input only in Mouse mode. Gestures and Select mode must suppress those
scroll-like events before xterm can translate them into mouse reports,
alternate-screen arrow keys, or scrollback motion.

In Mouse mode, primary touch and pen pointers synthesize left-button terminal
mouse input: pointerdown emits a mouse press, pointermove emits mouse motion,
and pointerup or pointercancel emits a mouse release. The wrapper suppresses
the native touch gesture while emitting those mouse events so a tap or drag is
seen by the TUI, not by browser panning, browser selection, or xterm's native
touch-scroll fallback.

Select mode must route touch and pen drags through the shared terminal
mouse-selection router, not through a mobile-only selection implementation, so
selection geometry, smart token extension, copy popups, rewrapped copy, and TUI
mouse-capture override rules match desktop behavior
(`docs/specs/mouse-and-clipboard.md`).

Gesture mode intentionally consumes primary mouse/trackpad clicks in addition
to touch input. This keeps the composition usable in desktop browsers, narrow
desktop viewports, and Storybook without a touchscreen. A primary
mouse/trackpad click in pane content must start radial gesture handling, call
`preventDefault()`, stop propagation, and capture that pointer; it is not
passed through to the embedded `Wall`, xterm, or dockview for focus,
selection, or pane interaction. Non-primary mouse buttons are ignored by
gesture handling so their browser or host behavior can continue. Users who
want terminal selection or TUI mouse input must choose Select or Mouse mode
explicitly.

## Gesture mode

Gesture mode is the default pane-content touch behavior. Tapping the pane content
opens a radial menu offset from the touch origin. The menu should appear in the
opposite diagonal from the user's thumb so the compass rose fills the visible
area away from the touch point. For example, a lower-right thumb press opens the
rose up and left; a lower-left thumb press opens it up and right.

As the user drags, the UI draws only the offset guide line inside the visible
compass rose. It must not draw a line directly under the user's thumb. The guide
line is solid and fully opaque, and the offset rose center renders a small
fully opaque circle.

Source of truth: `RADIUS_LAYOUT`, `RADIUS_SELECT`, `RADIUS_FADE_START`, and
`RADIUS_HIGHLIGHT` in `lib/src/lib/mobile-gesture-menu.ts` define the radii
used below.

| Variable | Behavior |
| --- | --- |
| `RADIUS_LAYOUT` | Base circular radius for exploded option anchors around the offset compass rose origin. Diagonal exploded labels use normalized compass vectors, so their x/y offsets are `RADIUS_LAYOUT * Math.SQRT1_2`. Root labels use separate packed square-keypad geometry so long labels do not overlap. |
| `RADIUS_SELECT` | Visible circle drawn around the offset compass rose origin. When the mirrored drag reaches this distance, the closest compass direction is selected. |
| `RADIUS_FADE_START` | No directional root-group fading happens before this drag distance. |
| `RADIUS_HIGHLIGHT` | No circle is drawn. When the drag reaches this distance, the closest compass direction is highlighted, but not selected. |

Gesture menu item state uses the same palette as pane headers. Idle groups and
options use inactive header background/foreground. Highlighted or selected
groups and options use active header background/foreground plus an inset
`color-focus-ring` ring. Layout-affecting borders must not be used to indicate
gesture selection state. Inactive chips should have only a quiet shadow; the
heavier elevation is reserved for active chips.

The select circle and its eight compass-direction ticks render at full opacity.
The current highlighted or selected direction uses a stronger tick so the circle
and label clusters read as one gesture system.

Because the mobile composition does not mount the desktop `Wall`,
`MobileTerminalUi` must publish the shared dynamic palette variables, including
`--color-focus-ring`, before rendering gesture UI that depends on those tokens.

When the rose opens on touch-down, root labels fade in with a subtle scale-in
and the select circle grows from zero radius to `RADIUS_SELECT`. This is a short
state-reveal motion, not an ongoing decoration; reduced-motion users get the
final state immediately.

While the user is still choosing a root group, all root groups stay fully
opaque until the drag exceeds `RADIUS_FADE_START`; past that threshold each
group fades by its alignment with the drag vector (the group the user is
moving toward stays brightest, the rest dim toward a floor), reaching the
full per-direction opacity at `RADIUS_SELECT`. Source of truth:
`rootGroupOpacity()` in `lib/src/components/MobileGestureRadialMenu.tsx`.

N, S, E, and W root labels render as single arrow chips. Dragging to
`RADIUS_SELECT` in one of those four cardinal directions immediately sends the
matching arrow key; there is no second-swipe confirmation.

Diagonal root compass groups render as three separate labels placed close
together, not as one combined pill. When a diagonal group is selected, those
same three labels tween from their root group positions to their exploded
positions in the opposite directions. They must not fade out and be replaced by
newly spawned option labels.

Root labels are laid out as a square keypad, not on a circle. The four cardinal
arrow chips use one shared `GAP_CARDINAL_RING` from the select circle edge.
Source of truth: `GAP_CARDINAL_RING` and `GAP_CLUSTER` in
`lib/src/components/MobileGestureRadialMenu.tsx`.
Diagonal groups use an EW-dominant corner-and-stack layout: the center option's
inward corner is aligned with the diagonal tick mark at the same ring gap used
by the cardinal arrow chips, measured on screen as the same horizontal/vertical
visual gap rather than as a longer diagonal distance. The diagonal center corner
contract is: SE aligns Enter's top-left corner, NE aligns Backspace's
bottom-left corner, SW aligns Tab's top-right corner, and NW aligns Esc's
bottom-right corner. NE and SE place their secondary options to the right of the
center option, one above and one below. NW and SW place their secondary options
to the left of the center option, one above and one below. Exploded option
labels use circular direction anchors at `RADIUS_LAYOUT` from the reset center.
The root label pack stays close to the select circle, while preserving enough
room for long labels like Backspace.

Each diagonal root cluster uses the shared `GAP_CLUSTER` spacing. The first
option in each diagonal group is the cluster center. Secondary options use the
same edge-and-gap rule above or below the center chip.

For cardinal directions, the radial menu is a one-stage gesture:

1. Touch down to open the menu.
2. Drag to `RADIUS_HIGHLIGHT` to preview the closest compass point.
3. Drag to `RADIUS_SELECT` on N, S, E, or W to immediately send the matching
   arrow key. The app must not wait for touch release.
4. After the arrow sends, the radial menu remains for a short completion
   animation: removed labels fade out, and the selected arrow label expands and
   fades out for positive confirmation before the overlay clears.

For diagonal directions, the radial menu is a two-stage gesture:

1. Touch down to open the menu.
2. Drag to `RADIUS_HIGHLIGHT` to preview the closest compass point.
3. Drag to `RADIUS_SELECT` to choose that diagonal compass point's group.
4. The other seven compass groups fade out.
5. The compass center resets to the point where the user's drag intersected the
   `RADIUS_SELECT` circle.
6. The selected group's three options explode out from the reset center in the
   opposite directions.
7. Drag from the reset center to `RADIUS_HIGHLIGHT` to preview an option.
8. Drag from the reset center to `RADIUS_SELECT` to choose and immediately send
   that option. The app must not wait for touch release.
9. After the option sends, the radial menu remains for a short completion
   animation: removed labels fade out, and the selected label expands and fades
   out for positive confirmation before the overlay clears.

If the user releases after the first group selection but before choosing one of
the exploded options, the gesture is cancelled.

Source of truth: `MOBILE_GESTURE_OPTION_DIRECTIONS` in
`lib/src/lib/mobile-gesture-menu.ts` defines exploded-option directions per
diagonal group.

Examples:

* Right arrow: tap, drag right to `RADIUS_SELECT`; it sends immediately.
* Enter: tap, drag down-right to choose the SE group, then drag up-left from
  the reset center until it sends.
* Shift+Enter: tap, drag down-right to choose the SE group, then drag up from
  the reset center until it sends.

Root gesture menu labels use compact key glyphs: `⌃` for Ctrl, `⬆︎` for
Shift, and `▲`/`▼`/`◀`/`▶` for arrow keys. Enter and Backspace remain spelled
out.

Root gesture menu:

```text
Esc      ⌃C*               ▲                n Backspace
Quit**                                                     Paste*
```

```text
                           ◀                ▶
```

```text
⬆︎Tab                     ▼                  y ⬆︎Enter
Tab Space                                   Enter
```

`⌃C` and `Paste` require an in-pane confirmation modal before they run.

`Quit` enters a second exploded-option menu instead of sending input immediately:

```text
q | ⌃X | :q↵
```

The quit submenu uses the same reset-center, highlight-radius, and select-radius
rules as the main option selection. Its final selected item uses the same
expand-and-fade completion feedback as the root menu options.

Source of truth: `MOBILE_TERMINAL_KEY_SEQUENCES` in
`lib/src/components/MobileTerminalUi.tsx` defines action-to-byte-sequence
mapping; `MOBILE_GESTURE_GROUPS` and `MOBILE_GESTURE_QUIT_GROUP` in
`lib/src/lib/mobile-gesture-menu.ts` define root and quit submenu actions.

## Input mode selector

The input mode selector controls what appears in the reserve area. It is always
visible and has four items:

```text
Sessions | Recent | Type | Draft
```

The selector must be self-labeling through segmented buttons that include both
an icon and a short mode label.

Source of truth: `KEYBOARD_MODES` and `RESERVE_PLACEHOLDER_COPY` in
`lib/src/components/MobileTerminalUi.tsx` define input-mode button labels,
icons, and placeholder copy.

| Mode | Reserve area content |
| --- | --- |
| Sessions | The reserve area displays mobile session rows with active, alert, and TODO state. Selecting a session makes it the single visible terminal. |
| Recent | The entire reserve area displays the Recent reserve placeholder copy. |
| Type | The reserve area displays the Type reserve placeholder copy and focuses the hidden terminal input. Every typed key is echoed into the terminal as it happens. |
| Draft | The entire reserve area displays the Draft reserve placeholder copy. |

Default input mode is **Type**. Recent and Draft are placeholder-only today —
the real features are staged (see [Future](#future)).

Switching to Type should focus the hidden input and open the native keyboard
where browser policy allows. Switching away from Type should blur the hidden
input so the app keyboard UI is visible again.

Tapping the **Type** selector must focus the hidden input synchronously during
the tap/click handler. Do not defer this focus to `requestAnimationFrame` or a
timer, because mobile browsers may then treat it as no longer user-initiated and
refuse to open the native keyboard.

## Type mode input

Use a hidden or visually minimal input configured for terminal-style typing:

```html
<textarea
  autocapitalize="off"
  autocomplete="off"
  autocorrect="off"
  spellcheck="false"
  inputmode="text"
  enterkeyhint="enter"
></textarea>
```

Required behavior:

* Normal characters are sent to the active terminal immediately.
* Enter sends terminal Enter.
* Backspace works.
* Physical `Ctrl+C` sends `\x03`.
* Autocorrect and autocapitalization are disabled where possible.
* Input supports mobile keyboard behavior and IME composition.
* The app does not depend only on `keydown` for text input.

## Keyboard reserve

The keyboard reserve area has a stable height. It should not be recomputed from
`visualViewport` while the native keyboard animates.

When the OS keyboard is hidden, the reserve area shows the selected app keyboard
UI: session list, or the Recent/Type/Draft reserve placeholder copy.

When the OS keyboard is visible, the OS keyboard may cover or occupy that same
physical area. This is preferred over resizing the whole app around the keyboard.

## Touch interactions

Required interactions:

* Tap input mode selector items.
* Tap touch mode selector items.
* Switch active sessions through Sessions mode.
* Tap Type reserve area to focus typing.
* Type through the native keyboard.
* Use Gesture mode to open the radial menu and send terminal inputs.
* Confirm sensitive Gesture mode actions before sending `Ctrl+C` or reading the clipboard for Paste.
* Use Text selection mode for terminal selection and copy/paste.
* Use Mouse mode for terminal mouse input when a TUI requests mouse reporting.

Pane-content touches must never open the native keyboard. The pane content area
may focus the terminal internally for key routing or mouse handling, but the
mobile wrapper must configure text inputs created by the terminal surface as
non-keyboard targets (`inputmode="none"`, readonly, not tab-reachable) and
immediately blur them when the touch starts there. Since `Wall` may defer xterm
focus to `requestAnimationFrame`, the wrapper must also repeat that blur shortly
after the touch. The only mobile UI surfaces that should open the native
keyboard are the Type selector and the Type reserve area.

## Copy and paste

Keep copy and paste minimal:

* Text selection mode should allow the existing terminal selection and copy/paste flows to work (`docs/specs/mouse-and-clipboard.md`).
* Let users paste through the native browser/OS paste flow where possible.
* No custom mobile clipboard manager is required.
* No multi-line paste review is required.

## Files

| File | Role |
|------|------|
| `lib/src/components/MobileTerminalUi.tsx` | The mobile wrapper: touch/input mode state, selectors, keyboard reserve, hidden Type input, key sequences (`MOBILE_TERMINAL_KEY_SEQUENCES`) |
| `lib/src/components/MobileWall.tsx` | One-active-session mobile wall composition and session-row helpers (`useMobileWallSessionItems`) |
| `lib/src/components/MobileGestureRadialMenu.tsx` | Radial menu rendering: keypad layout, group opacity, completion animation |
| `lib/src/lib/mobile-gesture-menu.ts` | Gesture geometry (radii, option directions) and root/quit action groups |

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
