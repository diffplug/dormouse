// Bundled by prepare.mjs. Only VS Code's output-channel API is replaced; the
// peer transport, endpoint publication, control server and Git guard are real.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { configurePeerLink, initPeerLink, ensurePeerNet, disposePeerLink, isPeerBroker } from '../../vscode-ext/src/peer-link';
import { localGitRepository } from '../../dor-lib-common/src/git';
const { createDorControlServer } = require('../../standalone/sidecar/dor-control-server.js');

const [mode, root, share, git] = process.argv.slice(2);
const out = (name: string, data: unknown) => writeFile(join(root, name), JSON.stringify(data, null, 2));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function probe(path: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(3000, () => socket.destroy(new Error('same-account pipe timed out')));
    socket.once('error', reject);
    socket.once('data', () => { socket.destroy(); resolve(); });
  });
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows required');
  if (mode === 'serve') {
    const storage = join(root, 'peer-storage');
    await mkdir(storage, { recursive: true });
    initPeerLink({ globalStorageUri: { fsPath: storage } } as any);
    configurePeerLink({
      brokerRequest: async () => ({ answers: [] }), ownsPty: () => false,
      invalidateDirectory() {}, streamPty: () => () => {}, writePty() {}, resizePty() {},
      handleForwardedCommand() {}, dropForwardedCommands() {}, handleForwardedPush() {},
      deliverCommandResult() {}, deliverUiEvent() {}, onClientAuthenticated() {},
    } as any);
    const dor = createDorControlServer({ token: randomBytes(24).toString('hex'), send() {} });
    try {
      await dor.ready;
      await ensurePeerNet(() => {});
      if (!isPeerBroker()) throw new Error('fixture did not become the broker');
      const endpoint = JSON.parse(await readFile(join(storage, 'burrow.peer-endpoint'), 'utf8'));
      await probe(dor.socketPath);
      await probe(endpoint.name);
      await out('pipes.json', { dor: dor.socketPath, peer: endpoint.name, sameAccount: 'connected and received both challenges', node: process.version });
      // Bounded even if the PowerShell parent is interrupted.
      for (let i = 0; i < 600; i++) {
        if (await readFile(join(root, 'stop'), 'utf8').then(() => true, () => false)) break;
        await pause(500);
      }
    } finally { dor.close(); await disposePeerLink(); }
  } else if (mode === 'git') {
    const results: unknown[] = [];
    const stamp = (phase: string, extra = {}) => results.push({ phase, at: new Date().toISOString(), ...extra });
    // Positive control: an actual SMB read, then Git following a planted gitfile.
    // The share is made by the runner on THIS computer, containing no real data.
    stamp('positive-start');
    const sentinel = await readFile(`${share}\\sentinel.txt`, 'utf8');
    if (sentinel.trim() !== 'dormouse-audit-synthetic') throw new Error('SMB positive control failed');
    const gitfile = join(root, 'gitfile');
    await mkdir(gitfile, { recursive: true });
    await writeFile(join(gitfile, '.git'), `gitdir: ${share.replaceAll('\\', '/')}/repo.git\n`);
    // Only the synthetic positive control bypasses Git's cross-owner trust check.
    const direct = execFileSync(git, ['-c', 'safe.directory=*', '-C', gitfile, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 10000 });
    stamp('positive-end', { gitDir: direct.trim() });
    await pause(1500);
    stamp('guard-start');
    const included = join(root, 'include');
    await mkdir(join(included, '.git', 'objects'), { recursive: true });
    await mkdir(join(included, '.git', 'refs'), { recursive: true });
    await writeFile(join(included, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(included, '.git', 'config'), `[core]\nrepositoryformatversion = 0\n[include]\npath = ${share.replaceAll('\\', '/')}/config\n`);
    for (const [kind, path] of [['unc-cwd', share], ['gitfile', gitfile], ['include', included], ['symlink-to-share', join(root, 'share-link')]]) {
      const result = await localGitRepository(path);
      stamp(kind, { refused: result === null });
      if (result !== null) throw new Error(`${kind} was accepted`);
    }
    stamp('guard-end');
    await out('git.json', { results, verdict: 'guard refused all cases; review capture positive and guarded windows before asserting no SMB contact' });
  } else throw new Error('expected serve or git');
}
main().catch(async error => {
  await out(`${mode}-error.json`, { error: String(error), stack: error.stack }).catch(() => {});
  process.exitCode = 1;
});
