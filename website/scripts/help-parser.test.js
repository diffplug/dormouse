import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseSnapshot,
  parseHelp,
  reconstruct,
  rootCommandNames,
  usageLines,
  definitionRows,
  labelledBody,
  MalformedSnapshotError,
} from './help-parser.js';

const helpDir = join(process.cwd(), '..', 'dor', 'test', 'snapshots', 'help');

async function allSnapshots() {
  const files = (await readdir(helpDir)).filter((f) => f.endsWith('.md'));
  return Promise.all(
    files.map(async (file) => ({ file, ...parseSnapshot(await readFile(join(helpDir, file), 'utf8'), file) })),
  );
}

describe('snapshot envelope', () => {
  it('parses every shipped snapshot', async () => {
    const snaps = await allSnapshots();
    expect(snaps.length).toBeGreaterThan(0);
    for (const s of snaps) {
      expect(s.title).toMatch(/^dor/);
      expect(s.invocation).toMatch(/--help$/);
      expect(s.raw).toContain('USAGE');
    }
  });

  it('rejects a malformed envelope', () => {
    expect(() => parseSnapshot('no heading here', 'x.md')).toThrow(MalformedSnapshotError);
    expect(() => parseSnapshot('# dor x\n\nno invocation\n', 'x.md')).toThrow(/Invocation/);
    expect(() => parseSnapshot('# dor x\n\nInvocation: `dor x --help`\n', 'x.md')).toThrow(/text help block/);
  });
});

describe('losslessness', () => {
  it('reconstructs every snapshot byte for byte', async () => {
    for (const snap of await allSnapshots()) {
      expect(reconstruct(parseHelp(snap.raw)), snap.file).toBe(snap.raw);
    }
  });

  it('keeps unclassified content as ordered prose', () => {
    const raw = 'USAGE\n  dor x\n\nSome prose here.\n\nFLAGS\n  --json  Print JSON.';
    const nodes = parseHelp(raw);
    expect(nodes.map((n) => n.kind)).toEqual(['usage', 'prose', 'flags']);
    expect(reconstruct(nodes)).toBe(raw);
  });
});

describe('semantic extraction', () => {
  it('reads usage lines', () => {
    const [usage] = parseHelp('USAGE\n  dor list [--json]\n  dor list --help');
    expect(usageLines(usage)).toEqual(['dor list [--json]', 'dor list --help']);
  });

  it('splits terms from descriptions on the aligned column', async () => {
    const snaps = await allSnapshots();
    const list = snaps.find((s) => s.file === 'list.md');
    const flags = parseHelp(list.raw).find((n) => n.kind === 'flags');
    const rows = definitionRows(flags);
    // "-h  --help" contains its own gap, so a naive first-gap split would
    // truncate the term to "-h".
    expect(rows.find((r) => r.term === '-h  --help')?.description).toBe('Print help information and exit');
    expect(rows.find((r) => r.term === '[--ports]')?.description).toMatch(/listening ports/);
  });

  it('joins a description that wrapped onto the next line', async () => {
    const snaps = await allSnapshots();
    const split = snaps.find((s) => s.file === 'split.md');
    const flags = parseHelp(split.raw).find((n) => n.kind === 'flags');
    const [first] = definitionRows(flags);
    expect(first.term).toBe('[--left|--right|--up|--down|--auto]');
    expect(first.description).toBe('Split direction. Mutually exclusive; default is --auto.');
  });

  it('never leaves a definition row without a description', async () => {
    for (const snap of await allSnapshots()) {
      for (const node of parseHelp(snap.raw).filter((n) => ['flags', 'arguments', 'commands'].includes(n.kind))) {
        for (const row of definitionRows(node)) {
          expect(row.description, `${snap.file}: "${row.term}"`).not.toBe('');
        }
      }
    }
  });

  it('reads labelled blocks', () => {
    const [block] = parseHelp('Text output:\n  * surface:1  terminal');
    expect(labelledBody(block)).toBe('  * surface:1  terminal');
  });

  it('reads the root command inventory in listed order', async () => {
    const snaps = await allSnapshots();
    const root = snaps.find((s) => s.file === 'dor.md');
    const names = rootCommandNames(parseHelp(root.raw));
    expect(names[0]).toBe('split');
    expect(names).toContain('agent-browser');
    expect(new Set(names).size).toBe(names.length);
  });

  it('throws when there is no COMMANDS section', () => {
    expect(() => rootCommandNames(parseHelp('USAGE\n  dor x'))).toThrow(/no COMMANDS/);
  });
});
