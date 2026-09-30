#!/usr/bin/env node
// Wraps the Tauri CLI so `pnpm tauri …` always stages the sidecar bundles first.
//
// `tauri dev` stages a dev build (`stage:dev`) and every other subcommand a
// release build (`stage`): the sidecar bundle bakes the relay origin, and only a
// dev build may bake `DORMOUSE_RELAY_IS_HOSTED` or a loopback http:// origin
// (docs/specs/relay.md → "Relay origin"). The webview's CSP in tauri.conf.json
// has no relay sources at all.
//
// cross-spawn (matches the other scripts here): resolves the local `tauri`
// bin and behaves on Windows where a bare spawn('pnpm', …) can't.
import spawn from 'cross-spawn';

const dev = process.argv[2] === 'dev';

const staged = spawn.sync('pnpm', ['run', dev ? 'stage:dev' : 'stage'], { stdio: 'inherit' });
if (staged.error) {
  console.error(staged.error);
  process.exit(1);
}
if (staged.status !== 0) process.exit(staged.status ?? 1);

if (dev) {
  const { runDev } = await import('./dev-standalone.mjs');
  await runDev(process.argv.slice(3));
} else {
  const child = spawn('pnpm', ['exec', 'tauri', ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('error', err => { console.error(err); process.exit(1); });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
