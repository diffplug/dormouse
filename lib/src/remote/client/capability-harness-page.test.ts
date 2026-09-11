/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-ignore Shared JavaScript build assertion.
import { assertPocketShell } from '../../../scripts/assert-pocket-worker.mjs';

const fake = vi.hoisted(() => ({ run: vi.fn(), prepare: vi.fn(), verify: vi.fn(), clear: vi.fn() }));
vi.mock('../../../pocket/public/diagnostics/restart.js', () => ({
  prepareRestart: fake.prepare, verifyRestart: fake.verify, clearRestart: fake.clear,
}));
vi.mock('../../../pocket/public/diagnostics/capabilities.js', () => ({
  HARNESS_VERSION: '1', runCapabilities: fake.run,
}));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('wires explicit restart preparation, verification, copy, and cleanup', async () => {
  const html = readFileSync(resolve('pocket/public/diagnostics/index.html'), 'utf8');
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!;
  fake.prepare.mockResolvedValue({ status: 'PREPARED' });
  fake.verify.mockResolvedValue({ status: 'PASS', newPageInstance: true });
  fake.clear.mockResolvedValue({ status: 'REMOVED' });
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  // @ts-ignore Browser-native JavaScript entry point.
  await import('../../../pocket/public/diagnostics/restart-page.js');
  expect(fake.prepare).not.toHaveBeenCalled();
  document.getElementById('prepare-restart')!.click();
  await vi.waitFor(() => expect(document.getElementById('restart-status')!.textContent).toContain('Prepared.'));
  document.getElementById('verify-restart')!.click();
  await vi.waitFor(() => expect(document.getElementById('restart-status')!.textContent).toContain('PASS:'));
  document.getElementById('copy-restart')!.click();
  expect(JSON.parse(copy.mock.calls[0]![0])).toMatchObject({ status: 'PASS' });
  document.getElementById('clear-restart')!.click();
  await vi.waitFor(() => expect(document.getElementById('restart-status')!.textContent).toContain('checkpoint removed'));
});

it('renders completed and failed checks and copies a report without HTML injection', async () => {
  const root = resolve('pocket/public/diagnostics');
  expect(assertPocketShell(root)).toBe(2);
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));
  expect(manifest).toMatchObject({ id: '/diagnostics/', start_url: '/diagnostics/index.html', display: 'standalone' });
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!;
  const rows = [
    { id: 'aes', label: 'AES-GCM', status: 'PASS' },
    { id: 'x', label: 'X25519', status: 'FAIL', stage: 'write', error: '<img src=x> DataError' },
  ];
  fake.run.mockImplementation(async onResult => {
    rows.forEach(onResult);
    return { results: rows, cleanupErrors: [] };
  });
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  // @ts-ignore Browser-native JavaScript entry point.
  await import('../../../pocket/public/diagnostics/page.js');
  document.getElementById('run')!.click();
  await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toContain('1 passed, 1 failed'));
  expect(document.querySelectorAll('#results li')).toHaveLength(2);
  expect(document.querySelector('#results img')).toBeNull();
  document.getElementById('copy')!.click();
  expect(JSON.parse(copy.mock.calls[0]![0]).results).toEqual(rows);
});
