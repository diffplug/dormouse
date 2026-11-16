/**
 * The fingertip that drives the homepage's Pocket demo. It moves a visible dot
 * over the phone's screen and sends the real components the events a thumb
 * would: clicks on their buttons, pointer drags on the terminal.
 */

export interface Point { x: number; y: number }

/** Rejects with this once the demo stops, unwinding the script wherever it is. */
export class DemoStopped extends Error {}

const POINTER_ID = 7_301;
const FINGER_SIZE = 34;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export class Finger {
  private position: Point;

  constructor(
    /** The phone's screen: every point is relative to its top-left corner. */
    private readonly screen: HTMLElement,
    private readonly dot: HTMLElement,
    private readonly signal: AbortSignal,
  ) {
    this.position = { x: screen.clientWidth * 0.7, y: screen.clientHeight * 0.85 };
    this.place();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new DemoStopped());
        return;
      }
      const timer = setTimeout(() => {
        this.signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      const stop = () => {
        clearTimeout(timer);
        reject(new DemoStopped());
      };
      this.signal.addEventListener("abort", stop, { once: true });
    });
  }

  show(visible: boolean): void {
    this.dot.style.opacity = visible ? "1" : "0";
  }

  /** Glides to `to`, calling `onFrame` at each step (a drag's pointermoves). */
  async moveTo(to: Point, ms: number, onFrame?: (at: Point) => void): Promise<void> {
    const from = this.position;
    const start = performance.now();
    for (;;) {
      await this.frame();
      const t = Math.min(1, (performance.now() - start) / ms);
      const k = easeInOut(t);
      this.position = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      this.place();
      onFrame?.(this.position);
      if (t === 1) return;
    }
  }

  /** Moves onto `element`'s center and taps it. */
  async tap(element: Element): Promise<void> {
    await this.moveTo(this.centerOf(element), 520);
    await this.press(true);
    (element as HTMLElement).click();
    await this.sleep(110);
    await this.press(false);
  }

  /**
   * Presses on `target` where the finger is, then drags through `path`
   * (offsets from the press), pausing `holdMs` at each point, and lifts.
   */
  async drag(target: Element, path: Array<Point & { ms: number; holdMs?: number }>): Promise<void> {
    const origin = this.position;
    await this.press(true);
    this.pointer(target, "pointerdown", origin);
    for (const step of path) {
      await this.moveTo({ x: origin.x + step.x, y: origin.y + step.y }, step.ms, (at) => this.pointer(target, "pointermove", at));
      if (step.holdMs) {
        // Settling moves: the radial menu expands once a drag stops pushing outward.
        const settleUntil = performance.now() + step.holdMs;
        while (performance.now() < settleUntil) {
          await this.sleep(60);
          this.pointer(target, "pointermove", this.position);
        }
      }
    }
    this.pointer(target, "pointerup", this.position);
    await this.press(false);
  }

  centerOf(element: Element): Point {
    const box = element.getBoundingClientRect();
    const screen = this.screen.getBoundingClientRect();
    return { x: box.left + box.width / 2 - screen.left, y: box.top + box.height / 2 - screen.top };
  }

  private pointer(target: Element, type: string, at: Point): void {
    const screen = this.screen.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: POINTER_ID,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: screen.left + at.x,
      clientY: screen.top + at.y,
    }));
  }

  private async press(down: boolean): Promise<void> {
    this.dot.dataset.pressed = down ? "true" : "false";
    await this.sleep(down ? 90 : 60);
  }

  private place(): void {
    this.dot.style.transform = `translate(${this.position.x - FINGER_SIZE / 2}px, ${this.position.y - FINGER_SIZE / 2}px)`;
  }

  private frame(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new DemoStopped());
        return;
      }
      requestAnimationFrame(() => (this.signal.aborted ? reject(new DemoStopped()) : resolve()));
    });
  }
}

export const FINGER_CLASS = [
  "pointer-events-none absolute left-0 top-0 z-50 h-[34px] w-[34px] rounded-full",
  "border-2 border-white/80 bg-white/35 shadow-[0_2px_10px_rgba(0,0,0,0.45)]",
  "transition-[opacity,scale] duration-150 data-[pressed=true]:scale-[0.82] data-[pressed=true]:bg-white/55",
].join(" ");
