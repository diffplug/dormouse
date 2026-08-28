import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';

import { getWebviewHtml } from '../src/webview-html';
import { launchChromium } from './launch-chromium';

/**
 * Does the built webview actually boot?
 *
 * Every other test in this directory checks a transform in isolation, including
 * `webview-html.test.ts`, which pins the CSP contract against a *fixture* of
 * Vite's output. A fixture cannot notice that Vite started emitting a shape
 * nobody anticipated — which is exactly how the webview shipped blank for
 * thirteen days (`docs/specs/vscode.md` → "CSP policy"). Only running the real
 * bundle under the real policy in a real engine closes that gap, because CSP
 * enforcement is the thing under test and no amount of string inspection
 * substitutes for it. jsdom is not an option: it does not enforce CSP at all.
 *
 * Deliberately shallow. It asserts the app mounts and the policy blocked
 * nothing — not what the UI looks like, which is Storybook's and Chromatic's
 * job.
 */

const MEDIA_PATH = new URL('../media', import.meta.url).pathname;

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

/**
 * Serve `media/` the way the VS Code webview does — the document at `/`, assets
 * beside it. The origin stands in for `webview.cspSource`, so the CSP under test
 * has the same *structure* as the real one: scripts pass on the nonce and
 * `'strict-dynamic'` alone, never on a host source.
 */
function serveMedia(document: { html: string }): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(document.html);
      return;
    }
    // `normalize` collapses any `..` before the prefix check, so a traversal
    // cannot escape media/ even though this only ever serves our own build.
    const file = normalize(join(MEDIA_PATH, path));
    if (!file.startsWith(MEDIA_PATH) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

let browser: Browser;
let server: Server;
let origin: string;

/** Everything the page reported that should not have happened. */
const cspViolations: string[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const requested: string[] = [];
const failedRequests: string[] = [];
let rootChildCount = 0;

beforeAll(async () => {
  expect(
    existsSync(join(MEDIA_PATH, 'index.html')),
    'vscode-ext/media/index.html is missing — run `pnpm --filter dormouse build:frontend` first',
  ).toBe(true);

  // The CSP embeds the origin, and the origin is only known once the server has
  // a port — so the server reads its body from a box we fill in after binding.
  // Restarting to bake the URLs in would hand out a different port and point the
  // document at a closed one.
  const document = { html: '' };
  ({ server, origin } = await serveMedia(document));

  const webview = {
    cspSource: origin,
    asWebviewUri: () => origin,
  } as never;
  document.html = getWebviewHtml(webview, MEDIA_PATH).html;

  browser = await launchChromium();
  const page = await browser.newPage();

  page.on('requestfinished', (req) => requested.push(req.url()));
  page.on('requestfailed', (req) => {
    requested.push(req.url());
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  // The signal this test exists for. A blocked script fires this and otherwise
  // leaves no trace outside the webview console.
  await page.addInitScript(() => {
    (globalThis as unknown as { __csp: string[] }).__csp = [];
    globalThis.addEventListener('securitypolicyviolation', (e) => {
      (globalThis as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} blocked ${e.blockedURI}`,
      );
    });
    // Without this the bundle takes its non-VS Code path: `FakePtyAdapter`, and
    // `enableRemoteHost` false, so the lazy `RemotePairingModalHost` chunk is
    // never imported — and a lazy `import()` is half of what broke here.
    (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
      postMessage: () => {},
      getState: () => undefined,
      setState: () => {},
    });
  });

  await page.goto(`${origin}/`, { waitUntil: 'load' });
  // The app mounts behind `resumeOrRestore`, which self-caps at 500ms when no
  // host answers. Poll rather than sleep so a fast boot does not pay for it.
  await page
    .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, {
      timeout: 15_000,
    })
    .catch(() => {});

  rootChildCount = await page.evaluate(
    () => document.getElementById('root')?.childElementCount ?? 0,
  );
  cspViolations.push(
    ...(await page.evaluate(() => (globalThis as unknown as { __csp: string[] }).__csp ?? [])),
  );
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe('the built webview boots under its own CSP', () => {
  it('violates no CSP directive', () => {
    // Includes the ones that are survivable on their own: a blocked preload
    // still means a tag the policy does not cover, and the next bundler change
    // could make it fatal.
    expect(cspViolations).toEqual([]);
  });

  it('mounts the app into #root', () => {
    expect(rootChildCount).toBeGreaterThan(0);
  });

  it('actually exercised the lazy-import path', () => {
    // Without this the suite could pass while never fetching a dynamically
    // imported chunk — and a lazy `import()` is half of what broke here. Assert
    // the coverage rather than trusting the boot path to keep providing it.
    expect(
      requested.filter((u) => /RemotePairingModalHost-/.test(u)),
      `no lazy chunk was requested; requests were:\n${requested.join('\n')}`,
    ).not.toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  it('throws nothing while booting', () => {
    expect(pageErrors).toEqual([]);
    // Failing to fetch a chunk surfaces here rather than as a violation, since
    // React turns it into a caught render error.
    expect(consoleErrors.filter((t) => /import|chunk|Content Security/i.test(t))).toEqual([]);
  });
});
