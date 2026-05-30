import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = join(__dirname, 'snapshots', 'help');
const updateSnapshots = process.env.UPDATE_SNAPSHOTS === '1';

test('help snapshots cover every command in global help', async (t) => {
  const globalHelp = await runCli(['--help']);
  const commandNames = parseCommandNames(globalHelp.stdout);

  assert.deepEqual(await runCli([]), globalHelp, 'no-arg dor should print root help');
  assert.deepEqual(await runCli(['help']), globalHelp, 'dor help should print root help');

  await t.test('dor', async () => {
    await snapshotHelp({
      file: 'dor',
      title: 'dor',
      invocation: 'dor --help',
      result: globalHelp,
    });
  });

  for (const command of commandNames) {
    await t.test(`dor ${command}`, async () => {
      await snapshotHelp({
        file: command,
        title: `dor ${command}`,
        invocation: `dor ${command} --help`,
        result: await runCli([command, '--help']),
      });
    });
  }

  await assertSnapshotInventory(['dor', ...commandNames]);
});

function parseCommandNames(stdout) {
  const lines = stdout.split('\n');
  const commandsIndex = lines.indexOf('COMMANDS');
  assert.notEqual(commandsIndex, -1, 'global help should include a Commands section');

  return lines
    .slice(commandsIndex + 1)
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

async function snapshotHelp({ file, title, invocation, result }) {
  assert.equal(result.exitCode, 0, `${invocation} should succeed`);
  assert.equal(result.stderr, '', `${invocation} should not write stderr`);
  assert.notEqual(result.stdout, '', `${invocation} should write help text`);

  const actual = [
    `# ${title}`,
    '',
    `Invocation: \`${invocation}\``,
    '',
    '```text',
    result.stdout,
    '```',
    '',
  ].join('\n');
  const path = join(snapshotsDir, `${file}.md`);
  if (updateSnapshots) {
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(path, actual);
    return;
  }
  const expected = await readFile(path, 'utf8');
  assert.equal(actual, expected);
}

async function assertSnapshotInventory(snapshotNames) {
  const expected = snapshotNames.map((name) => `${name}.md`).sort();
  const actual = (await readdir(snapshotsDir))
    .filter((name) => name.endsWith('.md'))
    .sort();

  assert.deepEqual(actual, expected, 'help snapshot files should match global help commands');
}
