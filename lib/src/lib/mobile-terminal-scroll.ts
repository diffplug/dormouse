import type { Terminal } from '@xterm/xterm';

/** Width of the Gestures-mode scroll strip on each side of the pane. */
export const EDGE_SCROLL_WIDTH_PX = 48;
/** Vertical drag distance per scrolled line. */
export const EDGE_SCROLL_LINE_PX = 18;

// UIScrollView's normal decay, applied per millisecond. Integrating the curve
// over elapsed time keeps the travel identical at 60 Hz and 120 Hz.
const DECAY = -Math.log(0.998);
const VELOCITY_WINDOW_MS = 100;
const RELEASE_PAUSE_MS = 80;
const MIN_VELOCITY = 0.05; // CSS px/ms (also the stopping speed)
const MAX_VELOCITY = 3;

/** Pixel motion shared by drag and coast; xterm consumes whole lines while
 * fractional-line travel survives release. Estimate velocity over the last
 * `VELOCITY_WINDOW_MS` (100 ms) of the current direction, resetting history
 * on reversal or a held finger. Include release-time pauses in the estimate;
 * `RELEASE_PAUSE_MS` (80 ms) suppresses momentum. Clamp launch speed to
 * `MAX_VELOCITY` (3 CSS px/ms), decay by 0.998 per millisecond, integrate over
 * elapsed frame time, and stop below `MIN_VELOCITY` (0.05 CSS px/ms).
 * The caller alone decides whether the pointer type/release may coast.
 */
export class EdgeScrollMotion {
  private samples: Array<{ y: number; time: number }>;
  private remainder = 0;
  private direction = 0;
  private velocity = 0;
  private frameTime = 0;

  constructor(y: number, time: number) {
    this.samples = [{ y, time }];
  }

  private lines(pixels: number): number {
    this.remainder += pixels;
    const lines = Math.trunc(this.remainder / EDGE_SCROLL_LINE_PX);
    this.remainder -= lines * EDGE_SCROLL_LINE_PX;
    return lines;
  }

  move(y: number, time: number): number {
    const previous = this.samples[this.samples.length - 1];
    const delta = previous.y - y;
    if (!delta) return 0;
    // A reversal or a held finger starts a fresh velocity estimate, so an old
    // fast stroke cannot launch a new slow stroke in the wrong direction.
    if (Math.sign(delta) !== this.direction || time - previous.time > RELEASE_PAUSE_MS) {
      this.samples = [previous];
    }
    this.direction = Math.sign(delta);
    this.samples.push({ y, time });
    while (this.samples.length > 2 && this.samples[1].time <= time - VELOCITY_WINDOW_MS) {
      this.samples.shift();
    }
    return this.lines(delta);
  }

  release(time: number): boolean {
    const last = this.samples[this.samples.length - 1];
    if (time - last.time >= RELEASE_PAUSE_MS) return false;
    const cutoff = time - VELOCITY_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1].time <= cutoff) this.samples.shift();
    const first = this.samples[0];
    const second = this.samples[1];
    const start = Math.max(first.time, cutoff);
    // Interpolate the segment crossing the window boundary instead of letting
    // a sparsely delivered pointer event extend the velocity history.
    const y = second && second.time > first.time
      ? first.y + (second.y - first.y) * (start - first.time) / (second.time - first.time)
      : first.y;
    const elapsed = time - start;
    if (elapsed <= 0) return false;
    this.velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, (y - last.y) / elapsed));
    this.frameTime = time;
    return Math.abs(this.velocity) >= MIN_VELOCITY;
  }

  /** null ends the coast; zero retains sub-line travel for a later frame. */
  step(time: number): number | null {
    if (Math.abs(this.velocity) < MIN_VELOCITY) return null;
    const elapsed = Math.max(0, time - this.frameTime);
    const decay = Math.exp(-DECAY * elapsed);
    const pixels = this.velocity * (1 - decay) / DECAY;
    this.velocity *= decay;
    this.frameTime = time;
    return this.lines(pixels);
  }
}

export const isEdgeScrollOrigin = (x: number, width: number): boolean =>
  width > 0 && (x <= EDGE_SCROLL_WIDTH_PX || x >= width - EDGE_SCROLL_WIDTH_PX);

// Only wheels created by this path may pass the mobile capture-phase guard.
const mobileWheels = new WeakSet<Event>();
export const isMobileScrollWheel = (event: Event): boolean => mobileWheels.has(event);

/** False when there is no scroll target or the buffer has reached its boundary. */
export function scrollMobileTerminal(terminal: Terminal, lines: number, clientX: number, clientY: number): boolean {
  if (terminal.modes.mouseTrackingMode === 'none') {
    // Native wheels can become arrow keys in an alternate screen. This path
    // scrolls only the buffer, including a no-op when there is no history.
    const buffer = terminal.buffer.active;
    if (lines < 0 ? buffer.viewportY === 0 : buffer.viewportY === buffer.baseY) return false;
    terminal.scrollLines(lines);
    return true;
  }
  const screen = terminal.element?.querySelector('.xterm-screen');
  if (!screen) return false;
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
  return true;
}
