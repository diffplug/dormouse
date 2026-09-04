/**
 * @vitest-environment jsdom
 *
 * The ring's *first* render in a fresh module registry, which is the only place
 * a React DOM-property warning can be observed: React dedupes each one by
 * property name for the life of the process, so a second render — or a second
 * test file's — is silent no matter how wrong the JSX is. Its own file for that
 * reason, rather than a case in `WorkspaceSelectionOverlay.test.tsx`.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { isRingCorner, type RingPiece } from '../../lib/ring-geometry';
import { SelectionRing } from './SelectionRing';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The smear pieces are stroked at unit width and scaled from their own corner,
// so the transform origin is load-bearing geometry — but writing it as the SVG
// presentation attribute reaches the DOM *and* logs `Invalid DOM property` on
// every render, because React knows that attribute only as `transformOrigin`.
// Identical pixels, an error per render: found by reading the console during a
// walkthrough (`scripts/pairing-walkthrough/`).
it('renders the smear transform origin without a React DOM-property warning', async () => {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <SelectionRing
        variant="ants"
        animationKey="pane:a"
        color="#fff"
        windowFocused
        containerRef={null}
        pathRef={null}
        smearRef={null}
      />,
    ));
  } finally {
    console.error = realError;
  }

  expect(errors.filter((line) => /Invalid DOM property/.test(line))).toEqual([]);
  // Every piece carries it, but a corner is where it does work: the overlay
  // scales corners from their own corner and leaves the straight edges
  // untransformed (`WorkspaceSelectionOverlay.tsx` → `writeSmear`).
  const corners = [...container.querySelectorAll<SVGPathElement>('[data-piece]')]
    .filter((el) => isRingCorner(el.dataset.piece as RingPiece));
  expect(corners).toHaveLength(4);
  expect(corners.map((el) => el.style.transformOrigin)).toEqual(['0 0', '0 0', '0 0', '0 0']);

  await act(async () => root.unmount());
  container.remove();
});
