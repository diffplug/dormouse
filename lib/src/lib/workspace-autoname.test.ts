import { describe, expect, it } from 'vitest';
import { deriveWorkspaceAutoName, type AutoNameVote } from './workspace-autoname';
import type { CwdState } from './terminal-state';

function cwd(path: string, host?: string): CwdState {
  return { path, pathKind: 'posix', isRemote: !!host, source: 'osc633', updatedAt: 0, ...(host ? { host, scheme: 'file' } : {}) };
}

const folder = (path: string, host?: string): AutoNameVote => ({ cwd: cwd(path, host), git: null });
const repo = (path: string, name: string, branch: string): AutoNameVote => ({ cwd: cwd(path), git: { repo: name, branch } });

describe('deriveWorkspaceAutoName', () => {
  it('keeps the current name when no terminal has reported a directory', () => {
    expect(deriveWorkspaceAutoName([], 'Workspace 1')).toBeNull();
  });

  it('names a Workspace outside any repository after its most common directory', () => {
    expect(deriveWorkspaceAutoName([folder('/tmp'), folder('/var/log'), folder('/tmp')], 'Workspace 1')).toBe('tmp');
  });

  it('counts directories by identity, so unrelated folders sharing a basename never pool', () => {
    expect(deriveWorkspaceAutoName([folder('/a/src'), folder('/b/src'), folder('/c/lib')], 'x')).toBe('src');
    expect(deriveWorkspaceAutoName([folder('/a/src'), folder('/b/src'), folder('/c/lib'), folder('/c/lib')], 'x')).toBe('lib');
  });

  it('lets a single repository outvote every directory outside one', () => {
    const votes = [folder('/tmp'), folder('/tmp'), folder('/tmp'), repo('/p/dormouse', 'dormouse', 'main')];
    expect(deriveWorkspaceAutoName(votes, 'tmp')).toBe('dormouse @ main');
  });

  it('picks the most common repository and branch', () => {
    const votes = [repo('/p/a', 'a', 'main'), repo('/p/b', 'b', 'dev'), repo('/p/b/src', 'b', 'dev')];
    expect(deriveWorkspaceAutoName(votes, 'a @ main')).toBe('b @ dev');
  });

  it('keeps the incumbent on a tie it is part of', () => {
    const votes = [repo('/p/a', 'a', 'main'), repo('/p/b', 'b', 'dev')];
    expect(deriveWorkspaceAutoName(votes, 'b @ dev')).toBe('b @ dev');
    expect(deriveWorkspaceAutoName([folder('/x'), folder('/y')], 'y')).toBe('y');
  });

  it('breaks a tie the incumbent is not part of by member order', () => {
    const votes = [repo('/p/a', 'a', 'main'), repo('/p/b', 'b', 'dev')];
    expect(deriveWorkspaceAutoName(votes, 'Workspace 3')).toBe('a @ main');
  });

  it('labels home `~`, but only on this machine', () => {
    expect(deriveWorkspaceAutoName([folder('/Users/me')], 'x', '/Users/me')).toBe('~');
    expect(deriveWorkspaceAutoName([folder('/Users/me', 'prod-box')], 'x', '/Users/me')).toBe('prod-box:me');
  });

  it('labels a remote directory with its host', () => {
    expect(deriveWorkspaceAutoName([folder('/srv/app', 'prod-box')], 'x')).toBe('prod-box:app');
  });
});
