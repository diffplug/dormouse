import { describe, expect, it } from 'vitest';
import { getCargoGitRepository, getShippedCargoGraph } from './cargo-dependencies.js';

const edge = (pkg, ...kinds) => ({ name: pkg, pkg, dep_kinds: kinds.map((kind) => ({ kind, target: null })) });
const metadata = (nodes) => ({ resolve: { root: 'app', nodes: Object.entries(nodes).map(([id, deps]) => ({ id, deps })) } });

describe('shipped Cargo graph', () => {
  it('drops dev-only edges and what only they reach, keeping normal and build edges', () => {
    const { directDeps, shippedIds } = getShippedCargoGraph(metadata({
      app: [edge('tauri', null), edge('tauri-build', 'build'), edge('tao', 'dev'), edge('harness', 'dev')],
      tauri: [edge('tao', null)],
      'tauri-build': [],
      tao: [],
      harness: [edge('harness-only', null)],
      'harness-only': [],
    }));
    expect(directDeps.map((dep) => dep.pkg)).toEqual(['tauri', 'tauri-build']);
    expect([...shippedIds].sort()).toEqual(['tao', 'tauri', 'tauri-build']);
  });

  it('keeps a direct edge that is both dev and normal', () => {
    const { directDeps } = getShippedCargoGraph(metadata({ app: [edge('objc2', null, 'dev')], objc2: [] }));
    expect(directDeps.map((dep) => dep.pkg)).toEqual(['objc2']);
  });
});

describe('Cargo git sources', () => {
  it('discloses a git-patched crate at its fork', () => {
    expect(getCargoGitRepository('git+https://github.com/diffplug/tao?rev=397f678#397f678')).toBe('https://github.com/diffplug/tao');
    expect(getCargoGitRepository('git+https://github.com/diffplug/tao.git#397f678')).toBe('https://github.com/diffplug/tao');
  });

  it('leaves registry crates to their own metadata', () => {
    expect(getCargoGitRepository('registry+https://github.com/rust-lang/crates.io-index')).toBeNull();
    expect(getCargoGitRepository(null)).toBeNull();
  });
});
