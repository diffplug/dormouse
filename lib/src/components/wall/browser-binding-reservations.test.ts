import { test, expect, vi } from 'vitest';
import { BrowserBindingReservations } from './browser-binding-reservations';
test('concurrent first commands share cwd; a failed launch reservation expires', () => {
  vi.useFakeTimers();
  try {
    const registry = new BrowserBindingReservations();
    const first = { cwd: '/project-a' };
    const second = { cwd: '/project-b' };
    const binding = registry.resolve('app', first);
    expect(binding).toMatchObject({ cwd: first.cwd });
    expect(registry.resolve('app', second)).toEqual(binding);
    vi.advanceTimersByTime(120000);
    const replacement = registry.resolve('app', second);
    expect(replacement).toMatchObject({ cwd: second.cwd });
    expect(replacement?.session).not.toBe(binding?.session);
    registry.delete('app');
    expect(registry.resolve('app', first)?.cwd).toBe(first.cwd);
  } finally { vi.useRealTimers(); }
});

test('the same key in separate workspaces has independent native sessions', () => {
  const first = new BrowserBindingReservations();
  const second = new BrowserBindingReservations();
  const proposed = { cwd: '/project', binaryPath: '/tools/playwright-cli' };
  const binding = first.resolve('app', proposed)!;
  expect(binding.session).not.toBe(second.resolve('app', proposed)?.session);
  expect(first.resolve('app', { ...proposed, binaryPath: '/other/playwright-cli' })).toEqual(binding);
  expect(binding.binaryPath).toBe(proposed.binaryPath);
});
