/**
 * The webview's end of the bridge, minus the transport — the part every host
 * shares, so a rule proved here holds in the Tauri app, the dev harness, and VS
 * Code alike. What each host adds on top (which message carries what) is
 * covered by its own adapter test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerAskCommand,
  createRemoteHostLinkClient,
  notifyCommand,
  REMOTE_HOST_COMMAND_TIMEOUT_MS,
  type RemoteHostLinkClient,
} from './link-client';
import type { RemoteHostCommand } from './service-protocol';

function fakeTransport() {
  const sent: RemoteHostCommand[] = [];
  const answers: Array<{ askId: string; results: unknown[] }> = [];
  let notified = 0;
  return {
    sent,
    answers,
    notified: () => notified,
    client(): RemoteHostLinkClient {
      return createRemoteHostLinkClient({
        sendCommand: (command) => void sent.push(command),
        answerAsk: (askId, results) => void answers.push({ askId, results }),
        notify: () => void (notified += 1),
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('commands', () => {
  it('resolves the one command its rhId names', async () => {
    const transport = fakeTransport();
    const client = transport.client();

    const pending = client.link.command('status');
    const rhId = transport.sent[0]!.rhId;
    expect(transport.sent[0]).toMatchObject({ cmd: 'status' });

    // A result for somebody else's command must not settle this one.
    client.onResult({ rhId: 'other', result: { enrolled: false } });
    client.onResult({ rhId, result: { enrolled: true } });
    expect(await pending).toEqual({ enrolled: true });
  });

  it('rejects with the error the service reported', async () => {
    const transport = fakeTransport();
    const client = transport.client();
    const pending = client.link.command('enroll', { relayUrl: 'https://nope' });
    client.onResult({ rhId: transport.sent[0]!.rhId, error: 'outside the allowed sources' });
    await expect(pending).rejects.toThrow('outside the allowed sources');
  });

  it('mints ids no sibling webview can collide with', () => {
    // Every webview sees every result, so two of them minting `rh-1` would
    // settle each other's commands.
    const a = fakeTransport();
    const b = fakeTransport();
    void a.client().link.command('status');
    void b.client().link.command('status');
    expect(a.sent[0]!.rhId).not.toBe(b.sent[0]!.rhId);
  });

  it('gives up at the timeout rather than hanging', async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const pending = transport.client().link.command('status');
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(REMOTE_HOST_COMMAND_TIMEOUT_MS);
    await rejected;
  });

  it('ignores a result nothing is waiting for', () => {
    const client = fakeTransport().client();
    expect(() => client.onResult({ rhId: 'nope', result: {} })).not.toThrow();
    expect(() => client.onResult(undefined)).not.toThrow();
  });

  it('rejects everything outstanding when the bridge closes', async () => {
    const client = fakeTransport().client();
    const pending = client.link.command('status');
    client.dispose();
    await expect(pending).rejects.toThrow('remote host bridge closed');
  });
});

describe('asks', () => {
  it('answers with what the responder claims', () => {
    const transport = fakeTransport();
    const client = transport.client();
    client.link.respond('surfaceOp', (params) => [
      { ptyId: 'pty-1', surfaceId: (params as { surfaceId: string }).surfaceId },
    ]);

    client.onAsk('ask-1', 'surfaceOp', { surfaceId: 's1' });
    expect(transport.answers).toEqual([
      { askId: 'ask-1', results: [{ ptyId: 'pty-1', surfaceId: 's1' }] },
    ]);
  });

  it('always answers — with no responder, and with a responder that threw', () => {
    // The service holds the ask open for its whole budget otherwise, and an
    // attach waits on it. An empty answer claims nothing, so it cannot beat the
    // webview that really owns the surface.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = fakeTransport();
    const client = transport.client();

    client.onAsk('ask-1', 'directory', {});
    client.link.respond('directory', () => {
      throw new Error('registry exploded');
    });
    client.onAsk('ask-2', 'directory', {});

    expect(transport.answers).toEqual([
      { askId: 'ask-1', results: [] },
      { askId: 'ask-2', results: [] },
    ]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('events and notifies', () => {
  it('fans an event to its own subscribers only, until they unsubscribe', () => {
    const client = fakeTransport().client();
    const seen: unknown[] = [];
    const unsubscribe = client.link.on('pairing-queue', (data) => void seen.push(data));

    client.onEvent({ name: 'pairing-queue', queue: [{ clientId: 'c1' }] });
    client.onEvent({ name: 'something-else', queue: [] });
    client.onEvent(null);
    expect(seen).toEqual([{ name: 'pairing-queue', queue: [{ clientId: 'c1' }] }]);

    unsubscribe();
    client.onEvent({ name: 'pairing-queue', queue: [] });
    expect(seen).toHaveLength(1);
  });

  it('sends a notify through the transport, not as a command', () => {
    const transport = fakeTransport();
    transport.client().link.notify();
    expect(transport.notified()).toBe(1);
    expect(transport.sent).toEqual([]);
  });
});

describe('tunnelled envelopes', () => {
  it('carries the ask’s own id in the params, never in the envelope', () => {
    // The envelope's `rhId` is answered by nobody; the service settles the ask
    // named inside it.
    const answer = answerAskCommand('ask-1', [{ ptyId: 'pty-1' }]);
    expect(answer).toMatchObject({
      cmd: 'answer',
      params: { rhId: 'ask-1', results: [{ ptyId: 'pty-1' }] },
    });
    expect(answer.rhId).not.toBe('ask-1');
    // A notify names nothing: the directory is the only answer a peer gives.
    expect(notifyCommand()).toMatchObject({ cmd: 'notify' });
    expect(notifyCommand().params).toBeUndefined();
  });
});
