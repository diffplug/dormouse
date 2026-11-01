// @vitest-environment node
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlaywrightInstall } from './playwright-install';

// Each layout is what npm, pnpm, or cmd-shim writes for `@playwright/cli`, whose
// `bin` maps `playwright-cli` to `playwright-cli.js` at the package root.

let root: string;
const loaded = globalThis as { plantedLoaded?: string[] };

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dor-pw-install-')));
  loaded.plantedLoaded = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(file: string, text: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function link(target: string, at: string): void {
  mkdirSync(path.dirname(at), { recursive: true });
  // Windows package managers use directory junctions without symlink privileges.
  // File links stay real symlinks for the POSIX launcher layouts.
  const directory = statSync(path.resolve(path.dirname(at), target)).isDirectory();
  symlinkSync(target, at, process.platform === 'win32' && directory ? 'junction' : undefined);
}

function cliPackage(dir: string, bin = 'playwright-cli.js'): void {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: '@playwright/cli', bin: { 'playwright-cli': bin } }));
  write(path.join(dir, bin), '#!/usr/bin/env node\n');
}

/** A `playwright-core` stand-in; a planted one records that it ran. */
function core(dir: string, planted = false): void {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'playwright-core', main: 'index.js' }));
  const record = planted ? `(globalThis.plantedLoaded ??= []).push(${JSON.stringify(dir)});\n` : '';
  write(path.join(dir, 'index.js'), `${record}module.exports = { chromium: { connect() {} } };\n`);
}

/** A planted CLI and client in `dir`'s node_modules. */
function plant(dir: string): void {
  const modules = path.join(dir, 'node_modules');
  cliPackage(path.join(modules, '@playwright', 'cli'));
  core(path.join(modules, '@playwright', 'cli', 'node_modules', 'playwright-core'), true);
  core(path.join(modules, 'playwright-core'), true);
  cliPackage(path.join(dir, '@playwright', 'cli'));
  core(path.join(dir, '@playwright', 'cli', 'node_modules', 'playwright-core'), true);
}

function resolve(launcher: string) {
  return resolvePlaywrightInstall(undefined, { DORMOUSE_PLAYWRIGHT_BIN: launcher });
}

const posixShim = (rel: string) => `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${rel}" "$@"
else
  exec node  "$basedir/${rel}" "$@"
fi
`;
const pnpmCmdShim = (rel: string) => `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\${rel.replaceAll('/', '\\')}" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\${rel.replaceAll('/', '\\')}" %*
)
`;
const pnpmPwshShim = (rel: string) => `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe"  "$basedir/${rel}" $args
} else {
  & "node$exe"  "$basedir/${rel}" $args
}
`;
const npmCmdShim = (rel: string) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel.replaceAll('/', '\\')}" %*
`;

/** pnpm's virtual store: the CLI and its linked `playwright-core` under `.pnpm`. */
function pnpmStore(modules: string): string {
  const cli = path.join(modules, '.pnpm', '@playwright+cli@0.1.19', 'node_modules', '@playwright', 'cli');
  cliPackage(cli);
  const coreReal = path.join(modules, '.pnpm', 'playwright-core@1.63.0', 'node_modules', 'playwright-core');
  core(coreReal);
  link(coreReal, path.join(modules, '.pnpm', '@playwright+cli@0.1.19', 'node_modules', 'playwright-core'));
  return cli;
}

test('npm global on macOS and Linux: a bin symlink into the package, playwright-core nested', () => {
  const cli = path.join(root, 'prefix', 'lib', 'node_modules', '@playwright', 'cli');
  cliPackage(cli);
  core(path.join(cli, 'node_modules', 'playwright-core'));
  const launcher = path.join(root, 'prefix', 'bin', 'playwright-cli');
  link('../lib/node_modules/@playwright/cli/playwright-cli.js', launcher);
  expect(resolve(launcher)).toMatchObject({ binary: launcher, libraryPath: path.join(cli, 'node_modules', 'playwright-core') });
});

test('npm local: a node_modules/.bin symlink, playwright-core hoisted beside the CLI', () => {
  const modules = path.join(root, 'project', 'node_modules');
  cliPackage(path.join(modules, '@playwright', 'cli'));
  core(path.join(modules, 'playwright-core'));
  link('../@playwright/cli/playwright-cli.js', path.join(modules, '.bin', 'playwright-cli'));
  expect(resolve(path.join(modules, '.bin', 'playwright-cli')).libraryPath).toBe(path.join(modules, 'playwright-core'));
});

test('a bin file in a subdirectory of the package', () => {
  const cli = path.join(root, 'prefix', 'lib', 'node_modules', '@playwright', 'cli');
  cliPackage(cli, 'bin/cli.js');
  core(path.join(cli, 'node_modules', 'playwright-core'));
  link(path.join(cli, 'bin', 'cli.js'), path.join(root, 'prefix', 'bin', 'playwright-cli'));
  expect(resolve(path.join(root, 'prefix', 'bin', 'playwright-cli')).libraryPath).toBe(path.join(cli, 'node_modules', 'playwright-core'));
});

test('a linked checkout: the bin symlink lands on the checkout\'s own bin file', () => {
  const checkout = path.join(root, 'src', 'playwright-cli');
  cliPackage(checkout);
  core(path.join(checkout, 'node_modules', 'playwright-core'));
  link(path.join(checkout, 'playwright-cli.js'), path.join(root, 'prefix', 'bin', 'playwright-cli'));
  expect(resolve(path.join(root, 'prefix', 'bin', 'playwright-cli')).libraryPath).toBe(path.join(checkout, 'node_modules', 'playwright-core'));
});

test('npm global on Windows: a cmd-shim beside node_modules', () => {
  const prefix = path.join(root, 'AppData', 'Roaming', 'npm');
  const cli = path.join(prefix, 'node_modules', '@playwright', 'cli');
  cliPackage(cli);
  core(path.join(cli, 'node_modules', 'playwright-core'));
  const launcher = write(path.join(prefix, 'playwright-cli.cmd'), npmCmdShim('node_modules/@playwright/cli/playwright-cli.js'));
  expect(resolve(launcher).libraryPath).toBe(path.join(cli, 'node_modules', 'playwright-core'));
});

test('pnpm local: a node_modules/.bin shell shim, the CLI linked from the virtual store', () => {
  const modules = path.join(root, 'project', 'node_modules');
  const cli = pnpmStore(modules);
  link(cli, path.join(modules, '@playwright', 'cli'));
  const launcher = write(path.join(modules, '.bin', 'playwright-cli'), posixShim('../.pnpm/@playwright+cli@0.1.19/node_modules/@playwright/cli/playwright-cli.js'));
  expect(resolve(launcher).libraryPath).toBe(path.join(modules, '.pnpm', 'playwright-core@1.63.0', 'node_modules', 'playwright-core'));
});

test.each([
  ['shell', 'playwright-cli', posixShim],
  ['cmd', 'playwright-cli.cmd', pnpmCmdShim],
  ['PowerShell', 'playwright-cli.ps1', pnpmPwshShim],
])('pnpm global: the %s shim names its bin file below PNPM_HOME', (_kind, name, shim) => {
  const home = path.join(root, 'AppData', 'Local', 'pnpm');
  pnpmStore(path.join(home, 'global', '5'));
  const launcher = write(path.join(home, name), shim('global/5/.pnpm/@playwright+cli@0.1.19/node_modules/@playwright/cli/playwright-cli.js'));
  expect(resolve(launcher).libraryPath).toBe(path.join(home, 'global', '5', '.pnpm', 'playwright-core@1.63.0', 'node_modules', 'playwright-core'));
});

test('a launcher no layout matches never loads a CLI planted above it', () => {
  const home = path.join(root, 'Users', 'me', 'AppData', 'Local', 'pnpm');
  // A pnpm global store the shim does not name, as after a store-layout change.
  pnpmStore(path.join(home, 'global', '6'));
  const launcher = write(path.join(home, 'playwright-cli.cmd'), '@node "%~dp0\\elsewhere.js" %*\n');
  for (let dir = path.dirname(home); dir.startsWith(root); dir = path.dirname(dir)) plant(dir);
  expect(() => resolve(launcher)).toThrow(/playwright CLI installation unavailable/);
  expect(loaded.plantedLoaded).toEqual([]);
});

test('a matching launcher whose own client is incompatible never falls back to one planted above it', () => {
  const cli = path.join(root, 'Users', 'me', 'prefix', 'lib', 'node_modules', '@playwright', 'cli');
  cliPackage(cli);
  write(path.join(cli, 'node_modules', 'playwright-core', 'package.json'), JSON.stringify({ name: 'playwright-core', main: 'index.js' }));
  write(path.join(cli, 'node_modules', 'playwright-core', 'index.js'), 'module.exports = {};\n');
  const launcher = path.join(root, 'Users', 'me', 'prefix', 'bin', 'playwright-cli');
  link('../lib/node_modules/@playwright/cli/playwright-cli.js', launcher);
  for (let dir = path.join(root, 'Users', 'me'); dir.startsWith(root); dir = path.dirname(dir)) plant(dir);
  expect(() => resolve(launcher)).toThrow(/playwright CLI installation unavailable/);
  expect(loaded.plantedLoaded).toEqual([]);
});

test('a CLI missing its own playwright-core never loads one Node\'s lookup finds above the installation', () => {
  const cli = path.join(root, 'Users', 'me', 'prefix', 'lib', 'node_modules', '@playwright', 'cli');
  cliPackage(cli);
  const launcher = path.join(root, 'Users', 'me', 'prefix', 'bin', 'playwright-cli');
  link('../lib/node_modules/@playwright/cli/playwright-cli.js', launcher);
  core(path.join(root, 'Users', 'me', 'prefix', 'node_modules', 'playwright-core'), true);
  core(path.join(root, 'node_modules', 'playwright-core'), true);
  expect(() => resolve(launcher)).toThrow(/playwright CLI installation unavailable/);
  expect(loaded.plantedLoaded).toEqual([]);
});

test('a shim whose script path climbs out of its own directory is not followed', () => {
  const home = path.join(root, 'Users', 'me', 'pnpm');
  const launcher = write(path.join(home, 'playwright-cli'), posixShim('../../../node_modules/@playwright/cli/playwright-cli.js'));
  plant(root);
  expect(() => resolve(launcher)).toThrow(/playwright CLI installation unavailable/);
  expect(loaded.plantedLoaded).toEqual([]);
});

test('a shim naming two different scripts is not followed', () => {
  const home = path.join(root, 'pnpm');
  pnpmStore(path.join(home, 'global', '5'));
  pnpmStore(path.join(home, 'global', '6'));
  const shim = posixShim('global/5/.pnpm/@playwright+cli@0.1.19/node_modules/@playwright/cli/playwright-cli.js');
  const launcher = write(path.join(home, 'playwright-cli'), shim.replace(/global\/5(?=[^]*global\/5)/, 'global/6'));
  expect(() => resolve(launcher)).toThrow(/playwright CLI installation unavailable/);
});

test('a launcher outside node_modules is a checkout only when it is that package\'s bin file', () => {
  const dir = path.join(root, 'tools');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: '@playwright/cli', bin: { 'playwright-cli': 'other.js' } }));
  core(path.join(dir, 'node_modules', 'playwright-core'), true);
  const launcher = write(path.join(dir, 'playwright-cli'), '#!/bin/sh\n');
  expect(() => resolve(launcher)).toThrow(/playwright CLI installation unavailable/);
  expect(loaded.plantedLoaded).toEqual([]);
});

// Off Windows a path opening with `//` is still a local one, so a link whose
// target is spelled as a share leads somewhere real here: an installation the
// old `existsSync` + `realpathSync` would have followed it to and loaded.
test.skipIf(process.platform === 'win32')('a hint that links to a share or device path is refused before it is followed', () => {
  const cli = path.join(root, 'share', 'lib', 'node_modules', '@playwright', 'cli');
  cliPackage(cli);
  core(path.join(cli, 'node_modules', 'playwright-core'), true);
  const real = path.join(root, 'share', 'bin', 'playwright-cli');
  link('../lib/node_modules/@playwright/cli/playwright-cli.js', real);
  const hint = path.join(root, 'hint', 'playwright-cli');
  mkdirSync(path.dirname(hint), { recursive: true });
  symlinkSync(`/${real}`, hint);
  expect(() => resolvePlaywrightInstall(hint, {})).toThrow(/playwright CLI installation unavailable/);
  expect(loaded.plantedLoaded).toEqual([]);
  // The same installation through a local link is found, so the refusal is the share spelling's.
  const local = path.join(root, 'local', 'playwright-cli');
  mkdirSync(path.dirname(local), { recursive: true });
  symlinkSync(real, local);
  expect(resolvePlaywrightInstall(local, {}).binary).toBe(local);
});
