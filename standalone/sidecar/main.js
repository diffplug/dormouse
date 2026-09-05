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
// Same pattern again: lib/src/host/remote/sidecar-entry.ts is the Burrow —
// the relay socket, the enrollment, the ACL, and remote-api v1 — running next to
// the PTYs it serves. See docs/specs/remote-api.md.
const { createSidecarBurrow } = require('./burrow.cjs');

const agentBrowser = createAgentBrowserHost({
  writeClipboardText: (text) => clipboard.writeClipboardText(text),
  log: (m) => console.error(m),
});

function send(event, data) {
  process.stdout.write(JSON.stringify({ event, data }) + '\n');
}

const mgr = create((event, data) => {
  // Output goes through the host's parser — one per PTY, feeding the webview
  // and every attached Client from the same pass (docs/specs/terminal-escapes.md
  // → "Parsing location") — so a `data` event reaches the webview as the
  // `pty:data` the host emits, never raw. A remote sink runs only after that
  // send, and the whole tap is wrapped so a throw is logged rather than fatal.
  try {
    burrow.onPtyEvent(event, data);
  } catch (err) {
    console.error(`[sidecar] burrow ${event} tap failed:`, err && err.message || err);
  }
  if (event !== 'data') send(`pty:${event}`, data);
}, nodePty);

const burrow = createSidecarBurrow({
  send,
  stateDir: process.env.DORMOUSE_STATE_DIR,
  mgr,
});

// The control token arrives from Rust in our own environment, and `pty-core`
// merges `process.env` into every shell it spawns — so it has to come out of
// there and go back only once the channel is actually listening. A lost bind
// (a squatted Windows pipe name, an unsafe socket directory) is not fatal to
// PTY work, but it must not leave Dormouse handing the token, and the surface
// API it opens, to whoever won the path. See docs/specs/dor-cli.md.
const dorControlToken = process.env.DORMOUSE_CONTROL_TOKEN;
delete process.env.DORMOUSE_CONTROL_TOKEN;
delete process.env.DORMOUSE_CONTROL_SOCKET;

const dorControl = createDorControlServer({
  token: dorControlToken,
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

// Hold commands until the control channel has settled, so the very first
// `pty:spawn` cannot race the bind and produce a shell with no `dor` (or, worse,
// with a token for a channel that never came up). `listen` calls back or errors
// within a tick or two, and the 2s ceiling means a runtime that somehow does
// neither costs a short delay rather than a sidecar that never spawns anything.
let controlSettled = !dorControl;
const queuedLines = [];

if (dorControl) {
  dorControl.ready.then(
    () => {
      process.env.DORMOUSE_CONTROL_SOCKET = dorControl.socketPath;
      process.env.DORMOUSE_CONTROL_TOKEN = dorControlToken;
    },
    () => {
      console.error('[dor-control] control channel is off; `dor` will not be available in new terminals');
    },
  );
  Promise.race([
    dorControl.ready.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
  ]).then(() => {
    controlSettled = true;
    while (queuedLines.length > 0) handleLine(queuedLines.shift());
  });
}

rl.on('line', (line) => {
  if (!controlSettled) {
    queuedLines.push(line);
    return;
  }
  handleLine(line);
});

function handleLine(line) {
  try {
    const { event, data } = JSON.parse(line);
    switch (event) {
      // Told before the spawn: the id may be a live PTY's, and the parser for
      // that generation must not carry a half-read sequence into the new one.
      case 'pty:spawn':   burrow.onPtySpawn(data.id); mgr.spawn(data.id, data.options); break;
      case 'pty:input':   mgr.write(data.id, data.data); break;
      case 'pty:resize':  mgr.resize(data.id, data.cols, data.rows); break;
      case 'pty:kill':    mgr.kill(data.id); break;
      case 'pty:requestInit': mgr.list(); break;
      case 'pty:getCwd':  mgr.getCwd(data.id, data.requestId); break;
      case 'pty:getOpenPorts': mgr.getOpenPorts(data.id, data.requestId); break;
      case 'pty:getScrollback': mgr.getScrollback(data.id, data.requestId); break;
      case 'pty:getShells':  mgr.getShells(data.requestId); break;
      // Reserved: no standalone caller yet — recovery capture ships for VS Code
      // only, which reaches the same `pty-core` through its own `pty-host.js`
      // rather than this route (docs/specs/vscode.md -> "Capturing agent
      // recovery").
      case 'pty:interrupt': mgr.interrupt(data.ids, data.requestId); break;
      case 'pty:gracefulKillAll': mgr.gracefulKillAll(data.timeout, data.requestId); break;
      // The webview's resolved terminal theme, so the parser here can answer
      // OSC 10/11/12 (docs/specs/terminal-escapes.md → Supported OSCs).
      case 'pty:themeColors': burrow.setThemeColors(data); break;
      case 'sidecar:shutdown': shutdown(); break;
      case 'dor:controlResponse': dorControl?.respond(data); break;
      case 'burrow:command': burrow.handleCommand(data); break;
      case 'iframe:createProxyUrl':
        // Log to stderr — stdout is the JSON-lines protocol channel.
        respondAsync('iframe:proxyUrl', data.requestId, async () => ({
          result: await createIframeProxyUrl(data.target, {
            log: (m) => console.error(m),
            // Validated inside the proxy (`normalizeEmbedderOrigins`); an
            // unusable chain costs the shim, never a wider grant.
            embedderOrigins: data.embedderOrigins,
          }),
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
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Close any headed pop-out windows so quitting never orphans a real Chrome
  // window (spec → "Pop-Out" lifecycle). Bounded so a hung agent-browser
  // can't wedge the exit; mirrors the VS Code host's deactivate().
  try {
    await Promise.race([
      agentBrowser.closePoppedOut(),
      new Promise((resolve) => setTimeout(resolve, 1500).unref?.()),
    ]);
  } catch {}
  dorControl?.close();
  burrow.dispose();
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
