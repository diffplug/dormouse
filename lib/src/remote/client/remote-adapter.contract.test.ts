import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from 'remote-lib-common';
import { adapterContract, type SentRecord } from '../../lib/platform/adapter-contract-test-utils';
import { RemotePtyAdapter, type RemoteAdapterClient, type TerminalHandlers } from './remote-adapter';
import { FRESH_TERMINAL_MODES } from '../test-terminal-modes';

/**
 * `RemotePtyAdapter` under the shared contract, its Burrow played as a
 * network-free protocol-v1 session: output and exits reach only the attached
 * pane, so the harness attaches before it speaks for one.
 */
adapterContract('remote', async () => {
  const sent: SentRecord[] = [];
  const attached = new Map<string, TerminalHandlers>();
  const client: RemoteAdapterClient = {
    watchDirectory: async () => 'directory',
    attach: async (surfaceId, cols, rows, handlers) => {
      attached.set(surfaceId, handlers);
      return { subId: `sub-${surfaceId}`, result: { cols, rows, modes: FRESH_TERMINAL_MODES } };
    },
    write: async (id, bytes) => void sent.push({ op: 'write', id, data: utf8Decode(fromBase64Url(bytes)) }),
    resize: async (id, cols, rows) => void sent.push({ op: 'resize', id, cols, rows }),
    detach: async () => undefined,
    unsubscribe: () => {},
  };
  const adapter = new RemotePtyAdapter(client);
  await adapter.init();
  const show = async (id: string) => { if (adapter.activeSurfaceId !== id) await adapter.setActivePane(id); };
  const encode = (text: string) => toBase64Url(utf8Encode(text));
  return {
    adapter,
    data: async (id, data, textData) => {
      await show(id);
      attached.get(id)!.onData({ bytes: encode(data), ...(textData === undefined ? {} : { text: encode(textData) }) });
    },
    exit: async (id, exitCode) => {
      await show(id);
      attached.get(id)!.onClosed?.(exitCode);
    },
    sent: () => sent,
    show,
    settle: (promise) => promise,
  };
});
