import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dehydrateSequence, DEHYDRATE_ENV, openSequence, parseToolAnnounce, parseToolDehydrate, parseToolOpen, parseToolState, readDehydrated, serveSequence, stateSequence, TOOL_PAYLOAD_LIMIT } from '../dist/osc.js';

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

  test('ignores every verb but serve', () => {
    assert.equal(parseToolAnnounce('dehydrate;{"v":1,"state":{"port":1}}'), null);
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
    assert.equal(parseToolAnnounce(serve({ dehydrate: false, persist: 'sometimes' })), null);
  });

  test('reads a reaping declaration alone as an announcement, selecting no port', () => {
    assert.deepEqual(parseToolAnnounce(serve({ dehydrate: true, v: 1 })), { port: null, name: null, key: null, dehydrate: true, persist: null });
    assert.deepEqual(parseToolAnnounce(serve({ persist: 'never' })), { port: null, name: null, key: null, dehydrate: false, persist: 'never' });
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
  for (const preview of [true, false]) {
    assert.deepEqual(parseToolOpen(content(openSequence({ path: '/repo/a b.md', preview }))), { path: '/repo/a b.md', preview });
  }
  assert.deepEqual(parseToolOpen(content(openSequence({ path: 'C:\\repo\\a.md' }))), { path: 'C:\\repo\\a.md', preview: false });
});

test('parseToolOpen reads only a v1 absolute local path', () => {
  const open = payload => parseToolOpen(`open;${JSON.stringify(payload)}`);
  assert.deepEqual(open({ v: 1, path: '/a' }), { path: '/a', preview: false });
  assert.deepEqual(open({ v: 1, path: 'D:/a', preview: true }), { path: 'D:/a', preview: true });
  for (const payload of [{ path: '/a' }, { v: 2, path: '/a' }, { v: 1 }, { v: 1, path: 'a/b' }, { v: 1, path: 'file:///a' },
    { v: 1, path: 'C:a' }, { v: 1, path: '/a\x07b' }, { v: 1, path: '/a\u009bb' },
    { v: 1, path: `/${'a'.repeat(2048)}` }, { v: 1, path: '/a', preview: 'true' }]) {
    assert.equal(open(payload), null, JSON.stringify(payload));
  }
  assert.equal(parseToolOpen('serve;{"v":1,"path":"/a"}'), null);
});

test('openSequence refuses a path the host would ignore', () => {
  for (const path of ['relative', 'file:///a', '/a\nb']) assert.throws(() => openSequence({ path }), RangeError);
});

test('serveSequence refuses a value the host would ignore', () => {
  for (const port of [0, 65536, 1.5]) assert.throws(() => serveSequence({ port }), RangeError);
  for (const path of ['relative', '//evil.test/', '/a b']) assert.throws(() => serveSequence({ port: 1, path }), RangeError);
});


test('stateSequence rejects runtime non-boolean dirty values', () => {
  for (const dirty of ['true', 1, null, undefined]) assert.throws(() => stateSequence({ dirty }), TypeError);
});

test('openSequence rejects runtime non-boolean preview values', () => {
  for (const preview of ['true', 1, null]) assert.throws(() => openSequence({ path: '/a', preview }), TypeError);
});

test('serveSequence bounds serialized JSON after escaping a valid path', () => {
  assert.equal(parseToolAnnounce(content(serveSequence({ port: 1, path: '/' + 'a'.repeat(2047) })))?.path.length, 2048);
  assert.throws(() => serveSequence({ port: 1, path: '/' + '"'.repeat(2047) }), RangeError);
});

test('openSequence bounds serialized JSON after escaping a valid path', () => {
  assert.equal(parseToolOpen(content(openSequence({ path: '/' + 'a'.repeat(2047) })))?.path.length, 2048);
  assert.throws(() => openSequence({ path: 'C:' + '\\'.repeat(2046) }), RangeError);
});

test('serve paths reject C1 controls that could terminate or inject OSCs', () => {
  for (let code = 0x80; code <= 0x9f; code++) {
    const path = '/a' + String.fromCharCode(code) + 'b';
    assert.throws(() => serveSequence({ port: 1, path }), RangeError);
    assert.equal(parseToolAnnounce(serve({ port: 1, path }))?.path, undefined);
  }
});

describe('dehydrate', () => {
  test('round-trips a Tool state through the sequence, the host parse, and the environment', () => {
    const state = { expanded: ['src', 'src/lib'], selected: 'README.md' };
    const parsed = parseToolDehydrate(content(dehydrateSequence(state)));
    assert.ok(parsed);
    // The host hands the payload back verbatim: it never re-serializes the Tool's JSON.
    assert.equal(parsed.payload, JSON.stringify({ v: 1, state }));
    assert.deepEqual(readDehydrated(parsed.payload), state);
    assert.equal(DEHYDRATE_ENV, 'DORMOUSE_DEHYDRATE');
  });

  test('refuses an unknown version, a missing or null state, another verb, and malformed JSON', () => {
    for (const raw of ['{"v":2,"state":1}', '{"state":1}', '{"v":1}', '{"v":1,"state":null}', '[1]', 'not json', '']) {
      assert.equal(parseToolDehydrate(`dehydrate;${raw}`), null, raw);
      assert.equal(readDehydrated(raw), null, raw);
    }
    assert.equal(parseToolDehydrate('serve;{"v":1,"state":1}'), null);
  });

  test('a missing, garbage, or oversized environment value reads as none: start from args', () => {
    assert.equal(readDehydrated(undefined), null);
    assert.equal(readDehydrated('{"v":1,"state":'), null);
    const oversized = JSON.stringify({ v: 1, state: 'x'.repeat(TOOL_PAYLOAD_LIMIT) });
    assert.equal(readDehydrated(oversized), null);
    assert.equal(parseToolDehydrate(`dehydrate;${oversized}`), null);
  });

  test('the encoder refuses what the host would drop', () => {
    assert.throws(() => dehydrateSequence(null), TypeError);
    assert.throws(() => dehydrateSequence(undefined), TypeError);
    assert.throws(() => dehydrateSequence('x'.repeat(TOOL_PAYLOAD_LIMIT)), RangeError);
    // Falsy but present states are states.
    for (const state of [0, false, '', []]) assert.deepEqual(readDehydrated(JSON.stringify({ v: 1, state })), state);
  });
});

describe('serveSequence reaping options', () => {
  test('announces dehydrate and persist beside the port, or alone', () => {
    assert.deepEqual(parseToolAnnounce(content(serveSequence({ port: 6006, dehydrate: true }))), { port: 6006, name: null, key: null, dehydrate: true, persist: null });
    assert.deepEqual(parseToolAnnounce(content(serveSequence({ dehydrate: true }))), { port: null, name: null, key: null, dehydrate: true, persist: null });
    assert.equal(parseToolAnnounce(content(serveSequence({ port: 1, persist: 'never' })))?.persist, 'never');
  });

  test('refuses an announcement that states nothing, or a path without a port', () => {
    assert.throws(() => serveSequence({}), RangeError);
    assert.throws(() => serveSequence({ dehydrate: false }), RangeError);
    assert.throws(() => serveSequence({ path: '/x', dehydrate: true }), RangeError);
    assert.throws(() => serveSequence({ port: 1, persist: 'sometimes' }), RangeError);
  });
});
