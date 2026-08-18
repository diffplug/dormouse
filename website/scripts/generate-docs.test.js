import { describe, it, expect } from 'vitest';
import { generateDocs } from './generate-docs.js';

const data = await generateDocs();

describe('product guide', () => {
  it('drops exactly the document title and records the delta', () => {
    expect(data.guide.delta).toHaveLength(1);
    expect(data.guide.delta[0]).toMatchObject({ id: 'drop-document-title', operation: 'remove' });
    expect(data.guide.blocks.some((b) => b.type === 'heading' && b.depth === 1)).toBe(false);
  });

  it('has unique, stable heading ids', () => {
    const ids = data.guide.headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('alerts-and-todos');
    expect(ids).toContain('browsers-for-you-and-your-agents');
  });

  it('carries the sections the scope requires', () => {
    const text = data.guide.headings.map((h) => h.text.toLowerCase());
    for (const required of ['get dormouse', 'alerts and todos', 'keyboard shortcuts', 'getting started']) {
      expect(text).toContain(required);
    }
  });
});

describe('cli reference', () => {
  it('covers every command in the root inventory, in order', () => {
    expect(data.cli.commands.length).toBeGreaterThan(0);
    expect(data.cli.commands[0].id).toBe('split');
    expect(data.cli.commands.map((c) => c.id)).toContain('agent-browser');
  });

  it('provides the anchors the skill links into', () => {
    const anchors = new Set([...data.cli.intro.map((s) => s.id), 'dor', ...data.cli.commands.map((c) => c.id)]);
    for (const a of ['targeting', 'surface-handles', 'dor', 'list', 'split', 'ensure', 'send', 'read', 'kill', 'agent-browser', 'iframe']) {
      expect(anchors, `missing anchor #${a}`).toContain(a);
    }
  });

  it('keeps exact help alongside the parsed view', () => {
    for (const cmd of data.cli.commands) {
      expect(cmd.raw).toContain('USAGE');
      expect(cmd.usage.length).toBeGreaterThan(0);
    }
  });

  it('lifts its intro sections from the skill rather than re-authoring them', () => {
    expect(data.cli.intro.map((s) => s.id)).toEqual(['targeting', 'surface-handles']);
    for (const section of data.cli.intro) expect(section.blocks.length).toBeGreaterThan(0);
  });
});

describe('agent skill', () => {
  it('retains the skill markdown byte for byte', async () => {
    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(new URL('../../dor/skill.md', import.meta.url), 'utf8');
    expect(data.skill.markdown).toBe(onDisk);
  });

  it('resolves every reference into an existing CLI anchor', () => {
    const anchors = new Set([...data.cli.intro.map((s) => s.id), 'dor', ...data.cli.commands.map((c) => c.id)]);
    const refs = Object.values(data.skill.references);
    expect(refs.length).toBe(10);
    for (const ref of refs) {
      expect(anchors).toContain(ref.href.replace('/docs/dor#', ''));
    }
  });

  it('anchors each reference to a real skill heading id', () => {
    const ids = new Set(data.skill.headings.map((h) => h.id));
    for (const id of Object.keys(data.skill.references)) expect(ids).toContain(id);
  });
});
