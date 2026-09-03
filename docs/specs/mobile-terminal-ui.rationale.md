# Mobile Terminal UI — Rationale

> Informative companion to [mobile-terminal-ui.md](mobile-terminal-ui.md), keyed by that spec's headings. Nothing here is normative.

## Core layout

**Fixed reserve height rather than a `visualViewport` measurement.**
`window.visualViewport` shrinks and grows for the whole length of the OS
keyboard's open/close animation, so a height derived from it bounces the
terminal region and reflows xterm mid-gesture. The trade — the keyboard covering
the same physical area — is the cheaper cost, since what it hides is the app
keyboard UI the OS keyboard is replacing anyway.

**Why the two rows sit on different grounds.** The Touch row acts on the
terminal, so `terminal-bg` reads it as part of the surface above; the Input row
and the reserve act on the app, so the header-inactive pair separates them while
still following the selected theme rather than a hardcoded color.

## Touch mode selector

**Why the selector is self-labeling.** Icon-only touch controls are
undiscoverable: a phone has no hover tooltip, and none of the three modes is a
convention a user arrives with.

**What consuming pane-content pointer events prevents.** Left alone, xterm
translates a `wheel` or `touchmove` over the pane into mouse reports for the
inside program, alternate-screen arrow keys, or scrollback motion — all three
fight the gesture or the selection the user is making. In Mouse mode the browser
competes too, claiming the touch first for panning or text selection, so without
suppression a tap or drag never reaches the TUI at all.

**Why Gesture mode also takes primary mouse clicks.** Desktop browsers, narrow
desktop viewports, and Storybook have no touchscreen, and a mouse-only reviewer
would otherwise see a radial menu that never opens.

## Gesture mode

**The offset direction, worked through.** The hand holding the phone sits over
the touch origin, so a rose centered there would be under the thumb; offsetting
into the opposite diagonal fills visible area instead — a lower-right press
opens the rose up and left, a lower-left press up and right. Same reason the
guide line is drawn only in the offset copy.

**Why the ticks and the chips share one opacity treatment.** Full-opacity ticks
with a thicker one on the active direction make the select circle and the label
clusters read as a single gesture system rather than a circle with unrelated
text floating near it.

## Root layout

**Why the pack stays tight against the select circle.** Eight groups plus their
secondaries have to fit a phone-width pane with room for the longest label
(`Backspace`). Anchoring them on the circle the exploded options use overlaps
those long labels; the square keypad packs them without collisions and still
stays close to the circle.

## Selection stages

**Why the option origin ratchets outward.** A drag that overshoots the
group-selection radius usually keeps going in the opening direction. Without the
ratchet the user drags back through that whole overshoot before a move in
another direction registers, which reads as the menu ignoring them.

**Why the compass stays collapsed during a brisk push.** Expanding the moment
the group is chosen flickers the labels between collapsed and exploded for the
length of the overshoot. `OPTION_EXPAND_RELEASE` is the per-move outward
distance below which the drag counts as settling rather than still pushing out,
so the expansion happens once, after it settles.

## Input mode selector

**Why the Type focus is synchronous.** Mobile browsers open the native keyboard
only for a focus call made while the user gesture is still on the stack; one
deferred to `requestAnimationFrame` or a timer may be refused as not
user-initiated, so the tap appears to do nothing.

**What the follow-up effect buys.** It re-asserts focus after re-renders that
would drop it, and is the only focus path when Type is the initial mode and no
tap has happened yet. Strict browsers can still keep the keyboard closed until
the first real tap — best effort, not the contract.

## Keyboard focus invariant

**Why one blur is not enough.** `Wall` can restore xterm focus in a
`requestAnimationFrame` after the touch, undoing a single synchronous blur a
frame later. Repeating across a rAF and staggered timers covers that window;
cancelling pending retries on unmount keeps one from firing into a torn-down
DOM, which is also what test teardown looks like.
