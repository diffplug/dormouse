# Mobile Terminal Website Prototype Spec

## 1. Overview

This document specifies the `/tether` mobile terminal prototype.

The prototype tests one core idea:

```text
Stable terminal viewport + explicit touch mode + explicit keyboard mode.
```

The app should feel like a lightweight mobile terminal playground. It does not
need remote sessions, SSH, user accounts, or production infrastructure.

The website `/tether` prototype exposes a small floating theme switcher above
the terminal. It uses the shared MouseTerm `ThemePicker`.

`/tether` uses the same fake playground terminal stack as `/playground`:
`PlaygroundShellRegistry` attaches a `TutorialShell` to every spawned pane, the
same fake commands dispatch to browser-side runners, and the first pane simply
auto-runs `ascii-splash` as its initial command.

## 2. Prototype Goals

Primary goals:

* Keep the terminal viewport stable when the native phone keyboard opens or closes.
* Let the user explicitly choose what terminal touches mean.
* Let the user explicitly choose what appears in the stable keyboard reserve area.
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
* Multi-touch gestures.
* Production security hardening.
* Full accessibility implementation.

## 3. Core Layout

The mobile UI is split into fixed and flexible regions:

```text
┌─────────────────────────┐
│ Pane title               │ fixed/small
├─────────────────────────┤
│ Pane content             │ flexible terminal area
├─────────────────────────┤
│ Touch mode selector      │ labeled, always visible
├─────────────────────────┤
│ Keyboard mode selector   │ labeled, always visible
├─────────────────────────┤
│ Keyboard reserve area    │ stable height
│                         │
│ Shows app keyboard UI    │ when OS keyboard hidden
│ Occupied by OS keyboard  │ when OS keyboard visible
└─────────────────────────┘
```

The pane title and pane content come from the embedded `Wall` terminal pane. The
mobile wrapper owns the two selectors and the fixed-height keyboard reserve.

The root height must not be recalculated from `window.visualViewport` on every
keyboard resize. The reserve area is intentionally stable so the terminal region
does not bounce while the OS keyboard animates.

## 4. Touch Mode Selector

The touch selector controls what happens when the user touches the pane content
area. It is always visible between the terminal content and the keyboard mode
selector.

The selector must be self-labeling. It should use a compact left-side `Touch`
label plus segmented buttons that include both an icon and a short mode label.
Icon-only touch controls are too hard to discover in this prototype.

Touch modes:

| Mode | Button label | Icon | Availability | Behavior |
| --- | --- | --- | --- | --- |
| Gestures | `Gestures` | `HandPointingIcon` | Always available | Pane-content touches open the Gesture mode radial menu. |
| Text selection | `Select` | `CursorTextIcon` | Always available | Touches are reserved for terminal text selection and copy/paste. If the TUI is capturing mouse events, MouseTerm activates mouse override for the active pane. |
| Cursor | `Cursor` | `CursorClickIcon` | Only when the active TUI is capturing mouse events | Touches are passed through as terminal mouse/cursor input. |

Default touch mode is **Gestures**.

If Cursor mode is active and the active pane stops capturing mouse events, the
selector must fall back to Gestures.

## 5. Gesture Mode

Gesture mode is the default pane-content touch behavior. Tapping the pane content
opens a radial menu offset from the touch origin. The menu should appear in the
opposite diagonal from the user's thumb so the compass rose fills the visible
area away from the touch point. For example, a lower-right thumb press opens the
rose up and left; a lower-left thumb press opens it up and right. The center `o`
is only the menu origin marker; it is not an action.

As the user drags, the UI draws a visible line from the initial thumb press to
the current thumb position. The offset compass rose may also mirror that motion
with a lighter guide line so the selected direction remains readable away from
the thumb.

Gesture mode uses these radii:

| Variable | Value | Behavior |
| --- | --- | --- |
| `RADIUS_LAYOUT` | `92px` | Distance from the offset compass rose origin to the menu item groups. |
| `RADIUS_SELECT` | `RADIUS_LAYOUT * 0.75` | Visible circle drawn around the offset compass rose origin. When the mirrored drag reaches this distance, the closest compass direction is selected. |
| `RADIUS_HIGHLIGHT` | `RADIUS_SELECT * 0.5` | No circle is drawn. When the drag reaches this distance, the closest compass direction is highlighted, but not selected. |

The radial menu is a two-stage gesture:

1. Touch down to open the menu.
2. Drag to `RADIUS_HIGHLIGHT` to preview the closest compass point.
3. Drag to `RADIUS_SELECT` to choose that compass point's group.
4. Drag in a different direction to choose one of that group's three options.
5. Release to send the selected terminal input.

After the first breakout, the final option is selected this way:

| Final movement | Selected option |
| --- | --- |
| Back to center | First option |
| Visually counter-clockwise from the breakout direction | Second option |
| Visually clockwise from the breakout direction | Third option |
| Still in the original breakout direction | Cancel |

Examples:

* Right arrow: tap, drag right, drag back to center, release.
* End: tap, drag right, drag up, release.
* `l`: tap, drag right, drag down, release.

Root gesture menu labels use compact key glyphs: `⌃` for Ctrl, `⬆︎` for
Shift, and `▲`/`▼`/`◀`/`▶` for arrow keys. Enter, Backspace, PgUp, and PgDn
remain spelled out.

Root gesture menu:

```text
Esc|⌃C*|Quit**         ▲|PgUp|k        Backspace|Paste*|n

◀|Home|h                    o            ▶|End|l

Tab|⬆︎Tab|Space      ▼|PgDn|j      Enter|⬆︎Enter|y
```

`⌃C` and `Paste` require an in-pane confirmation modal before they run.

`Quit` enters a second breakout menu instead of sending input immediately:

```text
q | ⌃X | :q↵
```

The quit submenu uses the same final movement rule. Returning to center selects
`q`, visually counter-clockwise selects `⌃X`, and visually clockwise selects
`:q↵`.

Gesture action mappings:

| Action | Sequence |
| --- | --- |
| Esc | `\x1B` |
| ⌃C | `\x03` |
| q | `q` |
| ⌃X | `\x18` |
| `:q↵` | `:q\r` |
| ▲ | `\x1B[A` |
| PgUp | `\x1B[5~` |
| k | `k` |
| Backspace | `\x7F` |
| Paste | Existing MouseTerm paste flow for the active pane |
| n | `n` |
| ◀ | `\x1B[D` |
| Home | `\x1B[H` |
| h | `h` |
| ▶ | `\x1B[C` |
| End | `\x1B[F` |
| l | `l` |
| Tab | `\x09` |
| ⬆︎Tab | `\x1B[Z` |
| Space | ` ` |
| ▼ | `\x1B[B` |
| PgDn | `\x1B[6~` |
| j | `j` |
| Enter | `\r` |
| ⬆︎Enter | `\x1B[13;2u` |
| y | `y` |

## 6. Keyboard Mode Selector

The keyboard mode selector controls what appears in the keyboard reserve area.
It is always visible and has four items:

```text
Recent | Type | Draft | Keys
```

The selector must be self-labeling. It should use a compact left-side `Input`
label plus segmented text buttons. The label describes the reserve area's
purpose without adding a longer instruction line.

Keyboard modes:

| Mode | Reserve area content |
| --- | --- |
| Recent | The entire reserve area displays `Recent - WIP`. |
| Type | The reserve area focuses the hidden terminal input. Every typed key is echoed into the terminal as it happens. |
| Draft | The entire reserve area displays `Draft - WIP`. |
| Keys | The entire reserve area displays terminal key buttons. |

Default keyboard mode is **Type**.

Switching to Type should focus the hidden input and open the native keyboard
where browser policy allows. Switching away from Type should blur the hidden
input so the app keyboard UI is visible again.

Tapping the **Type** selector must focus the hidden input synchronously during
the tap/click handler. Do not defer this focus to `requestAnimationFrame` or a
timer, because mobile browsers may then treat it as no longer user-initiated and
refuse to open the native keyboard.

## 7. Keys Mode

Keys mode displays exactly these buttons:

```text
Esc   Tab   Space   Enter
◀     ▼     ▲       ▶
```

Mappings:

| Button | Sequence |
| --- | --- |
| Esc | `\x1B` |
| Tab | `\x09` |
| Space | ` ` |
| Enter | `\r` |
| ◀ | `\x1B[D` |
| ▼ | `\x1B[B` |
| ▲ | `\x1B[A` |
| ▶ | `\x1B[C` |

Tapping a key sends exactly one action. Long-press repeat is not required for v0.

## 8. Type Mode Input

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

## 9. Terminal Playground Behavior

A fake shell is acceptable for v0.

Minimum useful behavior:

* Echo typed characters.
* Maintain a command line buffer.
* Enter submits the current command.
* Backspace edits the current command.
* Arrow keys produce visible behavior.
* Escape and Tab produce visible behavior.
* When a fake full-screen app such as `ascii-splash`, `splash`, `changelog`, or
  `tut` is running, `Ctrl+C` sends `\x03` to that app; if the app exits, the
  terminal returns to the fake shell prompt instead of restarting the app.
* New panes created from the wall get the same fake shell behavior and prompt as
  regular `/playground` panes.

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

## 10. Keyboard Reserve

The keyboard reserve area has a stable height. It should not be recomputed from
`visualViewport` while the native keyboard animates.

When the OS keyboard is hidden, the reserve area shows the selected app keyboard
UI (`Recent - WIP`, Type focus target, `Draft - WIP`, or Keys buttons).

When the OS keyboard is visible, the OS keyboard may cover or occupy that same
physical area. This is preferred over resizing the whole app around the keyboard.

## 11. Touch Interactions

Required interactions:

* Tap keyboard mode selector items.
* Tap touch mode selector items.
* Tap Type reserve area to focus typing.
* Type through the native keyboard.
* Tap key buttons in Keys mode.
* Use Gesture mode to open the radial menu and send terminal inputs.
* Confirm sensitive Gesture mode actions before sending `Ctrl+C` or reading the clipboard for Paste.
* Use Text selection mode for terminal selection and copy/paste.
* Use Cursor mode for terminal mouse/cursor input when a TUI requests mouse reporting.

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

## 12. Copy And Paste

Keep copy and paste minimal.

Prototype behavior:

* Text selection mode should allow the existing terminal selection and copy/paste flows to work.
* Let users paste through the native browser/OS paste flow where possible.
* No custom mobile clipboard manager is required.
* No multi-line paste review is required.

## 13. Recommended v0 Scope

Build exactly this:

* One terminal playground screen.
* Floating theme switcher using the shared MouseTerm theme picker.
* Touch mode selector:

```text
Touch  Gestures | Select | Cursor
```

* Keyboard mode selector:

```text
Input  Recent | Type | Draft | Keys
```

* Stable keyboard reserve area.
* Recent reserve content: `Recent - WIP`.
* Draft reserve content: `Draft - WIP`.
* Type mode native mobile keyboard input.
* Gesture mode radial menu for arrows, navigation keys, Esc, Tab, Enter, simple vim-like keys, confirmed Ctrl+C, confirmed Paste, and Quit breakout.
* Keys buttons:

```text
Esc   Tab   Space   Enter
◀     ▼     ▲       ▶
```

* Simple local playground terminal behavior.

## 14. Prototype Success Criteria

The prototype should answer these questions:

1. Does the terminal viewport feel stable when the mobile keyboard opens and closes?
2. Is the touch mode selector understandable and reachable?
3. Is Gesture mode fast and understandable enough for arrows, navigation keys, and common TUI exits?
4. Is text selection discoverable and reliable on mobile?
5. Is Cursor mode useful when a TUI captures mouse events?
6. Does native keyboard Type mode feel acceptable for terminal text entry?
7. Does the stable keyboard reserve feel better than resizing the whole UI?
8. Is the UI too cramped in portrait orientation?

## 15. Future Work

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

## 16. Product Principle

The v0 prototype should stay focused:

```text
Touch modes make pane touches explicit.
Keyboard modes make the reserve area explicit.
Everything else waits.
```
