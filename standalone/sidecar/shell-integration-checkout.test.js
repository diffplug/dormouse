// Exercise the bytes a Windows checkout packages, even when CI runs on Linux.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Windows checkout preserves executable Unix shell integration and login-profile startup', (t) => {
  const root = path.resolve(__dirname, '../..');
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'dormouse-shell-checkout-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Git for Windows rejects Node's null-device path. A real empty file
  // isolates both settings consistently across Git builds and platforms.
  const emptyConfig = path.join(fixture, 'empty-git-config');
  writeFileSync(emptyConfig, '');
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  const git = (...args) => execFileSync('git', [
    '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false',
    '-c', `core.attributesFile=${emptyConfig}`, ...args,
  ], { cwd: fixture, env, stdio: 'pipe' });
  const relative = 'standalone/sidecar/shell-integration';
  cpSync(path.join(root, '.gitattributes'), path.join(fixture, '.gitattributes'));
  cpSync(path.join(root, relative), path.join(fixture, relative), { recursive: true });
  git('init', '-q');
  git('add', '.gitattributes', relative);
  const checkout = path.join(fixture, 'Windows checkout');
  mkdirSync(checkout);
  git('checkout-index', '--all', `--prefix=${checkout}${path.sep}`);

  for (const shell of ['bash', 'zsh']) {
    const directory = path.join(checkout, relative, shell);
    for (const file of readdirSync(directory).filter((name) => name !== '.gitignore')) {
      assert.ok(!readFileSync(path.join(directory, file)).includes(Buffer.from('\r\n')),
        `${shell}/${file} must remain LF in a Windows checkout`);
    }
  }

  const home = path.join(fixture, 'home');
  mkdirSync(home);
  writeFileSync(path.join(home, '.bash_profile'), 'export DORMOUSE_TEST_PROFILE=loaded\n');
  const result = spawnSync('bash', [
    '--init-file', path.join(checkout, relative, 'bash/shellIntegration.bash'), '-ic',
    'test "$DORMOUSE_TEST_PROFILE" = loaded && test "$__dormouse_633_installed" = 1',
  ], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
