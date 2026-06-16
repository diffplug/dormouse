import { describe, expect, it, vi } from 'vitest';
import {
  closeAgentBrowserScreenModal,
  getAgentBrowserScreenController,
  getOpenAgentBrowserScreenModalId,
  openAgentBrowserScreenModal,
  registerAgentBrowserScreen,
  subscribeAgentBrowserScreenModal,
  subscribeAgentBrowserScreenPresence,
  type ScreenActions,
  type ScreenSnapshot,
} from './agent-browser-screen';

const SNAPSHOT: ScreenSnapshot = {
  state: 'SCALED',
  viewport: { w: 1280, h: 720, dpr: 1 },
  paneCss: { w: 980, h: 560 },
  displayDpr: 2,
  syncEngaged: true,
};

function stubActions(): ScreenActions {
  return { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() };
}

describe('agent-browser screen registry', () => {
  it('registers a controller, notifies presence, and disposes', () => {
    let presence = 0;
    const unsubscribe = subscribeAgentBrowserScreenPresence(() => {
      presence += 1;
    });

    expect(getAgentBrowserScreenController('pane-1')).toBeNull();

    const registration = registerAgentBrowserScreen('pane-1', {
      snapshot: SNAPSHOT,
      actions: stubActions(),
      hostCapable: true,
    });
    expect(presence).toBe(1);

    const controller = getAgentBrowserScreenController('pane-1');
    expect(controller).not.toBeNull();
    expect(controller?.snapshot()).toEqual(SNAPSHOT);
    expect(controller?.hostCapable).toBe(true);

    registration.dispose();
    expect(presence).toBe(2);
    expect(getAgentBrowserScreenController('pane-1')).toBeNull();

    unsubscribe();
  });

  it('publishes snapshot updates to subscribers', () => {
    const registration = registerAgentBrowserScreen('pane-2', {
      snapshot: SNAPSHOT,
      actions: stubActions(),
      hostCapable: false,
    });
    const controller = getAgentBrowserScreenController('pane-2')!;

    let updates = 0;
    const unsubscribe = controller.subscribe(() => {
      updates += 1;
    });

    const next: ScreenSnapshot = { ...SNAPSHOT, state: 'SYNCED' };
    registration.update(next);
    expect(updates).toBe(1);
    expect(controller.snapshot()).toEqual(next);

    unsubscribe();
    registration.dispose();
  });

  it('a stale registration does not clobber a re-registered surface on dispose', () => {
    const first = registerAgentBrowserScreen('pane-3', {
      snapshot: SNAPSHOT,
      actions: stubActions(),
      hostCapable: true,
    });
    const second = registerAgentBrowserScreen('pane-3', {
      snapshot: SNAPSHOT,
      actions: stubActions(),
      hostCapable: true,
    });
    const live = getAgentBrowserScreenController('pane-3');

    // Disposing the superseded registration must not remove the live one.
    first.dispose();
    expect(getAgentBrowserScreenController('pane-3')).toBe(live);

    second.dispose();
    expect(getAgentBrowserScreenController('pane-3')).toBeNull();
  });

  it('tracks which surface has its modal open', () => {
    let changes = 0;
    const unsubscribe = subscribeAgentBrowserScreenModal(() => {
      changes += 1;
    });
    expect(getOpenAgentBrowserScreenModalId()).toBeNull();

    openAgentBrowserScreenModal('pane-9');
    expect(getOpenAgentBrowserScreenModalId()).toBe('pane-9');
    expect(changes).toBe(1);

    // Re-opening the same id is a no-op (no spurious notification).
    openAgentBrowserScreenModal('pane-9');
    expect(changes).toBe(1);

    closeAgentBrowserScreenModal();
    expect(getOpenAgentBrowserScreenModalId()).toBeNull();
    expect(changes).toBe(2);

    unsubscribe();
  });
});
