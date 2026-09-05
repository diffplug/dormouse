import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  concatBytes,
  constantTimeEqual,
  fromBase64Url,
  lengthPrefixedConcat,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../dist/index.js';

test('base64url round-trips all byte values and lengths 0..8', () => {
  const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64Url(toBase64Url(everyByte)), everyByte);
  for (let length = 0; length <= 8; length++) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes, `length ${length}`);
  }
});

test('base64url matches known vectors', () => {
  assert.equal(toBase64Url(new Uint8Array(0)), '');
  assert.equal(toBase64Url(Uint8Array.of(0xff)), '_w');
  assert.equal(toBase64Url(utf8Encode('hello')), 'aGVsbG8');
  assert.deepEqual(fromBase64Url('aGVsbG8'), utf8Encode('hello'));
});

test('base64url tolerates trailing padding', () => {
  assert.deepEqual(fromBase64Url('aGVsbG8='), utf8Encode('hello'));
});

test('base64url rejects malformed input', () => {
  assert.throws(() => fromBase64Url('a+b/'), /invalid base64url/);
  assert.throws(() => fromBase64Url('ab cd'), /invalid base64url/);
  assert.throws(() => fromBase64Url('abcde'), /impossible length/);
  // '_x' decodes to 0xff plus nonzero leftover bits — not a canonical encoding.
  assert.throws(() => fromBase64Url('_x'), /nonzero trailing bits/);
});

test('utf8 round-trips ascii, multibyte, and astral text', () => {
  for (const text of ['', 'hello', 'héllo wörld', '€100', '日本語', '🐭 dormouse 🛡️', '\ufeffleading BOM', 'interior\ufeffBOM']) {
    assert.equal(utf8Decode(utf8Encode(text)), text, JSON.stringify(text));
  }
});

test('utf8Encode matches known multibyte vector', () => {
  // '€' is U+20AC → E2 82 AC.
  assert.deepEqual(utf8Encode('€'), Uint8Array.of(0xe2, 0x82, 0xac));
});

test('utf8Encode replaces each unpaired surrogate with U+FFFD', () => {
  assert.deepEqual(utf8Encode('\ud800x\udfff'), Uint8Array.of(
    0xef, 0xbf, 0xbd, 0x78, 0xef, 0xbf, 0xbd,
  ));
});

test('utf8Decode rejects malformed encodings without poisoning the next value', () => {
  for (const bytes of [
    [0x80],                         // lone continuation
    [0xe2, 0x82],                   // truncated sequence
    [0xe2, 0x41, 0x41],             // bad continuation
    [0xc0, 0x80],                   // overlong NUL
    [0xe0, 0x80, 0x80],             // overlong NUL, three bytes
    [0xed, 0xa0, 0x80],             // UTF-16 surrogate U+D800
    [0xf4, 0x90, 0x80, 0x80],       // above U+10FFFF
  ]) {
    assert.throws(() => utf8Decode(Uint8Array.from(bytes)), TypeError);
    assert.equal(utf8Decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)), '\ufeffa');
  }
});

test('concatBytes joins parts in order', () => {
  assert.deepEqual(
    concatBytes(Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3)),
    Uint8Array.of(1, 2, 3),
  );
});

test('lengthPrefixedConcat makes field boundaries unambiguous', () => {
  const ab_c = lengthPrefixedConcat([utf8Encode('ab'), utf8Encode('c')]);
  const a_bc = lengthPrefixedConcat([utf8Encode('a'), utf8Encode('bc')]);
  assert.notDeepEqual(ab_c, a_bc);
  assert.deepEqual(
    lengthPrefixedConcat([utf8Encode('ab')]),
    Uint8Array.of(0, 0, 0, 2, 0x61, 0x62),
  );
});

test('constantTimeEqual compares content, not identity', () => {
  assert.equal(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
  assert.equal(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)), false);
  assert.equal(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)), false);
  assert.equal(constantTimeEqual(new Uint8Array(0), new Uint8Array(0)), true);
});
