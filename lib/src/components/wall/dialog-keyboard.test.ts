import { describe, expect, it } from 'vitest';
import { createDialogKeyboardCoordinator } from './wall-context';

describe('dialog keyboard coordinator', () => {
  it('stays active until every independent owner releases its lease', () => {
    const active = { current: false };
    const acquire = createDialogKeyboardCoordinator(active);
    const releaseFirst = acquire();
    const releaseSecond = acquire();
    expect(active.current).toBe(true);

    releaseSecond();
    expect(active.current).toBe(true);
    releaseFirst();
    expect(active.current).toBe(false);

    releaseFirst();
    expect(active.current).toBe(false);
  });
});
