import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { changedSince, lastPass, report } from './red-team-since.mjs';

test('lastPass takes the latest completed closure, not the latest created', () => {
  assert.deepEqual(lastPass([
    { number: 3, closedAt: '2026-11-03T00:00:00Z', stateReason: 'COMPLETED' },
    { number: 2, closedAt: '2026-12-01T00:00:00Z', stateReason: 'COMPLETED' },
    { number: 4, closedAt: '2026-12-20T00:00:00Z', stateReason: 'NOT_PLANNED' },
    { number: 5, closedAt: null, stateReason: '' },
  ]), { number: 2, closedAt: '2026-12-01T00:00:00Z' });
  assert.equal(lastPass([]), null);
});

test('report warns with the count, says so when nothing changed, and when there is no pass', () => {
  const pass = { number: 1341, closedAt: '2026-10-25T17:00:00Z' };
  const changed = report({ pass, commits: [{ sha: 'a'.repeat(40), subject: 'Change the relay' }, { sha: 'b'.repeat(40), subject: 'Change hosted' }] });
  assert.equal(changed.warning, 'Remote control or Hosted changed since the last red-team pass, #1341 closed 2026-10-25: 2 commits.');
  assert.match(changed.summary, /aaaaaaaaa Change the relay/);
  assert.equal(report({ pass, commits: [] }).warning, null);
  assert.match(report({ pass: null }).warning, /No closed `red-team` issue yet/);
});

test('changedSince counts first-parent commits after the date that touch a surface', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'red-team-since-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, date) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const commit = (path, subject, date) => {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), subject);
    git(['add', '-A'], date);
    git(['commit', '-q', '-m', subject], date);
  };
  git(['init', '-q', '-b', 'main'], '2026-10-01T00:00:00Z');
  commit('relay/a.ts', 'before the pass', '2026-10-10T00:00:00Z');
  // A branch merged after the pass counts once, at its merge, not once per branch commit.
  git(['switch', '-q', '-c', 'side'], '2026-10-11T00:00:00Z');
  commit('hosted/b.ts', 'branch commit', '2026-10-11T00:00:00Z');
  commit('hosted/b.ts', 'branch fix', '2026-10-21T12:00:00Z');
  git(['switch', '-q', 'main'], '2026-10-12T00:00:00Z');
  commit('lib/src/components/x.ts', 'unrelated', '2026-10-21T00:00:00Z');
  commit('vscode-ext/src/burrow-host.ts', 'burrow host', '2026-10-22T00:00:00Z');
  git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side'], '2026-10-23T00:00:00Z');

  const subjects = changedSince({ since: '2026-10-20T00:00:00Z', cwd: dir }).map((c) => c.subject);
  assert.deepEqual(subjects, ['Merge side', 'burrow host']);
});
