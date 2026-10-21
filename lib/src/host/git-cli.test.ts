import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runGit } from './git-cli';
import { lookupGitDir } from './git-info';
import { resolveUpstreamUrl } from './git-upstream';

// A repository's own `.git/config` names the program; the hook is a shell script.
let base: string;
let repo: string;
let marker: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'git-cli-')));
  repo = join(base, 'repo');
  marker = join(base, 'fsmonitor-ran');
  const hook = join(base, 'fsmonitor.sh');
  writeFileSync(hook, `#!/bin/sh\necho > '${marker}'\n`);
  chmodSync(hook, 0o755);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' });
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'a');
  git('remote', 'add', 'origin', 'https://github.com/o/r.git');
  git('config', 'core.fsmonitor', hook);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

it.skipIf(process.platform === 'win32')('never runs a repository-configured fsmonitor, even for a subcommand that reads the index', async () => {
  expect(await runGit(repo, ['ls-files'])).toBe('a.txt');
  expect(await lookupGitDir(repo)).toMatchObject({ repo: 'r' });
  expect(await resolveUpstreamUrl(repo)).toBe('https://github.com/o/r');
  expect(existsSync(marker)).toBe(false);
});

it.skipIf(process.platform === 'win32')('runs git no higher than the repository it checked, past a decoy git would skip', async () => {
  // `outer/.git` names `//<base>/repo/.git`, which POSIX reads as the real
  // repository. `outer/inner/.git` passes the check but not git's own, so
  // git would move up to `outer` and open what its `.git` names.
  const outer = join(base, 'outer');
  const inner = join(outer, 'inner');
  mkdirSync(join(inner, '.git', 'objects'), { recursive: true });
  mkdirSync(join(inner, '.git', 'refs'));
  writeFileSync(join(inner, '.git', 'HEAD'), 'not a ref\n');
  writeFileSync(join(outer, '.git'), `gitdir: /${join(repo, '.git')}\n`);
  expect(execFileSync('git', ['-C', inner, 'config', '--get', 'remote.origin.url']).toString().trim()).toBe('https://github.com/o/r.git');
  expect(await runGit(inner, ['config', '--get', 'remote.origin.url'])).toBeNull();
  expect(existsSync(marker)).toBe(false);
});
