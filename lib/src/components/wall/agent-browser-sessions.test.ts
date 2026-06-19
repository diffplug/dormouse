import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAgentBrowserSessionClosed,
  isAgentBrowserSessionClosed,
  markAgentBrowserSessionClosed,
} from './agent-browser-sessions';

afterEach(() => {
  // Module state is process-global; reset the names this suite touches.
  clearAgentBrowserSessionClosed('dormouse.1.gui-abc');
  clearAgentBrowserSessionClosed('dormouse.1.default');
});

describe('agent-browser session teardown guard', () => {
  it('reports a session as closed only after it is marked', () => {
    expect(isAgentBrowserSessionClosed('dormouse.1.gui-abc')).toBe(false);
    markAgentBrowserSessionClosed('dormouse.1.gui-abc');
    expect(isAgentBrowserSessionClosed('dormouse.1.gui-abc')).toBe(true);
  });

  it('clears the mark when a new surface re-takes the session name', () => {
    // Kill marks the name closed; a later `dor ab` re-creating the same managed
    // name must clear it so the new surface's auto-revert is live again.
    markAgentBrowserSessionClosed('dormouse.1.default');
    expect(isAgentBrowserSessionClosed('dormouse.1.default')).toBe(true);
    clearAgentBrowserSessionClosed('dormouse.1.default');
    expect(isAgentBrowserSessionClosed('dormouse.1.default')).toBe(false);
  });

  it('tracks sessions independently', () => {
    markAgentBrowserSessionClosed('dormouse.1.gui-abc');
    expect(isAgentBrowserSessionClosed('dormouse.1.default')).toBe(false);
    expect(isAgentBrowserSessionClosed('dormouse.1.gui-abc')).toBe(true);
  });
});
