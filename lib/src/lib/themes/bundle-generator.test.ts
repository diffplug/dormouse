import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('runs the actual bundle generator with the shared color conversion', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/bundle-themes.mjs');
  const fixture = mkdtempSync(join(tmpdir(), 'dormouse-theme-generator-'));
  try {
    const preload = join(fixture, 'openvsx-fixture.mjs');
    writeFileSync(preload,
      "import fs from 'node:fs';\n" +
      "import { basename, dirname, join, resolve } from 'node:path';\n" +
      "import { createRequire, syncBuiltinESMExports } from 'node:module';\n" +
      "import { pathToFileURL } from 'node:url';\n" +
      "const script = " + JSON.stringify(script) + ";\n" +
      "const fixture = " + JSON.stringify(fixture) + ";\n" +
      "const { zipSync, strToU8 } = createRequire(pathToFileURL(script))('fflate');\n" +
      "const vsix = zipSync({\n" +
      "  'extension/package.json': strToU8(JSON.stringify({ contributes: { themes: [\n" +
      "    { path: './light.json', label: '%light%', uiTheme: 'hc-light' },\n" +
      "    { path: './dark.json', label: 'Test Dark', uiTheme: 'vs-dark' },\n" +
      "  ] } })),\n" +
      "  'extension/package.nls.json': strToU8(JSON.stringify({ light: { message: 'Test Light' } })),\n" +
      "  'extension/light.json': strToU8(JSON.stringify({ colors: { 'editor.background': '#123456', 'list.activeSelectionForeground': '#abcdef', 'terminal.ansiMagenta': '#fedcba', 'unconsumed.key': '#654321' } })),\n" +
      "  'extension/dark.json': strToU8(JSON.stringify({ colors: {} })),\n" +
      "});\n" +
      "globalThis.fetch = async (input) => {\n" +
      "  const url = new URL(input);\n" +
      "  if (url.origin === 'https://open-vsx.org' && url.pathname.endsWith('/latest')) return Response.json({ version: '1.2.3', files: { download: 'https://theme-fixture.invalid/test.vsix' } });\n" +
      "  if (url.href === 'https://theme-fixture.invalid/test.vsix') return new Response(vsix);\n" +
      "  throw new Error('unexpected network request: ' + url.href);\n" +
      "};\n" +
      "const allowed = new Set(['bundled.json', 'bundled-extensions.json'].map(name => resolve(dirname(script), '../src/lib/themes', name)));\n" +
      "const originalWrite = fs.writeFileSync;\n" +
      "fs.writeFileSync = (destination, ...args) => {\n" +
      "  const target = resolve(String(destination));\n" +
      "  if (!allowed.has(target)) throw new Error('unexpected generator output: ' + target);\n" +
      "  originalWrite(join(fixture, basename(target)), ...args);\n" +
      "};\n" +
      "syncBuiltinESMExports();\n",
    );
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const themes = JSON.parse(readFileSync(join(fixture, 'bundled.json'), 'utf8'));
    const extensions = JSON.parse(readFileSync(join(fixture, 'bundled-extensions.json'), 'utf8'));
    expect(extensions.length).toBeGreaterThan(0);
    expect(themes).toHaveLength(extensions.length * 2);
    for (const extension of extensions) {
      const owned = themes.filter((theme: { id: string }) => theme.id.startsWith(extension.extensionId + '.'));
      expect(owned).toHaveLength(2);
      expect(owned[0]).toMatchObject({ label: 'Test Light', type: 'light', vars: {
        '--vscode-editor-background': '#123456',
        '--vscode-list-activeSelectionForeground': '#abcdef',
        '--vscode-terminal-ansiMagenta': '#fedcba',
      } });
      expect(Object.keys(owned[0].vars)).toHaveLength(3);
      expect(owned[1]).toMatchObject({ label: 'Test Dark', type: 'dark', vars: {} });
      expect(extension.version).toBe('1.2.3');
    }
  } finally {
    // mkdtemp owns only this new fixture directory, never checked-in bundles.
    if (dirname(fixture) !== resolve(tmpdir()) || !basename(fixture).startsWith('dormouse-theme-generator-')) throw new Error('unexpected fixture path');
    rmSync(fixture, { recursive: true, force: true });
  }
});
