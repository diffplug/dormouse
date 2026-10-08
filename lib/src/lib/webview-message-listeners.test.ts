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
  // origin is a live proxy grant
  'lib/src/components/wall/use-wall-keyboard.ts': { count: 1, pinnedBy: 'lib/src/components/wall/use-wall-keyboard.test.tsx' },
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
    };
    expect(scan()).toEqual(expected);
  });

  it('each name a test that exists', () => {
    for (const { pinnedBy } of Object.values(WINDOW_LISTENERS)) {
      expect(() => readFileSync(join(repo, pinnedBy)), pinnedBy).not.toThrow();
    }
  });
});
