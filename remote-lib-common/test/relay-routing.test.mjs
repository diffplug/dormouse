/**
 * The frame layer both Relays route through (docs/specs/relay.md -> Routing):
 * the byte bound, the Client frame's three refusals, the dropped Burrow frame,
 * and the envelopes rebuilt field by field. The Relays' own suites run the
 * same rules end to end through `test/harness/relay-parity.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MALFORMED_E2E_FRAME_ERROR,
  MALFORMED_FRAME_ERROR,
  MAX_RELAY_FRAME_BYTES,
  UNKNOWN_FRAME_TYPE_ERROR,
  exceedsRelayFrameBytes,
  offlineError,
  readBurrowFrame,
  readClientFrame,
  toBurrowEnvelope,
  toClientEnvelope,
} from '../dist/index.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const clientFrame = { t: 'e2e', burrowId: ID, kind: 'pairing', id: ID, step: 'init', ct: 'Zm9v' };
const burrowFrame = { t: 'e2e', clientId: 'c1', kind: 'pairing', id: ID, step: 'response', ct: 'YmFy' };

test('the frame bound counts UTF-8 bytes, as `ws` maxPayload does', () => {
  assert.equal(exceedsRelayFrameBytes('x'.repeat(MAX_RELAY_FRAME_BYTES)), false);
  assert.equal(exceedsRelayFrameBytes('x'.repeat(MAX_RELAY_FRAME_BYTES + 1)), true);
  // Two bytes a code unit: under the bound in UTF-16 units, over it in bytes.
  const twoByte = 'é'.repeat(Math.floor(MAX_RELAY_FRAME_BYTES / 2) + 1);
  assert.ok(twoByte.length <= MAX_RELAY_FRAME_BYTES);
  assert.equal(exceedsRelayFrameBytes(twoByte), true);
  assert.equal(exceedsRelayFrameBytes('é'.repeat(Math.floor(MAX_RELAY_FRAME_BYTES / 2))), false);
  // Four bytes a surrogate pair, two code units.
  const astral = '😀'.repeat(Math.floor(MAX_RELAY_FRAME_BYTES / 4) + 1);
  assert.equal(exceedsRelayFrameBytes(astral), true);
  assert.equal(exceedsRelayFrameBytes('😀'.repeat(Math.floor(MAX_RELAY_FRAME_BYTES / 4))), false);
});

test('a Client frame is the e2e envelope, or one of three errors', () => {
  assert.deepEqual(readClientFrame(JSON.stringify(clientFrame)), { frame: clientFrame });
  for (const raw of ['not json', '42', 'null', '{}', '{"t":1}'])
    assert.deepEqual(readClientFrame(raw), { error: { t: 'error', error: MALFORMED_FRAME_ERROR } }, raw);
  assert.deepEqual(readClientFrame('{"t":"hello"}'), {
    error: { t: 'error', error: UNKNOWN_FRAME_TYPE_ERROR },
  });
  assert.deepEqual(readClientFrame(JSON.stringify({ ...clientFrame, ct: '' })), {
    error: { t: 'error', error: MALFORMED_E2E_FRAME_ERROR },
  });
  assert.deepEqual(offlineError(ID), { t: 'error', error: `burrow ${ID} is offline` });
});

test('a malformed Burrow frame is dropped, not answered', () => {
  assert.deepEqual(readBurrowFrame(JSON.stringify(burrowFrame)), burrowFrame);
  for (const raw of ['not json', '{}', JSON.stringify({ ...burrowFrame, step: 'init' })])
    assert.equal(readBurrowFrame(raw), null, raw);
});

test('each envelope is rebuilt field by field: nothing a sender added rides along', () => {
  const toBurrow = toBurrowEnvelope('relay-id', { ...clientFrame, clientId: 'forged', extra: 1 });
  assert.deepEqual(toBurrow, { ...clientFrame, clientId: 'relay-id' });
  const toClient = toClientEnvelope(ID, { ...burrowFrame, burrowId: 'forged', extra: 1 });
  const { clientId: _dropped, ...rest } = burrowFrame;
  assert.deepEqual(toClient, { ...rest, burrowId: ID });
});
