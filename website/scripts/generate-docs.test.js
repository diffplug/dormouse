import { describe, it, expect } from 'vitest';
import {
  REPO_BLOB_BASE,
  SECURITY_AUDIENCES,
  SITE_ROUTES,
  applyDelta,
  assertRouteFragments,
  generateDocs,
  resolveRepoLinks,
  securityAudiences,
} from './generate-docs.js';
import { createSlugger, parseMarkdown, visit } from './docs-parser.js';

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
  for (const section of data.cli.intro) collect(section.blocks);
  return hrefs;
}

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
    expect(data.selfhost.headings.every((h) => h.depth === 2)).toBe(true);
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
      'guarantees',
      'what-is-not-defended',
      'known-gaps',
      'how-the-guarantees-are-checked',
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
    expect(data.security.repoLinks).toContainEqual({ from: '../../SELF_HOST.md', to: '/docs/self-host/' });
    expect(data.security.repoLinks).toContainEqual({
      from: '../../SELF_HOST.md#keeping-the-relay-up-while-the-laptop-sleeps',
      to: '/docs/self-host/#keeping-the-relay-up-while-the-laptop-sleeps',
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

  it('renders its own page as one audience, every other block untouched', () => {
    const own = data.security.audiences.security;
    const swapped = data.security.pageBlocks.filter((b, i) => b !== data.security.blocks[i]);
    expect(swapped).toEqual([own.guarantees, own.notDefended, own.knownGaps]);
    expect(data.security.pageBlocks).toHaveLength(data.security.blocks.length);
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

  it('fails on a link into a published page whose fragment names no heading there', () => {
    const target = { source: 'SELF_HOST.md', headings: [{ id: 'prerequisites' }], blocks: [] };
    const link = (href) => ({ source: 'docs/specs/security.md', headings: [], blocks: [{ type: 'link', href }] });
    expect(() => assertRouteFragments([target, link('/docs/self-host/#prerequisites')])).not.toThrow();
    expect(() => assertRouteFragments([target, link('/docs/self-host/#nowhere')])).toThrow(/names no heading/);
    // A route nobody generated, and a fragment on this page, are not this check's.
    expect(() => assertRouteFragments([target, link('/docs/dor/#nowhere')])).not.toThrow();
  });

  it('keeps the fragment on a link into another spec', () => {
    expect(data.security.repoLinks).toContainEqual({
      from: './remote-security-model.md#pairing',
      to: `${REPO_BLOB_BASE}/docs/specs/remote-security-model.md#pairing`,
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
      '/docs/self-host/',
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

  it('resolves every reference into an existing CLI anchor', () => {
    const anchors = new Set(data.cli.anchors);
    const refs = Object.values(data.skill.references);
    // If this ever finds nothing the derivation has silently stopped matching.
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(anchors).toContain(ref.href.replace('/docs/dor/#', ''));
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
      from: 'https://dormouse.sh/docs/dor',
      to: '/docs/dor/',
    });
  });

  it('keeps the fragment on a localized deep link', () => {
    expect(data.guide.localizedLinks).toContainEqual({
      from: 'https://dormouse.sh/docs/dor#agent-browser',
      to: '/docs/dor/#agent-browser',
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
