import type { Terminal } from '@xterm/xterm';

/** Width of the Gestures-mode scroll strip on each side of the pane. */
export const EDGE_SCROLL_WIDTH_PX = 48;
/** Vertical drag distance per scrolled line. */
export const EDGE_SCROLL_LINE_PX = 18;

export const isEdgeScrollOrigin = (x: number, width: number): boolean =>
  width > 0 && (x <= EDGE_SCROLL_WIDTH_PX || x >= width - EDGE_SCROLL_WIDTH_PX);

// Only wheels created by this path may pass the mobile capture-phase guard.
const mobileWheels = new WeakSet<Event>();
export const isMobileScrollWheel = (event: Event): boolean => mobileWheels.has(event);

export function scrollMobileTerminal(terminal: Terminal, lines: number, clientX: number, clientY: number): void {
  if (terminal.modes.mouseTrackingMode === 'none') {
    // Native wheels can become arrow keys in an alternate screen. This path
    // scrolls only the buffer, including a no-op when there is no history.
    terminal.scrollLines(lines);
    return;
  }
  const screen = terminal.element?.querySelector('.xterm-screen');
  if (!screen) return;
  const rect = screen.getBoundingClientRect();
  const view = screen.ownerDocument.defaultView ?? window;
  const init: WheelEventInit = {
    bubbles: true,
    cancelable: true,
    deltaMode: 1,
    deltaY: Math.sign(lines),
    clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, clientX)),
    clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY)),
  };
  // xterm reports one wheel per event, whatever its delta.
  for (let i = 0; i < Math.abs(lines); i++) {
    const wheel = new view.WheelEvent('wheel', init);
    mobileWheels.add(wheel);
    screen.dispatchEvent(wheel);
  }
}
