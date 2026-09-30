#!/usr/bin/env node
// Wraps the Tauri CLI. `tauri dev` stages the sidecar bundles as a dev build
// first; `tauri build` leaves staging to `beforeBuildCommand` (`pnpm build`), a
// release build. Which builds may bake what: docs/specs/relay.md → "Relay
// origin". The webview's CSP in tauri.conf.json has no relay sources at all.
//
// cross-spawn (matches the other scripts here): resolves the local `tauri`
// bin and behaves on Windows where a bare spawn('pnpm', …) can't.
import spawn from 'cross-spawn';
import { resolveRelayOrigin } from '../../scripts/relay-origin.mjs';

/**
 * What a self-host `tauri build` overlays on tauri.conf.json: no updater
 * endpoint, so the binary cannot reach dormouse.sh, and no updater artifacts,
 * which only the release signing key can sign (docs/specs/standalone.md →
 * "Build and development").
 */
const SELF_HOST_BUILD_CONFIG = {
  bundle: { createUpdaterArtifacts: false },
  plugins: { updater: { endpoints: [] } },
};

const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === 'dev') {
  const staged = spawn.sync('pnpm', ['run', 'stage:dev'], { stdio: 'inherit' });
  if (staged.error) {
    console.error(staged.error);
    process.exit(1);
  }
  if (staged.status !== 0) process.exit(staged.status ?? 1);
  const { runDev } = await import('./dev-standalone.mjs');
  await runDev(rest);
} else {
  const args = process.argv.slice(2);
  // Resolved here as well as by the build it runs, which bakes the same pair.
  if (subcommand === 'build' && resolveRelayOrigin(process.env, 'tauri').mode === 'self-host') {
    args.splice(1, 0, '--config', JSON.stringify(SELF_HOST_BUILD_CONFIG));
  }
  const child = spawn('pnpm', ['exec', 'tauri', ...args], { stdio: 'inherit' });
  child.on('error', err => { console.error(err); process.exit(1); });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
