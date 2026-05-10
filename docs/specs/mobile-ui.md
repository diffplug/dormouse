# Mobile Terminal Website Prototype Spec

## 1. Overview

This document specifies a greenfield prototype for a mobile-first terminal UI.

The prototype tests one core idea:

```text
Native phone keyboard for text + simple terminal controls for missing keys.
```

The app should feel like a lightweight mobile terminal playground. It does not need remote sessions, SSH, user accounts, or production infrastructure. The first version should use a local playground PTY, fake shell, in-browser terminal demo, or command simulator that is realistic enough to test the mobile UI.

The main interface has a terminal viewport and a bottom navigation row:

```text
Recent | Type | Draft | Keys
```

Only the most important sections need complete behavior in v0:

* **Type**: implemented.
* **Keys**: implemented.
* **Recent**: opens a TODO pane.
* **Draft**: opens a TODO pane.

## 2. Prototype goals

### 2.1 Primary goals

* Test mobile terminal text entry using the native phone keyboard.
* Test whether simple on-screen terminal controls make missing keys usable on a phone.
* Keep the terminal viewport usable when the mobile keyboard is visible.
* Provide enough terminal behavior to evaluate typing, Enter, Backspace, arrows, Escape, Tab, and Ctrl+C.
* Keep the implementation small and easy to iterate on.

### 2.2 Non-goals

The prototype does not need:

* Remote shell support.
* SSH support.
* WebSocket transport.
* User accounts.
* Session persistence.
* Multiple terminal sessions.
* Command history storage.
* Snippet management.
* A real draft/scratchpad workflow.
* Terminal mouse mode.
* Advanced gestures.
* Production security hardening.
* Full accessibility implementation.

## 3. Core layout

## 3.1 Default portrait layout

```text
┌─────────────────────────┐
│ Terminal playground      │
│                         │
│                         │
├─────────────────────────┤
│ Active pane              │
├─────────────────────────┤
│ Recent | Type | Draft | Keys
└─────────────────────────┘
```

The active pane changes when the user taps a bottom navigation item.

## 3.2 Type mode layout

Type is the default active section.

```text
┌─────────────────────────┐
│ Terminal playground      │
│                         │
├─────────────────────────┤
│ Esc Tab Ctrl+C ← ↓ ↑ →   │
├─────────────────────────┤
│ Recent | Type | Draft | Keys
├─────────────────────────┤
│ native phone keyboard    │
└─────────────────────────┘
```

When the native keyboard is open, the terminal viewport should resize to remain visible.

## 3.3 Keys mode layout

Keys mode shows the same important controls in a larger layout.

```text
┌─────────────────────────┐
│ Terminal playground      │
│                         │
├─────────────────────────┤
│ Esc     Tab     Ctrl+C   │
│ ←       ↓       ↑       →│
├─────────────────────────┤
│ Recent | Type | Draft | Keys
└─────────────────────────┘
```

Keys mode is useful when the user needs more reliable taps for arrow keys and Ctrl+C.

## 3.4 TODO pane layout

Recent and Draft should open simple placeholder panes.

```text
┌─────────────────────────┐
│ Terminal playground      │
│                         │
├─────────────────────────┤
│ TODO: Recent             │
├─────────────────────────┤
│ Recent | Type | Draft | Keys
└─────────────────────────┘
```

```text
┌─────────────────────────┐
│ Terminal playground      │
│                         │
├─────────────────────────┤
│ TODO: Draft              │
├─────────────────────────┤
│ Recent | Type | Draft | Keys
└─────────────────────────┘
```

The TODO panes should make the app structure visible without implementing those workflows.

## 4. Bottom navigation

The bottom navigation row is always present unless the native keyboard or viewport constraints make that impossible.

```text
Recent | Type | Draft | Keys
```

### 4.1 Navigation behavior

| Item   | v0 behavior                                |
| ------ | ------------------------------------------ |
| Recent | Opens TODO pane                            |
| Type   | Opens Type pane and focuses terminal input |
| Draft  | Opens TODO pane                            |
| Keys   | Opens large Keys pane                      |

### 4.2 Active state

The active item should be visually obvious.

Recommended active states:

* Highlight the selected label.
* Use a top border or pill background.
* Keep the active pane directly above the nav row.

### 4.3 Default state

The app should start in **Type** mode.

## 5. Terminal playground

The terminal area is the main testing surface.

### 5.1 Requirements

The terminal playground should:

* Display terminal-like output.
* Accept typed input from the native mobile keyboard.
* Show a cursor.
* Support Enter.
* Support Backspace.
* Respond visibly to arrow keys.
* Respond visibly to Escape, Tab, and Ctrl+C.
* Scroll when output exceeds the visible area.
* Resize when the mobile keyboard appears or disappears.

### 5.2 Implementation options

Use the simplest implementation that gives a realistic enough interaction test.

Acceptable options:

* xterm.js connected to a local playground process.
* xterm.js with an in-browser command simulator.
* A custom terminal-like component if true terminal emulation is not needed yet.

Prefer xterm.js if the prototype should test realistic cursor movement, ANSI behavior, and terminal rendering.

### 5.3 Minimal fake shell behavior

A fake shell is acceptable for v0.

Minimum useful behavior:

* Echo typed characters.
* Maintain a command line buffer.
* Enter submits the current command.
* Backspace edits the current command.
* Arrow keys produce visible behavior.
* Ctrl+C clears or interrupts the current command.
* Escape and Tab produce visible behavior.

Example commands:

```text
help
clear
echo hello
```

The shell only needs enough behavior to test the mobile controls.

## 6. Type pane

Type is the primary implemented pane.

### 6.1 Purpose

Type mode lets the user enter normal text through the native phone keyboard while keeping a compact terminal control row available.

### 6.2 Layout

```text
Esc Tab Ctrl+C ← ↓ ↑ →
```

### 6.3 Behavior

When the user opens Type mode:

* Focus the terminal input.
* Open the native phone keyboard where browser policy allows.
* Show the compact terminal control row.
* Keep the terminal viewport visible above the controls and keyboard.

### 6.4 Hidden input

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

### 6.5 Text input behavior

Required behavior:

* Normal characters are sent to the terminal playground.
* Enter sends terminal Enter.
* Backspace works.
* Autocorrect and autocapitalization are disabled where possible.
* Input should support mobile keyboard behavior and IME composition.
* The app should not depend only on `keydown` for text input.

## 7. Keys pane

Keys is the second implemented pane.

### 7.1 Purpose

Keys mode provides larger tap targets for the terminal controls that are most important on mobile.

### 7.2 Layout

```text
┌───────────────────────┐
│ Esc   Tab   Ctrl+C     │
│ ←     ↓     ↑     →    │
└───────────────────────┘
```

### 7.3 Controls

| Button | Behavior         |
| ------ | ---------------- |
| Esc    | Send Escape      |
| Tab    | Send Tab         |
| Ctrl+C | Send interrupt   |
| ←      | Send left arrow  |
| ↓      | Send down arrow  |
| ↑      | Send up arrow    |
| →      | Send right arrow |

### 7.4 Interaction rules

* Tapping a key sends exactly one action.
* The same key mappings should be used in Type mode and Keys mode.
* Keys mode should not add extra controls in v0.
* Long-press repeat is not required for v0.
* Modifier-lock behavior is not required for v0.

## 8. Recent TODO pane

### 8.1 Purpose

Recent is visible in the navigation so the overall app structure can be tested, but it does not implement command history in v0.

### 8.2 Layout

```text
TODO: Recent commands

This pane will eventually show recently used commands.
```

### 8.3 Behavior

* Tapping Recent opens the TODO pane.
* The terminal remains visible above the pane.
* No command list is required.
* No storage is required.

## 9. Draft TODO pane

### 9.1 Purpose

Draft is visible in the navigation so the overall app structure can be tested, but it does not implement scratchpad or dual-pane editing in v0.

### 9.2 Layout

```text
TODO: Draft

This pane will eventually support composing text before sending it to the terminal.
```

### 9.3 Behavior

* Tapping Draft opens the TODO pane.
* The terminal remains visible above the pane.
* No editable scratchpad is required.
* No copy/paste workflow is required.

## 10. Key sequence mapping

Use these mappings for both Type mode and Keys mode.

| UI action   | Sequence       |
| ----------- | -------------- |
| Ctrl+C      | `\x03`         |
| Esc         | `\x1B`         |
| Tab         | `\x09`         |
| Enter       | `\r`           |
| Backspace   | Usually `\x7F` |
| Arrow Up    | `\x1B[A`       |
| Arrow Down  | `\x1B[B`       |
| Arrow Right | `\x1B[C`       |
| Arrow Left  | `\x1B[D`       |

If the playground terminal uses a higher-level input API instead of raw terminal sequences, map these actions to the equivalent local action.

## 11. Keyboard visibility and layout

Keyboard handling should be simple and pragmatic.

The prototype should resize the terminal area when the phone keyboard appears. Use the simplest reliable approach available:

1. Use `window.visualViewport` resize events if available.
2. Fall back to normal viewport sizing.
3. Avoid complex keyboard detection logic unless the layout is broken.

Minimal approach:

```js
function updateLayoutForKeyboard() {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty(
    "--visible-height",
    `${viewportHeight}px`
  );
}

window.visualViewport?.addEventListener("resize", updateLayoutForKeyboard);
window.visualViewport?.addEventListener("scroll", updateLayoutForKeyboard);
window.addEventListener("resize", updateLayoutForKeyboard);
updateLayoutForKeyboard();
```

The prototype does not need to perfectly detect whether the keyboard is present. It only needs to keep the terminal, active pane, and nav row usable.

## 12. Touch interactions

Keep touch behavior minimal.

Required interactions:

* Tap terminal to focus typing.
* Tap Type to focus typing.
* Tap control buttons.
* Tap bottom navigation items.
* Scroll terminal output.

Not required for v0:

* Swipe navigation.
* Long-press arrow repeat.
* Trackpad mode.
* Two-finger gestures.
* Terminal mouse mode.
* Custom text selection behavior.

## 13. Copy and paste

Keep copy and paste minimal.

Prototype behavior:

* Let users paste through the native browser/OS paste flow where possible.
* Let terminal output selection rely on default browser behavior where possible.
* No custom clipboard manager is required.
* No multi-line paste review is required.

## 14. Recommended v0 scope

Build exactly this:

* One terminal playground screen.
* Bottom navigation row:

```text
Recent | Type | Draft | Keys
```

* Type pane with compact controls:

```text
Esc Tab Ctrl+C ← ↓ ↑ →
```

* Keys pane with larger controls:

```text
Esc   Tab   Ctrl+C
←     ↓     ↑     →
```

* Recent TODO pane.
* Draft TODO pane.
* Native mobile keyboard input.
* Basic viewport resizing when the keyboard opens.
* Simple local playground terminal behavior.

## 15. Prototype success criteria

The prototype should answer these questions:

1. Is the terminal viewport usable when the mobile keyboard is open?
2. Is the compact Type control row easy to reach?
3. Is the larger Keys pane necessary or useful?
4. Are arrow keys usable enough for command history and cursor movement?
5. Is Ctrl+C discoverable and easy to trigger?
6. Does the native keyboard feel acceptable for terminal text entry?
7. Does the four-item navigation row make sense, even with Recent and Draft as placeholders?
8. Is the UI too cramped in portrait orientation?

## 16. Future work

Potential later additions:

* Real recent commands.
* Draft scratchpad.
* Dual-pane copy/paste.
* Pinned snippets.
* Ctrl+D and Ctrl+Z.
* Alt and modifier behavior.
* Home, End, PgUp, PgDn.
* Long-press key repeat.
* Gesture navigation.
* Terminal mouse mode.
* Remote backend PTY.
* SSH sessions.
* User accounts.
* Session persistence.
* Multi-session support.
* Production security model.

## 17. Product principle

The v0 prototype should stay focused:

```text
Type and Keys are real.
Recent and Draft establish the shape of the app.
Everything else waits.
```
