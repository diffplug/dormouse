/**
 * @vitest-environment jsdom
 */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { usePaneChrome } from './use-pane-chrome';
import { PaneElementsContext } from './wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Body({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePaneChrome(id, ref);
  return <div ref={ref} data-name={name} />;
}

// A preview slot switch mounts the next body beside its ghost, which leaves
// first (`docs/specs/dor-tool.md` -> Switching the slot).
it('keeps a newer body registered when an older one with its id unmounts', () => {
  const panes = { elements: new Map<string, HTMLElement>(), bumpVersion: () => {}, version: 0 };
  const { elements } = panes;
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (names: string[]) => act(() => root.render(
    <PaneElementsContext.Provider value={panes}>
      {names.map(name => <Body key={name} id="slot" name={name} />)}
    </PaneElementsContext.Provider>,
  ));
  render(['ghost']);
  render(['ghost', 'next']);
  render(['next']);
  expect(elements.get('slot')?.dataset.name).toBe('next');
  render([]);
  expect(elements.has('slot')).toBe(false);
  act(() => root.unmount());
});
