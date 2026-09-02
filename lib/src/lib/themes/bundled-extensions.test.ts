import { describe, expect, it } from 'vitest';
import bundledExtensions from './bundled-extensions.json';
import bundledThemes from './bundled.json';

// Every theme in bundled.json is compiled into every build (store.ts imports
// it), so each one owes an upstream-provenance row on the supply-chain page —
// SECURITY.md, "Dependency Supply Chain". bundled-extensions.json is that
// disclosure, and website/scripts/generate-deps.js appends it to the npm table.
//
// lib/scripts/bundle-themes.mjs writes both files from one EXTENSIONS list, but
// both are checked in and the script needs network, so nothing stops a hand-edit
// to one from drifting off the other — and regenerating the disclosure produces
// no diff, so ci.yml's stale-snapshot gate cannot see it. `extensionId` is the
// join key; this test is the gate.
describe('bundled.json / bundled-extensions.json disclosure parity', () => {
  // bundled.json ids are `${namespace}.${name}.${slugify(label)}`; the first two
  // segments are the OpenVSX extension the theme was extracted from.
  const extensionIdOf = (themeId: string) => themeId.split('.').slice(0, 2).join('.');

  const shipped = new Set(bundledThemes.map((theme) => extensionIdOf(theme.id)));
  const disclosed = new Set(bundledExtensions.map((ext) => ext.extensionId));

  it('every bundled theme comes from a disclosed extension', () => {
    expect([...shipped].filter((id) => !disclosed.has(id))).toEqual([]);
  });

  it('every disclosed extension still ships at least one bundled theme', () => {
    expect([...disclosed].filter((id) => !shipped.has(id))).toEqual([]);
  });

  it('discloses each extension exactly once', () => {
    expect(bundledExtensions.length).toBe(disclosed.size);
  });
});
