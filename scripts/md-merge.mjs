#!/usr/bin/env node
/**
 * Git merge driver for markdown that merges paragraphs sentence by sentence.
 * With one source line per paragraph (AGENTS.md -> "Markdown"), Git's line
 * merge conflicts whenever both sides touch one paragraph; this driver lets
 * edits to different sentences merge, adjacent ones included.
 *
 *   1. Each side is unwrapped (so a pre-reflow side merges against a reflowed
 *      one), and every paragraph is split onto one line per sentence. A split
 *      line ends in MORE when its paragraph continues, END when it closes it.
 *   2. `git merge-file --diff3` merges the split texts line by line.
 *   3. A conflict hunk made only of sentence lines is re-merged here, sentence
 *      by sentence, where edits that touch different base sentences do not
 *      conflict even when adjacent (Git's line merge requires an unchanged
 *      line between them). Anything else stays a conflict.
 *   4. Sentences rejoin into one line per paragraph, except inside a remaining
 *      conflict, where they stay one per line so the conflict is as small as
 *      the sentences involved. `pnpm lint:md` flags a resolution left split;
 *      `node scripts/md-unwrap.mjs --fix` joins it.
 *
 * Installed per clone by `pnpm setup:git` (scripts/setup-git.mjs) for the
 * `*.md` / `*.mdx` attribute in .gitattributes. Git invokes it as
 *
 *   md-merge.mjs %O %A %B %L %P %S %X %Y
 *
 * and reads the result from %A: exit 0 when clean, 1 on conflicts, above 128
 * when the merge itself failed. Input this driver cannot parse, or a side that
 * already contains MORE or END, gets Git's own line merge instead.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Ends a sentence line whose paragraph continues on the next line. */
export const MORE = '\x1f';
/** Ends the last sentence line of a paragraph. */
export const END = '\x1e';

/** A sentence end: terminal punctuation, any closers, then the one space split there. */
const BOUNDARY = /(?<=[.!?][)\]"'’”*_`]*) (?=\S)/g;
/** Marker width for the internal merge, wide enough never to match content. */
const WIDE = 40;

const isSentence = (line) => line.endsWith(MORE) || line.endsWith(END);

/**
 * `text` unwrapped, then each one-line paragraph split after every sentence.
 * Only the paragraph's content is split, never its container prefix.
 */
export function splitSentences(text, mdx, { unwrap, parseMarkdown }) {
  const unwrapped = unwrap(text, { mdx });
  const lines = unwrapped.split('\n');
  const walk = (node) => {
    const { start, end } = node.position ?? {};
    if (node.type === 'paragraph' && start.line === end.line) {
      const line = lines[start.line - 1];
      const at = start.column - 1;
      lines[start.line - 1] = line.slice(0, at) + line.slice(at).replace(BOUNDARY, `${MORE}\n`) + END;
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(parseMarkdown(unwrapped, mdx));
  return lines.join('\n');
}

/** Sentence lines rejoined into their paragraphs; other lines unchanged. */
export function rejoin(lines) {
  const out = [];
  let open = false;
  for (const line of lines) {
    if (isSentence(line)) {
      const text = line.slice(0, -1);
      if (open) out[out.length - 1] += ` ${text}`;
      else out.push(text);
      open = line.endsWith(MORE);
    } else {
      out.push(line);
      open = false;
    }
  }
  return out;
}

/** `side` as edits to `base`: `base[start, end)` replaced by `lines`, in order. */
function edits(base, side) {
  const n = base.length;
  const m = side.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = base[i] === side[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let hunk = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) {
      if (hunk) { out.push(hunk); hunk = null; }
      i++; j++;
      continue;
    }
    hunk ??= { start: i, end: i, lines: [] };
    if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) hunk.lines.push(side[j++]);
    else hunk.end = ++i;
  }
  if (hunk) out.push(hunk);
  return out;
}

const sameEdit = (x, y) => x.start === y.start && x.end === y.end && x.lines.join('\n') === y.lines.join('\n');

function clash(x, y) {
  const xInsert = x.start === x.end;
  const yInsert = y.start === y.end;
  if (xInsert && yInsert) return x.start === y.start;
  if (xInsert) return y.start < x.start && x.start < y.end;
  if (yInsert) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

/**
 * A 3-way merge of sentence lists in which edits conflict only when they
 * replace a shared base sentence or insert different sentences at one point.
 * Returns the merged list, or null on conflict.
 */
export function mergeSentences(base, ours, theirs) {
  const a = edits(base, ours);
  const b = edits(base, theirs).filter((y) => !a.some((x) => sameEdit(x, y)));
  if (a.some((x) => b.some((y) => clash(x, y)))) return null;
  const all = [...a, ...b].sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
  const out = [];
  let at = 0;
  for (const edit of all) {
    out.push(...base.slice(at, edit.start), ...edit.lines);
    at = edit.end;
  }
  return [...out, ...base.slice(at)];
}

/** Re-merge a hunk of sentence lines; null when it is not prose or truly conflicts. */
function resolveHunk({ ours, base, theirs }) {
  const sections = [ours, base, theirs];
  // One paragraph only: END may close a section, never sit inside one.
  if (!sections.every((s) => s.every(isSentence) && s.slice(0, -1).every((line) => line.endsWith(MORE)))) return null;
  const text = (s) => s.map((line) => line.slice(0, -1));
  const merged = mergeSentences(text(base), text(ours), text(theirs));
  if (merged === null) return null;
  const closes = sections.some((s) => s.at(-1)?.endsWith(END));
  return merged.map((sentence, k) => sentence + (k === merged.length - 1 && closes ? END : MORE));
}

/** `git merge-file -p` over three texts; returns its stdout and exit status. */
function mergeFile(base, ours, theirs, args) {
  const dir = mkdtempSync(join(tmpdir(), 'md-merge-'));
  try {
    const paths = ['ours', 'base', 'theirs'].map((name) => join(dir, name));
    [ours, base, theirs].forEach((text, k) => writeFileSync(paths[k], text));
    const result = spawnSync('git', ['merge-file', '-p', ...args, ...paths], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.error || result.status === null || result.status > 127) {
      throw new Error(`git merge-file failed: ${result.error?.message ?? result.stderr}`);
    }
    return { text: result.stdout, conflicts: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Split `git merge-file --diff3` output (WIDE markers) into clean lines and hunks. */
function segments(text) {
  const mark = (c) => c.repeat(WIDE);
  const out = [];
  let hunk = null;
  let section = null;
  for (const line of text.split('\n')) {
    if (line === `${mark('<')} o`) { hunk = { ours: [], base: [], theirs: [] }; section = hunk.ours; continue; }
    if (hunk && line === `${mark('|')} b`) { section = hunk.base; continue; }
    if (hunk && line === mark('=')) { section = hunk.theirs; continue; }
    if (hunk && line === `${mark('>')} t`) { out.push(hunk); hunk = null; continue; }
    if (hunk) section.push(line);
    else out.push(line);
  }
  return out;
}

/**
 * A remaining conflict in the caller's style, its sentences one per line.
 * Lines both sides share are lifted out, still marked, to rejoin their paragraph.
 */
function renderConflict({ ours, base, theirs }, { markerSize, labels, conflictStyle }) {
  const plain = (lines) => lines.map((line) => (isSentence(line) ? line.slice(0, -1) : line));
  const [o, t] = [[...ours], [...theirs]];
  const before = [];
  const after = [];
  if (conflictStyle !== 'diff3') {
    // Like Git's `merge` and `zdiff3`, lift lines both sides share out of the conflict.
    while (o.length && t.length && o[0] === t[0]) { before.push(o.shift()); t.shift(); }
    while (o.length && t.length && o.at(-1) === t.at(-1)) { after.unshift(o.pop()); t.pop(); }
  }
  const [oursLabel, baseLabel, theirsLabel] = labels;
  const mark = (c, label) => c.repeat(markerSize) + (label ? ` ${label}` : '');
  const middle = conflictStyle === 'diff3' || conflictStyle === 'zdiff3' ? [mark('|', baseLabel), ...plain(base)] : [];
  const conflict = [mark('<', oursLabel), ...plain(o), ...middle, mark('='), ...plain(t), mark('>', theirsLabel)];
  return { before, conflict, after };
}

/**
 * Merge three markdown texts sentence by sentence. Returns the merged text and
 * its conflict count; `sentences` is false when it fell back to a line merge.
 */
export async function mergeMarkdown({ base, ours, theirs, mdx = false, markerSize = 7, labels = ['ours', 'base', 'theirs'], conflictStyle = 'merge' }) {
  if (![base, ours, theirs].some((text) => text.includes(MORE) || text.includes(END))) {
    let kit = null;
    try { kit = await import('./md-unwrap.mjs'); } catch { /* dependencies missing: line merge below */ }
    let split = null;
    try { split = kit && [base, ours, theirs].map((text) => splitSentences(text, mdx, kit)); } catch { /* unparseable */ }
    if (split) {
      const merged = mergeFile(split[0], split[1], split[2], ['--diff3', `--marker-size=${WIDE}`, '-L', 'o', '-L', 'b', '-L', 't']);
      const out = [];
      let flow = [];
      let conflicts = 0;
      for (const segment of segments(merged.text)) {
        const resolved = typeof segment === 'string' ? [segment] : resolveHunk(segment);
        if (resolved) { flow.push(...resolved); continue; }
        const { before, conflict, after } = renderConflict(segment, { markerSize, labels, conflictStyle });
        out.push(...rejoin([...flow, ...before]), ...conflict);
        flow = after;
        conflicts++;
      }
      out.push(...rejoin(flow));
      return { text: out.join('\n'), conflicts, sentences: true };
    }
  }
  const style = conflictStyle === 'diff3' || conflictStyle === 'zdiff3' ? [`--${conflictStyle}`] : [];
  const fallback = mergeFile(base, ours, theirs, [...style, `--marker-size=${markerSize}`, ...labels.flatMap((label) => ['-L', label])]);
  return { ...fallback, sentences: false };
}

async function main([basePath, oursPath, theirsPath, markerSize, path = '', baseLabel, oursLabel, theirsLabel]) {
  const given = (label) => label && !label.startsWith('%');
  const labels = [oursLabel, baseLabel, theirsLabel].every(given) ? [oursLabel, baseLabel, theirsLabel] : undefined;
  const conflictStyle = spawnSync('git', ['config', 'merge.conflictStyle'], { encoding: 'utf8' }).stdout.trim() || undefined;
  const read = (file) => readFileSync(file, 'utf8');
  const { text, conflicts } = await mergeMarkdown({
    base: read(basePath),
    ours: read(oursPath),
    theirs: read(theirsPath),
    mdx: path.endsWith('.mdx'),
    markerSize: Number(markerSize) || 7,
    labels,
    conflictStyle,
  });
  writeFileSync(oursPath, text);
  process.exit(conflicts > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`md-merge: ${error.message}`);
    process.exit(255);
  });
}
