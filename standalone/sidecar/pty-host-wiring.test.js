const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { create } = require('./pty-core');

test('VS Code gracefulKill dispatches named PTYs to the shared core and acknowledges exit', async () => {
  const messages = [];
  const handlers = {};
  const killed = [];
  let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const pty = { spawn() {
    let exit;
    return {
      pid: 7, onData() {}, onExit(fn) { exit = fn; },
      kill(signal) { killed.push(signal); setImmediate(() => exit({ exitCode: 0 })); },
    };
  } };
  const source = readFileSync(require.resolve('../../vscode-ext/src/pty-host.js'), 'utf8');
  runInNewContext(source, {
    __dirname: require('node:path').dirname(require.resolve('../../vscode-ext/src/pty-host.js')),
    require(id) {
      if (id === 'path') return require('node:path');
      if (id.endsWith('node-pty')) return pty;
      if (id.endsWith('pty-core.cjs')) return { create };
      if (id.endsWith('dor-control-server.js')) return { createDorControlServer: () => null };
      throw new Error(`Unexpected module: ${id}`);
    },
    process: {
      env: {}, on(event, fn) { handlers[event] = fn; },
      send(message) { messages.push(message); if (message.type === 'gracefulKillDone') doneResolve(); },
    },
  });
  handlers.message({ type: 'spawn', id: 'one' });
  handlers.message({ type: 'spawn', id: 'two' });
  handlers.message({ type: 'gracefulKill', ids: ['one'], timeout: 1_000, requestId: 'deactivate' });
  await done;
  assert.equal(killed.length, 1);
  assert.deepEqual(messages.filter(message => message.type === 'exit').map(message => message.id), ['one']);
  assert.equal(messages.at(-1).type, 'gracefulKillDone');
  assert.equal(messages.at(-1).requestId, 'deactivate');
});
