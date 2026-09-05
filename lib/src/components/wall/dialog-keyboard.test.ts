import { describe, expect, it } from 'vitest';
import { createDialogKeyboardCoordinator } from './wall-context';

describe('dialog keyboard coordinator', () => {
  it('stays active until every independent owner releases its lease', () => {
    const active = { current: false };
    const acquire = createDialogKeyboardCoordinator(active);
    const releaseNotepad = acquire();
    const releaseSettings = acquire();
    expect(active.current).toBe(true);

    releaseSettings();
    expect(active.current).toBe(true);
    releaseNotepad();
    expect(active.current).toBe(false);

    releaseNotepad();
    expect(active.current).toBe(false);
  });
});
