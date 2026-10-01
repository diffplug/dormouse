import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// docs/specs/dor-tools-lib.md -> Package: MIT, with no runtime dependencies,
// so nothing FSL or third-party reaches a Tool or host that embeds it.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('declares no runtime dependencies and the MIT license', () => {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
    assert.equal(pkg[field], undefined, field);
  }
  assert.equal(pkg.license, 'MIT');
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License/);
});

test('its source imports only its own modules', () => {
  const src = new URL('../src/', import.meta.url);
  for (const name of readdirSync(src)) {
    const text = readFileSync(new URL(name, src), 'utf8');
    for (const [, specifier] of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      assert.match(specifier, /^\.\/[\w-]+\.js$/, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/, `${name} loads a module dynamically`);
  }
});
