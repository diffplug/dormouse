import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWorkspaceCoverage,
  getDependencyNames,
  externalPlatformSiblings,
  isLonePlatformBuild,
  linkedPeerPackageJsonPath,
  missingDependency,
} from './dependency-workspaces.js';

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
      { name: 'runtime', optional: false, peer: false },
      { name: 'native-darwin', optional: true, peer: false },
    ]);
  });

  // pnpm installs these, as `debug`'s optional `supports-color` in the Relay.
  it('includes required and optional peers, and an optional peer named only in its meta', () => {
    expect(getDependencyNames({
      dependencies: { runtime: '1.0.0' },
      peerDependencies: { react: '*', 'supports-color': '*', runtime: '*' },
      peerDependenciesMeta: { 'supports-color': { optional: true }, '@types/react': { optional: true } },
    })).toEqual([
      { name: 'runtime', optional: false, peer: false },
      { name: 'react', optional: false, peer: true },
      { name: 'supports-color', optional: true, peer: true },
      { name: '@types/react', optional: true, peer: true },
    ]);
  });

  // Hosted ships bundles only, which hold an optional peer only where imported.
  it('drops only optional peers when a section follows none', () => {
    expect(getDependencyNames({
      optionalDependencies: { 'native-darwin': '2.0.0' },
      peerDependencies: { hono: '*', vitest: '*' },
      peerDependenciesMeta: { vitest: { optional: true }, next: { optional: true } },
    }, { optionalPeers: false })).toEqual([
      { name: 'native-darwin', optional: true, peer: false },
      { name: 'hono', optional: false, peer: true },
    ]);
  });

  it('accepts a manifest declaring neither block', () => {
    expect(getDependencyNames({})).toEqual([]);
  });
});

// docs/specs/security-supply-chain.md -> "Disclosure": only an external
// package's optional edge may go undisclosed.
describe('a dependency this machine did not install', () => {
  it('is skipped only on an optional edge an external package declares', () => {
    expect(missingDependency({ optional: false, isWorkspace: false, isProductRoot: false })).toBe('throw');
    expect(missingDependency({ optional: true, isWorkspace: false, isProductRoot: false })).toBe('skip');
    expect(missingDependency({ optional: true, isWorkspace: true, isProductRoot: true })).toBe('describe');
    expect(missingDependency({ optional: true, isWorkspace: true, isProductRoot: false })).toBe('throw');
  });

  it('is skipped on an optional peer nothing supplied, whoever declares it', () => {
    expect(missingDependency({ optional: true, peer: true, isWorkspace: false, isProductRoot: false })).toBe('skip');
    expect(missingDependency({ optional: true, peer: true, isWorkspace: true, isProductRoot: true })).toBe('skip');
    expect(missingDependency({ optional: false, peer: true, isWorkspace: false, isProductRoot: false })).toBe('throw');
  });
});

// The layout pnpm writes: each instance of a package lives in its own
// `.pnpm/<id>/node_modules`, beside the dependencies and peers linked for it.
describe('a peer pnpm linked for one instance', () => {
  let root;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function manifest(dir, name) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
    return dir;
  }

  it('resolves beside the instance only, never from the hidden hoist', () => {
    root = mkdtempSync(join(tmpdir(), 'linked-peer-'));
    const store = join(root, 'node_modules', '.pnpm');
    const supplied = manifest(join(store, 'debug@4.4.3_supports-color@10.2.2', 'node_modules', 'debug'), 'debug');
    manifest(join(store, 'debug@4.4.3_supports-color@10.2.2', 'node_modules', 'supports-color'), 'supports-color');
    const bare = manifest(join(store, 'debug@4.4.3', 'node_modules', 'debug'), 'debug');
    manifest(join(store, 'node_modules', 'supports-color'), 'supports-color');
    const scoped = manifest(join(store, '@radix-ui+react-slot@1.0.0_react@19.3.0', 'node_modules', '@radix-ui', 'react-slot'), '@radix-ui/react-slot');
    manifest(join(store, '@radix-ui+react-slot@1.0.0_react@19.3.0', 'node_modules', 'react'), 'react');
    const workspace = manifest(join(root, 'lib'), 'lib');
    manifest(join(workspace, 'node_modules', 'react'), 'react');

    expect(linkedPeerPackageJsonPath(supplied, 'debug', 'supports-color', false))
      .toBe(join(store, 'debug@4.4.3_supports-color@10.2.2', 'node_modules', 'supports-color', 'package.json'));
    expect(linkedPeerPackageJsonPath(bare, 'debug', 'supports-color', false)).toBeNull();
    expect(linkedPeerPackageJsonPath(scoped, '@radix-ui/react-slot', 'react', false))
      .toBe(join(store, '@radix-ui+react-slot@1.0.0_react@19.3.0', 'node_modules', 'react', 'package.json'));
    expect(linkedPeerPackageJsonPath(workspace, 'lib', 'react', true))
      .toBe(join(workspace, 'node_modules', 'react', 'package.json'));
  });
});

// docs/specs/security-supply-chain.md -> "Disclosure": which build installs
// depends on the machine, so the family is disclosed whichever one did.
describe('an installed platform build an external package declares', () => {
  const typescript = {
    name: 'typescript',
    optionalDependencies: {
      '@typescript/typescript-darwin-arm64': '7.0.2',
      '@typescript/typescript-linux-x64': '7.0.2',
      '@typescript/typescript-win32-x64': '7.0.2',
      '@typescript/typescript-legacy': '6.0.0',
    },
  };
  const edge = { pkg: typescript, optional: true, isWorkspace: false };
  const build = (name) => ({ name, os: ['any'] });
  const none = new Set();

  it('brings every sibling at its version, whichever one this machine installed', () => {
    expect(externalPlatformSiblings(edge, build('@typescript/typescript-darwin-arm64'), none))
      .toEqual(['@typescript/typescript-linux-x64', '@typescript/typescript-win32-x64']);
    expect(externalPlatformSiblings(edge, build('@typescript/typescript-linux-x64'), none))
      .toEqual(['@typescript/typescript-darwin-arm64', '@typescript/typescript-win32-x64']);
    expect(externalPlatformSiblings(edge, { name: '@typescript/typescript-linux-x64', libc: ['glibc'] }, none))
      .toEqual(['@typescript/typescript-darwin-arm64', '@typescript/typescript-win32-x64']);
  });

  it('brings nothing for a portable package, a required or workspace edge, or a family a product root names', () => {
    const name = '@typescript/typescript-darwin-arm64';
    expect(externalPlatformSiblings(edge, { name }, none)).toEqual([]);
    expect(externalPlatformSiblings({ ...edge, optional: false }, build(name), none)).toEqual([]);
    expect(externalPlatformSiblings({ ...edge, isWorkspace: true }, build(name), none)).toEqual([]);
    expect(externalPlatformSiblings(edge, build(name), new Set([name]))).toEqual([]);
  });
});

// docs/specs/security-supply-chain.md -> "Disclosure": a machine that cannot
// install a lone platform build has nothing to describe it from, so every
// machine must skip it for the snapshot to be the same everywhere.
describe('an external platform build with no sibling', () => {
  const vite = { name: 'vite', optionalDependencies: { fsevents: '~2.3.3' } };
  const edge = { pkg: vite, optional: true, peer: false, isWorkspace: false, isProductRoot: false };
  const fsevents = { name: 'fsevents', version: '2.3.3', os: ['darwin'] };
  const none = new Set();

  it('is skipped installed as it is absent', () => {
    expect(missingDependency(edge)).toBe('skip');
    expect(isLonePlatformBuild(edge, fsevents, none)).toBe(true);
  });

  it('is read when portable, required, a workspace\'s, in a family, or a product root\'s', () => {
    expect(isLonePlatformBuild(edge, { name: 'fsevents' }, none)).toBe(false);
    expect(isLonePlatformBuild({ ...edge, optional: false }, fsevents, none)).toBe(false);
    expect(isLonePlatformBuild({ ...edge, isWorkspace: true }, fsevents, none)).toBe(false);
    expect(isLonePlatformBuild(
      { ...edge, pkg: { optionalDependencies: { fsevents: '2.3.3', 'fsevents-linux': '2.3.3' } } }, fsevents, none,
    )).toBe(false);
    expect(isLonePlatformBuild(edge, fsevents, new Set(['fsevents']))).toBe(false);
  });
});
