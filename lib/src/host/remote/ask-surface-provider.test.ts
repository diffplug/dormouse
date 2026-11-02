// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, SurfaceHold } from '../../remote/burrow/burrow-surface-provider';
import { createAskSurfaceProvider } from './ask-surface-provider';

const entry = (surfaceId: string, title: string): DirectoryEntry => ({
  paneRef: surfaceId,
  surfaceId,
  type: 'terminal',
  title,
  focused: false,
  alive: true,
  ringing: false,
  hasTODO: false,
});

const HOLD: SurfaceHold = { holder: 'session-a', label: 'iPhone', lease: '3', serviceId: 'service-1' };

const inertPty = {
  writePty: () => {},
  resizePty: () => {},
  streamPty: () => ({ stop: () => {}, ready: Promise.resolve() }),
};

describe('createAskSurfaceProvider directory', () => {
  it('keeps the first of two answerers claiming one surface id', async () => {
    // Duplicated cold-restored windows can both hold a pane id. The first
    // answer is the owner the attach path's resolve probe selects, so the row
    // the phone shows must be that one — not a duplicate lottery.
    const { provider } = createAskSurfaceProvider(
      async () => [
        entry('pane-1', 'local copy'),
        entry('pane-2', 'only one'),
        entry('pane-1', 'far copy'),
      ],
      inertPty,
    );

    const entries = await provider.collectDirectory();
    expect(entries.map((e) => e.title)).toEqual(['local copy', 'only one']);
  });
});

describe('createAskSurfaceProvider resize', () => {
  it('rejects when the resolved owner disappears instead of acknowledging the cached size', async () => {
    const { provider } = createAskSurfaceProvider(
      async (_op, params) => (params as { op: string }).op === 'attach'
        ? [{ ptyId: 'pty-1', cols: 80, rows: 24 }]
        : [],
      inertPty,
    );
    const handle = await provider.resolveSurface('pane-1', { cols: 80, rows: 24 }, HOLD);
    await expect(handle!.resize(120, 40)).rejects.toThrow('surface owner unavailable');
    expect({ cols: handle!.cols, rows: handle!.rows }).toEqual({ cols: 80, rows: 24 });
  });
});

describe('createAskSurfaceProvider holds', () => {
  it('names the hold on the attach and every resize, and releases it at the owner that took it', async () => {
    const asks: Array<{ op: string; params: unknown; ownerPtyId?: string }> = [];
    const { provider } = createAskSurfaceProvider(async (op, params, ownerPtyId) => {
      asks.push({ op, params, ownerPtyId });
      const { op: surfaceOp } = params as { op: string };
      return surfaceOp === 'release' ? [] : [{ ptyId: 'owner-key', cols: 51, rows: 14 }];
    }, inertPty);

    const handle = await provider.resolveSurface('pane-1', { cols: 51, rows: 14 }, HOLD);
    await handle!.resize(40, 20);
    handle!.release();

    expect(asks).toEqual([
      { op: 'surfaceOp', params: { surfaceId: 'pane-1', op: 'attach', cols: 51, rows: 14, hold: HOLD }, ownerPtyId: undefined },
      { op: 'surfaceOp', params: { surfaceId: 'pane-1', op: 'resize', cols: 40, rows: 20, hold: HOLD }, ownerPtyId: 'owner-key' },
      { op: 'surfaceOp', params: { surfaceId: 'pane-1', op: 'release', hold: HOLD }, ownerPtyId: 'owner-key' },
    ]);
  });

  it('releases a hold no handle carries at every answerer, naming no owner', () => {
    const asks: Array<{ op: string; params: unknown; ownerPtyId?: string }> = [];
    const { provider } = createAskSurfaceProvider(async (op, params, ownerPtyId) => {
      asks.push({ op, params, ownerPtyId });
      return [];
    }, inertPty);

    provider.releaseSurface('pane-1', HOLD);
    expect(asks).toEqual([
      { op: 'surfaceOp', params: { surfaceId: 'pane-1', op: 'release', hold: HOLD }, ownerPtyId: undefined },
    ]);
  });

  it('swallows a release whose ask rejects: nothing waits on one', async () => {
    const { provider } = createAskSurfaceProvider(async (_op, params) => {
      if ((params as { op: string }).op === 'release') throw new Error('window gone');
      return [{ ptyId: 'owner-key', cols: 80, rows: 24 }];
    }, inertPty);
    const handle = await provider.resolveSurface('pane-1', {}, HOLD);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      handle!.release();
      provider.releaseSurface('pane-1', HOLD);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('createAskSurfaceProvider closeSurface', () => {
  const noPty = { writePty: () => {}, resizePty: () => {}, streamPty: () => () => {} } as never;

  it('polls past a pending close to its outcome', async () => {
    const answers: unknown[][] = [[{ outcome: 'pending' }], [{ outcome: 'pending' }], [{ outcome: 'closed' }]];
    const asked: unknown[] = [];
    const { provider } = createAskSurfaceProvider(async (_op, params) => {
      asked.push(params);
      return answers.shift() ?? [];
    }, noPty);
    expect(await provider.closeSurface('surface:1', { confirmed: true })).toEqual({ outcome: 'closed' });
    expect(asked[0]).toEqual({ surfaceId: 'surface:1', confirmed: true });
    expect(asked[1]).toEqual({ surfaceId: 'surface:1', poll: true });
  });

  it('refuses a surface nobody claims, an ask that failed included', async () => {
    const { provider: none } = createAskSurfaceProvider(async () => [], noPty);
    expect((await none.closeSurface('surface:1', {})).outcome).toBe('refused');
    const { provider: failing } = createAskSurfaceProvider(async () => { throw new Error('gone'); }, noPty);
    expect((await failing.closeSurface('surface:1', {})).outcome).toBe('refused');
  });
});

describe('createAskSurfaceProvider resolveBrowser', () => {
  it('reads the first owner\'s page, crossing only its url and title', async () => {
    const asked: Array<[string, unknown]> = [];
    const { provider } = createAskSurfaceProvider(
      async (op, params) => {
        asked.push([op, params]);
        return [{ render: 'iframe', url: 'http://localhost:5173/', title: 'Vite', extra: 1 }, { url: 'http://other/' }];
      },
      inertPty,
    );
    expect(await provider.resolveBrowser('surface:2')).toEqual({ url: 'http://localhost:5173/', title: 'Vite' });
    expect(asked).toEqual([['browserOp', { surfaceId: 'surface:2' }]]);
  });

  it('answers null when no owner reports a page', async () => {
    const { provider } = createAskSurfaceProvider(async () => [{ title: 'no url' }], inertPty);
    expect(await provider.resolveBrowser('surface:2')).toBeNull();
  });
});
