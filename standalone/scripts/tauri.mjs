#!/usr/bin/env node
// Wraps the Tauri CLI so a custom (self-host) build can retarget the CSP's
// remote-server `connect-src` without editing the checked-in default.
//
// Unset (the shipped binary): the tight default in tauri.conf.json applies
//   (SaaS origin `*.dormouse.sh` only).
// Set DORMOUSE_REMOTE_CONNECT_SRC="https://my.host wss://my.host": the default
//   remote sources are replaced with that value via a `--config` override, so
//   the checked-in config stays clean and the shipped default stays secure.
//
// cross-spawn (matches the other scripts here): resolves the local `tauri`
// bin and behaves on Windows where a bare spawn('pnpm', …) can't.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import spawn from 'cross-spawn';
import { withRemoteConnectSrc } from './csp.mjs';

const args = process.argv.slice(2);
const remoteSrc = process.env.DORMOUSE_REMOTE_CONNECT_SRC?.trim();

if (remoteSrc) {
  const here = dirname(fileURLToPath(import.meta.url));
  const conf = JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp = withRemoteConnectSrc(conf.app.security.csp, remoteSrc);
  args.push('--config', JSON.stringify({ app: { security: { csp } } }));
  console.error(`[tauri] connect-src remote sources overridden via DORMOUSE_REMOTE_CONNECT_SRC=${remoteSrc}`);
}

const child = spawn('pnpm', ['exec', 'tauri', ...args], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
