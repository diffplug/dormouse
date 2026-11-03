import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `message` listener in the webview realm, classified. A framed page can
 * `postMessage` the webview window, so each window listener must check who sent
 * a message before it acts on one (docs/specs/security-local.md -> "Browser
 * panes"); the test named beside it plants a foreign sender and requires
 * nothing to happen. A listener on a socket or data channel hears only its own
 * peer, never a page. Standalone has none at all: its adapters take host
 * events over their own transport, so a page has no inbox to forge into.
 *
 * Scanned rather than trusted: a new listener fails here until it is placed in
 * one list or the other. `lib/src/host/` is Node, not the webview; the shim it
 * injects into framed pages is pinned by `lib/src/host/iframe-proxy-rewrite.test.ts`.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Window listeners, by file and count, with the test that plants a foreign sender. */
const WINDOW_LISTENERS: Record<string, { count: number; pinnedBy: string }> = {
  // origin is its own proxy origin
  'lib/src/components/wall/IframePanel.tsx': { count: 1, pinnedBy: 'lib/src/components/wall/IframePanel.test.tsx' },
  // the per-boot host token
  'lib/src/lib/platform/vscode-adapter.ts': { count: 2, pinnedBy: 'lib/src/lib/platform/vscode-adapter.test.ts' },
  // origin and source are its own frame
  'lib/src/lib/themes/iframe-theme.ts': { count: 1, pinnedBy: 'lib/src/lib/themes/iframe-theme.test.ts' },
  // origin, source, and connection are its own frame
  'lib/src/lib/tool-editor.ts': { count: 1, pinnedBy: 'lib/src/lib/tool-editor.test.ts' },
};

/** Listeners on a socket or data channel, which no page can address. */
const PEER_LISTENERS: Record<string, number> = {
  'lib/src/components/wall/agent-browser-connection.ts': 1,
  'lib/src/remote/burrow/burrow-runtime.ts': 1,
  'lib/src/remote/burrow/one-time-runtime.ts': 1,
  'lib/src/remote/client/one-time-client.ts': 1,
  'lib/src/remote/client/pocket-client.ts': 1,
  'lib/src/remote/direct/direct-peer.ts': 1,
};

/**
 * A frame origin's, on the worker's and bootstrap page's channels and the Client
 * window's port to them. A framed page shares that origin, so it can write to
 * each: what they accept is what it could fetch through its own grant anyway
 * (`docs/specs/pocket-app.md` -> "Frame origin"), and the test plants a foreign one.
 */
const FRAME_ORIGIN_LISTENERS: Record<string, { count: number; pinnedBy: string }> = {
  // the parent's first port; its worker's relays go down that port
  'lib/src/remote/frame-origin/bootstrap.ts': { count: 2, pinnedBy: 'lib/src/remote/frame-origin/bootstrap.test.ts' },
  // a port the bootstrap page holds, serving one frame's grant
  'lib/src/remote/frame-origin/frame-bridge.ts': { count: 4, pinnedBy: 'lib/src/remote/frame-origin/frame-bridge.test.ts' },
  // a page's socket, and one request's own reply port
  'lib/src/remote/frame-origin/worker.ts': { count: 2, pinnedBy: 'lib/src/remote/frame-origin/worker.test.ts' },
  // a port this window made, asking only whether the bootstrap page is ready; and
  // a new-window request, taken only from its own page's window and origin
  'lib/src/remote/pocket-app/PocketBrowserFrame.tsx': { count: 2, pinnedBy: 'lib/src/remote/pocket-app/PocketBrowserFrame.test.tsx' },
};

const LISTENER = /addEventListener\(\s*['"`]message['"`]|\bonmessage\s*=/g;

function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const root of ['lib/src', 'standalone/src']) {
    for (const entry of readdirSync(join(repo, root), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const rel = relative(repo, join(entry.parentPath, entry.name)).split(sep).join('/');
      if (rel.startsWith('lib/src/host/') || /(^|\/)test-[^/]*$/.test(rel)) continue;
      const count = readFileSync(join(repo, rel), 'utf8').match(LISTENER)?.length ?? 0;
      if (count) found[rel] = count;
    }
  }
  return found;
}

describe('webview message listeners', () => {
  it('are exactly the classified ones, and none in standalone', () => {
    const expected = {
      ...Object.fromEntries(Object.entries(WINDOW_LISTENERS).map(([file, { count }]) => [file, count])),
      ...PEER_LISTENERS,
      ...Object.fromEntries(Object.entries(FRAME_ORIGIN_LISTENERS).map(([file, { count }]) => [file, count])),
    };
    expect(scan()).toEqual(expected);
  });

  it('each name a test that exists', () => {
    for (const { pinnedBy } of [...Object.values(WINDOW_LISTENERS), ...Object.values(FRAME_ORIGIN_LISTENERS)]) {
      expect(() => readFileSync(join(repo, pinnedBy)), pinnedBy).not.toThrow();
    }
  });
});
