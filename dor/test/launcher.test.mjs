import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The staged launchers, run exactly as a terminal runs `dor`. DORMOUSE_CLI_JS
// points at a stub that exits with a chosen code, so each case asserts the
// launcher hands the CLI's exit status back to the shell.
const binDir = fileURLToPath(new URL('../bin/', import.meta.url));
const isWindows = process.platform === 'win32';

async function withStubCli(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dor-launcher-'));
  const cliJs = join(dir, 'cli.mjs');
  await writeFile(cliJs, 'process.exit(Number(process.argv[2]));\n');
  try {
    return await run(cliJs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runLauncher(cliJs, code) {
  const env = { ...process.env, DORMOUSE_NODE: process.execPath, DORMOUSE_CLI_JS: cliJs };
  if (isWindows) {
    // Node refuses to spawn a .cmd directly; go through cmd.exe as a shell does.
    return spawnSync('cmd.exe', ['/d', '/s', '/c', `""${join(binDir, 'dor.cmd')}" ${code}"`], {
      env,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync('sh', [join(binDir, 'dor'), String(code)], { env });
}

for (const code of [0, 7]) {
  test(`${isWindows ? 'dor.cmd' : 'dor'} propagates the CLI exit code ${code}`, async () => {
    await withStubCli((cliJs) => {
      const result = runLauncher(cliJs, code);
      assert.equal(result.error, undefined);
      assert.equal(result.status, code, String(result.stderr));
    });
  });
}
