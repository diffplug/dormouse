// The Pages Worker in public/_worker.js: what `/ingest` forwards to PostHog,
// and that every other path stays the static site.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { upstreamUrl } from '../public/_worker.js';

afterEach(() => vi.unstubAllGlobals());

describe('upstreamUrl', () => {
  it('maps /ingest to the ingestion host and its assets to the assets host, query kept', () => {
    expect(upstreamUrl('https://dormouse.sh/ingest/e/?ip=0&ver=1')).toBe('https://us.i.posthog.com/e/?ip=0&ver=1');
    expect(upstreamUrl('https://dormouse.sh/ingest/static/array.js')).toBe('https://us-assets.i.posthog.com/static/array.js');
    expect(upstreamUrl('https://dormouse.sh/ingest/array/phc_x/config')).toBe('https://us-assets.i.posthog.com/array/phc_x/config');
    expect(upstreamUrl('https://dormouse.sh/ingestion')).toBeNull();
    expect(upstreamUrl('https://dormouse.sh/hosted/')).toBeNull();
  });
});

describe('the Worker', () => {
  it('forwards the body with the visitor address, and drops cookies and authorization', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    const request = new Request('https://dormouse.sh/ingest/e/', {
      method: 'POST',
      body: 'batch',
      headers: { cookie: 'a=b', authorization: 'Bearer x', 'CF-Connecting-IP': '203.0.113.7', 'content-type': 'text/plain' },
    });
    await worker.fetch(request, { ASSETS: { fetch: vi.fn() } });
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/e/');
    expect(init.method).toBe('POST');
    expect(await new Response(init.body).text()).toBe('batch');
    expect(init.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(init.headers.get('cookie')).toBeNull();
    expect(init.headers.get('authorization')).toBeNull();
    expect(init.headers.get('content-type')).toBe('text/plain');
  });

  it('hands any other path to the static site', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const assets = vi.fn(async () => new Response('page'));
    const request = new Request('https://dormouse.sh/hosted/');
    await worker.fetch(request, { ASSETS: { fetch: assets } });
    expect(assets).toHaveBeenCalledWith(request);
    expect(upstream).not.toHaveBeenCalled();
  });
});
