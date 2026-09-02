// VSCode child process entry point — Node IPC transport over pty-core.
// Spawned by pty-manager.ts via child_process.fork().

const path = require('path');
const nodePty = require(path.join(__dirname, 'node-pty'));
const { create } = require('../../lib/pty-core.cjs');
const { createDorControlServer } = require('../../standalone/sidecar/dor-control-server.js');

const mgr = create((event, data) => {
  process.send({ type: event, ...data });
}, nodePty);

// The control token reaches this process through the fork env and stops here:
// `pty-core` merges our own `process.env` into every shell it spawns, so leaving
// it there would hand it out even when the channel never came up. It goes back
// into a shell's environment only alongside a socket path that is listening —
// see docs/specs/dor-cli.md.
const dorControlToken = process.env.DORMOUSE_CONTROL_TOKEN;
delete process.env.DORMOUSE_CONTROL_TOKEN;
delete process.env.DORMOUSE_CONTROL_SOCKET;

const dorControl = createDorControlServer({
  token: dorControlToken,
  send(event, data) {
    process.send({ type: event, ...data });
  },
});

let dorControlEnv = null;

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn':   mgr.spawn(msg.id, { cols: msg.cols, rows: msg.rows, cwd: msg.cwd, shell: msg.shell, args: msg.args, env: { ...msg.env, ...dorControlEnv } }); break;
    case 'input':   mgr.write(msg.id, msg.data); break;
    case 'resize':  mgr.resize(msg.id, msg.cols, msg.rows); break;
    case 'kill':    mgr.kill(msg.id); break;
    case 'killAll': mgr.killAll(); break;
    case 'interrupt': mgr.interrupt(msg.ids, msg.requestId); break;
    case 'gracefulKillAll': mgr.gracefulKillAll(msg.timeout, msg.requestId); break;
    case 'getCwd':  mgr.getCwd(msg.id); break;
    case 'getOpenPorts': mgr.getOpenPorts(msg.id); break;
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

// `ready` is what releases pty-manager's queued messages, so holding it until
// the control channel has settled means no spawn can race the bind — a shell
// either gets a listening socket or gets no control env at all. `listen` calls
// back or errors within a tick or two; the 2s ceiling keeps a runtime that
// somehow does neither from wedging terminal creation outright.
function announceReady() {
  process.send({ type: 'ready' });
}

if (dorControl) {
  dorControl.ready.then(
    () => {
      dorControlEnv = {
        DORMOUSE_CONTROL_SOCKET: dorControl.socketPath,
        DORMOUSE_CONTROL_TOKEN: dorControlToken,
      };
    },
    () => {
      console.error('[dor-control] control channel is off; `dor` will not be available in new terminals');
    },
  );
  Promise.race([
    dorControl.ready.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
  ]).then(announceReady);
} else {
  announceReady();
}
