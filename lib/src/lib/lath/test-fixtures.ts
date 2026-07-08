// Shared fixtures for the Lath wall tests: the `leafMeta` builder every suite uses to
// stamp per-leaf metadata.

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
