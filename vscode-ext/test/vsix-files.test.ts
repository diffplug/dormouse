/**
 * What `.vscodeignore` lets into the VSIX outside the build output. A new
 * root-level dev file (a tsconfig, a test config) is packaged unless it is
 * listed there, and nothing else notices.
 */

import { fileURLToPath } from 'node:url';

import { listFiles, PackageManager } from '@vscode/vsce';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

it('packages only the build output and the listed root files', async () => {
  const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
  const outsideBuild = files.filter((file) => !/^(dist|media|images)\//.test(file)).sort();
  expect(outsideBuild).toEqual(['CHANGELOG.md', 'LICENSE', 'README.md', 'icon-tiny.png', 'icon.png', 'package.json']);
});
