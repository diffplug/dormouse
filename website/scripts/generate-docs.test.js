import { describe, it, expect } from 'vitest';
import {
  REPO_BLOB_BASE,
  SECURITY_AUDIENCES,
  SECURITY_PAGE_AUDIENCES,
  SITE_ORIGIN,
  SITE_ROUTES,
  applyDelta,
  audienceBlocks,
  assertNoSiteLinks,
  assertRouteFragments,
  auditIndex,
  auditedSections,
  gatherGuarantees,
  generateDocs,
  groupGuarantees,
  guaranteeRows,
  linkPinnedBy,
  resolveRepoLinks,
  securityAudiences,
  securityCoverage,
  securityFeatures,
  withGuarantees,
  withoutFeatures,
} from './generate-docs.js';
import { createSlugger, inlineToText, parseMarkdown, visit } from './docs-parser.js';
import { mkdtemp, mkdir as mkdirp, writeFile as writeText } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODING_AGENTS } from '../../lib/src/lib/coding-agents.ts';

const data = await generateDocs();

/**
 * Every link href in the generated data: all three published pages, plus the
 * guide data, which has no page today but is generated and must stay correct.
 */
function generatedHrefs() {
  const hrefs = [];
  const collect = (blocks) =>
    visit(blocks, (node) => {
      if (node.type === 'link' && node.href) hrefs.push(node.href);
    });
  collect(data.guide.blocks);
  collect(data.selfhost.blocks);
  collect(data.security.blocks);
  collect(data.skill.blocks);
  collect(data.agents.blocks);
  for (const section of data.cli.intro) collect(section.blocks);
  return hrefs;
}

describe('compatible agents', () => {
  it('publishes the guide while withholding the recovery contract and future', () => {
    expect(data.agents.delta.map((rule) => rule.id)).toEqual([
      'drop-document-title', 'drop-front-matter', 'drop-recovery-contract', 'drop-future',
    ]);
    expect(data.agents.source).toBe('docs/compatible-agents.md');
    expect(data.agents.headings.map((heading) => heading.text)).toEqual([
      'Supported agents', 'How recovery and watching work', 'Conversation recovery',
      'Watching for attention', 'Adding an agent', 'Add the definition and fixture',
      'Verify the integration',
    ]);
    expect(data.agents.blocks.some((block) => block.type === 'blockquote')).toBe(false);
    const body = JSON.stringify(data.agents.blocks);
    expect(body).not.toContain('Must use the shared');
    expect(body).not.toContain('If automatic agent startup becomes disruptive');
  });

  it('sends contributor links to withheld headings on GitHub', () => {
    expect(data.agents.withheldLinks).toEqual([{
      from: '#detection',
      to: `${REPO_BLOB_BASE}/docs/compatible-agents.md#detection`,
    }, {
      from: '#recovery-contract-maintainers',
      to: `${REPO_BLOB_BASE}/docs/compatible-agents.md#recovery-contract-maintainers`,
    }]);
    expect(generatedHrefs()).toEqual(expect.arrayContaining(data.agents.withheldLinks.map(({ to }) => to)));
  });

  it('keeps the supported-agent table aligned with executable and resume definitions', () => {
    const table = data.agents.blocks.find((block) => block.type === 'table');
    expect(table.header.map(inlineToText)).toEqual(['Agent', 'Command', 'Resume command', 'Watch by default']);
    expect(table.rows.map((row) => row.map(inlineToText))).toEqual(
      CODING_AGENTS.flatMap((agent) => agent.commands.map((command) => [
        agent.name, command, `${command} ${agent.resume} <id>`, agent.watchByDefault ? 'Yes' : 'No',
      ])),
    );
  });
});

describe('product guide', () => {
  it('drops exactly the document title and records the delta', () => {
    expect(data.guide.delta).toHaveLength(1);
    expect(data.guide.delta[0]).toMatchObject({ id: 'drop-document-title', operation: 'remove' });
    expect(data.guide.blocks.some((b) => b.type === 'heading' && b.depth === 1)).toBe(false);
  });

  it('has unique, stable heading ids', () => {
    const ids = data.guide.headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('browsers-for-you-and-your-agents');
    expect(ids).toContain('select-and-copy-paste-like-you-meant');
  });
});

describe('delta operations', () => {
  const doc = () =>
    parseMarkdown(
      ['# Title', '', '## Keep', '', 'kept', '', '## Drop', '', 'gone', '', '### Nested', '', 'also gone', '', '## After', '', 'kept too'].join('\n'),
      { slug: createSlugger() },
    ).blocks;

  const dropRule = { id: 'drop', reason: 'test', operation: 'remove-section', match: (b) => b.type === 'heading' && b.text === 'Drop' };

  it('removes a section and its subsections, and stops at the next same-depth heading', () => {
    const { blocks, applied, removedIds } = applyDelta(doc(), [dropRule], 'test');
    const headings = blocks.filter((b) => b.type === 'heading').map((h) => h.text);
    expect(headings).toEqual(['Title', 'Keep', 'After']);
    expect(removedIds).toEqual(['drop', 'nested']);
    expect(applied[0].blocks).toBe(4);
  });

  it('fails when a rule matches nothing, rather than publishing what it withholds', () => {
    const gone = { ...dropRule, match: (b) => b.type === 'heading' && b.text === 'Renamed' };
    expect(() => applyDelta(doc(), [gone], 'test')).toThrow(/matched nothing/);
  });

  it('fails when a rule is ambiguous', () => {
    const both = { ...dropRule, match: (b) => b.type === 'heading' && b.depth === 2 };
    expect(() => applyDelta(doc(), [both], 'test')).toThrow(/matched 3 blocks/);
  });

  it('refuses remove-section on a block that is not a heading', () => {
    const wrong = { ...dropRule, match: (b) => b.type === 'paragraph' && b.children?.[0]?.value === 'kept' };
    expect(() => applyDelta(doc(), [wrong], 'test')).toThrow(/remove-section but matched a paragraph/);
  });
});

describe('self-host runbook', () => {
  it('keeps all first-run steps in one numbered sequence', () => {
    const start = data.selfhost.blocks.findIndex((b) => b.id === 'checkpoint-4-first-run-setup');
    const end = data.selfhost.blocks.findIndex((b) => b.id === 'checkpoint-5-updating-rollback-uninstall');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const lists = data.selfhost.blocks.slice(start, end).filter((b) => b.type === 'list');
    expect(lists).toHaveLength(1);
    expect(lists[0].items).toHaveLength(5);
    expect(lists[0].items[1].children).toHaveLength(2);
  });

  it('withholds the assistant and maintainer halves, and nothing else', () => {
    expect(data.selfhost.delta.map((r) => r.id)).toEqual([
      'drop-document-title',
      'drop-repo-invocation',
      'drop-assistant-instructions',
      'drop-final-handoff',
      'drop-installer-contract',
    ]);
    const text = data.selfhost.headings.map((h) => h.text);
    for (const withheld of ['Instructions to the assistant', 'Final handoff', 'Installer contract (maintainers)']) {
      expect(text).not.toContain(withheld);
    }
  });

  it('takes a removed section subheadings and all', () => {
    // The Installer contract's four ### subsections must go with their ##.
    const ids = data.selfhost.headings.map((h) => h.id);
    for (const id of ['mechanism-map', 'invariants', 'mechanical-traps', 'operator-surface-and-test-hooks']) {
      expect(ids, `#${id} outlived its parent section`).not.toContain(id);
    }
  });

  it('preserves subsections of the published troubleshooting section', () => {
    for (const id of ['phone-capability-diagnostics', 'service-and-deployment-failures']) {
      expect(data.selfhost.headings).toContainEqual(expect.objectContaining({ id, depth: 3 }));
    }
  });

  it('keeps every checkpoint the runbook walks through', () => {
    const ids = data.selfhost.headings.map((h) => h.id);
    expect(ids.filter((id) => id.startsWith('checkpoint-'))).toHaveLength(6);
    expect(ids).toContain('prerequisites');
    expect(ids).toContain('what-the-installer-does');
  });

  it('sends links orphaned by the delta to the canonical file', () => {
    // Without this the surviving prose points at an anchor that is no longer
    // on the page, and the link silently scrolls nowhere.
    expect(data.selfhost.withheldLinks.length).toBeGreaterThan(0);
    for (const { from, to } of data.selfhost.withheldLinks) {
      expect(from.startsWith('#')).toBe(true);
      expect(to).toBe(`https://github.com/diffplug/dormouse/blob/main/SELF_HOST.md${from}`);
    }
  });

  it('leaves no in-document link pointing at a missing heading', () => {
    const ids = new Set(data.selfhost.headings.map((h) => h.id));
    const dangling = [];
    visit(data.selfhost.blocks, (node) => {
      if (node.type === 'link' && node.href?.startsWith('#') && !ids.has(node.href.slice(1))) {
        dangling.push(node.href);
      }
    });
    expect(dangling).toEqual([]);
  });
});

describe('security spec', () => {
  it('drops exactly the document title and the front matter', () => {
    // Published whole is the point of the page: a delta that grew a third rule
    // is withholding something a reader was promised.
    expect(data.security.delta.map((r) => r.id)).toEqual(['drop-document-title', 'drop-front-matter']);
    expect(data.security.blocks.some((b) => b.type === 'heading' && b.depth === 1)).toBe(false);
    expect(data.security.blocks.some((b) => b.type === 'blockquote')).toBe(false);
  });

  it('keeps every section, in order', () => {
    expect(data.security.headings.map((h) => h.id)).toEqual([
      'features',
      'guarantees',
      'how-the-guarantees-are-checked',
      'what-is-not-defended',
      'known-gaps',
      'reporting-a-vulnerability',
    ]);
  });

  it('sends unpublished specs to GitHub and published files to their pages', () => {
    // The spec links its neighbours the way GitHub resolves them. Published,
    // the domain specs have no page, so they go to the repository; the runbook
    // has one, so a reader on the site stays on the site.
    const routes = new Set(Object.values(SITE_ROUTES));
    expect(data.security.repoLinks.length).toBeGreaterThan(0);
    for (const { to } of data.security.repoLinks) {
      expect(to.startsWith(REPO_BLOB_BASE) || routes.has(to.split('#')[0])).toBe(true);
    }
    expect(data.security.repoLinks).toContainEqual({ from: '../../SELF_HOST.md', to: '/self-host/' });
    expect(data.security.repoLinks).toContainEqual({
      from: '../../SELF_HOST.md#keeping-the-relay-up-while-the-laptop-sleeps',
      to: '/self-host/#keeping-the-relay-up-while-the-laptop-sleeps',
    });
  });

  it('splits its guarantees, undefended edges, and gaps by audience, exhaustively', () => {
    // Every row and bullet lands on exactly one of the two specialized pages,
    // so nothing the umbrella says is absent from both and nothing is doubled.
    const audiences = Object.keys(SECURITY_AUDIENCES);
    const sectionBlock = (title, type) => {
      const i = data.security.blocks.findIndex((b) => b.type === 'heading' && b.text === title);
      return data.security.blocks.slice(i + 1).find((b) => b.type === type);
    };
    for (const [key, title, type, entries] of [
      ['guarantees', 'Guarantees', 'table', 'rows'],
      ['notDefended', 'What is not defended', 'list', 'items'],
      ['knownGaps', 'Known gaps', 'list', 'items'],
    ]) {
      const whole = sectionBlock(title, type)[entries].map((e) => JSON.stringify(e));
      const split = audiences.flatMap((a) => data.security.audiences[a][key][entries].map((e) => JSON.stringify(e)));
      expect(split.length).toBe(whole.length);
      expect(new Set(split).size).toBe(whole.length);
      for (const entry of split) expect(whole).toContain(entry);
    }
    for (const a of audiences) expect(data.security.audiences[a].guarantees.rows.length).toBeGreaterThan(0);
  });

  it('renders its own page as its audience and remote control’s, in spec order, every other block untouched', () => {
    expect(SECURITY_PAGE_AUDIENCES).toEqual(['security', 'self-host']);
    const narrowed = audienceBlocks({ blocks: data.security.blocks }, data.security.audiences, SECURITY_PAGE_AUDIENCES);
    expect(data.security.pageBlocks).toEqual(groupGuarantees(narrowed, data.security.features));
    const swapped = narrowed.filter((b, i) => b !== data.security.blocks[i]);
    expect(swapped).toHaveLength(3);
    const whole = (b) => data.security.blocks[narrowed.indexOf(b)];
    for (const [block, key, entries] of [
      [swapped[0], 'guarantees', 'rows'],
      [swapped[1], 'notDefended', 'items'],
      [swapped[2], 'knownGaps', 'items'],
    ]) {
      const shown = SECURITY_PAGE_AUDIENCES.flatMap((a) => data.security.audiences[a][key][entries]).map((e) => JSON.stringify(e));
      const rendered = block[entries].map((e) => JSON.stringify(e));
      expect(new Set(rendered)).toEqual(new Set(shown));
      expect(rendered).toEqual(whole(block)[entries].map((e) => JSON.stringify(e)).filter((e) => shown.includes(e)));
    }
    expect(narrowed).toHaveLength(data.security.blocks.length);
  });

  it('groups the guarantees under a subheading per feature', () => {
    const blocks = parseMarkdown(
      [
        '## Guarantees', '', 'Intro.', '',
        '| Guarantee | Feature | Pinned by |', '| --- | --- | --- |',
        '| g1 |  | p1 |', '| g2 | A, B | p2 |', '| g3 | B | p3 |', '',
        '## Next', '', 'After.',
      ].join('\n'),
      { slug: createSlugger() },
    ).blocks;
    const grouped = groupGuarantees(blocks, ['A', 'B', 'C']);
    expect(grouped.slice(0, 2)).toEqual(blocks.slice(0, 2));
    expect(grouped.slice(-2)).toEqual(blocks.slice(-2));
    const groups = grouped.slice(2, -2);
    expect(groups.filter((b) => b.type === 'heading').map((h) => [h.depth, h.id, h.text])).toEqual([
      [3, 'every-install', 'Every install'], [3, 'a', 'A'], [3, 'b', 'B'],
    ]);
    const tables = groups.filter((b) => b.type === 'table');
    expect(tables.map((table) => table.header.map((cell) => inlineToText(cell)))).toEqual(Array(3).fill(['Guarantee', 'Pinned by']));
    expect(tables.map((table) => table.rows.map((row) => row.map((cell) => inlineToText(cell))))).toEqual([
      [['g1', 'p1']],
      [['g2', 'p2']],
      [['g2', 'p2'], ['g3', 'p3']],
    ]);
    const clash = parseMarkdown('## Guarantees\n\n| Guarantee | Feature | Pinned by |\n| --- | --- | --- |\n| g | Next | p |\n\n## Next\n', { slug: createSlugger() }).blocks;
    expect(() => groupGuarantees(clash, ['Next'])).toThrow(/"Next" guarantees would share #next/);
    expect(() => groupGuarantees(blocks.filter((b) => b.type !== 'table'), ['A'])).toThrow(/no "Guarantees" table to group/);
    expect(() => groupGuarantees(blocks.filter((b) => b.type !== 'heading' || b.text !== 'Guarantees'), ['A'])).toThrow(/no heading matches "Guarantees"/);
  });

  it('refuses an entry whose links name no audience, or two', () => {
    const page = (markdown) => {
      const blocks = parseMarkdown(markdown, { slug: createSlugger() }).blocks;
      resolveRepoLinks(blocks, 'docs/specs/security.md');
      return { blocks };
    };
    const doc = (row) =>
      [
        '## Guarantees', '', '| G | Rule | Pinned by |', '| --- | --- | --- |', row, '',
        '## What is not defended', '', '- x ([a](./security-ci.md))', '',
        '## Known gaps', '', '- y ([b](./security-remote.md))',
      ].join('\n');
    expect(() => securityAudiences(page(doc('| g | [a](./security-ci.md), [b](./security-remote.md) | t |')))).toThrow(
      /do not name exactly one audience/,
    );
    expect(() => securityAudiences(page(doc('| g | no link | t |')))).toThrow(/names no spec/);
    expect(() => securityAudiences(page(doc('| g | [a](./website-docs.md) | t |')))).toThrow(/exactly one audience/);
    expect(securityAudiences(page(doc('| g | [a](./security-ci.md) | t |'))).security.guarantees.rows).toHaveLength(1);
  });

  it('reads the features from the feature table and every entry\'s tags against them', () => {
    // docs/specs/website-docs.md -> `/security` spec: a row tags itself in its
    // `Feature` cell, a bullet in the emphasis it opens with, an untagged entry
    // holds for every install, and the feature table's first column is the only
    // vocabulary either may use.
    const page = (markdown) => {
      const blocks = parseMarkdown(markdown, { slug: createSlugger() }).blocks;
      resolveRepoLinks(blocks, 'docs/specs/security.md');
      return { blocks };
    };
    const doc = ({
      features = ['| **A** | a |', '| **B** | b |'],
      header = '| G | Feature | Rule | Pinned by |',
      row = '| g | A | [a](./security-ci.md) | t |',
      bullet = '- *A, B.* **x** ([a](./security-ci.md))',
      table = true,
      section = true,
    } = {}) =>
      [
        ...(section ? ['## Features', '', ...(table ? ['| Feature | How |', '| --- | --- |', ...features] : ['No table.']), ''] : []),
        '## Guarantees', '', header, '| --- | --- | --- | --- |', row, '| h |  | [a](./security-ci.md) | t |', '',
        '## What is not defended', '', bullet, '- **w** ([a](./security-ci.md))', '',
        '## Known gaps', '', '- *B.* **y** ([b](./security-remote.md))',
      ].join('\n');
    expect(securityFeatures(page(doc()))).toEqual({
      names: ['A', 'B'],
      guarantees: [['A'], []],
      notDefended: [['A', 'B'], []],
      knownGaps: [['B']],
    });
    expect(() => securityFeatures(page(doc({ section: false })))).toThrow(/no heading matches "Features"/);
    expect(() => securityFeatures(page(doc({ table: false })))).toThrow(/"Features" has no table/);
    expect(() => securityFeatures(page(doc({ features: ['| **A** | a |', '| **B** | b |', '| **A** | c |'] })))).toThrow(
      /"Features" repeats A/,
    );
    expect(() => securityFeatures(page(doc({ header: '| G | Features | Rule | Pinned by |' })))).toThrow(
      /"Guarantees" has no "Feature" column/,
    );
    expect(() => securityFeatures(page(doc({ row: '| g | A, | [a](./security-ci.md) | t |' })))).toThrow(/empty feature tag/);
    expect(() => securityFeatures(page(doc({ row: '| g | A, C | [a](./security-ci.md) | t |' })))).toThrow(
      /"Guarantees" entry 1 names C, not a feature/,
    );
    expect(() => securityFeatures(page(doc({ bullet: '- *B, B.* **x** ([a](./security-ci.md))' })))).toThrow(
      /"What is not defended" entry 1 repeats B/,
    );
    expect(() => securityFeatures(page(doc({ features: ['| **A** | a |', '| **B** | b |', '| **C** | c |'] })))).toThrow(
      /no entry concerns C/,
    );
  });

  it('publishes the features the spec\'s entries were checked against', () => {
    // The vocabulary the page's readers pick from: the spec's three features,
    // in the table's order, and written by the build that checked the tags.
    expect(data.security.features).toEqual(['One-time link', 'Hosted phone', 'Self-hosted Relay']);
    expect(data.security.features).toEqual(securityFeatures({ blocks: data.security.blocks }).names);
  });

  it('gathers each domain spec\'s guarantees under the section that holds them', () => {
    // docs/specs/website-docs.md -> `/security` spec: a guarantee is stated
    // once, beside its checks; the page's table, each row led by its section, is built.
    const table = ['| Guarantee | Feature | Pinned by |', '| --- | --- | --- |'];
    const spec = (...lines) => ['# Spec', '', ...lines].join('\n');
    const SPEC = spec(
      '## Alpha', '', ...table, '| **a** see [beta](#beta) |  | `x/a.test.js` |', '|**b**|One|`x/b\\|c.test.js`|', '',
      '- **FAIL IF** `S1` one.', '',
      '### Nested', '', '- **FAIL IF** `S2` two.', '',
      '## Beta', '', '- **FAIL IF** `S3` three.', '',
      '## Future', '', ...table, '| **c** |  | t |',
    );
    expect(guaranteeRows(SPEC, 'docs/specs/security-x.md')).toEqual({
      rows: [
        '| [Alpha](./security-x.md#alpha) **a** see [beta](./security-x.md#beta) |  | `x/a.test.js` |',
        '| [Alpha](./security-x.md#alpha) **b** | One | `x/b\\|c.test.js` |',
      ],
      // A nested section's checks are not its parent's promise: each audited section holds its own.
      held: ['alpha'],
    });
    expect(() => guaranteeRows(spec('## Alpha', '', ...table, '| **a** |  | t |', '', '## Beta', '', '- **FAIL IF** `S3` three.'), 'f.md')).toThrow(
      /f\.md: the guarantees under "Alpha" sit in a section with no FAIL IF line/,
    );
    expect(() => guaranteeRows(spec('## Alpha', '', ...table, '| **a** |  | t |', '', ...table, '| **b** |  | t |', '', '- **FAIL IF** `S1` one.'), 'f.md')).toThrow(
      /split across two tables/,
    );
    expect(() => guaranteeRows(spec('## Alpha', '', ...table, '| **a** | t |', '', '- **FAIL IF** `S1` one.'), 'f.md')).toThrow(/has 2 cells, not 3/);
    expect(() => guaranteeRows(spec('## Alpha', '', table[0], '| **a** |  | t |', '', '- **FAIL IF** `S1` one.'), 'f.md')).toThrow(/a header with no delimiter row/);
    // A header spaced differently is still a guarantee table, read as the site's parser reads it.
    expect(guaranteeRows(spec('## Alpha', '', '|Guarantee|Feature|Pinned by|', table[1], '| **a** |  | t |', '', '- **FAIL IF** `S1` one.'), 'f.md').rows).toHaveLength(1);
  });

  it('fails on a guarantee in a spec /security does not gather from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guarantees-'));
    await mkdirp(join(root, 'docs/specs'), { recursive: true });
    const audited = '## A\n\n| Guarantee | Feature | Pinned by |\n| --- | --- | --- |\n| **g** |  | t |\n\n- **FAIL IF** `S1` one.\n';
    for (const name of ['security-local', 'security-remote', 'security-hosted', 'security-supply-chain', 'security-ci']) {
      await writeText(join(root, `docs/specs/${name}.md`), audited);
    }
    const { rows, held } = await gatherGuarantees(root);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe('| [A](./security-local.md#a) **g** |  | t |');
    expect(held).toContain(`${REPO_BLOB_BASE}/docs/specs/security-ci.md#a`);
    await writeText(join(root, 'docs/specs/layout.md'), audited);
    await expect(gatherGuarantees(root)).rejects.toThrow(/docs\/specs\/layout\.md: carries guarantees/);
  });

  it('closes the spec\'s "Guarantees" section with the gathered table, and refuses one written there', () => {
    const md = '# S\n\n## Guarantees\n\nIntro.\n\n## Next\n\nText.\n';
    expect(withGuarantees(md, ['| g | | p |'])).toBe(
      '# S\n\n## Guarantees\n\nIntro.\n\n| Guarantee | Feature | Pinned by |\n| --- | --- | --- |\n| g | | p |\n\n## Next\n\nText.\n',
    );
    expect(() => withGuarantees(md.replace('Intro.', '| Guarantee | Rule |'), ['| g |'])).toThrow(/belongs beside its checks/);
    expect(() => withGuarantees(md, [])).toThrow(/no domain spec states a guarantee/);
  });

  it('holds every audited section to a guarantee', () => {
    // docs/specs/website-docs.md -> `/security` spec: a check behind no
    // promise fails the build, and the audit's own process needs none.
    const section = (path, anchor) => ({ title: anchor, url: `${REPO_BLOB_BASE}/${path}#${anchor}`, checks: 1 });
    const index = {
      domains: [{
        specs: [
          { path: 'docs/specs/security-ci.md', sections: [section('docs/specs/security-ci.md', 'a'), section('docs/specs/security-ci.md', 'b')] },
          { path: 'docs/specs/security-audit.md', sections: [section('docs/specs/security-audit.md', 'd')] },
        ],
      }],
    };
    const held = (...anchors) => new Set(anchors.map((a) => `${REPO_BLOB_BASE}/docs/specs/security-ci.md#${a}`));
    expect(() => securityCoverage(index, held('a', 'b'))).not.toThrow();
    expect(() => securityCoverage(index, held('a'))).toThrow(/no guarantee holds the checks under docs\/specs\/security-ci\.md -> "b"/);
  });

  it('publishes every guarantee the domain specs hold, in their order', async () => {
    const { rows } = await gatherGuarantees();
    const guarantees = data.security.blocks.filter((b) => b.type === 'table').find((b) => inlineToText(b.header[0]) === 'Guarantee');
    expect(guarantees.rows).toHaveLength(rows.length);
    const [gathered] = parseMarkdown(['| Guarantee | Feature | Pinned by |', '| --- | --- | --- |', ...rows].join('\n'), { slug: createSlugger() }).blocks;
    expect(guarantees.rows.map((row) => inlineToText(row[0]))).toEqual(gathered.rows.map((row) => inlineToText(row[0])));
  });

  it('links each path a guarantee is pinned by to GitHub, and fails on one that does not exist', () => {
    const page = (cell) => {
      const blocks = parseMarkdown(
        ['## Guarantees', '', '| G | Rule | Pinned by |', '| --- | --- | --- |', `| g | r | ${cell} |`, '', '## What is not defended', '', '- x', '', '## Known gaps', '', '- y'].join('\n'),
        { slug: createSlugger() },
      ).blocks;
      linkPinnedBy({ blocks });
      return blocks[1].rows[0][2];
    };
    expect(page('`scripts/spec-lint.mjs`; `cargo test` in `standalone/src-tauri`, nightly')).toEqual([
      { type: 'link', href: `${REPO_BLOB_BASE}/scripts/spec-lint.mjs`, children: [{ type: 'code', value: 'scripts/spec-lint.mjs' }] },
      { type: 'text', value: '; ' },
      { type: 'code', value: 'cargo test' },
      { type: 'text', value: ' in ' },
      {
        type: 'link',
        href: `${REPO_BLOB_BASE.replace('/blob/', '/tree/')}/standalone/src-tauri`,
        children: [{ type: 'code', value: 'standalone/src-tauri' }],
      },
      { type: 'text', value: ', nightly' },
    ]);
    expect(() => page('`scripts/no-such-lint.mjs`')).toThrow(/pinned by scripts\/no-such-lint\.mjs, which does not exist/);
  });

  it('publishes /supply-chain\'s entries without the feature tags it has no table for', () => {
    const sections = data.security.supplyChain;
    expect(sections.guarantees.header.map((cell) => inlineToText(cell))).toEqual(['Guarantee', 'Pinned by']);
    expect(sections.guarantees.rows.every((row) => row.length === 2)).toBe(true);
    for (const item of [...sections.notDefended.items, ...sections.knownGaps.items]) {
      expect(item.children[0].children[0].type).toBe('strong');
    }
    expect(sections.guarantees.rows).toHaveLength(data.security.audiences['supply-chain'].guarantees.rows.length);
    const page = parseMarkdown(
      [
        '## Guarantees', '', '| G | Feature | Rule |', '| --- | :-: | --- |', '| g | A | r |', '',
        '## What is not defended', '', '- *A, B.* **x** y', '', '## Known gaps', '', '- *B.* z', '- **v** w',
      ].join('\n'),
      { slug: createSlugger() },
    ).blocks;
    const [, guarantees, , notDefended, , knownGaps] = page;
    const untagged = withoutFeatures({ guarantees, notDefended, knownGaps });
    expect(untagged.guarantees.align).toEqual([guarantees.align[0], guarantees.align[2]]);
    expect(untagged.guarantees.rows).toEqual([[guarantees.rows[0][0], guarantees.rows[0][2]]]);
    expect(inlineToText(untagged.notDefended.items[0].children[0].children)).toBe('x y');
    expect(inlineToText(untagged.knownGaps.items[0].children[0].children)).toBe('z');
    expect(untagged.knownGaps.items[1]).toBe(knownGaps.items[1]);
  });

  it('fails on a link into a published page whose fragment names no heading there', () => {
    const target = { source: 'SELF_HOST.md', headings: [{ id: 'prerequisites' }], blocks: [] };
    const link = (href) => ({ source: 'docs/specs/security.md', headings: [], blocks: [{ type: 'link', href }] });
    expect(() => assertRouteFragments([target, link('/self-host/#prerequisites')])).not.toThrow();
    expect(() => assertRouteFragments([target, link('/self-host/#nowhere')])).toThrow(/names no heading/);
    // A route nobody generated, and a fragment on this page, are not this check's.
    expect(() => assertRouteFragments([target, link('/dor/#nowhere')])).not.toThrow();
  });

  it('keeps the fragment on a link into another spec', () => {
    expect(data.security.repoLinks).toContainEqual({
      from: './security-remote.md#trust-boundary',
      to: `${REPO_BLOB_BASE}/docs/specs/security-remote.md#trust-boundary`,
    });
  });
});

describe('repository links', () => {
  const tree = (markdown) => parseMarkdown(markdown, { slug: createSlugger() }).blocks;
  const hrefs = (blocks) => {
    const out = [];
    visit(blocks, (node) => {
      if (node.type === 'link' && node.href) out.push(node.href);
    });
    return out;
  };

  it('resolves a relative path against the source file\'s own directory', () => {
    const blocks = tree('[a](./security-ci.md#domains) and [b](../../SELF_HOST.md)');
    const rewritten = resolveRepoLinks(blocks, 'docs/specs/security.md');
    expect(hrefs(blocks)).toEqual([
      `${REPO_BLOB_BASE}/docs/specs/security-ci.md#domains`,
      '/self-host/',
    ]);
    expect(rewritten).toHaveLength(2);
  });

  it('records what each rewritten link named in the repository', () => {
    const blocks = tree('[a](../../SELF_HOST.md#prerequisites)');
    resolveRepoLinks(blocks, 'docs/specs/security.md');
    const paths = [];
    visit(blocks, (node) => {
      if (node.type === 'link') paths.push(node.repoPath);
    });
    expect(paths).toEqual(['SELF_HOST.md']);
  });

  it('leaves anything that does not name a file in the repository alone', () => {
    const untouched = [
      '#a-heading-on-this-page',
      'https://dormouse.sh/supply-chain',
      'mailto:nobody@example.com',
      '//example.com/x',
    ];
    const blocks = tree(untouched.map((href, i) => `[${i}](${href})`).join(' '));
    expect(resolveRepoLinks(blocks, 'docs/specs/security.md')).toEqual([]);
    expect(hrefs(blocks)).toEqual(untouched);
  });

  it('fails on a target that does not exist, rather than publishing a 404', () => {
    const blocks = tree('[gone](./security-nowhere.md)');
    expect(() => resolveRepoLinks(blocks, 'docs/specs/security.md')).toThrow(/does not exist/);
  });

  it('fails on a path that climbs out of the repository', () => {
    const blocks = tree('[out](../../../etc/passwd)');
    expect(() => resolveRepoLinks(blocks, 'docs/specs/security.md')).toThrow(/outside the repository/);
  });
});

describe('cli reference', () => {
  it('covers every command in the root inventory, in order', () => {
    expect(data.cli.commands.length).toBeGreaterThan(0);
    expect(data.cli.commands[0].id).toBe('split');
    expect(data.cli.commands.map((c) => c.id)).toContain('agent-browser');
  });

  it('provides the anchors the skill links into', () => {
    const anchors = new Set(data.cli.anchors);
    for (const a of ['targeting', 'surface-handles', 'dor', 'list', 'split', 'ensure', 'send', 'read', 'kill', 'agent-browser', 'iframe']) {
      expect(anchors, `missing anchor #${a}`).toContain(a);
    }
  });

  it('exposes a collision-free anchor namespace', () => {
    expect(new Set(data.cli.anchors).size).toBe(data.cli.anchors.length);
  });

  it('keeps exact help alongside the parsed view', () => {
    for (const cmd of data.cli.commands) {
      expect(cmd.raw).toContain('USAGE');
      expect(cmd.usage.length).toBeGreaterThan(0);
    }
  });

  it('nests every command under one heading, and that heading is an anchor', () => {
    // Flat, this page alone is fourteen rail entries; nested under an id that
    // is not on the page, the parent is a link that scrolls nowhere.
    const { commandsHeading, toc } = data.cli;
    expect(toc.map((e) => e.id)).toEqual(['targeting', 'surface-handles', 'dor', commandsHeading.id]);
    // `anchors` is built from a separate list, so this crosses a real boundary.
    expect(data.cli.anchors).toContain(commandsHeading.id);
    for (const entry of toc.slice(0, -1)) expect(entry.children).toEqual([]);
  });

  it('lifts its intro sections from the skill rather than re-authoring them', () => {
    expect(data.cli.intro.map((s) => s.id)).toEqual(['targeting', 'surface-handles']);
    for (const section of data.cli.intro) expect(section.blocks.length).toBeGreaterThan(0);
  });
});

describe('agent skill', () => {
  it('reproduces every heading in dor/skill.md, with matching ids', async () => {
    // Independently parse the file and compare, rather than asserting the
    // generator's own copy of its own input equals its own input.
    const { readFile } = await import('node:fs/promises');
    const { parseMarkdown, createSlugger } = await import('./docs-parser.js');
    const onDisk = await readFile(new URL('../../dor/skill.md', import.meta.url), 'utf8');
    const expected = parseMarkdown(onDisk, { slug: createSlugger() }).headings;
    expect(data.skill.headings).toEqual(expected);
  });

  it('does not ship the raw skill markdown to the browser', () => {
    // Nothing renders it, and it is ~10 KB on every docs page.
    expect(data.skill.markdown).toBeUndefined();
  });

  it('rejects a site link in the skill', () => {
    // dor/skill.md is clean, so the build never drives this check red; a
    // finding check that cannot fail is a claim rather than a control.
    const offending = [
      { type: 'paragraph', children: [{ type: 'link', href: `${SITE_ORIGIN}/dor/` }] },
    ];
    expect(() => assertNoSiteLinks(offending, 'dor/skill.md')).toThrow(SITE_ORIGIN);
    expect(() => assertNoSiteLinks(data.skill.blocks, 'dor/skill.md')).not.toThrow();
  });

  it('resolves every reference into an existing CLI anchor', () => {
    const anchors = new Set(data.cli.anchors);
    const refs = Object.values(data.skill.references);
    // If this ever finds nothing the derivation has silently stopped matching.
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(anchors).toContain(ref.href.replace('/dor/#', ''));
    }
  });

  it('links every skill heading that names a dor command', () => {
    // The derivation's whole point: a command documented in dor/skill.md gets
    // its reference with no table to update, so none may be left out.
    const named = data.skill.blocks.filter(
      (b) => b.type === 'heading' && (b.children ?? []).some((n) => n.type === 'code' && /^dor \S+$/.test(n.value)),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const heading of named) expect(data.skill.references).toHaveProperty(heading.id);
  });

  it('anchors each reference to a real skill heading id', () => {
    const ids = new Set(data.skill.headings.map((h) => h.id));
    for (const id of Object.keys(data.skill.references)) expect(ids).toContain(id);
  });
});

describe('same-site links', () => {
  it('rewrites the guide\'s absolute site links to root-relative paths', () => {
    // The guide has to spell these absolutely for the Marketplace, so if this
    // ever finds nothing the rewrite has silently stopped matching.
    expect(data.guide.localizedLinks.length).toBeGreaterThan(0);
    expect(data.guide.localizedLinks).toContainEqual({
      from: 'https://dormouse.sh/dor',
      to: '/dor/',
    });
  });

  it('keeps the fragment on a localized deep link', () => {
    expect(data.guide.localizedLinks).toContainEqual({
      from: 'https://dormouse.sh/dor#agent-browser',
      to: '/dor/#agent-browser',
    });
    // A bare origin still has to address the homepage, not the empty string.
    for (const { to } of data.guide.localizedLinks) expect(to.startsWith('/')).toBe(true);
  });

  it('leaves no absolute site link in the generated data', () => {
    const offenders = generatedHrefs().filter((href) => href.startsWith('https://dormouse.sh'));
    expect(offenders, 'these would navigate off the current origin').toEqual([]);
  });

  it('leaves no relative link in the generated data', () => {
    // A page is not served from the repository tree, so a path relative to the
    // source file resolves against the URL it was published at instead.
    const relative = generatedHrefs().filter(
      (href) => !href.startsWith('#') && !href.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(href),
    );
    expect(relative, 'these would resolve against the page URL, not the repository').toEqual([]);
  });

  it('does not touch links to other origins', () => {
    const external = generatedHrefs().filter((href) => /^https?:\/\//i.test(href));
    expect(external.length).toBeGreaterThan(0);
    for (const href of external) expect(href).not.toContain('dormouse.sh');
  });
});

describe('audit index', () => {
  const SPEC = [
    '# Spec',
    'A `FAIL IF` pointer mid-line is no check.',
    '## Alpha',
    '- **FAIL IF** `S1` one.',
    '**FAIL IF** `S2` two, leading its paragraph.',
    '## Beta',
    'Prose, and a `**FAIL IF**` quoted mid-line.',
    '### `Gamma` [linked](./x.md)',
    '```',
    '- **FAIL IF** inside a fence.',
    '```',
    '- **FAIL IF** `S3` three.',
    '## Alpha',
    '- **FAIL IF** `S4` four, under a repeated heading.',
    '## Future',
    '- **FAIL IF** staged, below the fold.',
  ].join('\n');

  it('counts each FAIL IF under its nearest heading, above the fold and outside fences, with GitHub anchors', () => {
    expect(auditedSections(SPEC, 'fixture')).toEqual([
      { title: 'Alpha', anchor: 'alpha', checks: 2 },
      { title: 'Gamma linked', anchor: 'gamma-linked', checks: 1 },
      { title: 'Alpha', anchor: 'alpha-1', checks: 1 },
    ]);
  });

  it('refuses a FAIL IF with no section above it', () => {
    expect(() => auditedSections('# Spec\n- **FAIL IF** orphaned.\n## Alpha\n', 'fixture')).toThrow(/fixture: a FAIL IF above/);
  });

  it('lists every security spec once, under the domain whose scope claims it, linked on GitHub', async () => {
    const index = await auditIndex();
    expect(data.security.auditIndex).toEqual(index);
    const { readdir } = await import('node:fs/promises');
    const specs = (await readdir(new URL('../../docs/specs/', import.meta.url)))
      .filter((f) => /^security[a-z-]*\.md$/.test(f) && !f.endsWith('.rationale.md'))
      .map((f) => `docs/specs/${f}`);
    const listed = index.domains.flatMap((d) => d.specs.map((s) => s.path));
    expect([...listed].sort()).toEqual(specs.sort());
    expect(index.domains.map((d) => d.name)).toEqual(['ci-and-secrets', 'hosted', 'local', 'remote', 'supply-chain']);
    for (const domain of index.domains) {
      expect(domain.checks).toBe(domain.specs.reduce((n, s) => n + s.checks, 0));
      for (const spec of domain.specs) {
        expect(spec.url).toBe(`${REPO_BLOB_BASE}/${spec.path}`);
        expect(spec.sections.length).toBeGreaterThan(0);
        for (const section of spec.sections) expect(section.url.startsWith(`${spec.url}#`)).toBe(true);
      }
    }
    expect(index.checks).toBe(index.domains.reduce((n, d) => n + d.checks, 0));
  });
});
