/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { AgentBrowserScreenshotResult, PlatformAdapter } from '../../lib/platform/types';
import { createScreenshotLoop } from './agent-browser-screenshot-loop';

// Drive the loop directly (no controller/React): it owns backpressure, byte
// dedup, and the draw-generation key. The host screenshot is faked through the
// platform; createImageBitmap is stubbed (jsdom has none).

function setScreenshot(fn: PlatformAdapter['agentBrowserScreenshot']): void {
  const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
  platform.agentBrowserScreenshot = fn;
  setPlatform(platform);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() } as unknown as ImageBitmap)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setPlatform(new FakePtyAdapter());
});

describe('screenshot loop byte dedup', () => {
  it('draws once for byte-identical captures (still captures, but skips the redundant decode+draw)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const screenshot = vi.fn(async () => ({ ok: true as const, bytes, mime: 'image/jpeg' }));
    setScreenshot(screenshot);
    const draw = vi.fn();
    const loop = createScreenshotLoop({
      getSession: () => 'sess',
      getBinaryPath: () => undefined,
      isCapable: () => true,
      draw,
    });

    loop.pulse();
    await vi.advanceTimersByTimeAsync(300);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);

    // A second pulse still captures, but the bytes match what's on the canvas, so
    // the decode+draw is skipped.
    loop.pulse();
    await vi.advanceTimersByTimeAsync(300);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(draw).toHaveBeenCalledTimes(1);

    loop.dispose();
  });

  it('repaints byte-identical captures after the draw generation bumps', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const screenshot = vi.fn(async () => ({ ok: true as const, bytes, mime: 'image/jpeg' }));
    setScreenshot(screenshot);
    const draw = vi.fn();
    let generation = 0;
    const loop = createScreenshotLoop({
      getSession: () => 'sess',
      getBinaryPath: () => undefined,
      isCapable: () => true,
      draw,
      getDrawGeneration: () => generation,
    });

    loop.pulse();
    await vi.advanceTimersByTimeAsync(300);
    expect(draw).toHaveBeenCalledTimes(1);

    // Same bytes, but a fresh canvas (generation bumped on re-attach) must repaint.
    generation = 1;
    loop.pulse();
    await vi.advanceTimersByTimeAsync(300);
    expect(draw).toHaveBeenCalledTimes(2);

    loop.dispose();
  });
});

describe('screenshot loop backpressure', () => {
  it('coalesces pulses during an in-flight capture into a single follow-up', async () => {
    // A capture that stays in flight until we resolve it, so we can pulse during it.
    let release: ((res: AgentBrowserScreenshotResult) => void) | null = null;
    const screenshot = vi.fn(() => new Promise<AgentBrowserScreenshotResult>((resolve) => { release = resolve; }));
    setScreenshot(screenshot as unknown as PlatformAdapter['agentBrowserScreenshot']);
    const draw = vi.fn();
    const loop = createScreenshotLoop({
      getSession: () => 'sess',
      getBinaryPath: () => undefined,
      isCapable: () => true,
      draw,
    });

    loop.pulse();
    await vi.advanceTimersByTimeAsync(300);
    expect(screenshot).toHaveBeenCalledTimes(1);

    // Several pulses arrive while capture #1 is still in flight — they must
    // collapse to ONE follow-up, not one capture each.
    loop.pulse();
    loop.pulse();
    loop.pulse();
    expect(screenshot).toHaveBeenCalledTimes(1);

    // Finish capture #1 with a distinct byte payload so it draws.
    release?.({ ok: true, bytes: new Uint8Array([42]), mime: 'image/jpeg' });
    await vi.advanceTimersByTimeAsync(300);
    expect(draw).toHaveBeenCalledTimes(1);
    // Exactly one follow-up capture ran for the three coalesced pulses.
    expect(screenshot).toHaveBeenCalledTimes(2);

    loop.dispose();
  });
});
