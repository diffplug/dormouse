import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `message` listener in the webview realm, classified. A framed page can
 * `postMessage` the webview window, so each window listener must check who sent
 * a message before it acts on one (docs/specs/security-local.md -> "Browser
 * panes"); the test named beside it plants a foreign sender and requires
 * nothing to happen. A listener on a socket or data channel hears only its own
 * peer, never a page.
 *
 * Scanned rather than trusted: a new listener fails here until it is placed in
 * one list or the other, with the test that pins its check. `lib/src/host/` is
 * Node, not the webview; the shim it injects into framed pages is pinned by
 * `lib/src/host/iframe-proxy-rewrite.test.ts`.
 */

/** Window listeners, by file and count, with what each checks and its pin. */
const WINDOW_LISTENERS: Record<string, { count: number; checks: string; pinnedBy: string }> = {
  'components/wall/IframePanel.tsx': { count: 1, checks: 'origin is its own proxy origin', pinnedBy: 'components/wall/IframePanel.test.tsx' },
  'components/wall/use-wall-keyboard.ts': { count: 1, checks: 'origin is a live proxy grant', pinnedBy: 'components/wall/use-wall-keyboard.test.tsx' },
  'lib/platform/vscode-adapter.ts': { count: 2, checks: 'the per-boot host token', pinnedBy: 'lib/platform/vscode-adapter.test.ts' },
  'lib/themes/iframe-theme.ts': { count: 1, checks: 'origin and source are its own frame', pinnedBy: 'lib/themes/iframe-theme.test.ts' },
  'lib/tool-editor.ts': { count: 1, checks: 'origin, source, and connection are its own frame', pinnedBy: 'lib/tool-editor.test.ts' },
};

/** Listeners on a socket or data channel, which no page can address. */
const PEER_LISTENERS: Record<string, number> = {
  'components/wall/agent-browser-connection.ts': 1,
  'remote/burrow/burrow-runtime.ts': 1,
  'remote/burrow/one-time-runtime.ts': 1,
  'remote/client/one-time-client.ts': 1,
  'remote/client/pocket-client.ts': 1,
  'remote/direct/direct-peer.ts': 1,
};

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const LISTENER = /addEventListener\(\s*['"`]message['"`]|\bonmessage\s*=/g;

function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const rel = relative(src, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (rel.startsWith('host/') || /(^|\/)test-[^/]*$/.test(rel)) continue;
    const count = readFileSync(join(entry.parentPath, entry.name), 'utf8').match(LISTENER)?.length ?? 0;
    if (count) found[rel] = count;
  }
  return found;
}

describe('webview message listeners', () => {
  it('are exactly the classified ones', () => {
    const expected = {
      ...Object.fromEntries(Object.entries(WINDOW_LISTENERS).map(([file, { count }]) => [file, count])),
      ...PEER_LISTENERS,
    };
    expect(scan()).toEqual(expected);
  });

  it('each name a test that exists', () => {
    for (const { pinnedBy } of Object.values(WINDOW_LISTENERS)) {
      expect(() => readFileSync(join(src, pinnedBy)), pinnedBy).not.toThrow();
    }
  });
});
