# Mobile Terminal UI — Rationale

> Informative companion to [mobile-terminal-ui.md](mobile-terminal-ui.md), keyed by that spec's headings. Nothing here is normative.

## Core layout

**Why the reserve is a fixed height rather than a visual-viewport measurement.**
`window.visualViewport` shrinks and grows for the whole length of the OS
keyboard's open/close animation, so a height derived from it makes the terminal
region bounce and reflows xterm mid-gesture. A fixed reserve trades that for the
keyboard covering or occupying the same physical area — the cheaper cost, since
what it hides is the app keyboard UI the OS keyboard is replacing anyway.

**Why the two rows sit on different grounds.** The Touch row acts on the
terminal, so `terminal-bg` makes it read as part of the surface above it. The
Input row and the reserve act on the app, so the header-inactive pair separates
them from the terminal while still following the selected theme rather than a
hardcoded color.

## Touch mode selector

**Why the selector is self-labeling.** Icon-only touch controls are too hard to
discover: a phone has no hover tooltip, and none of the three modes is a
convention a user arrives with.

**What the Gestures / Select capture-phase consumption prevents.** Left alone,
xterm translates a `wheel` or `touchmove` over the pane into mouse reports for
the inside program, alternate-screen arrow keys, or scrollback motion — all
three fight the gesture or the selection the user is actually making.

**Why Mouse mode consumes the native touch events.** Suppressing the native
touch gesture is what makes a tap or drag reach the TUI at all — otherwise the
browser claims it first for panning or text selection, or xterm's own
touch-scroll fallback does.

**Why Gesture mode also takes primary mouse clicks.** The composition has to
stay usable in desktop browsers, narrow desktop viewports, and Storybook, none
of which have a touchscreen; without it a mouse-only reviewer sees a radial menu
that never opens.

## Gesture mode

**The offset direction, worked through.** A lower-right thumb press opens the
rose up and left; a lower-left press opens it up and right. The hand holding the
phone sits over the touch origin, so a rose centered there would be under the
thumb; offsetting into the opposite diagonal fills the visible area away from
the touch point. That is also why the guide line is drawn only in the offset
copy.

**Why the ticks and the chips share one opacity treatment.** Full-opacity ticks
with a thicker one on the active direction make the select circle and the label
clusters read as a single gesture system rather than a circle with unrelated
text floating near it.

## Root layout

**Why the pack stays tight against the select circle.** The root layout has to
fit eight groups plus their secondaries inside a phone-width pane while leaving
room for the longest label (`Backspace`). Anchoring root labels on the same
circle the exploded options use overlaps those long labels; the square keypad
packs them without collisions and still stays close to the circle.

## Selection stages

**Why the option origin ratchets outward.** A drag that overshoots the
group-selection radius usually keeps going in the opening direction. Without the
ratchet the user has to drag all the way back through that overshoot before a
move in another direction registers, which reads as the menu ignoring them.

**Why the compass stays collapsed during a brisk push.** Expanding the moment
the group is chosen makes the labels flicker between collapsed and exploded for
the length of the overshoot. `OPTION_EXPAND_RELEASE` is the per-move outward
distance below which the drag counts as settling rather than still pushing out,
so the expansion happens once, after the drag has stopped.

## Input mode selector

**Why the Type focus must be synchronous.** Mobile browsers open the native
keyboard only for a focus call made while the user gesture is still on the
stack. A focus deferred to `requestAnimationFrame` or a timer may be treated as
not user-initiated and refused outright, so the tap appears to do nothing.

**What the follow-up effect buys.** It re-asserts focus after re-renders that
would otherwise drop it, and it is the only focus path when Type is the initial
mode and no tap has happened yet. Strict browsers may still keep the keyboard
closed in that case until the first real tap, which is why it is best effort
rather than the contract.

## Keyboard focus invariant

**Why one blur is not enough.** `Wall` can restore xterm focus in a
`requestAnimationFrame` after the touch, so a single synchronous blur is undone
a frame later. Repeating across a rAF and staggered timers covers that focus
window; cancelling the pending retries on unmount keeps one from firing into a
torn-down DOM, which is also what test teardown looks like.
