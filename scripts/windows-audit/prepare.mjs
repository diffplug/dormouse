// Prepare without elevation. The elevated runner needs no build tools or network.
import { createRequire } from 'node:module';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { workspaceSourceAliases } from '../workspace-sources.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'vscode-ext/package.json'));
const { build } = require('esbuild');
const destination = process.argv[2];
if (!destination) throw new Error('Usage: pnpm exec node scripts/windows-audit/prepare.mjs <new output directory>');
const out = resolve(destination);
await mkdir(out); // Refuse to overwrite another run's kit.
await build({ entryPoints: [join(root, 'scripts/windows-audit/fixture.ts')], outfile: join(out, 'fixture.cjs'), bundle: true, alias: workspaceSourceAliases(), platform: 'node', format: 'cjs', plugins: [{
  name: 'output-channel-only', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'audit' }));
    build.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({ contents: 'export const window = { createOutputChannel: () => ({ appendLine() {} }) };' }));
  },
}] });
for (const file of ['run.ps1', 'account-probe.ps1', 'owner-acl.ps1', 'child.ps1', 'directory-link.ps1']) await copyFile(join(root, 'scripts/windows-audit', file), join(out, file));
await copyFile(join(root, 'deploy/local/install-windows.ps1'), join(out, 'installer.ps1'));
await copyFile(process.execPath, join(out, 'node.exe'));
await writeFile(join(out, 'provenance.json'), JSON.stringify({
  source: root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
  node: process.version, preparedAt: new Date().toISOString(),
  installerSha256: (await import('node:crypto')).createHash('sha256').update(await readFile(join(out, 'installer.ps1'))).digest('hex'),
}, null, 2));
console.log(`Prepared ${out}\nRun run.ps1 from an Administrator PowerShell; see docs/testing/windows-audit.md.`);

const hashes = {};
for (const name of ['fixture.cjs', 'node.exe', 'installer.ps1', 'run.ps1', 'account-probe.ps1', 'owner-acl.ps1', 'child.ps1', 'directory-link.ps1', 'provenance.json']) {
  hashes[name] = createHash('sha256').update(await readFile(join(out, name))).digest('hex');
}
await writeFile(join(out, 'sha256.json'), JSON.stringify(hashes, null, 2));