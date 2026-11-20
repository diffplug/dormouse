/**
 * The fingertip that drives the homepage's Pocket demo. It moves a visible dot
 * over the phone's screen and sends the real components the events a thumb
 * would: clicks on their buttons, pointer drags on the terminal.
 */

interface Point { x: number; y: number }

/** The abort reason that unwinds the script wherever it is once the demo stops. */
export class DemoStopped extends Error {}

/** Thrown when the agent never reaches a phase: a gesture a resize threw off
 *  answered something else. */
export class DemoStuck extends Error {}

const POINTER_ID = 7_301;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** `element`'s top-left within `root`, from layout offsets rather than client
 *  boxes, which a transform on the demo (a turn, a scale) skews. */
export function offsetWithin(element: HTMLElement, root: HTMLElement): Point {
  const at = { x: 0, y: 0 };
  for (let node: HTMLElement | null = element; node && node !== root; node = node.offsetParent as HTMLElement | null) {
    at.x += node.offsetLeft;
    at.y += node.offsetTop;
  }
  return at;
}

export class Finger {
  private position: Point;

  constructor(
    /** The phone's screen: every point is relative to its top-left corner. */
    private readonly screen: HTMLElement,
    private readonly dot: HTMLElement,
    /** Aborted with a `DemoStopped` reason. */
    private readonly signal: AbortSignal,
  ) {
    this.position = { x: screen.clientWidth * 0.7, y: screen.clientHeight * 0.85 };
    this.place();
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.signal.throwIfAborted();
  }

  /** Waits for `reached`, throwing `DemoStuck` once `ms` pass without it. */
  async expect(reached: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(this.signal.aborted ? this.signal.reason : new DemoStuck()), ms);
    });
    try {
      await Promise.race([reached, deadline]);
    } finally {
      clearTimeout(timer);
    }
    this.signal.throwIfAborted();
  }

  show(visible: boolean): void {
    this.dot.style.opacity = visible ? "1" : "0";
  }

  /** Glides to `to`, calling `onFrame` at each step (a drag's pointermoves). */
  async moveTo(to: Point, ms: number, onFrame?: (at: Point) => void): Promise<void> {
    const from = this.position;
    const start = performance.now();
    for (let t = 0; t < 1;) {
      await new Promise(requestAnimationFrame);
      this.signal.throwIfAborted();
      t = Math.min(1, (performance.now() - start) / ms);
      const k = easeInOut(t);
      this.position = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      this.place();
      onFrame?.(this.position);
    }
  }

  /** Moves onto `element`'s center and taps it. */
  async tap(element: HTMLElement): Promise<void> {
    const at = offsetWithin(element, this.screen);
    await this.moveTo({ x: at.x + element.offsetWidth / 2, y: at.y + element.offsetHeight / 2 }, 520);
    await this.press(true);
    element.click();
    await this.sleep(110);
    await this.press(false);
  }

  /**
   * Presses on `target` where the finger is, then drags through `path`
   * (offsets from the press), pausing `holdMs` at each point, and lifts.
   */
  async drag(target: Element, path: Array<Point & { ms: number; holdMs?: number }>): Promise<void> {
    const origin = this.position;
    // Pocket places a press within the pane's drawn box, which the phone's fit
    // scales, but reads a drag's distance as unscaled pixels: so the press goes
    // to its spot in the drawn box, and the drag moves at full size.
    const box = this.screen.getBoundingClientRect();
    const press = {
      x: box.left + (origin.x * box.width) / this.screen.offsetWidth,
      y: box.top + (origin.y * box.height) / this.screen.offsetHeight,
    };
    const pointer = (type: string) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: POINTER_ID,
      pointerType: "touch",
      isPrimary: true,
      clientX: press.x + this.position.x - origin.x,
      clientY: press.y + this.position.y - origin.y,
    }));
    await this.press(true);
    pointer("pointerdown");
    for (const step of path) {
      await this.moveTo({ x: origin.x + step.x, y: origin.y + step.y }, step.ms, () => pointer("pointermove"));
      // Settling moves: the radial menu expands once a drag stops pushing outward.
      for (let held = 0; held < (step.holdMs ?? 0); held += 60) {
        await this.sleep(60);
        pointer("pointermove");
      }
    }
    pointer("pointerup");
    await this.press(false);
  }

  private async press(down: boolean): Promise<void> {
    this.dot.dataset.pressed = String(down);
    await this.sleep(down ? 90 : 60);
  }

  private place(): void {
    this.dot.style.translate = `${this.position.x}px ${this.position.y}px`;
  }
}

/** Centered on its position by the negative margin, half its 34px size. A
 *  press fills it and rings it with a halo. */
export const FINGER_CLASS = [
  "pointer-events-none absolute left-0 top-0 z-50 -m-[17px] h-[34px] w-[34px] rounded-full",
  "border-2 border-white/80 bg-white/20 shadow-[0_2px_10px_rgba(0,0,0,0.45)]",
  "transition-[opacity,background-color,box-shadow] duration-150",
  "data-[pressed=true]:bg-white/70 data-[pressed=true]:shadow-[0_0_0_7px_rgba(255,255,255,0.22),0_2px_10px_rgba(0,0,0,0.45)]",
].join(" ");
