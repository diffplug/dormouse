/**
 * The curated voice set and its retired ids: a shipped desktop sends whatever
 * id it stored, so every retired one must still name a member.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MANAGED_VOICE_ID,
  MANAGED_VOICES,
  RETIRED_MANAGED_VOICES,
  currentManagedVoiceId,
  isManagedVoiceId,
} from '../dist/index.js';

test('every retired id maps to a member of the current set, and none is a member itself', () => {
  for (const [retired, replacement] of Object.entries(RETIRED_MANAGED_VOICES)) {
    assert.ok(isManagedVoiceId(replacement), `${retired} -> ${replacement}`);
    assert.ok(!isManagedVoiceId(retired), retired);
  }
});

test('currentManagedVoiceId keeps a member, translates a retired id, and refuses anything else', () => {
  for (const { id } of MANAGED_VOICES) assert.equal(currentManagedVoiceId(id), id);
  // George, the second voice before the 2026 change, is Eldrin's.
  assert.equal(currentManagedVoiceId('JBFqnCBsd6RMkjVDRZzb'), MANAGED_VOICES[1].id);
  // Rachel, the old default, is the new default.
  assert.equal(currentManagedVoiceId('21m00Tcm4TlvDq8ikWAM'), DEFAULT_MANAGED_VOICE_ID);
  for (const value of ['unknown', '', 'constructor', '__proto__', 'toString', null, undefined, 7, {}]) {
    assert.equal(currentManagedVoiceId(value), null, String(value));
  }
});
