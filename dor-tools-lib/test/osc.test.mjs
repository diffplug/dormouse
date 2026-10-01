import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseToolAnnounce, parseToolState, serveSequence, stateSequence } from '../dist/osc.js';

const serve = payload => `serve;${JSON.stringify(payload)}`;
/** What a host's parser receives: the sequence without `ESC ] 367 ;` and its terminator. */
const content = sequence => /^\x1b\]367;(.*)\x07$/s.exec(sequence)[1];

describe('parseToolAnnounce', () => {
  test('accepts a same-origin serve path and drops authority-changing or malformed paths', () => {
    assert.equal(parseToolAnnounce(serve({ port: 6006, path: '/token/file/a%20b.html?mode=1' }))?.path, '/token/file/a%20b.html?mode=1');
    for (const path of ['https://evil.test/', '//evil.test/', '/\\evil.test/', '/a\nb', 'relative', `/${'a'.repeat(2048)}`]) {
      assert.equal(parseToolAnnounce(serve({ port: 6006, path }))?.path, undefined);
    }
  });

  test('reads a full serve payload', () => {
    assert.deepEqual(parseToolAnnounce(serve({ port: 6006, name: 'Storybook', key: ['storybook', '/repo'], dehydrate: true, persist: 'never', v: 1 })), {
      port: 6006, name: 'Storybook', key: ['storybook', '/repo'], dehydrate: true, persist: 'never',
    });
  });

  test('defaults the reserved fields when unstated', () => {
    assert.deepEqual(parseToolAnnounce(serve({ port: 4242 })), { port: 4242, name: null, key: null, dehydrate: false, persist: null });
  });

  test('ignores every verb but serve — dehydrate is D2 and half-honoring it is worse than dropping it', () => {
    assert.equal(parseToolAnnounce('dehydrate;{"v":1}'), null);
    assert.equal(parseToolAnnounce('progress;{"v":1}'), null);
  });

  test('refuses a serve payload naming a version it does not speak', () => {
    // A v2 `serve` may reuse a field name for something else, so it is dropped
    // whole rather than read as v1. An omitted `v` is the shipped v1 shape.
    assert.equal(parseToolAnnounce(serve({ port: 6006, v: 1 }))?.port, 6006);
    assert.equal(parseToolAnnounce(serve({ port: 6006 }))?.port, 6006);
    for (const v of [2, 0, '1', null]) assert.equal(parseToolAnnounce(serve({ port: 6006, v })), null);
  });

  test('never throws on malformed output', () => {
    for (const input of ['serve;not json', 'serve;[1,2]', 'serve;null', 'serve;', 'serve', '']) {
      assert.equal(parseToolAnnounce(input), null);
    }
  });

  test('rejects a payload past the size cap rather than parsing it', () => {
    assert.equal(parseToolAnnounce(serve({ port: 1, name: 'x'.repeat(8000) })), null);
  });

  test('rejects ports outside the valid range', () => {
    for (const port of [0, -1, 65536, 1.5, '6006']) {
      assert.equal(parseToolAnnounce(serve({ port, name: 'n' }))?.port ?? null, null);
    }
  });

  test('sanitizes the name like every other OSC payload', () => {
    assert.equal(parseToolAnnounce(serve({ port: 1, name: 'Story\x07book\n\nhere' }))?.name, 'Story book here');
  });

  test('clamps an over-long name instead of dropping the announcement', () => {
    assert.equal(parseToolAnnounce(serve({ port: 1, name: 'a'.repeat(500) }))?.name.length, 200);
  });

  test('rejects a key that is not a list of strings, and caps its length', () => {
    for (const key of ['storybook', [1, 2], [], Array(20).fill('x')]) assert.equal(parseToolAnnounce(serve({ key })), null);
  });

  test('returns null when nothing actionable is stated', () => {
    assert.equal(parseToolAnnounce(serve({ v: 1 })), null);
    assert.equal(parseToolAnnounce(serve({ dehydrate: true })), null);
  });
});

test('parseToolState reads only a v1 boolean', () => {
  assert.deepEqual(parseToolState('state;{"v":1,"dirty":true}'), { dirty: true });
  assert.deepEqual(parseToolState('state;{"v":1,"dirty":false}'), { dirty: false });
  for (const payload of [{ dirty: true }, { v: 2, dirty: true }, { v: 1, dirty: 'false' }, { v: 1 }]) {
    assert.equal(parseToolState(`state;${JSON.stringify(payload)}`), null);
  }
  assert.equal(parseToolState('serve;{"v":1,"dirty":true}'), null);
});

test('the encoders write what the parsers read', () => {
  assert.deepEqual(parseToolAnnounce(content(serveSequence({ port: 6006 }))), { port: 6006, name: null, key: null, dehydrate: false, persist: null });
  assert.equal(parseToolAnnounce(content(serveSequence({ port: 6006, path: '/token/view' })))?.path, '/token/view');
  for (const dirty of [true, false]) assert.deepEqual(parseToolState(content(stateSequence({ dirty }))), { dirty });
});

test('serveSequence refuses a value the host would ignore', () => {
  for (const port of [0, 65536, 1.5]) assert.throws(() => serveSequence({ port }), RangeError);
  for (const path of ['relative', '//evil.test/', '/a b']) assert.throws(() => serveSequence({ port: 1, path }), RangeError);
});
