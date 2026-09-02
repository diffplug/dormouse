/**
 * The production check on the built worker
 * (`lib/scripts/assert-pocket-worker.mjs`, the last step of `build:pocket`).
 *
 * It is the only thing standing between a bundler-config change and a worker
 * that installs on no phone, and its failure mode is silence — so each rule is
 * driven against a fixture that violates exactly it.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain build script, deliberately not part of the app's
// TypeScript program; the shapes it takes and returns are exercised below.
import { assertPocketWorker, WORKER_FILE } from '../../../scripts/assert-pocket-worker.mjs';

const check = assertPocketWorker as (outDir: string) => number;

/** A `dist-pocket` holding whatever root files a case needs. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-worker-'));
  // Every real build has one, and its hashed contents must not be scanned.
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export const app = 1;\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const CLASSIC_WORKER = 'var w=(function(){"use strict";function a(){}return a})();\n';

describe('assertPocketWorker', () => {
  it('accepts a self-contained classic worker beside hashed app assets', () => {
    expect(check(fixture({ [WORKER_FILE]: CLASSIC_WORKER }))).toBe(CLASSIC_WORKER.length);
  });

  it('fails when the worker is missing', () => {
    expect(() => check(fixture({}))).toThrow(/exactly one root script/);
    expect(() => check(join(tmpdir(), 'no-such-pocket-build'))).toThrow(/does not exist/);
  });

  it('fails when a sibling chunk was emitted beside it', () => {
    // `inlineDynamicImports` off, or a second entry: a classic worker cannot
    // load either one.
    const dir = fixture({ [WORKER_FILE]: CLASSIC_WORKER, 'sw2.js': CLASSIC_WORKER });
    expect(() => check(dir)).toThrow(/sw2\.js/);
  });

  it('fails on module syntax or a dynamic-import loader', () => {
    for (const source of [
      'import { openPush } from "./chunk.js";\nvar w=1;\n',
      'import"./chunk.js";var w=1;\n',
      'var w=1;export{w};\n',
      'var w=1;export default w;\n',
      'var w=1;export const x=2;\n',
      'var w=(function(){return import("./chunk.js")})();\n',
    ]) {
      expect(() => check(fixture({ [WORKER_FILE]: source })), source).toThrow(/classic worker/);
    }
  });
});
