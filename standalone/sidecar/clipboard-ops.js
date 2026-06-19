const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

const MAC_FILE_PATHS_SCRIPT = [
  'use framework "AppKit"',
  'use framework "Foundation"',
  'use scripting additions',
  'try',
  '  set pb to current application\'s NSPasteboard\'s generalPasteboard()',
  '  set urls to pb\'s readObjectsForClasses:{current application\'s NSURL} options:(missing value)',
  '  if urls is missing value then return ""',
  '  set AppleScript\'s text item delimiters to linefeed',
  '  set path_list to {}',
  '  repeat with u in urls',
  '    if (u\'s isFileURL()) as boolean then',
  '      set end of path_list to (u\'s |path|() as text)',
  '    end if',
  '  end repeat',
  '  if (count of path_list) > 0 then return path_list as text',
  'end try',
  'return ""',
].join('\n');

async function readFilePathsMac(runtime) {
  const exec = runtime.exec || execFileP;
  try {
    const { stdout } = await exec('osascript', ['-e', MAC_FILE_PATHS_SCRIPT], { maxBuffer: MAX_BUFFER });
    return splitNonEmptyLines(stdout);
  } catch {
    return [];
  }
}

async function readFilePathsWindows(runtime) {
  const exec = runtime.exec || execFileP;
  const cmd = '$out = Get-Clipboard -Format FileDropList; if ($out) { $out | ForEach-Object { $_.FullName } }';
  try {
    const { stdout } = await exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { maxBuffer: MAX_BUFFER },
    );
    return splitNonEmptyLines(stdout);
  } catch {
    return [];
  }
}

function parseUriList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .filter((s) => s.startsWith('file://'))
    .map((uri) => {
      try { return decodeURIComponent(uri.slice('file://'.length)); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function readFilePathsLinux(runtime) {
  const env = runtime.env || process.env;
  const exec = runtime.exec || execFileP;
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const attempts = wayland
    ? [['wl-paste', ['--type', 'text/uri-list', '--no-newline']], ['xclip', ['-selection', 'clipboard', '-o', '-t', 'text/uri-list']]]
    : [['xclip', ['-selection', 'clipboard', '-o', '-t', 'text/uri-list']], ['wl-paste', ['--type', 'text/uri-list', '--no-newline']]];

  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await exec(cmd, args, { maxBuffer: MAX_BUFFER });
      const paths = parseUriList(stdout);
      if (paths.length > 0) return paths;
    } catch {}
  }
  return [];
}

async function readClipboardFilePaths(runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'darwin') return readFilePathsMac(runtime);
  if (platform === 'win32') return readFilePathsWindows(runtime);
  return readFilePathsLinux(runtime);
}

async function readTextMac(runtime) {
  const exec = runtime.exec || execFileP;
  try {
    const { stdout } = await exec('pbpaste', [], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch {
    return '';
  }
}

async function readTextWindows(runtime) {
  const exec = runtime.exec || execFileP;
  try {
    const { stdout } = await exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { maxBuffer: MAX_BUFFER },
    );
    // Get-Clipboard -Raw appends a trailing newline that wasn't on the clipboard.
    return stdout.replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

async function readTextLinux(runtime) {
  const env = runtime.env || process.env;
  const exec = runtime.exec || execFileP;
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const attempts = wayland
    ? [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']]]
    : [['xclip', ['-selection', 'clipboard', '-o']], ['wl-paste', ['--no-newline']]];

  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await exec(cmd, args, { maxBuffer: MAX_BUFFER });
      if (stdout) return stdout;
    } catch {}
  }
  return '';
}

// Native clipboard text read — bypasses navigator.clipboard.readText(), whose
// WKWebView implementation pops a "Paste from <App>" confirmation menu at the
// cursor every time it's called from JS.
async function readClipboardText(runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'darwin') return readTextMac(runtime);
  if (platform === 'win32') return readTextWindows(runtime);
  return readTextLinux(runtime);
}

async function readImageMac(out, runtime) {
  const exec = runtime.exec || execFileP;
  const script = [
    'try',
    '  set info to clipboard info',
    '  repeat with entry in info',
    '    if (item 1 of entry) is «class furl» then return ""',
    '  end repeat',
    'end try',
    'try',
    `  set f to open for access POSIX file "${out.replace(/"/g, '\\"')}" with write permission`,
    '  write (the clipboard as «class PNGf») to f',
    '  close access f',
    '  return "ok"',
    'on error',
    '  try',
    '    close access f',
    '  end try',
    '  return ""',
    'end try',
  ].join('\n');
  try {
    const { stdout } = await exec('osascript', ['-e', script], { maxBuffer: MAX_BUFFER });
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

async function readImageWindows(out, runtime) {
  const exec = runtime.exec || execFileP;
  const cmd = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$img = [System.Windows.Forms.Clipboard]::GetImage();',
    `if ($img) { $img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { '' }`,
  ].join(' ');
  try {
    const { stdout } = await exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { maxBuffer: MAX_BUFFER },
    );
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

async function readImageLinux(out, runtime, fsp) {
  const env = runtime.env || process.env;
  const exec = runtime.exec || execFileP;
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const attempts = wayland
    ? [['wl-paste', ['--type', 'image/png']], ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']]]
    : [['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']], ['wl-paste', ['--type', 'image/png']]];

  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await exec(cmd, args, { encoding: 'buffer', maxBuffer: MAX_BUFFER });
      if (stdout && stdout.length > 0) {
        await fsp.writeFile(out, stdout, { mode: 0o600 });
        return true;
      }
    } catch {}
  }
  return false;
}

// Delete dropped images after this window so $TMPDIR doesn't accumulate one
// file per image paste across a long-lived session. Long enough that any
// command the user launched against the path (claude, file, open, ...) has
// had time to read it.
const DROP_TTL_MS = 5 * 60 * 1000;

function scheduleDropCleanup(filePath, fsp, setTimeoutFn) {
  const timer = setTimeoutFn(() => {
    // Fire-and-forget — no awaiting inside the timer callback.
    Promise.resolve()
      .then(() => fsp.unlink(filePath).catch(() => {}))
      .then(() => fsp.rmdir(path.dirname(filePath)).catch(() => {}));
  }, DROP_TTL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

async function readClipboardImageAsFilePath(runtime = {}) {
  const platform = runtime.platform || process.platform;
  const osModule = runtime.osModule || os;
  const cryptoModule = runtime.cryptoModule || crypto;
  const fsp = (runtime.fsModule && runtime.fsModule.promises) || fs.promises;
  const setTimeoutFn = runtime.setTimeoutFn || setTimeout;

  let dir = null;
  let out = null;
  try {
    dir = await fsp.mkdtemp(path.join(osModule.tmpdir(), 'dormouse-drops-'));
    await fsp.chmod?.(dir, 0o700);
    out = path.join(dir, `${cryptoModule.randomUUID()}-clipboard.png`);
    const ok = platform === 'darwin' ? await readImageMac(out, runtime)
      : platform === 'win32' ? await readImageWindows(out, runtime)
      : await readImageLinux(out, runtime, fsp);
    if (ok && (await fsp.stat(out)).size > 0) {
      await fsp.chmod?.(out, 0o600);
      scheduleDropCleanup(out, fsp, setTimeoutFn);
      return out;
    }
  } catch {}
  if (out) {
    try { await fsp.unlink(out); } catch {}
  }
  if (dir) {
    try { await fsp.rmdir(dir); } catch {}
  }
  return null;
}

// Write text to the OS clipboard via the platform's native CLI (stdin), mirroring
// the native reads above. Backs the agent-browser host's edit channel: copy/cut
// land the grabbed selection on the user's real clipboard (the VS Code host uses
// vscode.env.clipboard.writeText for the same purpose).
function writeViaStdin(cmd, args, text, runtime) {
  const spawnFn = runtime.spawn || spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      reject(err);
      return;
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
    // The tool may exit before we finish writing (EPIPE) — swallow it; `close`
    // with a nonzero code already reports a real failure.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    }
  });
}

async function writeClipboardText(text, runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'darwin') return writeViaStdin('pbcopy', [], text, runtime);
  if (platform === 'win32') return writeViaStdin('clip', [], text, runtime);
  const env = runtime.env || process.env;
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const attempts = wayland
    ? [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
    : [['xclip', ['-selection', 'clipboard']], ['wl-copy', []]];
  let lastErr;
  for (const [cmd, args] of attempts) {
    try { return await writeViaStdin(cmd, args, text, runtime); }
    catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no clipboard write tool available');
}

module.exports = {
  readClipboardFilePaths,
  readClipboardImageAsFilePath,
  readClipboardText,
  writeClipboardText,
  parseUriList,
  splitNonEmptyLines,
};
function splitNonEmptyLines(stdout) {
  return stdout.split(/\r?\n/).filter((s) => s.length > 0);
}
