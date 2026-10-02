import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cancelPendingConfirmation,
  dismissWorkspaceUi,
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
