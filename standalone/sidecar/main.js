/**
 * Tauri sidecar entry point — stdio JSON-lines transport over pty-core.
 *
 * Protocol:
 *   stdin  ← JSON lines from Rust backend (commands)
 *   stdout → JSON lines to Rust backend (events)
 */

const readline = require('readline');
const nodePty = require('node-pty');
const { create } = require('./pty-core');
const clipboard = require('./clipboard-ops');

function send(event, data) {
  process.stdout.write(JSON.stringify({ event, data }) + '\n');
}

const mgr = create((event, data) => {
  send(`pty:${event}`, data);
}, nodePty);

async function respondAsync(event, requestId, run) {
  try {
    const data = await run();
    send(event, { ...data, requestId });
  } catch (err) {
    send(event, { error: String(err && err.message || err), requestId });
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const { event, data } = JSON.parse(line);
    switch (event) {
      case 'pty:spawn':   mgr.spawn(data.id, data.options); break;
      case 'pty:input':   mgr.write(data.id, data.data); break;
      case 'pty:resize':  mgr.resize(data.id, data.cols, data.rows); break;
      case 'pty:kill':    mgr.kill(data.id); break;
      case 'pty:requestInit': mgr.list(); break;
      case 'pty:getCwd':  mgr.getCwd(data.id, data.requestId); break;
      case 'pty:getScrollback': mgr.getScrollback(data.id, data.requestId); break;
      case 'pty:getShells':  mgr.getShells(data.requestId); break;
      case 'pty:gracefulKillAll': mgr.gracefulKillAll(data.timeout); break;
      case 'clipboard:readFiles':
        respondAsync('clipboard:files', data.requestId, async () => ({
          paths: await clipboard.readClipboardFilePaths(),
        }));
        break;
      case 'clipboard:readImage':
        respondAsync('clipboard:image', data.requestId, async () => ({
          path: await clipboard.readClipboardImageAsFilePath(),
        }));
        break;
      case 'clipboard:readText':
        respondAsync('clipboard:text', data.requestId, async () => ({
          text: await clipboard.readClipboardText(),
        }));
        break;
      default: console.error(`[sidecar] Unknown event: ${event}`);
    }
  } catch (err) {
    console.error(`[sidecar] Failed to parse message:`, err.message);
  }
});

rl.on('close', () => { mgr.killAll(); process.exit(0); });
process.on('SIGTERM', () => { mgr.killAll(); process.exit(0); });

// Watchdog: if the Tauri host crashes or is force-killed, stdin EOF isn't
// always delivered (esp. on Windows), leaving us as an orphan that locks
// the install directory. Poll the parent PID and self-exit when it's gone.
const parentPid = process.ppid;
if (parentPid && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      mgr.killAll();
      process.exit(0);
    }
  }, 2000).unref();
}
