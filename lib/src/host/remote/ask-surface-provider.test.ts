// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DirectoryEntry } from '../../remote/host/host-surface-provider';
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

const inertPty = {
  writePty: () => {},
  resizePty: () => {},
  streamPty: () => () => {},
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
