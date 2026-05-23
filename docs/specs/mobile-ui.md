# Mobile Terminal Website Prototype Spec

## 1. Overview

This document specifies the `/playground/pocket` mobile terminal prototype.

The prototype tests one core idea:

```text
Stable terminal viewport + mobile session viewport + explicit touch mode + explicit input mode.
```

The app should feel like a lightweight mobile terminal playground. It does not
need remote sessions, SSH, user accounts, or production infrastructure.

The website `/playground/pocket` prototype exposes a small floating theme
switcher above the terminal. It uses the shared Dormouse `ThemePicker`. On
desktop, `/playground/pocket` shows a share-to-phone page instead of the
interactive terminal. The `/pocket` route temporarily redirects to
`/playground/pocket`; this is a launch-state redirect, not the future real
tethering environment.

`/playground/pocket` uses the same fake playground terminal stack as
`/playground/desktop`: `PlaygroundShellRegistry` attaches a `TutorialShell` to
every spawned pane, and the same fake commands dispatch to browser-side runners.
The first mobile session auto-runs `tut` with the Pocket tutorial profile; a
second `changelog` session auto-runs `changelog` for the tutorial's copy/paste
coverage.

## 2. Prototype Goals

Primary goals:

* Keep the terminal viewport stable when the native phone keyboard opens or closes.
* Let the user explicitly choose what terminal touches mean.
* Let the user explicitly choose what appears in the stable reserve area.
* Show one terminal session at a time on mobile, with session switching available from the reserve controls.
* Test normal mobile text entry using the native phone keyboard.
* Provide enough terminal behavior to evaluate typing, Enter, Backspace, arrows, Escape, Tab, and app interruption.
* Keep the implementation small and easy to iterate on.

Non-goals:

* Remote shell support.
* SSH support.
* WebSocket transport.
* User accounts.
* Session persistence.
* Command history storage.
* A real draft/scratchpad workflow.
* Mobile split-pane layout.
* Multi-touch gestures.
* Production security hardening.
* Full accessibility implementation.

## 3. Core Layout

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
composition that displays one active terminal session at a time. Desktop `Wall`
remains the tiling workspace; mobile does not expose split-pane layout. The
mobile wrapper owns the two selectors and the fixed-height reserve. The selector
block should use one divider between the Touch and Input rows, with no divider
above Touch and no divider below Input. The mobile session header should not use
the desktop terminal title corner radius; it is a flush mobile bar. The alert
bell sits immediately after the title before secondary title detail. The mobile
header keeps a minimize button, and in the `/playground/pocket` prototype that
action opens the Sessions reserve instead of creating a desktop Door. The Touch
row and its selector tray should sit on `terminal-bg` so they read as part of
the terminal surface above. The Input row and reserve area should sit on
`header-inactive-bg` with `header-inactive-fg`, so the lower input controls are
distinct from the terminal while still following the selected theme.

The root height must not be recalculated from `window.visualViewport` on every
keyboard resize. The reserve area is intentionally stable so the terminal region
does not bounce while the OS keyboard animates.

## 4. Touch Mode Selector

The touch selector controls what happens when the user touches the pane content
area. It is always visible between the terminal content and the input mode
selector.

The selector must be self-labeling through segmented buttons that include both
an icon and a short mode label. Icon-only touch controls are too hard to
discover in this prototype.

Touch modes:

| Mode | Button label | Icon | Availability | Behavior |
| --- | --- | --- | --- | --- |
| Gestures | `Gestures` | `HandPointingIcon` | Always available | Pane-content touches, pen presses, and primary mouse/trackpad clicks open the Gesture mode radial menu. |
| Text selection | `Select` | `CursorTextIcon` | Always available | Touches are reserved for terminal text selection and copy/paste. If the TUI is capturing mouse events, Dormouse activates mouse override for the active pane. |
| Mouse | `Mouse` | `CursorClickIcon` | Only when the active TUI is capturing mouse events | Touches are passed through as terminal mouse input. |

Default touch mode is **Gestures**.

If Mouse mode is active and the active pane stops capturing mouse events, the
selector must fall back to Gestures.

Wheel, trackpad-scroll, and touchmove events in the pane content are terminal
input only in Mouse mode. Gestures and Select mode must suppress those
scroll-like events before xterm can translate them into mouse reports,
alternate-screen arrow keys, or scrollback motion.

Gesture mode intentionally consumes primary mouse/trackpad clicks in addition to
touch input. This keeps the `/playground/pocket` prototype usable in desktop
browsers, narrow desktop viewports, and Storybook without a touchscreen. A primary
mouse/trackpad click in pane content must start radial gesture handling, call
`preventDefault()`, stop propagation, and capture that pointer; it is not passed
through to the embedded `Wall`, xterm, or dockview for focus, selection, or pane
interaction. Non-primary mouse buttons are ignored by gesture handling so their
browser or host behavior can continue. Users who want terminal selection or TUI
mouse input must choose Select or Mouse mode explicitly.

## 5. Gesture Mode

Gesture mode is the default pane-content touch behavior. Tapping the pane content
opens a radial menu offset from the touch origin. The menu should appear in the
opposite diagonal from the user's thumb so the compass rose fills the visible
area away from the touch point. For example, a lower-right thumb press opens the
rose up and left; a lower-left thumb press opens it up and right.

As the user drags, the UI draws only the offset guide line inside the visible
compass rose. It must not draw a line directly under the user's thumb. The guide
line is solid and fully opaque, and the offset rose center renders a small
fully opaque circle.

Gesture mode uses these radii:

| Variable | Value | Behavior |
| --- | --- | --- |
| `RADIUS_LAYOUT` | `92px` | Base half-side for square direction anchors around the offset compass rose origin. Exploded option labels land on these anchors; root labels are packed around the same square so long labels do not overlap. |
| `RADIUS_SELECT` | `RADIUS_LAYOUT * 0.75` | Visible circle drawn around the offset compass rose origin. When the mirrored drag reaches this distance, the closest compass direction is selected. |
| `RADIUS_FADE_START` | `RADIUS_SELECT * 0.25` | No directional root-group fading happens before this drag distance. |
| `RADIUS_HIGHLIGHT` | `RADIUS_SELECT * 0.5` | No circle is drawn. When the drag reaches this distance, the closest compass direction is highlighted, but not selected. |

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

While the user is still choosing a root group, the root groups fade according to
the current drag vector only after the drag exceeds `RADIUS_FADE_START`. Before
that threshold, all root groups render at full opacity. After the threshold,
define `dragHat = (currentPoint - origin) / RADIUS_SELECT` and `unitToGroup` as
the unit vector from the origin to the group's compass direction. The root group
target opacity is `clamp(0.75 + dragHat dot unitToGroup, 0, 1)`. The rendered
opacity blends smoothly from `1` at `RADIUS_FADE_START` to that target at
`RADIUS_SELECT` using
`fadeProgress = clamp((dragDistance - RADIUS_FADE_START) / (RADIUS_SELECT -
RADIUS_FADE_START), 0, 1)` and
`opacity = 1 + (targetOpacity - 1) * fadeProgress`.

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
Diagonal groups use an EW-dominant corner-and-stack layout: the center option's
inward corner is aligned with the diagonal tick mark at the same ring gap used
by the cardinal arrow chips, measured on screen as the same horizontal/vertical
visual gap rather than as a longer diagonal distance. The diagonal center corner
contract is: SE aligns Enter's top-left corner, NE aligns Backspace's
bottom-left corner, SW aligns Tab's top-right corner, and NW aligns Esc's
bottom-right corner. NE and SE place their secondary options to the right of the
center option, one above and one below. NW and SW place their secondary options
to the left of the center option, one above and one below. Exploded option
labels use the square direction anchors directly. The root label pack stays
close to the select circle, while preserving enough room for long labels like
Backspace.

Each diagonal root cluster uses `GAP_CLUSTER = 2px`. The first option in each
diagonal group is the cluster center. Secondary options use the same edge-and-gap
rule above or below the center chip.

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

Exploded option directions for diagonal groups:

| Selected group | Option directions |
| --- | --- |
| NE | SW, W, S |
| SE | NW, N, W |
| SW | NE, N, E |
| NW | SE, E, S |

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

                           ◀                ▶

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

Gesture action mappings:

| Action | Sequence |
| --- | --- |
| Esc | `\x1B` |
| ⌃C | `\x03` |
| q | `q` |
| ⌃X | `\x18` |
| `:q↵` | `:q\r` |
| ▲ | `\x1B[A` |
| Backspace | `\x7F` |
| Paste | Existing Dormouse paste flow for the active pane |
| n | `n` |
| ◀ | `\x1B[D` |
| ▶ | `\x1B[C` |
| Tab | `\x09` |
| ⬆︎Tab | `\x1B[Z` |
| Space | ` ` |
| ▼ | `\x1B[B` |
| Enter | `\r` |
| ⬆︎Enter | `\x1B[13;2u` |
| y | `y` |

## 6. Input Mode Selector

The input mode selector controls what appears in the reserve area. It is always
visible and has four items:

```text
Sessions | Recent | Type | Draft
```

The selector must be self-labeling through segmented buttons that include both
an icon and a short mode label.

Input modes:

| Mode | Button label | Icon | Reserve area content |
| --- | --- | --- | --- |
| Sessions | `Sessions` | `TerminalWindowIcon` | The reserve area displays mobile session rows with active, alert, and TODO state. Selecting a session makes it the single visible terminal. |
| Recent | `Recent` | `ClockCounterClockwiseIcon` | The entire reserve area displays `WIP - commands you have recently executed will be available here`. |
| Type | `Type` | `TextTIcon` | The reserve area displays `Onscreen keyboard goes here` and focuses the hidden terminal input. Every typed key is echoed into the terminal as it happens. |
| Draft | `Draft` | `ArticleNyTimesIcon` | The entire reserve area displays `WIP - this will be a place to draft prompts before pasting into the terminal`. |

Default input mode is **Type**.

Switching to Type should focus the hidden input and open the native keyboard
where browser policy allows. Switching away from Type should blur the hidden
input so the app keyboard UI is visible again.

Tapping the **Type** selector must focus the hidden input synchronously during
the tap/click handler. Do not defer this focus to `requestAnimationFrame` or a
timer, because mobile browsers may then treat it as no longer user-initiated and
refuse to open the native keyboard.

## 7. Type Mode Input

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

## 8. Terminal Playground Behavior

A fake shell is acceptable for v0.

Minimum useful behavior:

* Echo typed characters.
* Maintain a command line buffer.
* Enter submits the current command.
* Backspace edits the current command.
* Gesture-generated arrow keys produce visible behavior.
* Escape and Tab produce visible behavior.
* When a fake full-screen app such as `ascii-splash`, `splash`, `changelog`, or
  `tut` is running, `Ctrl+C` sends `\x03` to that app; if the app exits, the
  terminal returns to the fake shell prompt instead of restarting the app.
* New panes created from the wall get the same fake shell behavior and prompt as
  regular `/playground/desktop` panes.

Example commands:

```text
help
clear
echo hello
ascii-splash
changelog
tut
```

The shell only needs enough behavior to test the mobile controls.

## 9. Keyboard Reserve

The keyboard reserve area has a stable height. It should not be recomputed from
`visualViewport` while the native keyboard animates.

When the OS keyboard is hidden, the reserve area shows the selected app keyboard
UI: session list, `WIP - commands you have recently executed will be available here`,
`Onscreen keyboard goes here`, or `WIP - this will be a place to draft prompts before pasting into the terminal`.

When the OS keyboard is visible, the OS keyboard may cover or occupy that same
physical area. This is preferred over resizing the whole app around the keyboard.

## 10. Touch Interactions

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

Not required for v0:

* Long-press key repeat.
* Multi-touch gestures.
* Trackpad mode.
* A full command history UI.
* A real draft editor.

## 11. Copy And Paste

Keep copy and paste minimal.

Prototype behavior:

* Text selection mode should allow the existing terminal selection and copy/paste flows to work.
* Let users paste through the native browser/OS paste flow where possible.
* No custom mobile clipboard manager is required.
* No multi-line paste review is required.

## 12. Recommended v0 Scope

Build exactly this:

* One mobile terminal playground screen with one visible session at a time.
* Floating theme switcher using the shared Dormouse theme picker.
* Touch mode selector:

```text
Gestures | Select | Mouse
```

* Input mode selector:

```text
Sessions | Recent | Type | Draft
```

* Stable keyboard reserve area.
* Sessions reserve content: active session rows with alert and TODO state.
* Recent reserve content: `WIP - commands you have recently executed will be available here`.
* Draft reserve content: `WIP - this will be a place to draft prompts before pasting into the terminal`.
* Type mode native mobile keyboard input.
* Gesture mode radial menu for arrows, navigation keys, Esc, Tab, Enter, simple vim-like keys, confirmed Ctrl+C, confirmed Paste, and Quit breakout.
* Pocket `tut` starts directly in the Gesture navigation section, uses the title `Dormouse Pocket Tutorial`, and credits gesture items from radial-menu input callbacks rather than from native keyboard input.
* Simple local playground terminal behavior.

## 13. Prototype Success Criteria

The prototype should answer these questions:

1. Does the terminal viewport feel stable when the mobile keyboard opens and closes?
2. Is the touch mode selector understandable and reachable?
3. Is Gesture mode fast and understandable enough for arrows, navigation keys, and common TUI exits?
4. Is text selection discoverable and reliable on mobile?
5. Is Mouse mode useful when a TUI captures mouse events?
6. Does native keyboard Type mode feel acceptable for terminal text entry?
7. Does the stable keyboard reserve feel better than resizing the whole UI?
8. Is the UI too cramped in portrait orientation?

## 14. Future Work

Potential later additions:

* Real recent commands.
* Draft scratchpad.
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z app-key buttons.
* Alt and modifier behavior.
* Long-press key repeat.
* Remote backend PTY.
* SSH sessions.
* User accounts.
* Session persistence.
* Multi-session support.
* Production security model.

## 15. Product Principle

The v0 prototype should stay focused:

```text
Touch modes make pane touches explicit.
Input modes make the reserve area explicit.
Everything else waits.
```
