import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSUMED_VSCODE_KEYS } from './convert';

// The bundle script is a .mjs build-time tool that can't import TS, so it
// duplicates CONSUMED_VSCODE_KEYS as a local set. This test pins the two
// lists together — adding a key to one without the other will fail loudly
// instead of producing a bundled.json that's missing colors used by the app
// at runtime.
describe('CONSUMED_VSCODE_KEYS / bundle-themes.mjs parity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(here, '../../../scripts/bundle-themes.mjs');
  const scriptSource = readFileSync(scriptPath, 'utf8');

  const consumedBlock = scriptSource.match(/const CONSUMED_KEYS = new Set\(\[([\s\S]*?)\]\);/);
  if (!consumedBlock) throw new Error('Could not locate CONSUMED_KEYS in bundle-themes.mjs');
  const scriptKeys = new Set(
    Array.from(consumedBlock[1].matchAll(/'([^']+)'/g), (match: RegExpExecArray) => match[1]),
  );

  it('every key in convert.ts CONSUMED_VSCODE_KEYS is in bundle-themes.mjs CONSUMED_KEYS', () => {
    const missing = CONSUMED_VSCODE_KEYS.filter((k) => !scriptKeys.has(k));
    expect(missing).toEqual([]);
  });

  it('every key in bundle-themes.mjs CONSUMED_KEYS is in convert.ts CONSUMED_VSCODE_KEYS', () => {
    const consumedSet = new Set<string>(CONSUMED_VSCODE_KEYS);
    const extra = [...scriptKeys].filter((k) => !consumedSet.has(k));
    expect(extra).toEqual([]);
  });
});

// Every var()-bound token declared at document level (@theme or :root) must be
// mirrored onto body with the same value, or it resolves to nothing outside
// VS Code — rationale in docs/specs/theme.md. Values are compared, not just
// presence, so repointing one level's binding without the other fails too.
describe('theme.css var() bindings are mirrored onto body', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const themeCss = readFileSync(resolve(here, '../../theme.css'), 'utf8');

  function declarations(block: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) out.set(m[1], m[2].trim());
    return out;
  }

  function blockBody(pattern: RegExp): string {
    const match = themeCss.match(pattern);
    if (!match) throw new Error(`Could not locate ${pattern} in theme.css`);
    return match[1];
  }

  const documentLevel = new Map([
    ...declarations(blockBody(/@theme \{([\s\S]*?)\n\}/)),
    ...declarations(blockBody(/\n:root \{([\s\S]*?)\n\}/)),
  ]);
  const bodyLevel = declarations(blockBody(/\nbody \{([\s\S]*?)\n\}/));

  it('every document-level token bound to a var() chain is mirrored onto body', () => {
    const missing = [...documentLevel]
      .filter(([name, value]) => value.includes('var(') && bodyLevel.get(name) !== value)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});
