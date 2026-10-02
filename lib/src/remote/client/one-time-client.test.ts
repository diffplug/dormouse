/**
 * The phone's one-time client against a Burrow each case scripts by hand: a
 * **real** Noise IK responder on the link's one-use key, on the far end of the
 * phone's own rendezvous socket, so a case can put any frame, outcome, or close
 * on it (`docs/specs/one-time.md` -> "Phone client").
 *
 * The whole loop against the real `OneTimeRuntime` — the switch, protocol-v1
 * over the channel, the ending — is `./one-time-e2e.test.ts`. Every deadline
 * here runs on one injected test clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ONE_TIME_FRAME_LENGTH,
  NoiseTransportSession,
  ONE_TIME_DENIAL_CODES,
  DIRECT_ONLY_DEADLINE_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  ONE_TIME_EXPIRY_GRACE_MS,
  ONE_TIME_LINK_TTL_MS,
  RELAY_PING,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_PEER_GONE,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  WS_CLOSE_ONE_TIME_VIOLATION,
  createNoiseResponder,
  fromBase64Url,
  generateNoiseKeyPair,
  oneTimeLinkPrologue,
  toBase64Url,
  type NoiseKeyPair,
  type OneTimeLink,
} from 'remote-lib-common';

import {
  ONE_TIME_DENIAL_MESSAGES,
  ONE_TIME_DIRECT_FAILED_MESSAGE,
  ONE_TIME_ENDED_MESSAGE,
  ONE_TIME_LINK_EXPIRED_MESSAGE,
  ONE_TIME_LINK_USED_MESSAGE,
  ONE_TIME_UNREACHABLE_MESSAGE,
  OneTimeClient,
  type OneTimeClientDeps,
  type OneTimeResult,
} from './one-time-client';
import type { PageVisibility } from './session-core';
import { FakeDirectNetwork, collect, type FakePeer } from '../direct/test-fake-peer';
import {
  FORGED_CT,
  flushUntil,
  openReceipt,
  settle,
  settleUntil,
  testRoutingId,
} from '../test-e2e-client';
import { FakeSocket } from '../test-fake-socket';
import { RendezvousSocket, oneTimeFrameText } from '../test-rendezvous';
import { createTestClock, type TestClock } from '../test-timers';

const WS_ORIGIN = 'wss://hosted.example';
const START = 1_700_000_000_000;
const LABEL = 'iPhone';

const VISIBLE: PageVisibility = { isVisible: () => true, subscribe: () => () => {} };

let clock: TestClock;
/** Every socket the client asked for, and the URL it asked with, in order. */
let sockets: RendezvousSocket[];
let urls: string[];
/** The phone's peer connections, so a case can see one closed. */
let offerers: FakePeer[];
let network: FakeDirectNetwork;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock = createTestClock(START);
  sockets = [];
  urls = [];
  offerers = [];
  network = new FakeDirectNetwork({ opening: 'never' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A client whose sockets open on the next microtask, as a room accepts one —
 * or, with `open: false`, never, as a refused upgrade looks from here.
 */
function makeClient(
  options: { open?: boolean } & Partial<Pick<OneTimeClientDeps, 'createDirectPeer'>> = {},
): OneTimeClient {
  return new OneTimeClient({
    wsOrigin: WS_ORIGIN,
    createWebSocket: (url) => {
      urls.push(url);
      const socket = new RendezvousSocket();
      sockets.push(socket);
      if (options.open !== false) queueMicrotask(() => socket.open());
      return socket;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    visibility: VISIBLE,
    createDirectPeer:
      options.createDirectPeer === undefined
        ? collect(offerers, () => network.createOfferer())
        : options.createDirectPeer,
  });
}

/** The phone's one socket; throws where it has not opened one. */
function phoneSocket(): RendezvousSocket {
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('the phone opened no socket');
  return socket;
}

/** Every JSON frame the phone put on its socket, in order. */
function fromPhone(): Array<Record<string, unknown>> {
  return phoneSocket().sentFrames();
}

/**
 * The Burrow at the far end of the phone's socket: the link's one-use
 * responder, driven step by step. Reads the phone's transport messages in
 * order, which is the only order its receive nonce accepts.
 */
class ScriptedBurrow {
  session: NoiseTransportSession | null = null;
  /** The static the phone presented in message 1. */
  phoneStatic: Uint8Array | null = null;
  #read = 0;

  constructor(
    readonly link: OneTimeLink,
    readonly keyPair: NoiseKeyPair,
  ) {}

  static async create(expiresAt = START + ONE_TIME_LINK_TTL_MS): Promise<ScriptedBurrow> {
    const keyPair = await generateNoiseKeyPair();
    const link: OneTimeLink = {
      roomId: testRoutingId(),
      expiry: Math.floor(expiresAt / 1000),
      ephPub: keyPair.publicKey,
      ephPubBase64Url: toBase64Url(keyPair.publicKey),
    };
    return new ScriptedBurrow(link, keyPair);
  }

  /** Read the phone's message 1 and answer it — with `payload` where a case forges one. */
  async answerInit(payload?: Uint8Array): Promise<void> {
    const init = await flushUntil(() => (sockets.length > 0 ? fromPhone()[0] : undefined));
    expect(init.step).toBe('init');
    const responder = await createNoiseResponder({
      prologue: oneTimeLinkPrologue(this.link),
      staticKeyPair: this.keyPair,
    });
    await responder.readMessage(fromBase64Url(init.ct as string));
    this.phoneStatic = responder.remoteStaticPublicKey ?? null;
    const message2 = await responder.writeMessage(payload);
    this.session = new NoiseTransportSession(responder.session);
    this.deliver('response', message2);
  }

  /** The phone's next transport message, opened. */
  async next(): Promise<unknown> {
    const frame = await flushUntil(() => fromPhone().filter((f) => f.step === 'transport')[this.#read]);
    this.#read += 1;
    return openReceipt(this.session!, fromBase64Url(frame.ct as string));
  }

  /** Every phone transport message not yet read, opened, without waiting for more. */
  rest(): unknown[] {
    const unread = fromPhone().filter((f) => f.step === 'transport').slice(this.#read);
    this.#read += unread.length;
    return unread.map((frame) => openReceipt(this.session!, fromBase64Url(frame.ct as string)));
  }

  sendControl(value: Record<string, unknown>): void {
    this.deliver('transport', this.session!.sendControl(value));
  }

  deliver(step: 'response' | 'transport', ciphertext: Uint8Array): void {
    phoneSocket().deliver(oneTimeFrameText(step, ciphertext));
  }
}

/** Start a connection, answer message 1, and read the request the code was shown for. */
async function confirming(client: OneTimeClient, burrow: ScriptedBurrow): Promise<{
  result: Promise<OneTimeResult>;
  shown: string;
}> {
  let shown: string | null = null;
  const result = client.connectOnce(burrow.link, LABEL, (code) => {
    shown = code;
  });
  await burrow.answerInit();
  const request = (await burrow.next()) as Record<string, unknown>;
  expect(request).toEqual({ code: shown, label: LABEL });
  return { result, shown: shown! };
}

/**
 * Confirmed: the phone holds an `ok` outcome and has offered its direct path.
 * The result is wrapped, since an async function returning a bare promise
 * would wait for it.
 */
async function connecting(
  client: OneTimeClient,
  burrow: ScriptedBurrow,
): Promise<{ result: Promise<OneTimeResult> }> {
  const { result } = await confirming(client, burrow);
  burrow.sendControl({ ok: true, burrowLabel: 'Ned’s laptop' });
  const offer = (await burrow.next()) as Record<string, unknown>;
  expect(offer.t).toBe('direct-offer');
  return { result };
}

describe('OneTimeClient: the rendezvous socket', () => {
  it('opens no socket until connectOnce, then joins the link’s room on the client route', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    await settle();
    expect(sockets).toHaveLength(0);

    const result = client.connectOnce(burrow.link, LABEL, () => {});
    await burrow.answerInit();
    expect(urls).toEqual([`${WS_ORIGIN}/api/one-time/client?room=${burrow.link.roomId}`]);
    client.close();
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
    expect(phoneSocket().closeCode).toBe(1000);
  });

  it('opens no socket for a link already past its expiry', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    clock.advance(burrow.link.expiry * 1000 + 1 - START);
    expect(await client.connectOnce(burrow.link, LABEL, () => {})).toEqual({
      ok: false,
      message: ONE_TIME_LINK_EXPIRED_MESSAGE,
    });
    expect(sockets).toHaveLength(0);
  });

  it('measures a frame against the bound before parsing it', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const shown: string[] = [];
    void client.connectOnce(burrow.link, LABEL, (code) => void shown.push(code));
    await flushUntil(() => (sockets.length > 0 && fromPhone().length > 0 ? true : undefined));
    const parse = vi.spyOn(JSON, 'parse');
    // Valid JSON, and a well-shaped frame, one character past the bound.
    const oversize = oneTimeFrameText('response', 'AAAA').padEnd(
      MAX_ONE_TIME_FRAME_LENGTH + 1,
      ' ',
    );
    phoneSocket().deliver(oversize);
    expect(parse.mock.calls.some(([text]) => text === oversize)).toBe(false);
    parse.mockRestore();
    // The honest answer still completes the handshake behind it.
    await burrow.answerInit();
    await settleUntil(() => shown.length > 0);
    expect(shown).toHaveLength(1);
    client.close();
  });

  it('ignores a pong, a non-string, and every frame its guard refuses', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const shown: string[] = [];
    void client.connectOnce(burrow.link, LABEL, (code) => void shown.push(code));
    await flushUntil(() => (sockets.length > 0 && fromPhone().length > 0 ? true : undefined));
    const socket = phoneSocket();
    const parse = vi.spyOn(JSON, 'parse');
    socket.deliver(RELAY_PONG);
    // A whole-string compare, never a parse.
    expect(parse.mock.calls.some(([text]) => text === RELAY_PONG)).toBe(false);
    parse.mockRestore();
    socket.deliver(new Uint8Array(8).buffer);
    socket.deliver('{"t":"one-time"');
    // A phone's own step, an extra key, and a relay envelope: none is the Burrow's.
    socket.deliver(JSON.stringify({ t: 'one-time', step: 'init', ct: 'AAAA' }));
    socket.deliver(JSON.stringify({ t: 'one-time', step: 'response', ct: 'AAAA', extra: 1 }));
    socket.deliver(JSON.stringify({ t: 'e2e', step: 'response', ct: 'AAAA' }));
    await settle();
    expect(shown).toEqual([]);
    await burrow.answerInit();
    await settleUntil(() => shown.length > 0);
    expect(shown).toHaveLength(1);
    client.close();
  });

  it('pings while the socket is open, and stops once it closes', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const result = client.connectOnce(burrow.link, LABEL, () => {});
    await burrow.answerInit();
    const pings = () => phoneSocket().sent.filter((data) => data === RELAY_PING).length;
    clock.advance(RELAY_PING_INTERVAL_MS - 1);
    expect(pings()).toBe(0);
    clock.advance(1);
    expect(pings()).toBe(1);
    clock.advance(RELAY_PING_INTERVAL_MS);
    expect(pings()).toBe(2);
    phoneSocket().closeWith(WS_CLOSE_ONE_TIME_PEER_GONE);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
    clock.advance(RELAY_PING_INTERVAL_MS);
    expect(pings()).toBe(2);
    expect(clock.armed).toBe(0);
  });
});

describe('OneTimeClient: the key', () => {
  it('mints a fresh static per handshake whose private half never leaves WebCrypto', async () => {
    const generateKey = vi.spyOn(globalThis.crypto.subtle, 'generateKey');
    const exportKey = vi.spyOn(globalThis.crypto.subtle, 'exportKey');
    const statics: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const client = makeClient();
      const burrow = await ScriptedBurrow.create();
      sockets = [];
      const result = client.connectOnce(burrow.link, LABEL, () => {});
      await burrow.answerInit();
      statics.push(toBase64Url(burrow.phoneStatic!));
      client.close();
      await result;
    }
    expect(statics[0]).not.toBe(statics[1]);
    const x25519 = generateKey.mock.calls.filter(([algorithm]) => {
      const name = typeof algorithm === 'string' ? algorithm : (algorithm as { name?: string }).name;
      return name === 'X25519';
    });
    // The static and the ephemeral, for each run — and none of them extractable.
    expect(x25519.length).toBeGreaterThanOrEqual(4);
    expect(x25519.every(([, extractable]) => extractable === false)).toBe(true);
    for (const [format, key] of exportKey.mock.calls) {
      expect(format).toBe('raw');
      expect((key as CryptoKey).type).toBe('public');
    }
  });
});

describe('OneTimeClient: the confirmation', () => {
  it('shows the code before the request carries it, with the label and nothing else', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    let sentBeforeCode = -1;
    const result = client.connectOnce(burrow.link, LABEL, () => {
      sentBeforeCode = fromPhone().filter((f) => f.step === 'transport').length;
    });
    await burrow.answerInit();
    const request = await burrow.next();
    expect(sentBeforeCode).toBe(0);
    expect(Object.keys(request as object).sort()).toEqual(['code', 'label']);
    client.close();
    await result;
  });

  it('answers each denial with its own fixed copy, and closes the room normally', async () => {
    for (const code of ONE_TIME_DENIAL_CODES) {
      sockets = [];
      const client = makeClient();
      const burrow = await ScriptedBurrow.create();
      const { result } = await confirming(client, burrow);
      burrow.sendControl({ ok: false, code });
      expect(await result).toEqual({ ok: false, message: ONE_TIME_DENIAL_MESSAGES[code] });
      expect(phoneSocket().closeCode).toBe(1000);
    }
  });

  it('tells the page once an ok outcome is read, before its peer exists, and never on a denial', async () => {
    const confirmed: number[] = [];
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const result = client.connectOnce(burrow.link, LABEL, () => {}, () => {
      confirmed.push(offerers.length);
    });
    await burrow.answerInit();
    await burrow.next();
    expect(confirmed).toEqual([]);
    burrow.sendControl({ ok: true, burrowLabel: 'Ned’s laptop' });
    expect(((await burrow.next()) as Record<string, unknown>).t).toBe('direct-offer');
    expect(confirmed).toEqual([0]);
    client.close();
    await result;
    expect(confirmed).toEqual([0]);

    sockets = [];
    const denied = makeClient();
    const second = await ScriptedBurrow.create();
    const deniedResult = denied.connectOnce(second.link, LABEL, () => {}, () => {
      confirmed.push(-1);
    });
    await second.answerInit();
    await second.next();
    second.sendControl({ ok: false, code: 'user-denied' });
    expect(await deniedResult).toEqual({ ok: false, message: ONE_TIME_DENIAL_MESSAGES['user-denied'] });
    expect(confirmed).toEqual([0]);
  });

  it('refuses a message 2 that carries a payload, and sends no request', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const shown: string[] = [];
    const result = client.connectOnce(burrow.link, LABEL, (code) => void shown.push(code));
    await burrow.answerInit(new Uint8Array([1]));
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DENIAL_MESSAGES['burrow-error'] });
    expect(shown).toEqual([]);
    expect(fromPhone().filter((f) => f.step === 'transport')).toEqual([]);
  });

  it('reads an outcome its guard refuses as the computer’s error', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const { result } = await confirming(client, burrow);
    burrow.sendControl({ ok: false, code: 'Visit evil.example to continue' });
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DENIAL_MESSAGES['burrow-error'] });
    expect(offerers).toHaveLength(0);
  });

  it('reads each close the room makes before the outcome as fixed copy', async () => {
    const cases: Array<[number, string]> = [
      [WS_CLOSE_ONE_TIME_TAKEN, ONE_TIME_LINK_USED_MESSAGE],
      [WS_CLOSE_ONE_TIME_UNAVAILABLE, ONE_TIME_LINK_USED_MESSAGE],
      [WS_CLOSE_ONE_TIME_EXPIRED, ONE_TIME_LINK_EXPIRED_MESSAGE],
      [WS_CLOSE_ONE_TIME_DEADLINE, ONE_TIME_LINK_EXPIRED_MESSAGE],
      [WS_CLOSE_ONE_TIME_PEER_GONE, ONE_TIME_ENDED_MESSAGE],
      [WS_CLOSE_ONE_TIME_VIOLATION, ONE_TIME_ENDED_MESSAGE],
      [1006, ONE_TIME_ENDED_MESSAGE],
    ];
    for (const [code, message] of cases) {
      // Refused at the join, as the room does it: accepted, then closed.
      sockets = [];
      const refused = makeClient();
      const early = await ScriptedBurrow.create();
      const joined = refused.connectOnce(early.link, LABEL, () => {});
      await flushUntil(() => (sockets[0]?.readyState === 1 ? true : undefined));
      phoneSocket().closeWith(code);
      expect(await joined, `at the join: ${code}`).toEqual({ ok: false, message });

      // And while the person at the computer is still deciding.
      sockets = [];
      const client = makeClient();
      const burrow = await ScriptedBurrow.create();
      const { result } = await confirming(client, burrow);
      phoneSocket().closeWith(code);
      expect(await result, `while confirming: ${code}`).toEqual({ ok: false, message });
    }
  });

  it('reads the computer leaving past the link’s expiry, with no outcome, as the link expiring', async () => {
    // The computer ends a link nobody confirmed at its expiry; a phone it never
    // answered hears only that the room closed.
    for (const code of [WS_CLOSE_ONE_TIME_PEER_GONE, 1006]) {
      sockets = [];
      const refused = makeClient();
      const early = await ScriptedBurrow.create(clock.now() + ONE_TIME_LINK_TTL_MS);
      const joined = refused.connectOnce(early.link, LABEL, () => {});
      await flushUntil(() => (sockets[0]?.readyState === 1 ? true : undefined));
      clock.jump(early.link.expiry * 1000 + 1 - clock.now());
      phoneSocket().closeWith(code);
      expect(await joined, `at the join: ${code}`).toEqual({
        ok: false,
        message: ONE_TIME_LINK_EXPIRED_MESSAGE,
      });

      sockets = [];
      const client = makeClient();
      const burrow = await ScriptedBurrow.create(clock.now() + ONE_TIME_LINK_TTL_MS);
      const { result } = await confirming(client, burrow);
      clock.jump(burrow.link.expiry * 1000 + 1 - clock.now());
      phoneSocket().closeWith(code);
      expect(await result, `while confirming: ${code}`).toEqual({
        ok: false,
        message: ONE_TIME_LINK_EXPIRED_MESSAGE,
      });
    }
  });

  it('reads the outcome it already holds over the room closing behind it', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const denied = await confirming(client, burrow);
    // The Burrow's own order: the denial, then it leaves the room.
    burrow.sendControl({ ok: false, code: 'user-denied' });
    phoneSocket().closeWith(WS_CLOSE_ONE_TIME_PEER_GONE);
    expect(await denied.result).toEqual({ ok: false, message: ONE_TIME_DENIAL_MESSAGES['user-denied'] });

    // An approval the room closes behind builds no peer for a room that is gone.
    sockets = [];
    const approved = makeClient();
    const second = await ScriptedBurrow.create();
    const { result } = await confirming(approved, second);
    second.sendControl({ ok: true, burrowLabel: 'Ned’s laptop' });
    phoneSocket().closeWith(WS_CLOSE_ONE_TIME_PEER_GONE);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
    expect(offerers).toHaveLength(0);
  });

  it('reads a room it never reached as unreachable: closed, errored, or refused outright', async () => {
    const burrow = await ScriptedBurrow.create();
    const closed = makeClient({ open: false });
    const result = closed.connectOnce(burrow.link, LABEL, () => {});
    await flushUntil(() => sockets[0]);
    phoneSocket().closeWith(1006);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_UNREACHABLE_MESSAGE });

    // A refused upgrade, where a browser reports `error` and nothing else.
    const refused = new FakeSocket();
    const errored = new OneTimeClient({
      wsOrigin: WS_ORIGIN,
      createWebSocket: () => refused,
      now: clock.now,
      setTimer: clock.setTimer,
      visibility: VISIBLE,
    });
    const erroredResult = errored.connectOnce(burrow.link, LABEL, () => {});
    await settle();
    refused.emitError();
    expect(await erroredResult).toEqual({ ok: false, message: ONE_TIME_UNREACHABLE_MESSAGE });

    const thrown = new OneTimeClient({
      wsOrigin: WS_ORIGIN,
      createWebSocket: () => {
        throw new Error('blocked by the page’s policy');
      },
      now: clock.now,
      setTimer: clock.setTimer,
      visibility: VISIBLE,
    });
    expect(await thrown.connectOnce(burrow.link, LABEL, () => {})).toEqual({
      ok: false,
      message: ONE_TIME_UNREACHABLE_MESSAGE,
    });
  });

  it('ends a socket that never opens at the room’s hard deadline, as the link expiring', async () => {
    const client = makeClient({ open: false });
    const burrow = await ScriptedBurrow.create();
    const result = client.connectOnce(burrow.link, LABEL, () => {});
    await flushUntil(() => sockets[0]);
    clock.advance(burrow.link.expiry * 1000 + ONE_TIME_EXPIRY_GRACE_MS - clock.now());
    expect(await result).toEqual({ ok: false, message: ONE_TIME_LINK_EXPIRED_MESSAGE });
    expect(phoneSocket().closeCode).toBe(1000);
    expect(clock.armed).toBe(0);
  });
});

describe('OneTimeClient: the direct path', () => {
  it('sends no protocol-v1 before both directions are direct', async () => {
    const client = makeClient();
    await expect(client.hello()).rejects.toThrow(/not direct/);
    expect(sockets).toHaveLength(0);

    const burrow = await ScriptedBurrow.create();
    const { result } = await connecting(client, burrow);
    // Confirmed, offered, and still on the rendezvous: every call refuses.
    await expect(client.hello()).rejects.toThrow(/not direct/);
    await expect(client.watchDirectory(() => {})).rejects.toThrow(/not direct/);
    await expect(client.attach('surface-1', 80, 24, { onData: () => {} })).rejects.toThrow(/not direct/);
    await expect(client.write('surface-1', 'ls\r')).rejects.toThrow(/not direct/);
    await expect(client.resize('surface-1', 80, 24)).rejects.toThrow(/not direct/);
    await expect(client.detach('surface-1')).rejects.toThrow(/not direct/);
    await settle();
    // Nothing reached the room but the offer already read.
    expect(burrow.rest()).toEqual([]);
    client.close();
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
  });

  it('names in the direct-failed copy a fix for every level, which a phone is never told', () => {
    // Local networks' fix is the computer's setting; Anywhere's, another network.
    expect(ONE_TIME_DIRECT_FAILED_MESSAGE).toContain('another network');
    expect(ONE_TIME_DIRECT_FAILED_MESSAGE).toContain('Settings → Network');
  });

  it('fails with the direct-failed copy when the computer declines', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const { result } = await connecting(client, burrow);
    burrow.sendControl({ v: 1, t: 'direct-decline' });
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    expect(phoneSocket().closeCode).toBe(1000);
    expect(offerers[0]!.closed).toBe(true);
  });

  it('fails with the direct-failed copy when no switch lands by the direct deadline', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const { result } = await connecting(client, burrow);
    const settled = vi.fn();
    void result.then(settled);
    // The phone's own channel opens at the last moment its setup bound allows
    // and it switches; the computer never does. The deadline is the sum of the
    // two bounds, so the phone's own handoff wait spends exactly what is left.
    clock.advance(DIRECT_SETUP_TIMEOUT_MS - 1);
    network.openChannels();
    clock.advance(DIRECT_ONLY_DEADLINE_MS - DIRECT_SETUP_TIMEOUT_MS - 1);
    await settle();
    expect(settled).not.toHaveBeenCalled();
    clock.advance(1);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    expect(offerers[0]!.closed).toBe(true);
    expect(clock.armed).toBe(0);
  });

  it('fails with the direct-failed copy at once when the session dies before the switch', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const { result } = await connecting(client, burrow);
    const settled = vi.fn();
    void result.then(settled);
    phoneSocket().deliver(oneTimeFrameText('transport', FORGED_CT));
    await settleUntil(() => settled.mock.calls.length > 0);
    expect(settled).toHaveBeenCalledWith({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    expect(offerers[0]!.closed).toBe(true);
  });

  it('fails with the direct-failed copy where this browser builds no peer', async () => {
    const client = makeClient({ createDirectPeer: null });
    const burrow = await ScriptedBurrow.create();
    const { result } = await confirming(client, burrow);
    burrow.sendControl({ ok: true, burrowLabel: 'Ned’s laptop' });
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
  });

  it('reads the computer leaving while it waits as a direct failure, the deadline as expiry', async () => {
    for (const [code, message] of [
      [WS_CLOSE_ONE_TIME_PEER_GONE, ONE_TIME_DIRECT_FAILED_MESSAGE],
      [WS_CLOSE_ONE_TIME_DEADLINE, ONE_TIME_LINK_EXPIRED_MESSAGE],
    ] as const) {
      sockets = [];
      const client = makeClient();
      const burrow = await ScriptedBurrow.create();
      const { result } = await connecting(client, burrow);
      phoneSocket().closeWith(code);
      expect(await result, String(code)).toEqual({ ok: false, message });
    }

    // Past the link's expiry too: confirmed in time, the computer's own direct
    // failure is what that close carries.
    sockets = [];
    const client = makeClient();
    const burrow = await ScriptedBurrow.create(clock.now() + 1_000);
    const { result } = await connecting(client, burrow);
    clock.jump(burrow.link.expiry * 1000 + 1 - clock.now());
    phoneSocket().closeWith(WS_CLOSE_ONE_TIME_PEER_GONE);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
  });
});

describe('OneTimeClient: close()', () => {
  it('ends a pending attempt with the ended copy, leaves nothing armed, and connects once', async () => {
    const client = makeClient();
    const burrow = await ScriptedBurrow.create();
    const { result } = await confirming(client, burrow);
    client.close();
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
    expect(phoneSocket().closeCode).toBe(1000);
    expect(clock.armed).toBe(0);
    client.close();
    await expect(client.connectOnce(burrow.link, LABEL, () => {})).rejects.toThrow(/connects once/);
  });
});
