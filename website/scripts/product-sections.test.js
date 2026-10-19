import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertWorkspaceCoverage, getWorkspacePackages } from './dependency-workspaces.js';
import { excludedWorkspacePackages, productSections } from './product-sections.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const rootsOf = (id) => productSections.find((section) => section.id === id)?.roots ?? [];

// docs/specs/security-supply-chain.md -> "Disclosure": every workspace is
// classified from its shipping route.
describe('the product sections over this repository', () => {
  it('classify every workspace, with no exclusion reachable from a root', () => {
    expect(() => assertWorkspaceCoverage(
      getWorkspacePackages(repoRoot),
      productSections.flatMap((section) => section.roots),
      excludedWorkspacePackages,
    )).not.toThrow();
  });

  // One package holds all three Workers and the account page.
  it('root Hosted at its Workers', () => {
    expect(rootsOf('hosted')).toEqual(['dormouse-hosted']);
    expect(excludedWorkspacePackages).not.toContain('dormouse-hosted');
  });
});

describe('the committed npm disclosure', () => {
  const npm = JSON.parse(readFileSync(resolve(here, '../src/data/dependencies-npm.json'), 'utf-8'));
  const releases = (rows) => rows.flatMap((row) => row.versions.map((version) => `${row.name}@${version}`));

  it('has one table per product section, in walk order', () => {
    expect(Object.keys(npm)).toEqual(productSections.map((section) => section.id));
  });

  it('lists each release in the first section that reaches it only', () => {
    const seen = new Map();
    const repeats = [];
    for (const [section, rows] of Object.entries(npm)) {
      for (const release of releases(rows)) {
        if (seen.has(release)) repeats.push(`${release} in ${seen.get(release)} and ${section}`);
        else seen.set(release, section);
      }
    }
    expect(repeats).toEqual([]);
  });

  // relay.dormouse.sh serves Pocket and the one-time page, built from
  // `dormouse-lib`, whose React and xterm.js the Terminal's root discloses.
  it('leaves Pocket\'s packages under the Terminal', () => {
    for (const name of ['react', '@xterm/xterm']) {
      expect(npm.terminal.map((row) => row.name)).toContain(name);
      expect(npm.hosted.map((row) => row.name)).not.toContain(name);
    }
  });
});
