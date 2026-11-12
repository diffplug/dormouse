// @vitest-environment jsdom
import { afterEach, beforeEach, vi } from 'vitest';
import { adapterContract, type SentRecord } from './adapter-contract-test-utils';
import { HOST_MESSAGE_TOKEN_FIELD, HOST_MESSAGE_TOKEN_GLOBAL } from '../vscode-message-token';
import { VSCodeAdapter } from './vscode-adapter';

/**
 * `VSCodeAdapter` under the shared contract, its extension host played as the
 * token-stamped `message` events `serveWebview` posts. The host answers no
 * request here: silence is the one failure this transport has of its own, so
 * every request meets its deadline on the faked clock. The router's error
 * replies are `vscode-adapter.test.ts`'s.
 */
const TOKEN = 'contract-host-token';

/** Each webview message the contract observes, in its words. */
const WIRE: Record<string, (message: Record<string, any>) => SentRecord> = {
  'pty:spawn': ({ id, options }) => ({ op: 'spawn', id, options }),
  'pty:sendInput': ({ id, events }) => ({ op: 'sendInput', id, events }),
  'pty:input': ({ id, data }) => ({ op: 'write', id, data }),
  'pty:resize': ({ id, cols, rows }) => ({ op: 'resize', id, cols, rows }),
  'pty:kill': ({ id }) => ({ op: 'kill', id }),
  'pty:ack': ({ id, chars }) => ({ op: 'ack', id, chars }),
  'dormouse:init': ({ requestId }) => ({ op: 'init', requestId }),
  'dormouse:themeColors': ({ foreground, background, cursor }) => ({ op: 'theme', foreground, background, cursor }),
  'alert:command': ({ command }) => ({ op: 'alert', command }),
  'pty:getCwds': ({ ids }) => ({ op: 'cwds', ids }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(HOST_MESSAGE_TOKEN_GLOBAL, TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

adapterContract('vscode', async () => {
  const posted: Array<Record<string, any>> = [];
  let state: unknown;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (message: Record<string, any>) => void posted.push(message),
    getState: () => state,
    setState: (next: unknown) => { state = next; },
  }));
  const adapter = new VSCodeAdapter();
  const host = (data: Record<string, unknown>) =>
    void window.dispatchEvent(new MessageEvent('message', { data: { ...data, [HOST_MESSAGE_TOKEN_FIELD]: TOKEN } }));
  return {
    adapter,
    completeInput: (error) => host({ type: 'pty:inputDone', requestId: posted.at(-1)!.requestId, ...(error ? { error } : { delivered: true }) }),
    data: (id, data, textData) => host({ type: 'pty:data', id, data, textData }),
    exit: (id, exitCode) => host({ type: 'pty:exit', id, exitCode }),
    list: ({ ptys, requestId }) => host({ type: 'pty:list', ptys, requestId }),
    replay: ({ id, data, requestId }) => host({ type: 'pty:replay', id, data, requestId }),
    sent: () => posted.flatMap((message) => WIRE[message.type]?.(message) ?? []),
    failRequests: () => {},
    settle: async (promise) => {
      await vi.advanceTimersByTimeAsync(60_000);
      return promise;
    },
  };
});
