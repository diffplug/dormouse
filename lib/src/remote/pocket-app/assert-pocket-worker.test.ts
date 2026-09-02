/**
 * The production checks on the built app
 * (`lib/scripts/assert-pocket-worker.mjs`, the last step of `build:pocket`).
 *
 * They are the only things standing between a bundler-config change and either
 * a worker that installs on no phone or a shell the origin's
 * `script-src 'self'` silently blocks — and both failure modes are silence, so
 * each rule is driven against a fixture that violates exactly it.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain build script, deliberately not part of the app's
// TypeScript program; the shapes it takes and returns are exercised below.
import {
  assertPocketShell,
  assertPocketWorker,
  SHELL_FILE,
  WORKER_FILE,
} from '../../../scripts/assert-pocket-worker.mjs';

const check = assertPocketWorker as (outDir: string) => number;
const checkShell = assertPocketShell as (outDir: string) => number;

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


/** A shell holding whatever `<head>` markup a case needs. */
function shell(head: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-shell-'));
  writeFileSync(
    join(dir, SHELL_FILE),
    `<!DOCTYPE html><html><head>${head}</head><body><div id=pocket-root></div></body></html>`,
  );
  return dir;
}

describe('assertPocketShell', () => {
  it('accepts the shape the build emits today', () => {
    // What `lib/dist-pocket/index.html` actually looks like: one external module
    // script, one stylesheet, the manifest and the icon — plus the inline
    // `<style>` the policy allows through `style-src 'unsafe-inline'`.
    const dir = shell(
      '<style>html{height:100%}</style>' +
        '<script type="module" crossorigin src="/assets/index-CfO_bf48.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/index-jbiwRWCc.css">' +
        '<link rel="manifest" href="/manifest.webmanifest">',
    );
    expect(checkShell(dir)).toBe(1);
  });

  it('fails on an inline script, which is what Vite could start emitting', () => {
    // The module-preload polyfill: inline, and silently blocked by
    // `script-src 'self'` at the phone rather than here.
    const dir = shell('<script type="module">!function(){const e=document;}();</script>');
    expect(() => checkShell(dir)).toThrow(/inline script/);
  });

  it('fails on an off-origin script or stylesheet, however it is spelled', () => {
    // A `base` pointing at a CDN is the one input that makes this guard fire.
    // The authority-relative forms are the ones that also start with `/` —
    // including the backslash spelling, which WHATWG folds into `//` for a
    // special scheme, so `new URL('/\\cdn.example.com/x.js', origin)` is
    // `https://cdn.example.com/x.js`.
    for (const src of [
      'https://cdn.example.com/x.js',
      '//cdn.example.com/x.js',
      '/\\cdn.example.com/x.js',
    ]) {
      expect(() => checkShell(shell(`<script src="${src}"></script>`)), src).toThrow(
        /not same-origin/,
      );
    }
    for (const href of [
      'https://fonts.example.com/x.css',
      '//fonts.example.com/x.css',
      '/\\fonts.example.com/x.css',
    ]) {
      expect(() => checkShell(shell(`<link rel="stylesheet" href="${href}">`)), href).toThrow(
        /off-origin/,
      );
    }
  });

  it('still approves the root-relative forms a real build emits', () => {
    // Including bare `/`, which the shape test admits at end of input.
    for (const href of ['/manifest.webmanifest', '/']) {
      expect(checkShell(shell(`<link rel="manifest" href="${href}">`)), href).toBe(0);
    }
  });

  it('fails when the shell is missing', () => {
    expect(() => checkShell(join(tmpdir(), 'no-such-pocket-build'))).toThrow(/does not exist/);
  });
});
