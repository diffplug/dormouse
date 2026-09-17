import { APP_CONTROL_METHODS } from 'dor/protocol';
import { getPlatformOrNull } from '../../lib/platform';
import { errorText } from './dor-control-shared';
import type { DorControlRequest } from './use-dor-control';

/**
 * The `app.*` control verbs, answered by the Window before any Workspace or
 * Surface is resolved (`docs/specs/dor-cli.md` → "dor app").
 *
 * The restart is triggered **before** the answer, so the caller sees the host's
 * refusal (a dev build) or that it joined a quit that will not relaunch. The
 * caller's own terminal is still running `dor app restart` while the quit asks
 * about running work; `countRunningSessionsIn` never counts that command.
 */
export async function handleAppControl(detail: DorControlRequest): Promise<void> {
  if (detail.method !== APP_CONTROL_METHODS.restart) {
    detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
    return;
  }
  const platform = getPlatformOrNull();
  if (!platform?.requestAppRestart) {
    detail.respond({ ok: false, error: 'dor app restart is available only in Dormouse Standalone' });
    return;
  }
  try {
    const relaunch = await platform.requestAppRestart();
    detail.respond({ ok: true, result: { relaunch } });
  } catch (error) {
    detail.respond({ ok: false, error: errorText(error) });
  }
}
