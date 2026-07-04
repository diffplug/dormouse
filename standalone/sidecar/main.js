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
const { createDorControlServer } = require('./dor-control-server');
// Built from lib/src/host/iframe-proxy.ts (shared with the VS Code host) by
// scripts/build-sidecar-proxy.mjs. See docs/specs/dor-browser.md.
const { createIframeProxyUrl } = require('./iframe-proxy.cjs');
// Same pattern: lib/src/host/agent-browser-host.ts is the single source of truth
// for the agent-browser host capabilities, run here exactly as the VS Code
// extension host runs it. See docs/specs/dor-browser.md → "Agent-Browser Host Capabilities".
const { createAgentBrowserHost } = require('./agent-browser-host.cjs');

const agentBrowser = createAgentBrowserHost({
  writeClipboardText: (text) => clipboard.writeClipboardText(text),
  log: (m) => console.error(m),
});

function send(event, data) {
  process.stdout.write(JSON.stringify({ event, data }) + '\n');
}

const mgr = create((event, data) => {
  send(`pty:${event}`, data);
}, nodePty);

const dorControl = createDorControlServer({
  socketPath: process.env.DORMOUSE_CONTROL_SOCKET,
  token: process.env.DORMOUSE_CONTROL_TOKEN,
  send,
});

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
      case 'pty:getOpenPorts': mgr.getOpenPorts(data.id, data.requestId); break;
      case 'pty:getScrollback': mgr.getScrollback(data.id, data.requestId); break;
      case 'pty:getShells':  mgr.getShells(data.requestId); break;
      case 'pty:gracefulKillAll': mgr.gracefulKillAll(data.timeout); break;
      case 'sidecar:shutdown': shutdown(); break;
      case 'dor:controlResponse': dorControl?.respond(data); break;
      case 'iframe:createProxyUrl':
        // Log to stderr — stdout is the JSON-lines protocol channel.
        respondAsync('iframe:proxyUrl', data.requestId, async () => ({
          result: await createIframeProxyUrl(data.target, { log: (m) => console.error(m) }),
        }));
        break;
      case 'agentBrowser:command':
        respondAsync('agentBrowser:result', data.requestId, async () => ({
          result: await agentBrowser.command(data.session, data.args, data.binaryPath),
        }));
        break;
      case 'agentBrowser:edit':
        respondAsync('agentBrowser:result', data.requestId, async () => ({
          result: await agentBrowser.edit(data.session, data.op, data.binaryPath),
        }));
        break;
      case 'agentBrowser:screenshot':
        // Return the temp-file PATH, not the bytes: a ~100-700KB base64 line would
        // otherwise ride the JSON-lines stdio pipe shared with all PTY traffic
        // (head-of-line blocking terminal output on every frame). Rust reads the
        // file itself and returns a raw tauri::ipc::Response for the webview.
        respondAsync('agentBrowser:result', data.requestId, async () => {
          const shot = await agentBrowser.screenshotToFile(
            data.session, { format: data.format, quality: data.quality }, data.binaryPath,
          );
          if (!shot.ok) return { result: { ok: false, error: shot.error } };
          return { result: { ok: true, mime: shot.mime, path: shot.path } };
        });
        break;
      case 'agentBrowser:streamStatus':
        respondAsync('agentBrowser:result', data.requestId, async () => ({
          result: await agentBrowser.streamStatus(data.session, data.binaryPath),
        }));
        break;
      case 'agentBrowser:open':
        respondAsync('agentBrowser:result', data.requestId, async () => ({
          result: await agentBrowser.open(data.url, { headed: data.headed }, data.binaryPath),
        }));
        break;
      case 'agentBrowser:popOut':
        respondAsync('agentBrowser:result', data.requestId, async () => ({
          result: await agentBrowser.popOut(data.session, { url: data.url, rect: data.rect }, data.binaryPath),
        }));
        break;
      case 'agentBrowser:popIn':
        respondAsync('agentBrowser:result', data.requestId, async () => ({
          result: await agentBrowser.popIn(data.session, { url: data.url }, data.binaryPath),
        }));
        break;
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Close any headed pop-out windows so quitting never orphans a real Chrome
  // window (spec → "Headed Pop-Out" lifecycle). Bounded so a hung agent-browser
  // can't wedge the exit; mirrors the VS Code host's deactivate().
  try {
    await Promise.race([
      agentBrowser.closePoppedOut(),
      new Promise((resolve) => setTimeout(resolve, 1500).unref?.()),
    ]);
  } catch {}
  dorControl?.close();
  mgr.killAll();
  process.exit(0);
}

rl.on('close', shutdown);
process.on('SIGTERM', shutdown);

// Watchdog: if the Tauri host crashes or is force-killed, stdin EOF isn't
// always delivered (esp. on Windows), leaving us as an orphan that locks
// the install directory. Poll the parent PID and self-exit when it's gone.
const parentPid = process.ppid;
if (parentPid && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown();
    }
  }, 2000).unref();
}
