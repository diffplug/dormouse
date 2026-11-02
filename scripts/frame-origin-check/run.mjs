#!/usr/bin/env node
/**
 * The phone check in headless Chromium, for CI: the same `serve.mjs` and check
 * page, driven to a verdict. Two runs in one browser context, so the second
 * meets the worker and the storage the first left behind.
 *
 *   pnpm check:frame-origin
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { chromium } = createRequire(join(root, 'lib', 'package.json'))('playwright-core');

/** Past the check page's own 180 s limit on the framed page, so its failure is the one reported. */
const RUN_TIMEOUT_MS = 240_000;
const RUNS = 2;

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const [pocketPort, framePort] = [await freePort(), await freePort()];
const reports = mkdtempSync(join(tmpdir(), 'frame-origin-check-'));
const server = spawn(process.execPath, [
  join(here, 'serve.mjs'), '--pocket-port', String(pocketPort), '--frame-port', String(framePort), '--reports', reports,
  '--case', 'cross-site',
], { stdio: ['ignore', 'pipe', 'inherit'] });
const listening = new Promise((resolve, reject) => {
  server.on('exit', (code) => reject(new Error(`serve.mjs exited with ${code}`)));
  server.stdout.on('data', (data) => {
    process.stdout.write(data);
    if (String(data).includes('Reports in')) resolve();
  });
});

let failed = 0;
let browser;
try {
  await listening;
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  for (let run = 1; run <= RUNS && !failed; run += 1) {
    const reported = page.waitForResponse((response) => new URL(response.url()).pathname === '/report', { timeout: RUN_TIMEOUT_MS });
    await page.goto(`http://localhost:${pocketPort}/`);
    const { results } = (await reported).request().postDataJSON();
    const failures = results.filter((result) => !result.ok);
    console.log(`run ${run}: ${results.length - failures.length} of ${results.length} passed`);
    failed += failures.length;
    // A page that never reached its checks has nothing to fail.
    if (!results.some((result) => result.name === 'page is controlled by the worker')) {
      console.error('The framed page never reported.');
      failed += 1;
    }
  }
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  await browser?.close();
  server.removeAllListeners('exit');
  server.kill();
  rmSync(reports, { recursive: true, force: true });
}
if (failed) console.error(`${failed} failed.`);
process.exit(failed ? 1 : 0);
