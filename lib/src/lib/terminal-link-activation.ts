import { PREVIEW_SUPERSEDED_ERROR } from 'dor/commands/types';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { requestExternalLinkConfirmation } from './external-link-confirmation';
import { localFileLinkPreviewPath } from './external-links';
import { getPlatform } from './platform';
import { dispatchDorControlRequest } from './platform/dor-control-dispatch';
import { normalizeFileUriPath } from './terminal-state';
import { getInheritableCwd } from './terminal-state-store';

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
    params: { file: uri, preview: event.detail < 2, cwd: getInheritableCwd(id) ?? directoryOf(normalizeFileUriPath(path)) },
  }, (response) => {
    if (!response.ok && response.error !== PREVIEW_SUPERSEDED_ERROR) requestExternalLinkConfirmation(uri, displayText);
  });
}

/** The parent of a native path with `/` separators; a root keeps its slash,
 *  so the parent of `C:/x` is `C:/` and of `/x` is `/`. */
function directoryOf(native: string): string {
  const dir = native.slice(0, native.lastIndexOf('/'));
  return /^([A-Za-z]:)?$/.test(dir) ? `${dir}/` : dir;
}
