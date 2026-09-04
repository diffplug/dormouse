#!/usr/bin/env node
/**
 * The dev runner: `dist/index.js` with a loopback default.
 *
 * A wrapper rather than an env prefix in `package.json`, because
 * `${DORMOUSE_BIND_HOST:-127.0.0.1}` is a shell-ism that a Windows contributor's
 * `pnpm dev:server` would pass through literally.
 *
 * **No `--watch`**, which this replaced: it watched `dist/`, nothing in the repo
 * runs `tsc -w`, so it fired only for someone already running one by hand. Add
 * it back here rather than in `package.json` if that loop is ever wanted —
 * Node's watcher follows the dynamic import below.
 *
 * **Unset means every interface** (`server/src/config.ts`) — right for a
 * container, where the namespace is the boundary, and wrong for a laptop, where
 * it publishes the plaintext port to the LAN and the tailnet
 * (`docs/specs/security-remote.md` -> "Network posture (self-hosted)"). `start`
 * keeps the shipped default; only this dev path opts into loopback, and an
 * explicit value still wins.
 */

process.env.DORMOUSE_BIND_HOST ??= '127.0.0.1';
await import('../dist/index.js');
