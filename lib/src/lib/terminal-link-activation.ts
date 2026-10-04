import { PREVIEW_SUPERSEDED_ERROR } from 'dor/commands/types';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { requestExternalLinkConfirmation } from './external-link-confirmation';
import { decodeFileLink, localFileLinkPreviewPath } from './external-links';
import { getPlatform } from './platform';
import { dispatchDorControlRequest } from './platform/dor-control-dispatch';
import { normalizeFileUriPath } from './terminal-state';
import { getInheritableCwd } from './terminal-state-store';

/** A click's preview; `failed` once its refusal opened the dialog. */
interface LinkPreview { id: string; uri: string; failed: boolean }
/** The last click's preview. */
let lastPreview: LinkPreview | null = null;

/**
 * An `OSC 8` link click in Session `id` (`docs/specs/dor-tool.md` -> Terminal
 * links). A local `file:` link whose display text names its target is opened as
 * a `dor open` from that Session: the click previews it, and a double-click's
 * second click (`detail` 2) pins it. Every other link, and an open the host
 * refuses, goes to the confirmation dialog — once per double-click.
 */
export function activateTerminalLink(
  id: string,
  event: Pick<MouseEvent, 'detail'>,
  uri: string,
  displayText: string,
): void {
  const preview = event.detail < 2;
  // A pin's own preview, recorded at its first click. The serial launch queue
  // answers that preview first.
  const ownPreview = !preview && lastPreview?.id === id && lastPreview.uri === uri ? lastPreview : null;
  if (preview) lastPreview = null;
  const path = localFileLinkPreviewPath(uri, displayText);
  const source = { surfaceId: id, cwd: linkCwd(id, path ?? decodeFileLink(uri)?.path) };
  // Only a host that resolves open rules can answer.
  if (path === null || !getPlatform().toolControl) {
    requestExternalLinkConfirmation(uri, displayText, source);
    return;
  }
  // A triple-click's third click would open the file again, unkeyed Tools twice.
  if (event.detail > 2) return;
  const record: LinkPreview | null = preview ? { id, uri, failed: false } : null;
  if (record) lastPreview = record;
  dispatchDorControlRequest({
    requestId: `link-${crypto.randomUUID()}`,
    surfaceId: id,
    method: SURFACE_CONTROL_METHODS.tool,
    params: { file: uri, preview, cwd: source.cwd },
  }, (response) => {
    if (response.ok || response.error === PREVIEW_SUPERSEDED_ERROR || ownPreview?.failed) return;
    if (record) record.failed = true;
    requestExternalLinkConfirmation(uri, displayText, source);
  });
}

/** The click's directory, kept across confirmation and viewer selection: the
 *  Session's CWD, else the linked file's own. The host still validates the link. */
function linkCwd(id: string, path: string | undefined): string | undefined {
  return getInheritableCwd(id) ?? (path === undefined ? undefined : directoryOf(normalizeFileUriPath(path)));
}

/** The parent of a native path with `/` separators; a root keeps its slash,
 *  so the parent of `C:/x` is `C:/` and of `/x` is `/`. */
function directoryOf(native: string): string {
  const dir = native.slice(0, native.lastIndexOf('/'));
  return /^([A-Za-z]:)?$/.test(dir) ? `${dir}/` : dir;
}
