/**
 * The pages this webview's Surfaces embed, as the frame tunnel reaches them
 * (`docs/specs/remote-api.md` → "Frames"): a browser Surface's, or a serving
 * Tool's, while the iframe renderer shows it. Read off the browser chrome both
 * renderers register, so a page is listed exactly while its chrome shows one.
 */

import type { DirectoryBrowser } from 'remote-lib-common';
import {
  getAgentBrowserScreenController,
  listAgentBrowserScreenControllers,
  type ScreenController,
} from '../../components/wall/agent-browser-screen';
import { isPendingKillSession } from '../../lib/pending-kills';
import { isHelperSession } from '../../lib/terminal-store';

function pageOf(controller: ScreenController): DirectoryBrowser | null {
  if (isHelperSession(controller.id) || isPendingKillSession(controller.id)) return null;
  if (controller.snapshot().renderMode !== 'iframe') return null;
  const { url, title } = controller.chrome();
  // Only what the iframe proxy fronts (`docs/specs/dor-browser.md` → "Iframe Renderer").
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  if (protocol !== 'http:') return null;
  return { render: 'iframe', url, ...(title ? { title } : {}) };
}

/** The page `surfaceId` embeds, or `null`. */
export function embeddedPageOf(surfaceId: string): DirectoryBrowser | null {
  const controller = getAgentBrowserScreenController(surfaceId);
  return controller ? pageOf(controller) : null;
}

/** Every embedded page, by Surface id. */
export function collectEmbeddedPages(): Map<string, DirectoryBrowser> {
  const pages = new Map<string, DirectoryBrowser>();
  for (const controller of listAgentBrowserScreenControllers()) {
    const page = pageOf(controller);
    if (page) pages.set(controller.id, page);
  }
  return pages;
}
