import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiClient, changelogEntries, publicationPlan, syncPublications } from './publish-blyg.mjs';

const markdown = '# Changelog\n\n## [Unreleased]\nSecret future\n\n## [1.0.0] - 2026-01-01\n### Added\n- Feature\n  - Nested [link](https://example.com)\n\n## [0.9.0] - 2025-12-01\n- Older\n';
const releases = [{ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false }];
const plan = publicationPlan(markdown, releases);
const id = '0123456789ABCDEFGHJKMNPQRS';

function studio(seed = []) {
  const items = structuredClone(seed);
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/items?')) return { items: structuredClone(items), total: items.length };
    let item = items.find(item => path.startsWith(`/items/${item.id}`));
    if (method === 'GET') return structuredClone(item);
    if (method === 'POST' && path === '/items') {
      item = { id, kind: 'thread', status: 'draft', version: 0, dirty: true, ...body };
      items.push(item);
      return structuredClone(item);
    }
    if (method === 'PATCH') { Object.assign(item, body, { dirty: true }); return structuredClone(item); }
    if (path.endsWith('/publish')) {
      item.status = 'public'; item.version++; item.dirty = false;
      return { ok: true, version: item.version };
    }
    if (path.endsWith('/pin')) return { ok: true };
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { api, items, calls };
}
const options = { log: () => {} };
const published = () => ({ id, kind: 'thread', status: 'public', version: 1, dirty: false, content_md: plan[0].content_md });

test('eligible releases exclude drafts, prereleases and unreleased; preserve Markdown', () => {
  const result = publicationPlan(markdown, [...releases, { ...releases[0], tag_name: 'v0.9.0', draft: true }, { ...releases[0], tag_name: 'v0.9.0', prerelease: true }]);
  assert.equal(result.length, 1);
  assert.match(result[0].content_md, /  - Nested \[link\]/);
  assert.doesNotMatch(result[0].content_md, /Secret future|Older/);
  assert.throws(() => publicationPlan(markdown, [{ ...releases[0], tag_name: 'v2.0.0' }]), /missing/);
  assert.throws(() => changelogEntries(markdown + '\n## [1.0.0] - 2026-01-01\n- Duplicate'), /Duplicate/);
});

test('first run creates and pins; rerun does not create or publish a new revision', async () => {
  const s = studio();
  await syncPublications(plan, s.api, options);
  await syncPublications(plan, s.api, options);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].version, 1);
  assert.equal(s.calls.filter(call => call.path.endsWith('/publish')).length, 1);
  assert.equal(s.calls.filter(call => call.path.endsWith('/pin')).length, 2);
});

test('correction pins prior revision before update and new revision after publish', async () => {
  const s = studio([published()]);
  await syncPublications([{ ...plan[0], content_md: plan[0].content_md.replace('- Feature', '- Corrected feature') }], s.api, options);
  assert.deepEqual(s.calls.filter(call => call.method !== 'GET').map(call => [call.method, call.path]), [
    ['PUT', `/items/${id}/versions/1/pin`], ['PATCH', `/items/${id}`], ['POST', `/items/${id}/publish`], ['PUT', `/items/${id}/versions/2/pin`],
  ]);
});

for (const stage of ['create', 'patch', 'publish']) {
  test(`recovers when ${stage} succeeds but response is lost`, async () => {
    const old = { ...published(), content_md: plan[0].content_md.replace('- Feature', '- Previous feature') };
    const s = studio(stage === 'create' ? [] : [old]);
    const api = async (method, path, body) => {
      const result = await s.api(method, path, body);
      if ((stage === 'create' && method === 'POST' && path === '/items') || (stage === 'patch' && method === 'PATCH') || (stage === 'publish' && path.endsWith('/publish'))) {
        throw new Error('Connection lost after mutation');
      }
      return result;
    };
    await assert.rejects(syncPublications(plan, api, options), /Connection lost/);
    await syncPublications(plan, s.api, options);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].version, stage === 'create' ? 1 : 2);
    assert.equal(s.items[0].dirty, false);
  });
}

test('refuses conflicting drafts, withdrawn entries, and duplicate ownership', async () => {
  for (const items of [
    [{ ...published(), dirty: true, content_md: plan[0].content_md + 'Human draft' }],
    [{ ...published(), kind: 'withdrawn' }],
    [published(), { ...published(), id: '1123456789ABCDEFGHJKMNPQRS' }],
  ]) {
    const s = studio(items);
    await assert.rejects(syncPublications(plan, s.api, options));
    assert.ok(s.calls.every(call => call.method === 'GET'));
  }
});

test('dry run makes no writes, including pins', async () => {
  for (const items of [[], [published()]]) {
    const s = studio(items);
    await syncPublications(plan, s.api, { ...options, dryRun: true });
    assert.ok(s.calls.every(call => call.method === 'GET'));
  }
});

test('HTTP client refuses redirects, does not repeat ambiguous writes, and diagnoses expiry', async () => {
  let count = 0;
  const api = apiClient('test-token', async (url, init) => {
    count++;
    assert.equal(init.redirect, 'error');
    assert.ok(url.startsWith('https://blyg.dormouse.sh/api/'));
    return new Response('{}', { status: 503 });
  });
  await assert.rejects(api('POST', '/items', {}), /503/);
  assert.equal(count, 1);
  await assert.rejects(apiClient('test-token', async () => new Response('{}', { status: 401 }))('GET', '/items'), /Renew the 30-day/);
});
