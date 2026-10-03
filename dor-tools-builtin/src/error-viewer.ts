import { ERROR_CSP, errorViewerPage } from './error-viewer-page.js';
import { announceViewer, HttpError, reply, startCapabilityViewer } from './viewer-server.js';

/** A listener serving only that page, for the preview slot to frame when an
 * OSC 367 `open` fails (docs/specs/dor-tools-builtin.md -> Error viewer). */
export async function startErrorViewer(target: string, message: string): Promise<{ port: number; path: string; close(): Promise<void> }> {
  const page = errorViewerPage(target, message);
  const viewer = await startCapabilityViewer({
    csp: ERROR_CSP,
    unavailable: 'Error page unavailable',
    route: async (req, res, prefix) => {
      if (req.url !== prefix) throw new HttpError(404);
      reply(res, 200, page, 'text/html; charset=utf-8');
    },
  });
  return { port: viewer.port, path: viewer.prefix, close: viewer.close };
}

/** The `dor __view-error <target> <message>` entry: starts the viewer, which
 * outlives the call, and returns its title and OSC 367 announcement. */
export async function runErrorViewer(target: string, message: string): Promise<string> {
  const viewer = await startErrorViewer(target, message);
  return announceViewer(viewer, target);
}
