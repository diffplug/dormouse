import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir, workflowRunBlock } from './lint-kit.mjs';
import { restoreExecutables, verifyInventory } from './release-artifact.mjs';

const script = fileURLToPath(new URL('./sign-and-deploy.sh', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  return tempDir(t, 'dormouse-sign-');
}
function put(root, path, content = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function artifact(root, executable = 'bin/dor') {
  const files = { 'bin/dor': 'original', 'data/file with spaces': 'data', 'artifact-executables.txt': `${executable}\n` };
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  put(root, 'artifact-manifest.sha256', Object.entries(files).map(([path, content]) => `${createHash('sha256').update(content).digest('hex')}  ${path}\n`).join(''));
  chmodSync(join(root, 'bin/dor'), 0o644);
}
function shell(root, code, args = []) {
  return spawnSync('bash', ['-c', `source ${quote(script)}
REPO_ROOT=${quote(root)}
WORK_DIR="$REPO_ROOT/release-signed"
DOWNLOAD_DIR="$WORK_DIR/downloads"
SIGN_DIR="$WORK_DIR/work"
${code}`, 'test', ...args], { encoding: 'utf8', timeout: 20_000 });
}
function succeeds(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }

test('verified executable metadata restores modes and leaves data non-executable', t => {
  const root = fixture(t);
  artifact(root);
  verifyInventory(root);
  restoreExecutables(root);
  assert.equal(statSync(join(root, 'bin/dor')).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, 'data/file with spaces')).mode & 0o111, 0);
});

for (const [name, mutate] of Object.entries({
  'unlisted code': root => put(root, 'bin/injected.js', 'injected'),
  'missing file': root => rmSync(join(root, 'bin/dor')),
  'symlink file': root => { rmSync(join(root, 'bin/dor')); symlinkSync('../data/file with spaces', join(root, 'bin/dor')); },
  'symlink directory': root => symlinkSync('data', join(root, 'linked')),
  'malformed hash': root => put(root, 'artifact-manifest.sha256', '123  bin/dor\n'),
  'duplicate record': root => put(root, 'artifact-manifest.sha256', readFileSync(join(root, 'artifact-manifest.sha256'), 'utf8').repeat(2)),
  'parent path': root => put(root, 'artifact-manifest.sha256', `${'a'.repeat(64)}  ../outside\n`),
  'absolute path': root => put(root, 'artifact-manifest.sha256', `${'a'.repeat(64)}  /outside\n`),
  'executable traversal': root => artifact(root, '../outside'),
  'unlisted executable': root => artifact(root, 'bin/missing'),
  'blank executable': root => artifact(root, ''),
  'duplicate executable': root => artifact(root, 'bin/dor\nbin/dor'),
  'Windows executable path': root => artifact(root, 'C:\\outside'),
})) {
  test(`artifact inventory rejects ${name}`, t => {
    const root = fixture(t);
    artifact(root);
    mutate(root);
    assert.throws(() => verifyInventory(root));
  });
}

test('artifact verification checks hashes even when attestation succeeds', t => {
  const root = fixture(t);
  const dir = join(root, 'release-signed/downloads/standalone-mac-aarch64');
  artifact(dir);
  put(dir, 'bin/dor', 'tampered');
  const result = shell(root, 'gh() { return 0; }; verify_downloaded_artifact standalone-mac-aarch64 v1.2.3 abc');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash verification failed/);
});

test('refreshing one platform preserves the other signed platform and immutable downloads', t => {
  const root = fixture(t);
  const download = join(root, 'release-signed/downloads/standalone-mac-aarch64');
  artifact(download);
  put(root, 'release-signed/work/standalone-win-x64/signed.exe', 'signed Windows');
  put(root, 'release-signed/work/.completed-sign-win');
  put(root, 'release-signed/work/.completed-notarize');
  put(root, 'release-signed/work/.completed-sign-updates');
  put(root, 'release-signed/work/Dormouse-macos-aarch64.tar.gz', 'old archive');
  put(root, 'release-signed/release-assets/stale.exe');
  succeeds(shell(root, 'prepare_artifact standalone-mac-aarch64'));
  assert.equal(readFileSync(join(root, 'release-signed/work/standalone-win-x64/signed.exe'), 'utf8'), 'signed Windows');
  assert.ok(existsSync(join(root, 'release-signed/work/.completed-sign-win')));
  assert.equal(statSync(join(download, 'bin/dor')).mode & 0o777, 0o644);
  for (const path of ['work/.completed-notarize', 'work/.completed-sign-updates', 'work/Dormouse-macos-aarch64.tar.gz', 'release-assets']) {
    assert.equal(existsSync(join(root, 'release-signed', path)), false);
  }
});

test('notarize reuses the signed working copy and verifies its download cache', t => {
  const root = fixture(t);
  put(root, 'release-signed/work/signed', 'signature');
  succeeds(shell(root, `
verify_cached_release() { touch "$WORK_DIR/verified"; }
prepare_sign_dir() { error 'must preserve signed work'; }
notarize_macos() { [[ -f "$WORK_DIR/verified" && -f "$SIGN_DIR/signed" ]]; }
main notarize`));
});

for (const command of ['sign-mac', 'notarize', 'sign-win', 'sign-updates', 'release']) {
  test(`${command} refuses invalid provenance before reaching signing or publication`, t => {
    const root = fixture(t);
    put(root, 'release-signed/.version', '1.2.3');
    const result = shell(root, `
check_command() { :; }
check_gh_attestation_support() { :; }
resolve_tag_sha() { echo abc; }
verify_downloaded_artifacts() { error 'invalid provenance'; }
main "$@"`, [command, '1.2.3']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid provenance/);
  });
}

test('version mismatch fails without deleting cached signed work', t => {
  const root = fixture(t);
  put(root, 'release-signed/.version', '1.2.3');
  put(root, 'release-signed/work/keep', 'signed');
  const result = shell(root, 'main sign-win 1.2.4');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cached release is 1.2.3/);
  assert.equal(readFileSync(join(root, 'release-signed/work/keep'), 'utf8'), 'signed');
});

for (const command of ['sign-mac', 'resume', 'all']) {
  test(`${command} refuses cached artifacts from a failed release workflow`, t => {
    const root = fixture(t);
    put(root, 'release-signed/.version', '1.2.3');
    const result = shell(root, `
check_command() { :; }
check_git_clean() { :; }
check_gh_attestation_support() { :; }
resolve_tag_sha() { echo abc; }
verify_downloaded_artifacts() { :; }
all_artifacts_downloaded() { return 0; }
find_release_run_id() { echo 123; }
gh() { if [[ "$2" == watch ]]; then return 1; else echo failure; fi; }
main "$@"`, [command, '1.2.3']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conclusion 'failure'|Workflow failed/);
    assert.equal(existsSync(join(root, 'release-signed/work')), false);
  });
}

test('notarization, updater signing, and publication require completed prior stages', t => {
  const root = fixture(t);
  for (const command of ['notarize_macos', 'sign_updates 1.2.3', 'create_release 1.2.3']) {
    const result = shell(root, `check_command() { :; }; ${command}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has not completed/);
  }
});

test('release notes match literal version and retain the final line of the last release', t => {
  const root = fixture(t);
  put(root, 'CHANGELOG.md', '## [1x2x3]\nwrong\n\n## [1.2.3]\n\nlast release line');
  put(root, 'release-signed/work/.completed-sign-updates');
  for (const file of ['Dormouse-macos-aarch64.tar.gz', 'Dormouse-windows-x64-setup.exe', 'Dormouse-linux-x86_64.AppImage']) put(root, `release-signed/release-assets/${file}`, 'bundle');
  succeeds(shell(root, `
gh() {
  if [[ "$2" == view ]]; then return 1; fi
  cp "$WORK_DIR/release-notes.md" "$REPO_ROOT/captured-notes"
}
create_release 1.2.3`));
  assert.equal(readFileSync(join(root, 'captured-notes'), 'utf8'), 'last release line\n');
});

test('a published release stops the retry path before it clobbers immutable assets', t => {
  const root = fixture(t);
  put(root, 'release-signed/work/.completed-sign-updates');
  for (const file of ['Dormouse-macos-aarch64.tar.gz', 'Dormouse-windows-x64-setup.exe', 'Dormouse-linux-x86_64.AppImage']) put(root, `release-signed/release-assets/${file}`, 'bundle');
  const result = shell(root, `
gh() {
  if [[ "$2" == view ]]; then
    case "$*" in *isDraft*) echo false;; *assets*) ;; esac
    return
  fi
  touch "$REPO_ROOT/published"
}
create_release 1.2.3`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already published/);
  assert.equal(existsSync(join(root, 'published')), false);
});

test('a draft release is repaired and published with a verified tag', t => {
  const root = fixture(t);
  put(root, 'release-signed/work/.completed-sign-updates');
  for (const file of ['Dormouse-macos-aarch64.tar.gz', 'Dormouse-windows-x64-setup.exe', 'Dormouse-linux-x86_64.AppImage']) put(root, `release-signed/release-assets/${file}`, 'bundle');
  succeeds(shell(root, `
gh() {
  if [[ "$2" == view ]]; then
    case "$*" in *isDraft*) echo true;; *assets*) echo Dormouse-macos-aarch64.tar.gz;; esac
    return
  fi
  echo "$2 $*" >> "$REPO_ROOT/gh-calls"
}
create_release 1.2.3`));
  const calls = readFileSync(join(root, 'gh-calls'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^upload .*--clobber/);
  assert.match(calls[1], /^edit .*--tag v1\.2\.3 --verify-tag --draft=false/);
});

test('existing unexpected GitHub assets block release updates', t => {
  const root = fixture(t);
  put(root, 'release-signed/work/.completed-sign-updates');
  for (const file of ['Dormouse-macos-aarch64.tar.gz', 'Dormouse-windows-x64-setup.exe', 'Dormouse-linux-x86_64.AppImage']) put(root, `release-signed/release-assets/${file}`, 'bundle');
  const result = shell(root, `
gh() {
  if [[ "$2" == view ]]; then
    case "$*" in *isDraft*) echo true;; *assets*) echo extra.vsix;; esac
    return
  fi
  touch "$REPO_ROOT/published"
}
create_release 1.2.3`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected asset: extra.vsix/);
  assert.equal(existsSync(join(root, 'published')), false);
});

test('nested copies of expected asset names cannot bypass the release directory inventory', t => {
  const root = fixture(t);
  put(root, 'release-signed/work/.completed-sign-updates');
  for (const file of ['Dormouse-macos-aarch64.tar.gz', 'Dormouse-windows-x64-setup.exe', 'Dormouse-linux-x86_64.AppImage']) put(root, `release-signed/release-assets/${file}`, 'bundle');
  put(root, 'release-signed/release-assets/extra/Dormouse-macos-aarch64.tar.gz', 'extra');
  const result = shell(root, 'gh() { error "must reject locally before gh"; }; create_release 1.2.3');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contains unexpected files/);
});

test('workflow discovery scopes to tag and commit without a title fallback', t => {
  const root = fixture(t);
  const result = shell(root, 'gh() { printf "%s\\n" "$@"; }; find_release_run_id v1.2.3 abc');
  succeeds(result);
  assert.match(result.stdout, /--branch\nv1\.2\.3\n--commit\nabc/);
  assert.doesNotMatch(result.stdout, /displayTitle/);
});

test('Windows signatures pass the PIV PIN through the environment only', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'release-signed/work'), { recursive: true });
  succeeds(shell(root, `
EV_SIGN_PIN='fixture-pin-7391'
check_command() { :; }
windows_exe_path() { echo inner.exe; }
windows_installer_path() { echo installer.exe; }
rebuild_windows_installer() { :; }
jsign() {
  [[ "$EV_SIGN_PIN" == fixture-pin-7391 ]]
  [[ "$*" == *'--storepass env:EV_SIGN_PIN'* ]]
  [[ "$*" != *fixture-pin-7391* ]]
  printf '%s\\n' "$*" >> "$REPO_ROOT/jsign-calls"
}
sign_windows 1.2.3`));
  assert.equal(readFileSync(join(root, 'jsign-calls'), 'utf8').trim().split('\n').length, 2);
});

test('CI records original executable paths, including app files and dotfiles, in its hashed inventory', t => {
  const root = fixture(t);
  const standalone = join(root, 'standalone');
  const app = 'src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Dormouse Terminal.app';
  put(standalone, `${app}/Contents/MacOS/node`, 'binary');
  put(standalone, `${app}/Contents/Resources/sidecar/dor/bin/dor`, 'launcher');
  put(standalone, 'sidecar/shell-integration/zsh/.zshenv', 'shell integration');
  put(standalone, 'src-tauri/binaries/node-aarch64-apple-darwin', 'binary');
  chmodSync(join(standalone, `${app}/Contents/MacOS/node`), 0o755);
  chmodSync(join(standalone, `${app}/Contents/Resources/sidecar/dor/bin/dor`), 0o755);
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const run = workflowRunBlock(workflow, 'Generate artifact manifest')
    .replaceAll('${{ matrix.target }}', 'aarch64-apple-darwin');
  succeeds(spawnSync('bash', ['-c', run], { cwd: root, encoding: 'utf8', timeout: 20_000 }));
  verifyInventory(standalone);
  const executables = readFileSync(join(standalone, 'artifact-executables.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(executables.sort(), [`${app}/Contents/MacOS/node`, `${app}/Contents/Resources/sidecar/dor/bin/dor`].sort());
  succeeds(spawnSync('shasum', ['-a', '256', '-c', 'artifact-manifest.sha256'], { cwd: standalone, encoding: 'utf8' }));
});
