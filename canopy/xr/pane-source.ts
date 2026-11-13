/**
 * Where the wall's terminals get their bytes: the subset of `lib`'s `RemotePtyAdapter`
 * (`lib/src/remote/client/remote-adapter.ts`) the wall calls, restated so canopy stays independent
 * of `dormouse-lib` until it has a live Client. Names and shapes follow the adapter, so the live
 * stage (`docs/specs/webgl-text.md` -> Future, "Live terminals") passes one in unchanged. Like
 * protocol-v1, a source streams one attached pane at a time: `setActivePane` detaches the last.
 */
export interface PaneSource {
  getDirectoryEntries(): readonly PaneEntry[];
  subscribeDirectory(listener: (entries: readonly PaneEntry[]) => void): () => void;
  /** Attach is the resize: the attached pane repaints at `cols` × `rows`. */
  setActivePane(id: string, cols?: number, rows?: number): Promise<void>;
  writePty(id: string, data: string): void;
  resizePty(id: string, cols: number, rows: number): void;
  /** `claim`, when present, returns the callback to pass to `term.write` so the chunk is acknowledged once parsed. */
  onPtyData(handler: (detail: { id: string; data: string }, claim?: () => () => void) => void): void;
  onPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void;
}

/** The fields of the wire's `DirectoryEntry` the wall reads. */
export interface PaneEntry {
  surfaceId: string;
  type: 'terminal' | 'browser';
  title: string;
  alive: boolean;
}

const ESC = '\x1b[';

/** A scripted terminal: what it shows at a size and tick, and what it streams per tick. */
interface Script {
  title: string;
  /** The whole screen, for an attach's repaint. */
  paint(cols: number, rows: number, tick: number): string;
  /** Output for one tick while attached, or '' to stay quiet. */
  step(cols: number, rows: number, tick: number): string;
  /** Keystrokes typed into the pane; returns what the program echoes. */
  input?(data: string): string;
}

const clock = (tick: number) => new Date(Date.UTC(2026, 10, 12, 18, 0, 0) + tick * 400).toISOString().slice(11, 19);

const BUILD_STEPS = ['lath/src/model.ts', 'lath/src/layout.ts', 'lath/src/ops.ts', 'lath/src/hit-test.ts', 'canopy/xr/wall-scene.ts', 'canopy/xr/in-scene-text.ts'];
function buildLine(tick: number) {
  const file = BUILD_STEPS[tick % BUILD_STEPS.length];
  return `${ESC}90m[${clock(tick)}]${ESC}0m ${ESC}36mtsc${ESC}0m ${file} ${ESC}32m✓${ESC}0m ${ESC}90m${(37 + ((tick * 13) % 61))}ms${ESC}0m`;
}

function topScreen(cols: number, rows: number, tick: number) {
  const lines = [`${ESC}1mcanned top${ESC}0m  ${clock(tick)}  load ${(1 + ((tick * 7) % 30) / 10).toFixed(2)}`, ''];
  const bar = Math.max(4, cols - 22);
  for (let i = 0; i < Math.min(rows - 3, 8); i++) {
    const pct = (tick * (i + 3) * 17 + i * 29) % 100;
    const fill = Math.round((pct / 100) * bar);
    const color = pct > 75 ? 31 : pct > 40 ? 33 : 32;
    lines.push(`cpu${i}  ${ESC}${color}m${'█'.repeat(fill)}${ESC}90m${'·'.repeat(bar - fill)}${ESC}0m ${String(pct).padStart(3)}%`);
  }
  return `${ESC}H${ESC}2J` + lines.join('\r\n');
}

const SCRIPTS: Script[] = [
  {
    title: 'pnpm build --watch',
    paint: (_c, rows, tick) => `${ESC}H${ESC}2J` + Array.from({ length: Math.min(rows - 1, tick) }, (_, i) => buildLine(tick - Math.min(rows - 1, tick) + i)).join('\r\n'),
    step: (_c, _r, tick) => `\r\n${buildLine(tick)}`,
  },
  {
    title: 'top',
    paint: topScreen,
    step: (cols, rows, tick) => (tick % 2 ? '' : topScreen(cols, rows, tick)),
  },
  {
    title: 'git log --oneline',
    paint: () =>
      `${ESC}H${ESC}2J` +
      ['5bfa78236 Canopy WebXR: draw mesh panes in-scene', '4c204d3c2 Canopy WebXR: the Lath wall on a cylinder', '1a8e65c1c Lath: extract the pure core', 'b990ca6c4 Canopy WebXR: controller rays as the mouse', 'fc311b437 Canopy WebXR: one SDF terminal', 'c0444761f Canopy WebXR: scaffold']
        .map((l) => `${ESC}33m${l.slice(0, 9)}${ESC}0m${l.slice(9)}`)
        .join('\r\n') +
      `\r\n${ESC}7m(END)${ESC}0m`,
    step: () => '',
  },
];

/**
 * A `PaneSource` playing scripted terminals, for the wall to exercise the live seam with no
 * Burrow: one attached pane streams and echoes typing, as a v1 session would, while the others
 * keep their last frame.
 */
export function cannedSource(count: number): PaneSource {
  const entries: PaneEntry[] = Array.from({ length: count }, (_, i) => ({
    surfaceId: `surface:${i + 1}`,
    type: 'terminal',
    title: SCRIPTS[i % SCRIPTS.length].title,
    alive: true,
  }));
  const dataHandlers = new Set<(detail: { id: string; data: string }) => void>();
  const emit = (id: string, data: string) => {
    if (data) for (const handler of dataHandlers) handler({ id, data });
  };
  let attached: { id: string; script: Script; cols: number; rows: number } | null = null;
  let tick = 20;
  setInterval(() => {
    tick++;
    if (attached) emit(attached.id, attached.script.step(attached.cols, attached.rows, tick));
  }, 400);

  return {
    getDirectoryEntries: () => entries,
    subscribeDirectory: (listener) => {
      listener(entries);
      return () => {};
    },
    async setActivePane(id, cols = 80, rows = 24) {
      const index = entries.findIndex((e) => e.surfaceId === id);
      if (index < 0) throw new Error(`no surface ${id}`);
      attached = { id, script: SCRIPTS[index % SCRIPTS.length], cols, rows };
      emit(id, attached.script.paint(cols, rows, tick));
    },
    writePty(id, data) {
      if (attached?.id !== id) return;
      emit(id, attached.script.input?.(data) ?? data.replace(/\r/g, '\r\n'));
    },
    resizePty(id, cols, rows) {
      if (attached?.id !== id) return;
      attached.cols = cols;
      attached.rows = rows;
      emit(id, attached.script.paint(cols, rows, tick));
    },
    onPtyData: (handler) => void dataHandlers.add(handler),
    onPtyExit: () => {},
  };
}
