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
const { createToolHost } = require('./tool-host.cjs');
const { gitInfo } = require('./git-info.cjs');
// Same pattern: lib/src/host/browser-host.ts is the single source of truth for
// browser automation, run here exactly as the VS Code extension host runs it,
// over the providers in lib/src/host/agent-browser-host.ts and
// playwright-host.ts. See docs/specs/dor-browser.md → "Agent-Browser Host Capabilities".
const { createBrowserHost } = require('./browser-host.cjs');
const { createAgentBrowserProvider } = require('./agent-browser-host.cjs');
// Same pattern again: lib/src/host/remote/sidecar-entry.ts is the Burrow —
// the relay socket, the enrollment, the ACL, and remote-api v1 — running next to
// the PTYs it serves (docs/specs/remote-api.md), and the app's one
// AlertManager, which its parse feeds, in the host role VS Code's extension
// host runs too (docs/specs/standalone.md -> "Alerts"). It handles every PTY
// command the alerts must see.
const { createSidecarHost } = require('./burrow.cjs');
// Same pattern again: lib/src/host/recovery.ts is the agent-recovery capture
// machine (shared with the VS Code extension host) plus the single-use record
// store. See docs/specs/standalone.md -> "Agent recovery".
const { captureAgentRecovery, createRecoveryStore, sliceSince } = require('./recovery.cjs');

const browserLog = (m) => console.error(m);
const browserHost = createBrowserHost({
  writeClipboardText: (text) => clipboard.writeClipboardText(text),
  log: browserLog,
  providers: {
    'agent-browser': () => createAgentBrowserProvider({ log: browserLog }),
    // Required on the first Playwright request rather than at boot: its bundle
    // carries `ws`, and most sessions never open a Playwright pane.
    playwright: () => require('./playwright-host.cjs').createPlaywrightProvider({ log: browserLog }),
  },
});

function send(event, data) {
  process.stdout.write(JSON.stringify({ event, data }) + '\n');
}

// stdout is the JSON-lines protocol channel, so every log line goes to stderr.
const recoveryLog = { info: (m) => console.error(m), error: (m) => console.error(m) };

// The record lives beside the session snapshots, under the state root Rust
// picks (dev and the installed app get different ones). Without a directory the
// store is memory-only and says so once.
const recovery = createRecoveryStore(process.env.DORMOUSE_RECOVERY_DIR || undefined, { log: recoveryLog });

const mgr = create((event, data) => {
  // Output goes through the host's parser — one per PTY, feeding the webview
  // and every attached Client from the same pass (docs/specs/terminal-escapes.md
  // → "Parsing location") — so a `data` event reaches the webview as the
  // `pty:data` the host emits, never raw. A remote sink runs only after that
  // send, and the whole tap is wrapped so a throw is logged rather than fatal.
  try {
    host.onPtyEvent(event, data);
  } catch (err) {
    console.error(`[sidecar] burrow ${event} tap failed:`, err && err.message || err);
  }
  if (event !== 'data') send(`pty:${event}`, data);
  // `sliceSince` comes from the shared bundle above rather than living in
  // pty-core, so this host and the VS Code extension host read their replay
  // buffers through one implementation. Each helper decision pty-core makes
  // reaches the alerts, which keep a helper inert (docs/specs/alert.md).
}, nodePty, { replay: true, sliceSince, onHelper: (id, helper) => host.alerts.setHelper(id, helper) });

const host = createSidecarHost({
  send,
  stateDir: process.env.DORMOUSE_STATE_DIR,
  mgr,
});

// Dor Tools. Shares the app's state directory, so an approved repo stays
// approved across restarts (docs/specs/dor-tool.md -> Trust).
const toolHost = createToolHost({ stateDir: process.env.DORMOUSE_STATE_DIR });

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
    // The PTY lifecycle and I/O, the alerts and the Burrow.
    if (host.handleCommand(event, data)) return;
    switch (event) {
      case 'pty:mark': mgr.mark(data?.ids, data?.requestId); break;
      case 'pty:context': mgr.context(data, data.requestId); break;
      case 'pty:getCwd':  mgr.getCwd(data.id, data.requestId); break;
      case 'pty:getCwds': mgr.getCwds(data.ids, data.requestId); break;
      case 'pty:getOpenPorts': mgr.getOpenPorts(data.id, data.requestId); break;
      case 'pty:getOpenPortsMany': mgr.getOpenPortsMany(data.ids, data.requestId); break;
      case 'pty:getShells':  mgr.getShells(data.requestId); break;
      case 'pty:interrupt': mgr.interrupt(data.ids, data.requestId); break;
      // Quit teardown, first step: press ^C, detect each agent's resume
      // invocation, and write the single-use record. Runs here rather than in
      // Rust because the replay buffers the detection reads are here, this
      // process's lifetime is exactly one activation, and the browser-dev
      // harness gets the same answer for free.
      case 'pty:captureRecovery':
        respondAsync('recoveryDone', data.requestId, async () => {
          recovery.beginCapture();
          const count = await captureAgentRecovery({
            liveIds: () => mgr.liveIds(),
            // One press, and the caller decides about a second: `mgr.interrupt`
            // writes synchronously, so the ack is immediate.
            interrupt: async (ids) => { mgr.interrupt(ids); },
            receivedChars: (id) => mgr.receivedChars(id),
            outputSince: (id, mark) => mgr.outputSince(id, mark),
            onCommand: (id, command) => recovery.record(id, command),
            log: recoveryLog,
          }, { ids: data.ids, maxWaitMs: data.timeout });
          return { count };
        });
        break;
      // Cold start: claim the invocations belonging to these panes. Destructive
      // on the first call, so nothing can replay them.
      case 'recovery:take':
        respondAsync('recovery:commands', data.requestId, async () => ({
          commands: recovery.take(Array.isArray(data.paneIds) ? data.paneIds : []),
        }));
        break;
      case 'pty:gracefulKill': mgr.gracefulKill(data.ids, data.timeout, data.requestId); break;
      case 'sidecar:shutdown': shutdown(); break;
      case 'dor:controlResponse': dorControl?.respond(data); break;
      case 'tool:control':
        respondAsync('tool:result', data.requestId, async () => ({
          result: await toolHost.handle(data.request),
        }));
        break;
      // Workspace auto-naming (docs/specs/layout.md -> "Workspace names").
      case 'git:info':
        respondAsync('git:infoResult', data.requestId, async () => ({
          result: await gitInfo(data.paths),
        }));
        break;
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
      case 'browser:request':
        // A screenshot answers with its temp-file PATH, not the bytes: a
        // ~100-700KB base64 line would otherwise ride the JSON-lines stdio pipe
        // shared with all PTY traffic (head-of-line blocking terminal output on
        // every frame). Rust reads the file itself and returns a raw
        // tauri::ipc::Response for the webview.
        respondAsync('browser:result', data.requestId, async () => ({
          result: await browserHost.requestFile(data.request),
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
      browserHost.close(),
      new Promise((resolve) => setTimeout(resolve, 1500).unref?.()),
    ]);
  } catch {}
  dorControl?.close();
  host.dispose();
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
