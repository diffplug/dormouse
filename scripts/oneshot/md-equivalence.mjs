#!/usr/bin/env node
/**
 * One-shot check for a markdown reflow: every tracked `*.md` / `*.mdx` changed
 * since <ref> (default HEAD) must parse to the same tree, with soft line breaks
 * read as spaces. Run from the repo root after `node scripts/md-unwrap.mjs --fix`.
 *
 *   node scripts/oneshot/md-equivalence.mjs [<ref>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';

const ref = process.argv[2] ?? 'HEAD';
const parse = (text, mdx) => fromMarkdown(text, {
  extensions: [gfmTable(), frontmatter(), ...(mdx ? [mdxjs()] : [])],
  mdastExtensions: [gfmTableFromMarkdown(), frontmatterFromMarkdown(), ...(mdx ? [mdxFromMarkdown()] : [])],
});
const shape = (tree) => JSON.stringify(tree, (key, value) => {
  if (key === 'position' || key === 'data') return undefined;
  return key === 'value' && typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ') : value;
});

const files = execFileSync('git', ['diff', '--name-only', ref, '--', '*.md', '*.mdx'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
let different = 0;
for (const file of files) {
  const mdx = file.endsWith('.mdx');
  const before = execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
  if (shape(parse(before, mdx)) !== shape(parse(readFileSync(file, 'utf8'), mdx))) {
    console.error(`DIFFERENT ${file}`);
    different++;
  }
}
console.error(`md-equivalence: ${files.length} file(s) vs ${ref}, ${different} parse differently`);
process.exit(different ? 1 : 0);
