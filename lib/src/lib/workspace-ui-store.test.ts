import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cancelPendingConfirmation,
  closeWorkspaceMenu,
  dismissWorkspaceUi,
  openWorkspaceMenu,
  setRenamingWorkspace,
  getWorkspaceUiSnapshot,
  requestConfirmation,
  resetWorkspaceUi,
  settleConfirmation,
  subscribeToWorkspaceUi,
} from './workspace-ui-store';

const emitted = vi.fn();
let unsubscribe: () => void;

beforeEach(() => {
  resetWorkspaceUi();
  unsubscribe = subscribeToWorkspaceUi(emitted);
  emitted.mockClear();
});

afterEach(() => unsubscribe());

it('answers the pending confirmation no before installing a newer one, in one emit', () => {
  const first = vi.fn(() => expect(getWorkspaceUiSnapshot().confirmation).toBeNull());
  requestConfirmation({ id: 'a', char: 'q', answer: first });
  emitted.mockClear();
  const second = { id: 'b', char: 'r', answer: vi.fn() };
  requestConfirmation(second);
  expect(first).toHaveBeenCalledExactlyOnceWith(false);
  expect(getWorkspaceUiSnapshot().confirmation).toBe(second);
  expect(emitted).toHaveBeenCalledTimes(1);
  // The superseded question's answer is stale now.
  settleConfirmation({ id: 'a', char: 'q', answer: first }, true);
  expect(getWorkspaceUiSnapshot().confirmation).toBe(second);
});

it.each([
  ['cancel', () => cancelPendingConfirmation()],
  ['dismiss', () => dismissWorkspaceUi('a')],
  ['reset', () => resetWorkspaceUi()],
] as const)('%s answers no once and emits once', (_, clear) => {
  const answer = vi.fn();
  requestConfirmation({ id: 'a', char: 'q', answer });
  emitted.mockClear();
  clear();
  clear();
  expect(answer).toHaveBeenCalledExactlyOnceWith(false);
  expect(emitted).toHaveBeenCalledTimes(1);
  expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
});

it('the tab menu yields to a rename, a confirmation, any close or move starting, and its own Workspace leaving', () => {
  const menu = { id: 'a', keyboard: false };
  const yields: Array<() => void> = [
    () => setRenamingWorkspace('b'),
    () => requestConfirmation({ id: 'b', char: 'q', answer: vi.fn() }),
    () => cancelPendingConfirmation(),
    () => dismissWorkspaceUi('a'),
    () => closeWorkspaceMenu(),
  ];
  for (const yieldTo of yields) {
    resetWorkspaceUi();
    openWorkspaceMenu(menu);
    expect(getWorkspaceUiSnapshot().menu).toBe(menu);
    yieldTo();
    expect(getWorkspaceUiSnapshot().menu).toBeNull();
  }
  // Another Workspace leaving keeps it.
  resetWorkspaceUi();
  openWorkspaceMenu(menu);
  dismissWorkspaceUi('b');
  expect(getWorkspaceUiSnapshot().menu).toBe(menu);
});
