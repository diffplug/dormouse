/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { resolvePaneGroupElement } from './spatial-nav';

/** Minimal DockviewApi stub: only `getPanel(id).group.element` is exercised. */
function fakeApi(groups: Record<string, HTMLElement | null>): DockviewApi {
  return {
    getPanel(id: string) {
      if (!(id in groups)) return undefined;
      const element = groups[id];
      return { group: element ? { element } : undefined };
    },
  } as unknown as DockviewApi;
}

/** A browser surface's body: mounted in a dv-render-overlay, NOT inside any
 *  dv-groupview, so a DOM climb finds no group and falls back to this body. */
function makeOverlayBody(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'dv-render-overlay';
  const body = document.createElement('div');
  overlay.appendChild(body);
  document.body.appendChild(overlay);
  return body;
}

describe('resolvePaneGroupElement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('climbs to the dv-groupview when the api has no group (e.g. terminal body inside it)', () => {
    const group = document.createElement('div');
    group.className = 'dv-groupview dv-active-group';
    const body = document.createElement('div');
    group.appendChild(body);
    document.body.appendChild(group);

    // No api group → resolution falls back to the DOM climb, which lands on the group.
    const api = fakeApi({ t1: null });
    expect(resolvePaneGroupElement(api, 't1', new Map([['t1', body]]))).toBe(group);
  });

  it('uses the dockview group element for a browser body rendered in the overlay layer', () => {
    const body = makeOverlayBody();
    // The full group (tab header + content) still lives elsewhere in the DOM.
    const group = document.createElement('div');
    group.className = 'dv-groupview';
    document.body.appendChild(group);

    const api = fakeApi({ b1: group });
    expect(resolvePaneGroupElement(api, 'b1', new Map([['b1', body]]))).toBe(group);
  });

  it('falls back to the body when no panel/group is available', () => {
    const body = makeOverlayBody();
    const api = fakeApi({}); // getPanel returns undefined
    expect(resolvePaneGroupElement(api, 'b1', new Map([['b1', body]]))).toBe(body);
  });

  it('falls back to the body when the api is null', () => {
    const body = makeOverlayBody();
    expect(resolvePaneGroupElement(null, 'b1', new Map([['b1', body]]))).toBe(body);
  });

  it('ignores a disconnected group element and falls back to the body', () => {
    const body = makeOverlayBody();
    const detachedGroup = document.createElement('div'); // never attached → !isConnected
    detachedGroup.className = 'dv-groupview';

    const api = fakeApi({ b1: detachedGroup });
    expect(resolvePaneGroupElement(api, 'b1', new Map([['b1', body]]))).toBe(body);
  });
});
