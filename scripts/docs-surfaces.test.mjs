import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDocsSurfaces } from './docs-surfaces.mjs';

test('docs checks reach nested components through TS bridges and cyclic imports on every OS', () => {
  const source = {
    'website/src/pages/Guide.tsx': `import { theme } from '../lib/theme'; import { Page } from '../components/Page';`,
    'website/src/lib/theme.ts': `export { ThemeControl } from '../components/ThemeControl';`,
    'website/src/components/Page.tsx': `import { Guide } from '../pages/Guide'; import React from 'react';`,
    'website/src/components/ThemeControl.tsx': '',
  };
  const reads = [];
  const result = collectDocsSurfaces(['website/src/pages/Guide.tsx'], Object.keys(source), rel => {
    reads.push(rel);
    return source[rel];
  });
  assert.deepEqual(result, {
    surfaces: ['website/src/components/Page.tsx', 'website/src/components/ThemeControl.tsx', 'website/src/pages/Guide.tsx'],
    missingSeeds: [],
  });
  assert.equal(new Set(reads).size, reads.length);
});

test('missing seeds are reported and absent imports are never read', () => {
  const source = { 'src/Page.tsx': `import { Absent } from './Absent'; import { Package } from 'package';` };
  assert.deepEqual(collectDocsSurfaces(['src/Page.tsx', 'src/Missing.tsx'], Object.keys(source), rel => {
    assert.ok(Object.hasOwn(source, rel));
    return source[rel];
  }), { surfaces: ['src/Page.tsx'], missingSeeds: ['src/Missing.tsx'] });
});
