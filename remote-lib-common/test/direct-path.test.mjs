/**
 * The direct path's shared half (`docs/specs/remote-api.md` -> Transport ->
 * "Direct path"): the signaling guard, the bound that keeps a signal inside one
 * control message, and the cutover state machine both ends run.
 *
 * The endpoints that drive it are `lib/src/remote/direct/direct-peer.test.ts`
 * and the in-process end-to-end cases in `pocket-client.test.ts` /
 * `burrow-runtime.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_PAYLOAD_SIZE,
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  DirectCutover,
  MAX_DIRECT_PENDING_BYTES,
  MAX_DIRECT_PENDING_FRAMES,
  MAX_DIRECT_SDP_LENGTH,
  encodeTransportPlaintext,
  isDirectSdp,
  isDirectSignalV1,
  utf8Encode,
} from '../dist/index.js';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

// --- The signaling guard ----------------------------------------------------

test('accepts the four signals and nothing else', () => {
  assert.ok(isDirectSignalV1({ v: 1, t: 'direct-offer', sdp: SDP }));
  assert.ok(isDirectSignalV1({ v: 1, t: 'direct-answer', sdp: SDP }));
  assert.ok(isDirectSignalV1({ v: 1, t: 'direct-decline' }));
  assert.ok(isDirectSignalV1({ v: 1, t: 'direct-switch' }));
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-renegotiate' }));
});

test('rejects anything that is not a plain versioned object', () => {
  for (const value of [null, undefined, 'direct-switch', 7, [{ v: 1, t: 'direct-switch' }]]) {
    assert.ok(!isDirectSignalV1(value));
  }
  // A future version is not this one: a peer that cannot read a signal ignores
  // it and stays relayed rather than guessing at its fields.
  assert.ok(!isDirectSignalV1({ v: 2, t: 'direct-switch' }));
  assert.ok(!isDirectSignalV1({ t: 'direct-switch' }));
});

test('rejects an extra key, on every shape', () => {
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-offer', sdp: SDP, iceServers: ['stun:x'] }));
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-switch', after: 3 }));
  // The two that carry nothing carry nothing: an SDP on a decline is a field
  // no reader has, which is exactly the shape a smuggler would pick.
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-decline', sdp: SDP }));
});

test('rejects an sdp that is missing, not a string, or over the bound', () => {
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-offer' }));
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-offer', sdp: 42 }));
  assert.ok(!isDirectSignalV1({ v: 1, t: 'direct-answer', sdp: null }));
  assert.ok(isDirectSignalV1({ v: 1, t: 'direct-answer', sdp: 'a'.repeat(MAX_DIRECT_SDP_LENGTH) }));
  assert.ok(
    !isDirectSignalV1({ v: 1, t: 'direct-answer', sdp: 'a'.repeat(MAX_DIRECT_SDP_LENGTH + 1) }),
  );
});

test('an sdp is printable ASCII with CRLF, and nothing else', () => {
  assert.ok(isDirectSdp(SDP));
  assert.ok(!isDirectSdp('a=candidate:\u0000'));
  assert.ok(!isDirectSdp('a=x:\t'));
  // A multi-byte character would encode to more than the two bytes per
  // character MAX_DIRECT_SDP_LENGTH is derived from.
  assert.ok(!isDirectSdp('s=café\r\n'));
});

/**
 * The bound's whole reason: a signal has to survive
 * {@link encodeTransportPlaintext}, which refuses a control body over
 * `CONTROL_PAYLOAD_SIZE` rather than truncating it. The worst case is an SDP
 * made entirely of characters JSON escapes, which is the widest an accepted one
 * can encode to.
 */
test('any signal with a maximal sdp fits one control message', () => {
  for (const t of ['direct-offer', 'direct-answer']) {
    const sdp = '"'.repeat(MAX_DIRECT_SDP_LENGTH);
    const signal = { v: 1, t, sdp };
    assert.ok(isDirectSignalV1(signal));
    const json = utf8Encode(JSON.stringify(signal));
    assert.ok(
      json.length <= CONTROL_PAYLOAD_SIZE,
      `${t} encodes to ${json.length} bytes, over the ${CONTROL_PAYLOAD_SIZE}-byte control body`,
    );
    // The padded body plus its kind byte, which is what actually goes on the wire.
    const plaintext = encodeTransportPlaintext({ kind: 'control', value: signal });
    assert.equal(plaintext.length, CONTROL_PAYLOAD_SIZE + 1);
  }
});

test('the timings the spec names are the values that ship', () => {
  assert.equal(DIRECT_SETUP_TIMEOUT_MS, 15_000);
  assert.equal(DIRECT_GATHER_TIMEOUT_MS, 3_000);
  assert.ok(DIRECT_GATHER_TIMEOUT_MS < DIRECT_SETUP_TIMEOUT_MS);
});

/**
 * The two holding bounds are not independent: the byte cap is the one meant to
 * bind, and the frame cap only exists so a peer cannot hold the queue open with
 * frames too small to fill it.
 */
test('the holding queue is bounded in bytes first', () => {
  assert.equal(MAX_DIRECT_PENDING_BYTES, 4 * 1024 * 1024);
  // A PTY emits ~1 KiB chunks uncoalesced, one per channel frame, so at the
  // frame size terminal traffic actually has the byte cap is reached first.
  assert.ok(
    MAX_DIRECT_PENDING_FRAMES * 1024 >= MAX_DIRECT_PENDING_BYTES,
    `${MAX_DIRECT_PENDING_FRAMES} frames of 1 KiB is under the ${MAX_DIRECT_PENDING_BYTES}-byte cap`,
  );
  // And the window it covers is one relay one-way hop, which is hundreds of
  // milliseconds to a phone on cellular: half a second of a fast stream fits.
  assert.ok(MAX_DIRECT_PENDING_BYTES >= 0.5 * 5_000_000);
});

// --- The cutover ------------------------------------------------------------

const frame = (n, size = 4) => new Uint8Array(size).fill(n);

test('starts relayed in both directions', () => {
  const cutover = new DirectCutover();
  assert.equal(cutover.outbound, 'relay');
  assert.equal(cutover.inbound, 'relay');
  assert.equal(cutover.path, 'relay');
  assert.equal(cutover.switched, false);
  assert.equal(cutover.onRelayTransport(), 'process');
});

test('claims the session’s one attempt, and never a second', () => {
  const cutover = new DirectCutover();
  assert.equal(cutover.state, 'idle');
  assert.equal(cutover.begin(), true);
  assert.equal(cutover.state, 'attempting');
  // The one-attempt-per-session gate: a second offer allocates nothing.
  assert.equal(cutover.begin(), false);
  cutover.abandon();
  assert.equal(cutover.state, 'abandoned');
  // And an attempt that was given up cannot be restarted either.
  assert.equal(cutover.begin(), false);
});

test('abandoning releases what it held, and is refused once switched', () => {
  const cutover = new DirectCutover();
  cutover.begin();
  cutover.onChannelFrame(frame(1));
  cutover.abandon();
  assert.equal(cutover.pendingFrames, 0);
  assert.equal(cutover.pendingBytes, 0);

  // After a switch there is no relay to fall back to, so a caller reaching here
  // has confused an abandoned attempt with burrow loss.
  const switched = new DirectCutover();
  switched.begin();
  switched.switchOutbound();
  assert.throws(() => switched.abandon(), /cannot be abandoned/);
});

test('a switch onto an abandoned channel is fatal, and a switch while attempting drains', () => {
  const abandoned = new DirectCutover();
  abandoned.begin();
  abandoned.abandon();
  assert.deepEqual(abandoned.onSwitchDecrypted(), { kind: 'fatal' });
  // Refused before anything moved: the session is over, not half switched.
  assert.equal(abandoned.inbound, 'relay');

  const attempting = new DirectCutover();
  attempting.begin();
  attempting.onChannelFrame(frame(1));
  attempting.onChannelFrame(frame(2));
  assert.deepEqual(attempting.onSwitchDecrypted(), {
    kind: 'drain',
    frames: [frame(1), frame(2)],
  });
  assert.equal(attempting.inbound, 'direct');
});

test('switches each direction on its own, and only both make it direct', () => {
  const cutover = new DirectCutover();
  cutover.begin();
  assert.equal(cutover.switchOutbound(), true);
  // A second open must not put a second switch on the relay.
  assert.equal(cutover.switchOutbound(), false);
  assert.equal(cutover.switched, true);
  // The peer is still on the relay, so the relay still carries half of it.
  assert.equal(cutover.path, 'relay');
  assert.equal(cutover.onRelayTransport(), 'process');

  cutover.onSwitchDecrypted();
  assert.equal(cutover.inbound, 'direct');
  assert.equal(cutover.path, 'direct');
});

test('holds channel frames until the peer’s switch, then drains them in order', () => {
  const cutover = new DirectCutover();
  assert.equal(cutover.onChannelFrame(frame(1)), 'held');
  assert.equal(cutover.onChannelFrame(frame(2)), 'held');
  assert.equal(cutover.pendingFrames, 2);
  assert.equal(cutover.pendingBytes, 8);

  const drained = cutover.onSwitchDecrypted();
  assert.deepEqual(drained.frames, [frame(1), frame(2)]);
  assert.equal(cutover.pendingFrames, 0);
  assert.equal(cutover.pendingBytes, 0);
  // Everything after the switch is read straight through.
  assert.equal(cutover.onChannelFrame(frame(3)), 'process');
});

test('a relay transport after the peer’s switch is a violation', () => {
  const cutover = new DirectCutover();
  cutover.onSwitchDecrypted();
  assert.equal(cutover.onRelayTransport(), 'violation');
});

test('overflows on the frame cap', () => {
  const cutover = new DirectCutover();
  for (let i = 0; i < MAX_DIRECT_PENDING_FRAMES; i += 1) {
    assert.equal(cutover.onChannelFrame(frame(i)), 'held');
  }
  assert.equal(cutover.onChannelFrame(frame(0)), 'overflow');
  // Refused, not counted: the queue is exactly at its cap.
  assert.equal(cutover.pendingFrames, MAX_DIRECT_PENDING_FRAMES);
});

test('overflows on the byte cap, whatever the frame count', () => {
  const cutover = new DirectCutover();
  const big = MAX_DIRECT_PENDING_BYTES / 2;
  assert.equal(cutover.onChannelFrame(new Uint8Array(big)), 'held');
  assert.equal(cutover.onChannelFrame(new Uint8Array(big)), 'held');
  assert.equal(cutover.pendingBytes, MAX_DIRECT_PENDING_BYTES);
  assert.equal(cutover.onChannelFrame(new Uint8Array(1)), 'overflow');
  assert.ok(cutover.pendingFrames < MAX_DIRECT_PENDING_FRAMES);
});

test('clear releases what a disposed session will never drain', () => {
  const cutover = new DirectCutover();
  cutover.onChannelFrame(frame(1));
  cutover.clear();
  assert.equal(cutover.pendingFrames, 0);
  assert.equal(cutover.pendingBytes, 0);
});
