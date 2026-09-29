import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { requestExternalLinkConfirmation } from './external-link-confirmation';
import { localFileLinkPreviewPath } from './external-links';
import { getPlatform } from './platform';
import { dispatchDorControlRequest } from './platform/dor-control-dispatch';
import { getInheritableCwd } from './terminal-state-store';

/** How the preview handler answers a preview that a newer one replaced while
 *  no slot exists: superseded, as the `superseded` status is, not failed. */
export const PREVIEW_SUPERSEDED_ERROR = 'superseded by a newer preview';

/**
 * An `OSC 8` link click in Session `id` (`docs/specs/dor-tool.md` -> Terminal
 * links). A local `file:` link whose display text names its target is opened as
 * a `dor open` from that Session: the click previews it, and a double-click's
 * second click (`detail` 2) pins it. Every other link, and a preview the host
 * refuses, goes to the confirmation dialog.
 */
export function activateTerminalLink(
  id: string,
  event: Pick<MouseEvent, 'detail'>,
  uri: string,
  displayText: string,
): void {
  const path = localFileLinkPreviewPath(uri, displayText);
  // Only a host that resolves open rules can answer.
  if (path === null || !getPlatform().toolControl) {
    requestExternalLinkConfirmation(uri, displayText);
    return;
  }
  // A triple-click's third click would open the file again, unkeyed Tools twice.
  if (event.detail > 2) return;
  dispatchDorControlRequest({
    requestId: `link-${crypto.randomUUID()}`,
    surfaceId: id,
    method: SURFACE_CONTROL_METHODS.tool,
    params: { file: uri, fileUri: true, preview: event.detail < 2, cwd: getInheritableCwd(id) ?? directoryOf(path) },
  }, (response) => {
    if (!response.ok && response.error !== PREVIEW_SUPERSEDED_ERROR) requestExternalLinkConfirmation(uri, displayText);
  });
}

/** The directory of a decoded `file:` path, native enough to run in:
 *  `file:///C:/x` decodes to `/C:/x`, whose directory is `C:/`. */
function directoryOf(path: string): string {
  const drive = /^\/[A-Za-z]:\//.test(path);
  const native = drive ? path.slice(1) : path;
  const slash = native.lastIndexOf('/');
  return native.slice(0, slash <= (drive ? 2 : 0) ? slash + 1 : slash);
}
