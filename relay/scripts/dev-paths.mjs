/**
 * Where a dev Relay keeps its state, resolved from this file rather than the
 * cwd so `pnpm dev:relay` from anywhere lands in the same worktree's
 * `relay/data`. `fake-burrow.mjs` reads the setup password the dev Relay wrote,
 * so the two must name the same directory — hence one constant, not two.
 */
import { fileURLToPath } from 'node:url';

export const DEV_STATE_DIR = fileURLToPath(new URL('../data', import.meta.url));
