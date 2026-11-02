/**
 * The files a frame origin serves. Imports nothing, so Hosted's staging script
 * loads this file as source.
 */

/** At the origin root, so its default scope is the whole origin. */
export const FRAME_WORKER_PATH = '/__dormouse-frame-sw.js';
export const FRAME_BOOTSTRAP_PATH = '/__dormouse-frame/bootstrap.html';
export const FRAME_BOOTSTRAP_SCRIPT_PATH = '/__dormouse-frame/bootstrap.js';
const FRAME_ASSET_PREFIX = '/__dormouse-frame/';

/** Whether a path is the frame origin's own, never the page's. */
export function isFrameAssetPath(pathname: string): boolean {
  return pathname === FRAME_WORKER_PATH || pathname.startsWith(FRAME_ASSET_PREFIX);
}
