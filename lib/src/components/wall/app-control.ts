import { getPlatformOrNull } from '../../lib/platform';
import type { DorControlRequest } from './use-dor-control';

/**
 * `app.restart`, answered by the Window before any Workspace or Surface is
 * resolved (`docs/specs/dor-cli.md` → "dor app"). A host refusal rejects, and
 * the router answers it.
 */
export async function handleAppControl(detail: DorControlRequest): Promise<void> {
  const platform = getPlatformOrNull();
  if (!platform?.requestAppRestart) {
    detail.respond({ ok: false, error: 'dor app restart is available only in Dormouse Standalone' });
    return;
  }
  const relaunch = await platform.requestAppRestart(detail.surfaceId);
  detail.respond({ ok: true, result: { relaunch } });
}
