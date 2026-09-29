/**
 * The renderer side of a preview slot switch (`docs/specs/dor-tool.md` ->
 * Switching the slot): what a switch captures when it begins — the ghost of
 * the slot's view and what its header showed — and the hooks the Tool body and
 * headers read it through. The lifecycle is
 * `lib/src/lib/preview-transition-store.ts`.
 */
import { useSyncExternalStore } from 'react';
import {
  beginPreviewTransition,
  getPreviewSlotView,
  subscribeToPreviewTransitions,
  type GhostRect,
  type PreviewGhost,
  type PreviewSlotView,
  type PreviewTransition,
} from '../../lib/preview-transition-store';
import { getActivitySnapshot, getTerminalPaneStateSnapshot } from '../../lib/terminal-registry';
import { buildAppTitleResolver, createTerminalPaneState } from '../../lib/terminal-state';
import { motionIsInstant } from '../../lib/ui-geometry';
import { devServerMatchNow, type DevServerMatch } from './agent-browser-ports';
import { browserDisplayMode, getAgentBrowserScreenController, type BrowserDisplayMode, type ChromeSnapshot } from './agent-browser-screen';
import { resolveRenderMode, toolFace, type ToolFace } from './browser-surface';
import { loopbackPort } from './browser-url';
import { headerPeerStates, terminalHeaderLabel, type TerminalHeaderLabel } from './terminal-header-label';

/** A browser header as it stood: its address, display chip, and dev-server chip. */
export interface HeldBrowserHeader {
  readonly face: 'browser';
  readonly chrome: ChromeSnapshot;
  readonly displayMode: BrowserDisplayMode;
  readonly port: number | null;
  readonly devServer: DevServerMatch | null;
}

interface HeldTerminalHeader extends TerminalHeaderLabel {
  readonly face: 'terminal';
}

type HeldHeader = HeldBrowserHeader | HeldTerminalHeader;

/** Marks a Tool's browser layer, the box a screencast snapshot is placed in. */
export const BROWSER_LAYER_ATTRIBUTE = 'data-browser-layer';
/** Marks a screencast's canvas with its Surface id. */
export const SCREENCAST_CANVAS_ATTRIBUTE = 'data-screencast-canvas-for';

/**
 * Begin a switch on the slot `id`, or take over the one in progress. What the
 * slot shows is captured only for a new switch, and only on a face with
 * something to hold.
 */
export function beginSlotSwitch(
  id: string,
  meta: () => { params?: Record<string, unknown>; title?: string } | null | undefined,
): number | null {
  return beginPreviewTransition(id, () => {
    const current = meta();
    return current ? capturePreviewGhost(id, current.params, current.title) : null;
  }, motionIsInstant());
}

/** What a switch on this Tool leaf holds, captured now; null on a face with
 *  nothing to hold (approval, a port conflict). */
function capturePreviewGhost(
  id: string,
  params: Record<string, unknown> | undefined,
  title: string | undefined,
): { ghost: PreviewGhost; header: HeldHeader | null } | null {
  const face = toolFace(params);
  if (face === 'terminal') return { ghost: { kind: 'terminal' }, header: captureTerminalHeader(id, title) };
  if (face !== 'browser' || !params) return null;
  const header = captureBrowserHeader(id);
  // A loaded document stays painted after its server exits, and blurs across
  // origins, so the iframe itself is kept; a screencast's session closes.
  if (resolveRenderMode(params) === 'iframe') {
    return { ghost: { kind: 'layer', generation: getPreviewSlotView(id).generation, params }, header };
  }
  const canvas = Array.from(document.querySelectorAll<HTMLCanvasElement>(`canvas[${SCREENCAST_CANVAS_ATTRIBUTE}]`))
    .find(candidate => candidate.getAttribute(SCREENCAST_CANVAS_ATTRIBUTE) === id);
  const snapshot = canvas ? snapshotScreencast(canvas, canvas.closest(`[${BROWSER_LAYER_ATTRIBUTE}]`)) : null;
  return { ghost: { kind: 'image', src: snapshot?.src ?? null, rect: snapshot?.rect ?? null }, header };
}

/** A screencast canvas's current frame as an image, placed where the canvas
 *  sits in `layer`; null when it shows no frame. Frames are drawn from the
 *  stream's own bytes, so the canvas is never tainted. */
export function snapshotScreencast(
  canvas: Pick<HTMLCanvasElement, 'width' | 'height' | 'toDataURL' | 'getBoundingClientRect'>,
  layer: Pick<Element, 'getBoundingClientRect'> | null,
): { src: string; rect: GhostRect } | null {
  if (!layer || !canvas.width || !canvas.height) return null;
  const box = canvas.getBoundingClientRect();
  // A hidden canvas — no frame yet, or popped out — measures nothing.
  if (!box.width || !box.height) return null;
  let src: string;
  try {
    src = canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
  if (!src?.startsWith('data:image/')) return null;
  const origin = layer.getBoundingClientRect();
  return { src, rect: { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height } };
}

function captureBrowserHeader(id: string): HeldBrowserHeader | null {
  const screen = getAgentBrowserScreenController(id);
  if (!screen) return null;
  const chrome = screen.chrome();
  const port = loopbackPort(chrome.url);
  return {
    face: 'browser',
    chrome,
    displayMode: browserDisplayMode(screen.snapshot()),
    port,
    devServer: port === null ? null : devServerMatchNow(port),
  };
}

function captureTerminalHeader(id: string, title: string | undefined): HeldTerminalHeader {
  const states = getTerminalPaneStateSnapshot();
  const label = terminalHeaderLabel(
    states.get(id) ?? createTerminalPaneState(),
    headerPeerStates(states),
    buildAppTitleResolver(states, getActivitySnapshot()),
    title,
  );
  return { face: 'terminal', ...label };
}

/** The name a retarget to `target` shows at once: its basename, as the
 *  built-in viewers title themselves, or the whole path for a root. */
export function targetLabel(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || target;
}

export function usePreviewSlotView(id: string): PreviewSlotView {
  return useSyncExternalStore(subscribeToPreviewTransitions, () => getPreviewSlotView(id));
}

/** The face a Tool shows: during a switch, its ghost's. */
export function shownToolFace(params: unknown, transition: PreviewTransition | null): ToolFace {
  const face = toolFace(params);
  if (!transition || face === 'pending-approval' || face === 'port-conflict') return face;
  return transition.ghost.kind === 'terminal' ? 'terminal' : 'browser';
}

/** The header a switch holds on `face`, showing the name its retarget
 *  committed; null when none is held there. */
export function useHeldHeader(id: string, face: 'terminal'): TerminalHeaderLabel | null;
export function useHeldHeader(id: string, face: 'browser'): HeldBrowserHeader | null;
export function useHeldHeader(id: string, face: HeldHeader['face']): TerminalHeaderLabel | HeldBrowserHeader | null {
  const { transition } = usePreviewSlotView(id);
  const header = transition?.header as HeldHeader | null | undefined;
  if (!transition || !header || header.face !== face) return null;
  const { label } = transition;
  if (header.face === 'terminal') return label === null ? header : { primary: label, secondary: null, failed: false };
  return label === null || !header.devServer ? header : { ...header, devServer: { ...header.devServer, label } };
}
