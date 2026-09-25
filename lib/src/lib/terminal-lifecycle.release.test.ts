// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two teardown verbs differ in exactly one thing — whether the process
 * dies — and that difference is what makes a Workspace transfer possible
 * (`docs/specs/transport.md` → "Transferring a Workspace").
 */

vi.mock('@xterm/xterm', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('./xterm-test-mock'));

vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const fakePlatform = new actual.FakePtyAdapter();
  return { ...actual, getPlatform: () => fakePlatform, __fakePlatform: fakePlatform };
});

import * as platformModule from './platform';
import type { FakePtyAdapter } from './platform';
import {
  disposeSession,
  getOrCreateTerminal,
  getTerminalInstance,
  releaseSession,
} from './terminal-registry';

const platform = (platformModule as unknown as { __fakePlatform: FakePtyAdapter }).__fakePlatform;

let killed: string[];

beforeEach(() => {
  killed = [];
  vi.spyOn(platform, 'killPty').mockImplementation((id: string) => void killed.push(id));
});

describe('releaseSession', () => {
  // The kill is also what removes the host's alert entry, which is the
  // Session's, not this Window's: a departure or a refused arrival that removed
  // it would wipe a ring or TODO the other Window is showing
  // (docs/specs/alert.md → Live Workspace transfer).
  it('never kills the PTY, unlike disposeSession', () => {
    getOrCreateTerminal('pane-1');
    releaseSession('pane-1');
    expect(killed).toEqual([]);

    getOrCreateTerminal('pane-2');
    disposeSession('pane-2');
    expect(killed).toEqual(['pane-2']);
  });

  it("drops this webview's half of the Session", () => {
    getOrCreateTerminal('pane-1');
    expect(getTerminalInstance('pane-1')).not.toBeNull();
    releaseSession('pane-1');
    // The registry entry and the xterm instance are gone: the target Window
    // builds its own over the same, still-running PTY.
    expect(getTerminalInstance('pane-1')).toBeNull();
  });

  it('is a no-op for an id the registry does not hold', () => {
    expect(() => releaseSession('never-existed')).not.toThrow();
    expect(killed).toEqual([]);
  });
});
