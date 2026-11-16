#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const ORIGIN = 'https://blyg.dormouse.sh';
const REPOSITORY = 'diffplug/dormouse';
const TITLE = /^# Dormouse (\d+\.\d+\.\d+)\n/;

function releaseVersion(markdown) {
  const version = TITLE.exec(markdown)?.[1];
  return version && markdown.includes(`https://github.com/${REPOSITORY}/releases/tag/v${version})`) ? version : undefined;
}

// Keep Markdown intact: nested bullets, links, and code are the release text.
export function changelogEntries(markdown) {
  const entries = new Map();
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const headings = [...normalized.matchAll(/^## (.+)$/gm)];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const match = /^\[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(heading[1]);
    if (!match) continue;
    const [, version, date] = match;
    if (entries.has(version)) throw new Error(`Duplicate changelog version ${version}`);
    const body = normalized.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim();
    if (!body) throw new Error(`Empty changelog for ${version}`);
    entries.set(version, { version, date, body });
  }
  return entries;
}

export function publicationPlan(markdown, releases, version) {
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  const entries = changelogEntries(markdown);
  const plan = releases
    .filter(release => !release.draft && !release.prerelease && release.published_at && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .filter(release => version === undefined || release.tag_name === `v${version}`)
    .sort((a, b) => a.published_at.localeCompare(b.published_at))
    .flatMap(release => {
      const entry = entries.get(release.tag_name.slice(1));
      if (!entry) throw new Error(`Published ${release.tag_name} is missing from CHANGELOG.md`);
      const { version, date, body } = entry;
      return [{ version, contentMd: `# Dormouse ${version}\n\nReleased ${date}. [Download](https://github.com/${REPOSITORY}/releases/tag/v${version}).\n\n${body}\n\n---\n\n🔌 VS Code extension only · 🖥️ Desktop app only · Unmarked changes apply to both.\n` }];
    });
  if (version !== undefined && !plan.length) throw new Error(`No stable public GitHub release for ${version}`);
  return plan;
}

export function apiClient(token, fetcher = fetch) {
  if (!token?.trim()) throw new Error('BLYG_API_TOKEN is missing. Run python3 deploy/blyg/authorize.py to renew publishing access.');
  return async (method, path, body) => {
    // Callers construct only fixed API paths and validated item IDs. Never follow
    // redirects with the publishing credential, including same-origin redirects.
    if (!path.startsWith('/items')) throw new Error('Publisher API path rejected');
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(`${ORIGIN}/api${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // 429 is a definite refusal, safe to retry. A timeout or 5xx on a mutation
      // is ambiguous: fail and let the next run reconcile the stored draft/version.
      if (response.status === 429 && attempt < 3) {
        const seconds = Number(response.headers.get('retry-after') ?? 60);
        await delay(Math.min(60, Math.max(1, Number.isFinite(seconds) ? seconds : 60)) * 1000);
        continue;
      }
      if (!response.ok) {
        const advice = response.status === 401 ? ' Renew the 30-day publishing token with deploy/blyg/authorize.py.' : '';
        throw new Error(`Studio ${method} ${path}: HTTP ${response.status}.${advice}`);
      }
      return response.json();
    }
  };
}

function itemPath(item) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(item.id)) throw new Error('Invalid Studio item ID');
  return `/items/${item.id}`;
}

export async function syncPublications(plan, api, { dryRun = false, log = console.log } = {}) {
  // Each write consumes the revision returned by the previous read or write. A
  // conflict stops the run: never retry against text we have not reconciled.
  function expected(item) {
    if (!Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Invalid Studio item revision');
    return { expectedRevision: item.revision };
  }
  async function pin(item) {
    const result = await api('PUT', `${itemPath(item)}/versions/${item.version}/pin`, expected(item));
    return { ...item, revision: result.revision };
  }
  const byVersion = new Map();
  const cursors = new Set();
  for (let cursor; ; ) {
    const page = await api('GET', `/items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const next = page.page?.nextCursor;
    if (!Array.isArray(page.items) || !(next === null || (typeof next === 'string' && next.length > 0))) {
      throw new Error('Invalid Studio item listing');
    }
    for (const item of page.items) {
      if (typeof item.contentMd !== 'string') throw new Error('Invalid Studio item content');
      const version = releaseVersion(item.contentMd);
      if (!version) continue;
      if (byVersion.has(version)) throw new Error(`Multiple Studio items claim Dormouse ${version}; refusing to publish`);
      byVersion.set(version, item);
    }
    if (next === null) break;
    if (!page.items.length || cursors.has(next)) throw new Error('Studio pagination did not advance');
    cursors.add(next);
    cursor = next;
  }
  for (const entry of plan) {
    let item = byVersion.get(entry.version);
    if (item) {
      item = await api('GET', itemPath(item));
      if (item.status === 'withdrawn') throw new Error(`Dormouse ${entry.version} was withdrawn; refusing to restore it automatically`);
      if (item.kind !== 'thread') throw new Error(`Dormouse ${entry.version} is not a thread`);
      // An interrupted PATCH leaves our exact intended working copy. Resume it;
      // anything else dirty may be a human's work and must not be overwritten.
      if ((item.dirty || item.version === 0) && item.contentMd !== entry.contentMd) {
        throw new Error(`Dormouse ${entry.version} has conflicting draft edits; resolve them in Studio first`);
      }
      if (item.version > 0 && !item.dirty && item.contentMd === entry.contentMd) {
        if (!dryRun) await pin(item);
        log(`Unchanged Dormouse ${entry.version}: ${ORIGIN}/t/${item.id}/`);
        continue;
      }
    }
    if (dryRun) {
      log(`${item ? 'Update' : 'Create'} Dormouse ${entry.version}`);
      continue;
    }
    if (!item) {
      item = await api('POST', '/items', { kind: 'thread', contentMd: entry.contentMd });
      byVersion.set(entry.version, item);
    } else {
      // Preserve the last live text before publishing a correction, even when a
      // previous run reached publish but failed before its pin request completed.
      if (item.version > 0) item = await pin(item);
      if (item.contentMd !== entry.contentMd) {
        item = await api('PATCH', itemPath(item), { contentMd: entry.contentMd, ...expected(item) });
      }
    }
    const result = await api('POST', `${itemPath(item)}/publish`, {
      ...expected(item),
      note: item.version > 0 ? 'Updated from the Dormouse changelog.' : 'Published from the Dormouse changelog.',
    });
    if (!Number.isInteger(result.version) || result.version < 1) throw new Error('Invalid published version');
    await pin({ ...item, ...result });
    log(`Published Dormouse ${entry.version} (revision ${result.version}): ${ORIGIN}/t/${item.id}/`);
  }
}

async function githubReleases() {
  const releases = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dormouse-blyg-publisher',
        ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    });
    if (!response.ok) throw new Error(`GitHub release listing: HTTP ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    'dry-run': { type: 'boolean' }, plan: { type: 'boolean' }, version: { type: 'string' },
  } });
  const markdown = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const plan = publicationPlan(markdown, await githubReleases(), values.version);
  if (values.plan) {
    for (const entry of plan) console.log(`Eligible: Dormouse ${entry.version} (${entry.contentMd.length} characters)`);
    return;
  }
  await syncPublications(plan, apiClient(process.env.BLYG_API_TOKEN), { dryRun: values['dry-run'] });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
