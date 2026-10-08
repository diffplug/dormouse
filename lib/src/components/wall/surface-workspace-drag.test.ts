/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetWorkspaceUi } from '../../lib/workspace-ui-store';
import { registerWallHandle, resetWallHandles, stubWallHandle } from './wall-handles';
import { requestSurfaceMove } from './surface-move';
import { surfaceWorkspaceDrag } from './surface-workspace-drag';

vi.mock('./surface-move', async importOriginal => ({ ...await importOriginal<typeof import('./surface-move')>(), requestSurfaceMove: vi.fn() }));

let count: number;
let sourceTab: HTMLElement;
let targetTab: HTMLElement;
let plus: HTMLElement;
const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 30 }) as DOMRect;

beforeEach(() => {
  resetWorkspaceUi();
  count = 2;
  registerWallHandle(stubWallHandle('source', { canMoveSurfaces: true, ownsSurface: id => id === 'pane', surfaceIds: () => Array.from({ length: count }, (_, i) => `pane-${i}`) }));
  document.body.innerHTML = '<div data-workspace-strip><div data-workspace-strip-area><div data-workspace-tab="source"></div><div data-workspace-tab="target"></div><button data-workspace-new></button></div><div data-workspace-strip-spacer></div><div data-workspace-strip-area data-workspace-pinned-group><div data-workspace-tab="pinned"></div></div></div>';
  const [strip, pinnedGroup] = document.querySelectorAll<HTMLElement>('[data-workspace-strip-area]');
  pinnedGroup.getBoundingClientRect = () => rect(400, 100);
  document.querySelector<HTMLElement>('[data-workspace-tab="pinned"]')!.getBoundingClientRect = () => rect(400, 100);
  sourceTab = document.querySelector<HTMLElement>('[data-workspace-tab="source"]')!;
  targetTab = document.querySelector<HTMLElement>('[data-workspace-tab="target"]')!;
  plus = document.querySelector<HTMLElement>('[data-workspace-new]')!;
  strip.getBoundingClientRect = () => rect(0, 300);
  sourceTab.getBoundingClientRect = () => rect(0, 80);
  targetTab.getBoundingClientRect = () => rect(90, 80);
  plus.getBoundingClientRect = () => rect(260, 30);
});

afterEach(() => {
  surfaceWorkspaceDrag.end();
  resetWallHandles();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

it('uses live tab bounds on release when a tab resizes during the gesture', () => {
  expect(surfaceWorkspaceDrag.hover('pane', 100, 15)).toBe(true);
  expect(targetTab.hasAttribute('data-surface-drop')).toBe(true);
  sourceTab.getBoundingClientRect = () => rect(0, 130);
  targetTab.getBoundingClientRect = () => rect(140, 80);
  expect(surfaceWorkspaceDrag.drop('pane', 100, 15)).toBe(true);
  expect(requestSurfaceMove).not.toHaveBeenCalled();
  expect(targetTab.hasAttribute('data-surface-drop')).toBe(false);
});

it('updates the new-Workspace highlight if source membership changes under the pointer', () => {
  count = 1;
  surfaceWorkspaceDrag.hover('pane', 275, 15);
  expect(plus.hasAttribute('data-surface-drop')).toBe(false);
  count = 2;
  surfaceWorkspaceDrag.hover('pane', 275, 15);
  expect(plus.hasAttribute('data-surface-drop')).toBe(true);
  surfaceWorkspaceDrag.drop('pane', 275, 15);
  expect(requestSurfaceMove).toHaveBeenCalledWith('pane', { new: true });
});

it('claims the pinned group but leaves the title-bar space before it to the host', () => {
  expect(surfaceWorkspaceDrag.hover('pane', 350, 15)).toBe(false);
  expect(surfaceWorkspaceDrag.hover('pane', 450, 15)).toBe(true);
  expect(document.querySelector('[data-workspace-tab="pinned"]')!.hasAttribute('data-surface-drop')).toBe(true);
});
