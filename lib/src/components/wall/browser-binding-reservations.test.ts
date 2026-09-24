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

test('a key whose command succeeded keeps its session with no Surface to bind', () => {
  // `dor pw --key app open --browser=firefox`: the native browser exists, but no
  // viewer can attach, so nothing but the reservation holds the key's session.
  vi.useFakeTimers();
  try {
    const registry = new BrowserBindingReservations();
    const binding = registry.resolve('app', { cwd: '/project' });
    registry.confirm('app');
    vi.advanceTimersByTime(10 * 60_000);
    expect(registry.resolve('app', { cwd: '/elsewhere' })).toEqual(binding);
    // A key with nothing reserved has nothing to confirm.
    registry.confirm('other');
    expect(registry.resolve('other', { cwd: '/elsewhere' })?.cwd).toBe('/elsewhere');
  } finally { vi.useRealTimers(); }
});
