/**
 * Where a dev Relay keeps its state, resolved from this file rather than the
 * cwd so `pnpm dev:relay` from anywhere lands in the same worktree's
 * `relay/data`. `fake-burrow.mjs` reads the setup password the dev Relay wrote,
 * so the two must name the same directory — hence one constant, not two.
 */
import { fileURLToPath } from 'node:url';

export const DEV_STATE_DIR = fileURLToPath(new URL('../data', import.meta.url));

/**
 * An explicit `DORMOUSE_STATE_DIR`, else {@link DEV_STATE_DIR}. A terminal from
 * a Dormouse that predates keeping its sidecar's storage roots out of panes
 * inherits the app's state root as both `DORMOUSE_STATE_DIR` and
 * `DORMOUSE_RECOVERY_DIR`; that pair reads as unset, so a dev Relay never
 * writes into the installed app.
 */
export function devStateDir(env) {
  const explicit = env.DORMOUSE_STATE_DIR;
  return explicit === undefined || explicit === env.DORMOUSE_RECOVERY_DIR ? DEV_STATE_DIR : explicit;
}
