import { describe, expect, it } from 'vitest';
import { layout } from './layout';
import { createHitTester, hitTest } from './hit-test';
import { isLathPersistedLayout, lathLayoutFromStore } from './persistence';
import { targetRect } from './drop-target';
import { type LathNode, findLeafPath, nodeAtPath, leafTree, leaves, validate } from './model';
import { insert, move, remove, restore, split as splitLeaf } from './ops';
import { leaf, split, tree, R } from './test-util';

const opts = { gap: 0, minLeaf: { width: 0, height: 0 } };
const box = R(0, 0, 1000, 600);
const row = tree(split('row', ...['a', 'b', 'c', 'd'].map((id): [ReturnType<typeof leaf>, number] => [leaf(id), 0.25])));
const target = { kind: 'edge' as const, path: [], edge: 'top' as const, range: { start: 1, end: 3 } };

describe('contiguous group drops', () => {
  it('inserts above the middle two children of a flat row', () => {
    const before = JSON.stringify(row);
    const out = insert(row, 'new', target, 0.25);
    expect(out.ok).toBe(true);
    expect(validate(out.tree)).toEqual([]);
    expect(JSON.stringify(row)).toBe(before);
    expect(Object.fromEntries(layout(out.tree, box, opts))).toEqual({
      a: R(0, 0, 250, 600), new: R(250, 0, 500, 150),
      b: R(250, 150, 250, 450), c: R(500, 150, 250, 450), d: R(750, 0, 250, 600),
    });
  });

  it('remaps a range after removal shifts its child indices', () => {
    const out = move(row, 'a', target);
    expect(out.ok).toBe(true);
    expect(validate(out.tree)).toEqual([]);
    const rects = layout(out.tree, box, opts);
    expect(rects.get('a')).toEqual(R(0, 0, 667, 150));
    expect(rects.get('d')).toEqual(R(667, 0, 333, 600));
    expect(new Set(leaves(out.tree))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('removes the dragged pane from within the chosen group', () => {
    const out = move(row, 'b', { ...target, range: { start: 0, end: 3 } });
    expect(out.ok).toBe(true);
    expect(validate(out.tree)).toEqual([]);
    const rects = layout(out.tree, box, opts);
    expect(rects.get('b')).toEqual(R(0, 0, 667, 150));
    expect(rects.get('a')!.y).toBe(150);
    expect(rects.get('c')!.y).toBe(150);
    expect(rects.get('d')).toEqual(R(667, 0, 333, 600));
  });

  it('retains the whole target when removing a pane flattens its former subtree', () => {
    const original = tree(split('row',
      [split('col', [leaf('a'), 0.5], [split('row', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]), 0.5],
      [leaf('d'), 0.5],
    ));
    const out = move(original, 'a', { kind: 'edge', path: [0], edge: 'top' });
    expect(out.ok).toBe(true);
    expect(validate(out.tree)).toEqual([]);
    expect(Object.fromEntries(layout(out.tree, box, opts))).toEqual(Object.fromEntries(layout(original, box, opts)));
  });

  it.each([
    { start: -1, end: 2 }, { start: 1, end: 1 }, { start: 1, end: 2 },
    { start: 0.5, end: 3 }, { start: 0, end: 5 }, { start: 0, end: NaN },
  ])('rejects invalid group bounds %j without mutation', (range) => {
    expect(insert(row, 'new', { ...target, range })).toEqual({ tree: row, ok: false });
    expect(move(row, 'a', { ...target, range })).toEqual({ tree: row, ok: false });
  });
});

describe('group drop discovery', () => {
  it('offers every contiguous scope containing the hovered pane, smallest first', () => {
    const candidates = hitTest(row, box, { x: 375, y: 5 }, null, opts);
    expect(candidates.map(c => c.target)).toEqual([
      { kind: 'edge', path: [1], edge: 'top' },
      { kind: 'edge', path: [], edge: 'top', range: { start: 0, end: 2 } },
      { kind: 'edge', path: [], edge: 'top', range: { start: 1, end: 3 } },
      { kind: 'edge', path: [], edge: 'top', range: { start: 0, end: 3 } },
      { kind: 'edge', path: [], edge: 'top', range: { start: 1, end: 4 } },
      { kind: 'edge', path: [], edge: 'top' },
    ]);
    expect(candidates[2].scopeRect).toEqual(R(250, 0, 500, 600));
    expect(candidates[2].scopeLeafCount).toBe(2);
    for (const candidate of candidates) {
      const committed = insert(row, 'new', candidate.target);
      expect(candidate.previewRect).toEqual(layout(committed.tree, box, opts).get('new'));
    }
  });

  it('deduplicates groups that become identical when the dragged child is removed', () => {
    const candidates = hitTest(row, box, { x: 375, y: 5 }, 'd', opts);
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      expect(candidate.previewRect).toEqual(layout(move(row, 'd', candidate.target).tree, box, opts).get('d'));
    }
  });

  it('does not reserve a real pane id for external preview bookkeeping', () => {
    const t = tree(leaf('__lath_external_drop__'));
    expect(hitTest(t, box, { x: 10, y: 300 }, null, opts)).toHaveLength(1);
  });
});

describe('three-pane layout choices', () => {
  const shape = (node: LathNode): string => node.kind === 'leaf' ? '*' : node.dir + '(' + node.children.map(c => shape(c.node)).join(',') + ')';
  const expected = ['col(row(*,*),*)', 'col(*,row(*,*))', 'row(col(*,*),*)', 'row(*,col(*,*))'];
  for (const direction of ['right', 'bottom'] as const) {
    for (const splitFirst of ['a', 'b']) {
      for (const dragged of ['a', 'b', 'c']) {
        it('offers all four arrangements moving ' + dragged + ' after splitting ' + splitFirst + ' toward ' + direction, () => {
          const pair = splitLeaf(leafTree('a'), 'a', direction, 'b').tree;
          const original = splitLeaf(pair, splitFirst, direction, 'c').tree;
          const found = new Set<string>();
          for (const rect of layout(original, box, opts).values()) {
            const points = [
              { x: rect.x + 1, y: rect.y + rect.height / 2 },
              { x: rect.x + rect.width - 1, y: rect.y + rect.height / 2 },
              { x: rect.x + rect.width / 2, y: rect.y + 1 },
              { x: rect.x + rect.width / 2, y: rect.y + rect.height - 1 },
            ];
            for (const point of points) for (const candidate of hitTest(original, box, point, dragged, opts)) {
              const result = move(original, dragged, candidate.target);
              expect(result.ok).toBe(true);
              expect(validate(result.tree)).toEqual([]);
              expect(new Set(leaves(result.tree))).toEqual(new Set(['a', 'b', 'c']));
              expect(layout(result.tree, box, opts).get(dragged)).toEqual(candidate.previewRect);
              found.add(shape(result.tree.root!));
            }
          }
          for (const arrangement of expected) expect(found.has(arrangement), arrangement).toBe(true);
        });
      }
    }
  }
});


describe('group drop geometry and persistence', () => {
  it('includes gutters in a nested column scope and keeps unrelated panes fixed', () => {
    const original = tree(split('row',
      [leaf('outside'), 0.4],
      [split('col', ...['a', 'b', 'c', 'd'].map((id): [ReturnType<typeof leaf>, number] => [leaf(id), 0.25])), 0.6],
    ));
    const geometry = { gap: 7, minLeaf: { width: 100, height: 60 } };
    const bounds = R(17, 23, 1201, 807);
    const scope = { kind: 'edge' as const, path: [1], edge: 'left' as const, range: { start: 1, end: 3 } };
    const before = layout(original, bounds, geometry);
    const b = before.get('b')!;
    const c = before.get('c')!;
    expect(targetRect(original, bounds, geometry, scope)).toEqual(R(b.x, b.y, b.width, c.y + c.height - b.y));
    const result = insert(original, 'new', scope);
    expect(result.ok).toBe(true);
    expect(validate(result.tree)).toEqual([]);
    expect(layout(result.tree, bounds, geometry).get('outside')).toEqual(before.get('outside'));
    const meta = new Map(leaves(result.tree).map(id => [id, { component: 'terminal', tabComponent: 'terminal', title: id }]));
    const restored = JSON.parse(JSON.stringify(lathLayoutFromStore({ tree: result.tree, leafMeta: meta })));
    expect(isLathPersistedLayout(restored)).toBe(true);
    expect(layout(restored.tree, bounds, geometry)).toEqual(layout(result.tree, bounds, geometry));
  });

  it('accepts a full child range as the equivalent whole split', () => {
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      expect(insert(row, 'new', { ...target, edge, range: { start: 0, end: 4 } }).tree)
        .toEqual(insert(row, 'new', { kind: 'edge', path: [], edge }).tree);
    }
  });

  it('preserves immutable trees, identities, and exact previews across 300 seeded group moves', () => {
    let seed = 0x5a17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    };
    let groups = 0;
    for (let run = 0; run < 300; run++) {
      let original = leafTree('0');
      const count = 4 + Math.floor(random() * 7);
      for (let i = 1; i < count; i++) {
        const edge = (['left', 'right', 'top', 'bottom'] as const)[Math.floor(random() * 4)];
        original = splitLeaf(original, String(Math.floor(random() * i)), edge, String(i)).tree;
      }
      const bounds = R(13, 19, 300 + Math.floor(random() * 1200), 200 + Math.floor(random() * 800));
      const geometry = { gap: run % 3 === 0 ? 0 : 7, minLeaf: { width: 100, height: 60 } };
      const dragged = run % 4 === 0 ? null : String(Math.floor(random() * count));
      const before = JSON.stringify(original);
      freeze(original);
      const rectangles = layout(original, bounds, geometry);
      for (const r of rectangles.values()) {
        const points = [
          { x: r.x + r.width / 2, y: r.y + 0.1 },
          { x: r.x + 0.1, y: r.y + r.height / 2 },
        ];
        for (const point of points) for (const candidate of hitTest(original, bounds, point, dragged, geometry)) {
          if (candidate.target.kind === 'edge' && candidate.target.range) groups++;
          const result = dragged === null ? insert(original, 'new', candidate.target) : move(original, dragged, candidate.target);
          expect(result.ok).toBe(true);
          expect(validate(result.tree)).toEqual([]);
          expect(new Set(leaves(result.tree))).toEqual(new Set([...leaves(original), ...(dragged === null ? ['new'] : [])]));
          expect(layout(result.tree, bounds, geometry).get(dragged ?? 'new')).toEqual(candidate.previewRect);
          expect(JSON.stringify(original)).toBe(before);
        }
      }
    }
    expect(groups).toBeGreaterThan(100);
  });
});

describe('gesture hit-test cache', () => {
  it('reuses speculative layouts within one edge and invalidates every geometry input', () => {
    const cached = createHitTester();
    const point = { x: 375, y: 5 };
    const first = cached(row, box, point, 'd', opts);
    expect(cached(row, { ...box }, { x: 376, y: 6 }, 'd', { ...opts })).toBe(first);
    const cases: Parameters<typeof hitTest>[] = [
      [row, box, { x: 375, y: 300 }, 'd', opts],
      [row, box, point, null, opts],
      [row, { ...box, width: 1200 }, point, 'd', opts],
      [row, box, point, 'd', { ...opts, gap: 7 }],
      [row, box, point, 'd', { ...opts, minLeaf: { width: 400, height: 60 } }],
      [splitLeaf(row, 'b', 'bottom', 'new').tree, box, point, 'd', opts],
    ];
    for (const args of cases) {
      const result = cached(...args);
      expect(result).not.toBe(first);
      expect(result).toEqual(hitTest(...args));
    }
    expect(cached(row, box, { x: -1, y: 5 }, 'd', opts)).toEqual([]);
    expect(cached(row, box, point, 'd', opts)).toEqual(first);
  });
});


describe('restore scopes after normalization', () => {
  it.each(['row', 'col'] as const)('restores beside an entire split sibling flattened into a %s grandparent', (dir) => {
    const across = dir === 'row' ? 'col' : 'row';
    const original = tree(split(dir,
      [split(across, [leaf('a'), 0.3], [split(dir, [leaf('b'), 0.2], [leaf('c'), 0.8]), 0.7]), 0.4],
      [leaf('d'), 0.6],
    ));
    const removed = remove(original, 'a');
    const restored = restore(removed.tree, JSON.parse(JSON.stringify(removed.token)));
    expect(restored.ok).toBe(true);
    expect(restored.tier).toBe('exact');
    expect(validate(restored.tree)).toEqual([]);
    expect(layout(restored.tree, box, opts)).toEqual(layout(original, box, opts));
  });

  it('does not reclaim an unrelated pane added inside the former sibling group', () => {
    const original = tree(split('row',
      [split('col', [leaf('a'), 0.3], [split('row', [leaf('b'), 0.2], [leaf('c'), 0.8]), 0.7]), 0.4],
      [leaf('d'), 0.6],
    ));
    const removed = remove(original, 'a');
    const changed = splitLeaf(removed.tree, 'b', 'bottom', 'new').tree;
    const restored = restore(changed, removed.token!);
    expect(restored.ok).toBe(true);
    expect(restored.tier).toBe('neighbor');
    expect(validate(restored.tree)).toEqual([]);
    expect(new Set(leaves(restored.tree))).toEqual(new Set(['a', 'b', 'c', 'd', 'new']));
  });
});


it('round-trips exact restore geometry across 100 seeded nested layouts', () => {
  let seed = 0x727374;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  let checked = 0;
  for (let run = 0; run < 100; run++) {
    let original = leafTree('0');
    for (let i = 1; i < 9; i++) {
      original = splitLeaf(original, String(Math.floor(random() * i)), (['left', 'right', 'top', 'bottom'] as const)[Math.floor(random() * 4)], String(i)).tree;
    }
    for (const id of leaves(original)) {
      const path = findLeafPath(original, id)!;
      const parent = nodeAtPath(original, path.slice(0, -1))!;
      if (parent.kind !== 'split' || parent.children.length === 2 && parent.children.every(child => child.node.kind === 'leaf')) continue;
      const removed = remove(original, id);
      const restored = restore(removed.tree, removed.token!);
      expect(restored.tier).toBe('exact');
      expect(validate(restored.tree)).toEqual([]);
      expect(layout(restored.tree, box, opts)).toEqual(layout(original, box, opts));
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(200);
});
