#!/usr/bin/env node
// Wraps the Tauri CLI so `pnpm tauri …` always stages the sidecar bundles first.
//
// The remote-server allowlist is no longer a webview concern: the Burrow runs in
// the sidecar, and `DORMOUSE_REMOTE_CONNECT_SRC` is baked into that bundle by
// `build-sidecar-proxy.mjs` (which `pnpm run stage` runs ahead of this). The
// webview's CSP in tauri.conf.json has no remote sources at all.
//
// cross-spawn (matches the other scripts here): resolves the local `tauri`
// bin and behaves on Windows where a bare spawn('pnpm', …) can't.
import spawn from 'cross-spawn';

const child = spawn('pnpm', ['exec', 'tauri', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
