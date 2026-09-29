import type { Terminal } from '@xterm/xterm';

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
  for (let i = 0; i < Math.abs(lines); i++) {
    const wheel = new view.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: 1,
      deltaY: Math.sign(lines),
      clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, clientX)),
      clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY)),
    });
    mobileWheels.add(wheel);
    screen.dispatchEvent(wheel);
  }
}
