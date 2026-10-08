#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

export function publicationPlan(markdown, releases) {
  const entries = changelogEntries(markdown);
  return releases
    .filter(release => !release.draft && !release.prerelease && release.published_at && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((a, b) => a.published_at.localeCompare(b.published_at))
    .flatMap(release => {
      const entry = entries.get(release.tag_name.slice(1));
      if (!entry) throw new Error(`Published ${release.tag_name} is missing from CHANGELOG.md`);
      const { version, date, body } = entry;
      return [{ version, content_md: `# Dormouse ${version}\n\nReleased ${date}. [Download and release assets](https://github.com/${REPOSITORY}/releases/tag/v${version}).\n\n${body}\n\n---\n\n🔌 VS Code extension only · 🖥️ Desktop app only · Unmarked changes apply to both.\n` }];
    });
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
  const byVersion = new Map();
  for (let offset = 0; ; ) {
    const page = await api('GET', `/items?limit=100&offset=${offset}`);
    if (!Array.isArray(page.items) || !Number.isInteger(page.total)) throw new Error('Invalid Studio item listing');
    for (const item of page.items) {
      const version = releaseVersion(item.content_md);
      if (!version) continue;
      if (byVersion.has(version)) throw new Error(`Multiple Studio items claim Dormouse ${version}; refusing to publish`);
      byVersion.set(version, item);
    }
    offset += page.items.length;
    if (offset >= page.total) break;
    if (!page.items.length) throw new Error('Studio pagination stopped before total');
  }
  for (const entry of plan) {
    let item = byVersion.get(entry.version);
    if (item) {
      item = await api('GET', itemPath(item));
      if (item.status === 'withdrawn' || item.kind === 'withdrawn') throw new Error(`Dormouse ${entry.version} was withdrawn; refusing to restore it automatically`);
      if (item.kind !== 'thread') throw new Error(`Dormouse ${entry.version} is not a thread`);
      // An interrupted PATCH leaves our exact intended working copy. Resume it;
      // anything else dirty may be a human's work and must not be overwritten.
      if ((item.dirty || item.version === 0) && item.content_md !== entry.content_md) {
        throw new Error(`Dormouse ${entry.version} has conflicting draft edits; resolve them in Studio first`);
      }
      if (item.version > 0 && !item.dirty && item.content_md === entry.content_md) {
        if (!dryRun) await api('PUT', `${itemPath(item)}/versions/${item.version}/pin`);
        log(`Unchanged Dormouse ${entry.version}: ${ORIGIN}/t/${item.id}/`);
        continue;
      }
    }
    if (dryRun) {
      log(`${item ? 'Update' : 'Create'} Dormouse ${entry.version}`);
      continue;
    }
    if (!item) {
      item = await api('POST', '/items', { kind: 'thread', content_md: entry.content_md });
      byVersion.set(entry.version, item);
    } else {
      // Preserve the last live text before publishing a correction, even when a
      // previous run reached publish but failed before its pin request completed.
      if (item.version > 0) await api('PUT', `${itemPath(item)}/versions/${item.version}/pin`);
      if (item.content_md !== entry.content_md) {
        await api('PATCH', itemPath(item), { content_md: entry.content_md });
      }
    }
    const result = await api('POST', `${itemPath(item)}/publish`, {
      note: item.version > 0 ? 'Updated from the Dormouse changelog.' : 'Published from the Dormouse changelog.',
    });
    if (!Number.isInteger(result.version) || result.version < 1) throw new Error('Invalid published version');
    await api('PUT', `${itemPath(item)}/versions/${result.version}/pin`);
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
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--plan'].includes(arg))) throw new Error('Usage: node scripts/publish-blyg.mjs [--plan | --dry-run]');
  const markdown = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const plan = publicationPlan(markdown, await githubReleases());
  if (args.includes('--plan')) {
    for (const entry of plan) console.log(`Eligible: Dormouse ${entry.version} (${entry.content_md.length} characters)`);
    return;
  }
  await syncPublications(plan, apiClient(process.env.BLYG_API_TOKEN), { dryRun: args.includes('--dry-run') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
