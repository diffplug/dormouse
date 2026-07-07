// Shared fixtures for the Lath wall tests: the `leafMeta` builder every suite uses to
// stamp per-leaf metadata, and a hand-written SerializedDockview blob for the
// persistence/migration tests.

import type { LeafMeta } from './persistence';

/** Build a `LeafMeta` for tests. `tabComponent` defaults from `component` the same way
 *  the real builders do (`terminal` → `terminal`, anything else → `surface`); `title`
 *  defaults to `'t'`. The single builder shared by every Lath wall test suite. */
export function leafMeta(overrides: {
  title?: string;
  component?: string;
  tabComponent?: string;
  params?: Record<string, unknown>;
} = {}): LeafMeta {
  const component = overrides.component ?? 'terminal';
  return {
    component,
    tabComponent: overrides.tabComponent ?? (component === 'terminal' ? 'terminal' : 'surface'),
    title: overrides.title ?? 't',
    ...(overrides.params ? { params: overrides.params } : {}),
  };
}

// The dockview fixture matches dockview-core's serialized shape: grid.orientation is
// the ROOT orientation; a HORIZONTAL branch lays children left→right; each child's
// `size` is its extent along the parent axis; a leaf `data` is a group ({ id, views,
// activeView }); the per-panel state lives in the flat `panels` map. Returned as
// `unknown` so callers cast/pass it as their assertion needs.
export function dockviewFixture(): unknown {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { id: 'group-1', views: ['pane-a'], activeView: 'pane-a' }, size: 600 },
          {
            type: 'branch',
            data: [
              { type: 'leaf', data: { id: 'group-2', views: ['pane-b'], activeView: 'pane-b' }, size: 300 },
              { type: 'leaf', data: { id: 'group-3', views: ['pane-c'], activeView: 'pane-c' }, size: 500 },
            ],
            size: 400,
          },
        ],
        size: 800,
      },
      width: 1000,
      height: 800,
      orientation: 'HORIZONTAL',
    },
    panels: {
      'pane-a': { id: 'pane-a', contentComponent: 'terminal', tabComponent: 'terminal', title: 'A' },
      'pane-b': {
        id: 'pane-b',
        contentComponent: 'browser',
        tabComponent: 'surface',
        title: 'B',
        renderer: 'always',
        params: { renderMode: 'iframe', url: 'https://example.com' },
      },
      'pane-c': { id: 'pane-c', contentComponent: 'terminal', tabComponent: 'terminal', title: 'C' },
    },
    activeGroup: 'group-1',
  };
}
