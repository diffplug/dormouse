// VSCode child process entry point — Node IPC transport over pty-core.
// Spawned by pty-manager.ts via child_process.fork().

const path = require('path');
const nodePty = require(path.join(__dirname, 'node-pty'));
const { create } = require('../../lib/pty-core.cjs');

const mgr = create((event, data) => {
  process.send({ type: event, ...data });
}, nodePty);

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn':   mgr.spawn(msg.id, { cols: msg.cols, rows: msg.rows, cwd: msg.cwd, shell: msg.shell, args: msg.args }); break;
    case 'input':   mgr.write(msg.id, msg.data); break;
    case 'resize':  mgr.resize(msg.id, msg.cols, msg.rows); break;
    case 'kill':    mgr.kill(msg.id); break;
    case 'killAll': mgr.killAll(); break;
    case 'gracefulKillAll': mgr.gracefulKillAll(msg.timeout); break;
    case 'getCwd':  mgr.getCwd(msg.id); break;
    case 'getOpenPorts': mgr.getOpenPorts(msg.id); break;
    case 'getShells': mgr.getShells(msg.requestId); break;
  }
});

process.send({ type: 'ready' });
