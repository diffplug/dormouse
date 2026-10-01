import { describe, expect, it } from 'vitest';
import { assertWorkspaceCoverage, getDependencyNames } from './dependency-workspaces.js';

const workspace = (name, fields = {}) => ({ pkg: { name, ...fields } });

describe('dependency disclosure workspace coverage', () => {
  it('rejects a new workspace even when it appears only in devDependencies', () => {
    const packages = [workspace('app', { devDependencies: { helper: '*' } }), workspace('helper')];
    expect(() => assertWorkspaceCoverage(packages, ['app'], [])).toThrow('Unclassified workspace packages: helper');
  });

  it('accepts transitive runtime and optional edges, including cycles', () => {
    const packages = [
      workspace('app', { dependencies: { common: 'workspace:*' } }),
      workspace('common', { optionalDependencies: { native: 'workspace:*' } }),
      workspace('native', { dependencies: { common: 'workspace:*' } }),
      workspace('lab'),
    ];
    expect(() => assertWorkspaceCoverage(packages, ['app'], ['lab'])).not.toThrow();
  });

  it('rejects an exclusion that starts shipping through a runtime edge', () => {
    const packages = [workspace('app', { dependencies: { lab: 'workspace:*' } }), workspace('lab')];
    expect(() => assertWorkspaceCoverage(packages, ['app'], ['lab'])).toThrow('Excluded workspace "lab" is reachable');
  });

  it.each(['root', 'exclusion'])('rejects a stale %s name', (kind) => {
    expect(() => assertWorkspaceCoverage([workspace('app')],
      kind === 'root' ? ['renamed'] : ['app'], kind === 'exclusion' ? ['renamed'] : []))
      .toThrow('Workspace package "renamed" was not found');
  });

  it('rejects duplicate workspace names that would hide a dependency graph', () => {
    expect(() => assertWorkspaceCoverage([workspace('app'), workspace('app')], ['app'], []))
      .toThrow('Workspace package names must be unique');
  });
});

describe('dependency edges', () => {
  it('flags which edges are optional and drops development ones', () => {
    expect(getDependencyNames({
      dependencies: { runtime: '1.0.0' },
      optionalDependencies: { 'native-darwin': '2.0.0' },
      devDependencies: { builder: '3.0.0' },
    })).toEqual([
      { name: 'runtime', optional: false },
      { name: 'native-darwin', optional: true },
    ]);
  });

  it('accepts a manifest declaring neither block', () => {
    expect(getDependencyNames({})).toEqual([]);
  });
});
