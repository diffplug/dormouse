import { describe, expect, it } from 'vitest';
import { compareVersions, mergeReleases } from './dependency-rows.js';

const release = (version, fields = {}) => ({ name: 'toml', version, license: 'MIT', author: null, homepage: null, ...fields });

describe('compareVersions', () => {
  it('orders numeric parts as numbers', () => {
    expect(['0.10.0', '0.9.12+spec-1.1.0', '1.1.2'].sort(compareVersions)).toEqual(['0.9.12+spec-1.1.0', '0.10.0', '1.1.2']);
  });
});

describe('mergeReleases', () => {
  it('lists every release of one name and license on one row, oldest first', () => {
    expect(mergeReleases([release('1.1.2'), release('0.8.2'), release('0.9.12')]).map((row) => row.version)).toEqual(['0.8.2, 0.9.12, 1.1.2']);
  });

  it('keeps a license change on its own row', () => {
    const rows = mergeReleases([release('2.12.1', { license: 'BSD-3-Clause' }), release('3.2.4', { license: 'ISC' })]);
    expect(rows.map((row) => [row.version, row.license])).toEqual([['2.12.1', 'BSD-3-Clause'], ['3.2.4', 'ISC']]);
  });

  it('takes author and homepage from the newest release that names them', () => {
    const [row] = mergeReleases([
      release('0.8.2', { author: 'Alex Crichton', homepage: 'https://old' }),
      release('1.1.2', { homepage: 'https://new' }),
    ]);
    expect([row.author, row.homepage]).toEqual(['Alex Crichton', 'https://new']);
  });

  it('keeps releases apart when a groupBy field differs', () => {
    const rows = mergeReleases([release('1.0.0', { section: 'terminal' }), release('2.0.0', { section: 'relay' })], ['section']);
    expect(rows.map((row) => row.section)).toEqual(['terminal', 'relay']);
  });
});
