import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { startFileViewer } from '../dist/file-viewer.js';
import { load } from './bundle.mjs';

// The panel imports MDXEditor, which bundles only for Node.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../viewer/images-panel.tsx', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', loader: { '.css': 'empty' },
});
const { localImagePath, renamedSource } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// The parser and serializer versions the installed editor saves with.
const editor = createRequire(createRequire(new URL('../viewer/markdown.tsx', import.meta.url)).resolve('@mdxeditor/editor'));
const dependency = name => import(pathToFileURL(editor.resolve(name)).href);
const { fromMarkdown } = await dependency('mdast-util-from-markdown');
const { toMarkdown } = await dependency('mdast-util-to-markdown');
const { markdownFormat } = await load('../viewer/markdown-format.ts');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077' + '53de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');

function rename(viewer, from, to) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: viewer.port, path: viewer.path.replace(/view$/, 'rename'), method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${viewer.port}` },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ from, to }));
  });
}

test('a renamed image is written as a link that reads back as its new file', { skip: process.platform === 'win32' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dor-images-panel-')));
  try {
    await mkdir(join(root, 'img'));
    for (const [src, name, line] of [
      ['shot.png', 'Figure #1.png', '![a](Figure%20%231.png)'],
      ['./img/shot.png', 'why?.png', '![a](./img/why%3F.png)'],
      ['img/shot.png', '50% scale.png', '![a](img/50%25%20scale.png)'],
      ['shot.png', 'my shot.png', '![a](<my shot.png>)'],
      ['img/shot.png', 'shot (2).png', '![a](<img/shot (2).png>)'],
      ['img/a%20b.png', 'shot (2).png', '![a](img/shot%20\\(2\\).png)'],
      ['img/shot.png', 'plain.png', '![a](img/plain.png)'],
    ]) {
      const path = localImagePath(src), folder = path.slice(0, path.lastIndexOf('/') + 1);
      for (const entry of await readdir(join(root, 'img'))) await rm(join(root, 'img', entry));
      await rm(join(root, 'shot.png'), { force: true });
      await writeFile(join(root, path), PNG);
      const doc = `# Doc\n\n![a](${src})\n`;
      await writeFile(join(root, 'doc.md'), doc);
      const viewer = await startFileViewer(join(root, 'doc.md'));
      try {
        assert.equal(await rename(viewer, path, folder + name), 200, name);
      } finally { await viewer.close(); }
      assert.ok((await readdir(join(root, folder || '.'))).includes(name), `${name} on disk`);

      const tree = fromMarkdown(doc);
      tree.children[1].children[0].url = renamedSource(src, name, folder + name);
      const saved = toMarkdown(tree, markdownFormat(doc));
      assert.equal(saved, doc.replace(`![a](${src})`, line), `${src} → ${name}`);
      assert.equal(localImagePath(fromMarkdown(saved).children[1].children[0].url), folder + name, `${line} reads back`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
