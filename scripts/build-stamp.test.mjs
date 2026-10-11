import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeBuildStamp } from './build-stamp.mjs';

const HEAD = 'a'.repeat(40);
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-01\n\n## [1.1.0]\n';
const RELEASE_REF = 'diffplug/dormouse/.github/workflows/release.yml@refs/tags/v1.2.0';
const RELEASE_ENV = { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: RELEASE_REF };

function fakeGit({ head = HEAD, tagCommit = HEAD, count = '0', status = '' } = {}) {
  return (args) => {
    switch (args.join(' ')) {
      case 'rev-parse HEAD': return head;
      case 'rev-parse --short=8 HEAD': return head?.slice(0, 8) ?? null;
      case 'rev-list --count v1.2.0..HEAD': return count;
      case 'status --porcelain': return status;
      case 'rev-parse --verify --quiet v1.2.0^{commit}': return tagCommit;
      default: return null;
    }
  };
}

const stamp = (env, git = fakeGit(), changelog = CHANGELOG) => computeBuildStamp({ env, git, changelog });

test('official only from release.yml at the version tag, at its commit, clean', () => {
  assert.deepEqual(stamp(RELEASE_ENV), {
    version: '1.2.0', commit: 'aaaaaaaa', commitsSinceVersion: 0, dirty: false, official: true,
  });
});

test('the same tree outside the release workflow is unofficial', () => {
  assert.equal(stamp({}).official, false);
  assert.equal(stamp({ GITHUB_WORKFLOW_REF: RELEASE_REF }).official, false, 'GITHUB_ACTIONS unset');
  assert.equal(stamp({ GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: 'diffplug/dormouse/.github/workflows/ci.yml@refs/heads/main' }).official, false);
  assert.equal(stamp({ GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: 'someone/dormouse/.github/workflows/release.yml@refs/tags/v1.2.0' }).official, false, 'a fork');
});

test('a release run that would be unofficial fails, naming why', () => {
  assert.throws(() => stamp(RELEASE_ENV, fakeGit({ status: '?? stray.txt' })), /dirty[\s\S]*stray\.txt/);
  assert.throws(() => stamp(RELEASE_ENV, fakeGit({ tagCommit: 'b'.repeat(40) })), /v1\.2\.0 does not resolve to HEAD/);
  assert.throws(() => stamp(RELEASE_ENV, fakeGit({ tagCommit: null })), /does not resolve to HEAD/);
  assert.throws(
    () => stamp({ GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: RELEASE_REF.replace('1.2.0', '1.3.0') }),
    /not release\.yml at v1\.2\.0/,
  );
});

test('a tag that cannot be resolved leaves the count unknown, not zero', () => {
  assert.equal(stamp({}, fakeGit({ count: null })).commitsSinceVersion, null);
  assert.equal(stamp({}, fakeGit({ count: '14' })).commitsSinceVersion, 14);
});

test('a failing git status reads as dirty', () => {
  assert.equal(stamp({}, fakeGit({ status: null })).dirty, true);
});

test('no CHANGELOG version reads as 0.0.0', () => {
  assert.equal(stamp({}, fakeGit(), '# Changelog\n').version, '0.0.0');
});
