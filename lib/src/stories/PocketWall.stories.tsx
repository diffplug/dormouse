import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef } from 'react';
import { toBase64Url, utf8Encode, type DirectoryEntry } from 'server-lib-common';
import { PocketWall } from '../remote/pocket-app/PocketWall';
import { RemotePtyAdapter, type RemoteAdapterClient } from '../remote/client/remote-adapter';
import type { TerminalHandlers } from '../remote/client/pocket-client';
import { setPlatform } from '../lib/platform';
import { disposeAllSessions, initAlertStateReceiver } from '../lib/terminal-registry';

// The adapter decodes `terminal.data` as base64url UTF-8, so encode splash text
// the same way the real wire does.
const b64 = (text: string) => toBase64Url(utf8Encode(text));

// One-terminal directory snapshot (id = surfaceId, as the registry binds panes).
const SINGLE_SESSION: DirectoryEntry[] = [
  {
    paneRef: 'pane-1',
    surfaceId: 'pane-1',
    type: 'terminal',
    title: 'zsh',
    focused: true,
    activity: 'prompt',
    alive: true,
    ringing: false,
    hasTODO: false,
  },
];

// Streamed once the wall attaches the pane — stands in for the Host's repaint.
const SPLASH = b64(
  [
    '\x1b[32mDormouse Pocket\x1b[0m connected to \x1b[36mStudio iMac\x1b[0m\r\n',
    '\x1b[2mremote session · one attachment at a time\x1b[0m\r\n',
    '\r\n',
    'ned@studio ~/projects/dormouse % \x1b[7m \x1b[0m\r\n',
  ].join(''),
);

/**
 * Network-free {@link RemoteAdapterClient}: serves a fixed directory snapshot and
 * echoes a splash through the attach handlers, so `PocketWall` renders its real
 * `MobileTerminalUi` + `MobileWall` composition without a live Host.
 */
class FakeRemoteClient implements RemoteAdapterClient {
  #snapshot: DirectoryEntry[];
  #n = 0;

  constructor(snapshot: DirectoryEntry[]) {
    this.#snapshot = snapshot;
  }

  async watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    // Deliver synchronously so the adapter has entries before PocketWall's first
    // render reads `getDirectoryEntries()`.
    onSnapshot(this.#snapshot);
    return 'dir-sub';
  }

  async attach(_surfaceId: string, cols: number, rows: number, handlers: TerminalHandlers) {
    const subId = `attach-${++this.#n}`;
    // Push after the pane's xterm (and its onPtyData handler) is mounted.
    queueMicrotask(() => handlers.onData(SPLASH));
    return { subId, result: { cols, rows } };
  }

  async write() {}
  async resize() {}
  async detach() {}
  unsubscribe() {}
}

function PocketWallStory() {
  const adapterRef = useRef<RemotePtyAdapter | null>(null);
  if (!adapterRef.current) {
    // Mirror App.tsx's onConnect: stand up the adapter as the platform, prep a
    // clean registry, then start the directory watch.
    const adapter = new RemotePtyAdapter(new FakeRemoteClient(SINGLE_SESSION));
    setPlatform(adapter);
    disposeAllSessions();
    initAlertStateReceiver();
    void adapter.init();
    adapterRef.current = adapter;
  }

  useEffect(() => {
    const adapter = adapterRef.current;
    return () => {
      void adapter?.dispose();
      disposeAllSessions();
    };
  }, []);

  return (
    <div
      className="overflow-hidden border border-border shadow-2xl"
      style={{ width: 390, height: 760 }}
    >
      <PocketWall adapter={adapterRef.current} />
    </div>
  );
}

const meta: Meta<typeof PocketWallStory> = {
  title: 'Pocket/PocketWall',
  component: PocketWallStory,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof PocketWallStory>;

// Smoke story: one attached session streaming a splash. Proves the
// adapter → directory → MobileWall wiring (the composition itself is also
// exercised by `App/MobileTerminalUi`'s PocketWall story with a FakePtyAdapter).
export const SingleSession: Story = {};
