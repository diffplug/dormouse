// VSCode child process entry point — Node IPC transport over pty-core.
// Spawned by pty-manager.ts via child_process.fork().

const path = require('path');
const nodePty = require(path.join(__dirname, 'node-pty'));
const { create } = require('../../lib/pty-core.cjs');
const { createDorControlServer } = require('../../standalone/sidecar/dor-control-server.js');

const mgr = create((event, data) => {
  process.send({ type: event, ...data });
}, nodePty);

const dorControl = createDorControlServer({
  socketPath: process.env.DORMOUSE_CONTROL_SOCKET,
  token: process.env.DORMOUSE_CONTROL_TOKEN,
  send(event, data) {
    process.send({ type: event, ...data });
  },
});

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn':   mgr.spawn(msg.id, { cols: msg.cols, rows: msg.rows, cwd: msg.cwd, shell: msg.shell, args: msg.args, env: msg.env }); break;
    case 'input':   mgr.write(msg.id, msg.data); break;
    case 'resize':  mgr.resize(msg.id, msg.cols, msg.rows); break;
    case 'kill':    mgr.kill(msg.id); break;
    case 'killAll': mgr.killAll(); break;
    case 'gracefulKillAll': mgr.gracefulKillAll(msg.timeout); break;
    case 'getCwd':  mgr.getCwd(msg.id); break;
    case 'getShells': mgr.getShells(msg.requestId); break;
    case 'dor:controlResponse': dorControl?.respond(msg); break;
  }
});

function shutdown() {
  dorControl?.close();
  mgr.killAll();
  process.exit(0);
}

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);

process.send({ type: 'ready' });
