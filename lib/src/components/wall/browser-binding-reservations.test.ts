import { test, expect, vi } from 'vitest';
import { sessionForKey } from 'dor-lib-common/browser-providers';
import { BrowserBindingReservations } from './browser-binding-reservations';

test('concurrent first commands share cwd; a failed launch reservation expires', () => {
  vi.useFakeTimers();
  try {
    const registry = new BrowserBindingReservations();
    const first = { cwd: '/project-a' };
    const second = { cwd: '/project-b' };
    const binding = registry.resolve('playwright', 'app', 'ws', first);
    expect(binding).toEqual({ session: sessionForKey('app', 'ws'), cwd: first.cwd });
    expect(registry.resolve('playwright', 'app', 'ws', second)).toEqual(binding);
    vi.advanceTimersByTime(120000);
    // The session is the key's own; only the pinned directory was released.
    expect(registry.resolve('playwright', 'app', 'ws', second)).toEqual({ session: binding.session, cwd: second.cwd });
    registry.delete('playwright', 'app');
    expect(registry.resolve('playwright', 'app', 'ws', first).cwd).toBe(first.cwd);
  } finally { vi.useRealTimers(); }
});

test('a key is namespaced by its Workspace and its provider, and pins only an allowed executable', () => {
  const registry = new BrowserBindingReservations();
  const proposed = { cwd: '/project', binaryPath: '/tools/playwright-cli' };
  const binding = registry.resolve('playwright', 'app', 'ws-a', proposed);
  expect(binding.session).not.toBe(new BrowserBindingReservations().resolve('playwright', 'app', 'ws-b', proposed).session);
  expect(registry.resolve('playwright', 'app', 'ws-a', { ...proposed, binaryPath: '/other/playwright-cli' })).toEqual(binding);
  expect(binding.binaryPath).toBe(proposed.binaryPath);
  // agent-browser's `app` is another browser, with its own reservation.
  expect(registry.resolve('agent-browser', 'app', 'ws-a', { cwd: '/elsewhere', binaryPath: '/tools/playwright-cli' }))
    .toEqual({ session: binding.session, cwd: '/elsewhere' });
});

test('a command that cannot bind a Surface reserves nothing', () => {
  const registry = new BrowserBindingReservations();
  expect(registry.resolve('agent-browser', 'app', 'ws')).toEqual({ session: sessionForKey('app', 'ws') });
  expect(registry.resolve('agent-browser', 'app', 'ws', { cwd: '/project' }).cwd).toBe('/project');
});

test('a key whose command succeeded keeps its binding with no Surface to bind', () => {
  // `dor pw --key app open --browser=firefox`: the native browser exists, but no
  // viewer can attach, so nothing but the reservation holds the key's cwd.
  vi.useFakeTimers();
  try {
    const registry = new BrowserBindingReservations();
    const binding = registry.resolve('playwright', 'app', 'ws', { cwd: '/project' });
    registry.confirm('playwright', 'app');
    vi.advanceTimersByTime(10 * 60_000);
    expect(registry.resolve('playwright', 'app', 'ws', { cwd: '/elsewhere' })).toEqual(binding);
    // A key with nothing reserved has nothing to confirm.
    registry.confirm('playwright', 'other');
    expect(registry.resolve('playwright', 'other', 'ws', { cwd: '/elsewhere' }).cwd).toBe('/elsewhere');
  } finally { vi.useRealTimers(); }
});
