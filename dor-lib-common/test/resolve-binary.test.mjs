import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserBinaryIsMissing, resolveBinaryPath } from '../dist/index.js';

// Every relative answer here would exist: the test runs from a folder that
// holds the planted file, as a host or `dor` runs from the folder the user
// opened. The walk's Windows branch builds `${dir}\${name}`, which off Windows
// is one file name with a backslash in it, so a file planted under that exact
// spelling makes both branches reachable on either platform.
async function inPlantedFolder(run) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dor-resolve-')));
  const previous = process.cwd();
  try {
    process.chdir(root);
    await run(root);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
}

async function plant(file) {
  await writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
}

test('a relative PATH entry is skipped on POSIX, whatever the cwd holds', async () => {
  await inPlantedFolder(async (root) => {
    await mkdir(path.join(root, 'bin'));
    await mkdir(path.join(root, 'real'));
    await plant(path.join(root, 'bin', 'git'));
    await plant(path.join(root, 'git'));
    await plant(path.join(root, 'real', 'git'));
    const env = { PATH: ['bin', '.', path.join(root, 'real')].join(':') };
    assert.equal(resolveBinaryPath('git', env, false), path.join(root, 'real', 'git'));
    assert.equal(resolveBinaryPath('git', { PATH: 'bin:.' }, false), undefined);
  });
});

test('a relative PATH entry is skipped on Windows, whatever the cwd holds', async () => {
  await inPlantedFolder(async (root) => {
    const real = path.join(root, 'real');
    await mkdir(real);
    await mkdir(path.join(root, 'bin'));
    await plant(path.join(root, '.\\git.EXE'));
    await plant(path.join(root, 'bin\\git.EXE'));
    await plant(`${real}\\git.EXE`);
    const env = { Path: `.;bin;${real}`, PATHEXT: '.EXE' };
    assert.equal(resolveBinaryPath('git', env, true), `${real}\\git.EXE`);
    assert.equal(resolveBinaryPath('git', { Path: '.;bin', PATHEXT: '.EXE' }, true), undefined);
  });
});

test('an explicit path comes back only when absolute', async () => {
  await inPlantedFolder(async (root) => {
    await plant(path.join(root, 'agent-browser'));
    await plant(path.join(root, 'agent-browser.cmd'));
    assert.equal(resolveBinaryPath('./agent-browser', {}, false), undefined);
    assert.equal(resolveBinaryPath('.\\agent-browser.cmd', {}, true), undefined);
    assert.equal(resolveBinaryPath('./agent-browser.cmd', {}, true), undefined);
    assert.equal(resolveBinaryPath('/opt/custom/agent-browser', {}, false), '/opt/custom/agent-browser');
    assert.equal(resolveBinaryPath('C:\\tools\\agent-browser.cmd', {}, true), 'C:\\tools\\agent-browser.cmd');
  });
});

test('a relative explicit path is a missing install even when the cwd holds it', async () => {
  await inPlantedFolder(async (root) => {
    await plant(path.join(root, 'agent-browser'));
    const isWindows = process.platform === 'win32';
    const binary = isWindows ? '.\\agent-browser' : './agent-browser';
    assert.equal(browserBinaryIsMissing(binary, {}, resolveBinaryPath(binary, {}, isWindows), isWindows), true);
    const absolute = path.join(root, 'agent-browser');
    assert.equal(browserBinaryIsMissing(absolute, {}, resolveBinaryPath(absolute, {}, isWindows), isWindows), false);
  });
});
