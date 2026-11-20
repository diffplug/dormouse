/**
 * @vitest-environment jsdom
 */
import { act, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModalFrame, NativeModalDialog } from '../components/design';
import { useCloseOnOutsideAndEscape } from '../components/use-anchored-menu';
import { useDismissOverlay } from '../components/wall/use-dismiss-overlay';
import { ensureDialogModal, ensureResizeObserver } from '../components/wall/wall-test-utils';
import { paneWebviewsOccluded } from './pane-webview-occlusion';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ensureDialogModal();
  ensureResizeObserver();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Menu({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useCloseOnOutsideAndEscape(open, ref, () => {});
  return <div ref={ref} />;
}

function Popover() {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOverlay(() => {}, ref);
  return <div ref={ref} />;
}

/** Whether pane webviews are hidden while `node` is mounted, and shown again after. */
function occludedWhile(node: ReactNode): boolean {
  act(() => root.render(node));
  const occluded = paneWebviewsOccluded();
  act(() => root.render(null));
  expect(paneWebviewsOccluded()).toBe(false);
  return occluded;
}

describe('pane webview occlusion', () => {
  it('hides every pane webview while a modal, a native dialog, a menu, or a popover is open', () => {
    expect(occludedWhile(<ModalFrame titleId="t"><h2 id="t">Title</h2></ModalFrame>)).toBe(true);
    expect(occludedWhile(<NativeModalDialog onClose={() => {}}>Dialog</NativeModalDialog>)).toBe(true);
    expect(occludedWhile(<Menu open />)).toBe(true);
    expect(occludedWhile(<Popover />)).toBe(true);
  });

  it('leaves them shown for a closed menu', () => {
    expect(occludedWhile(<Menu open={false} />)).toBe(false);
  });
});
