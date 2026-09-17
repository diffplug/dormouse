import { APP_CONTROL_METHODS, isAppControlMethod, unsupportedControlMethodMessage } from 'dor/protocol';
import type { AppRestartResponse } from 'dor/commands/types';
import { getPlatformOrNull } from '../../lib/platform';
import type { DorControlRequest } from './use-dor-control';

/**
 * The `app.*` verbs (`docs/specs/dor-cli.md` → "dor app"). A host refusal
 * rejects, and the router answers it.
 */
export async function handleAppControl(detail: DorControlRequest): Promise<void> {
  // Narrowed before the switch, whose exhaustiveness is then what makes a new
  // app verb a compile error here rather than a silent restart.
  if (!isAppControlMethod(detail.method)) {
    detail.respond({ ok: false, error: unsupportedControlMethodMessage(detail.method) });
    return;
  }
  switch (detail.method) {
    case APP_CONTROL_METHODS.restart: {
      const platform = getPlatformOrNull();
      if (!platform?.requestAppRestart) {
        detail.respond({ ok: false, error: 'dor app restart is available only in Dormouse Standalone' });
        return;
      }
      const relaunch = await platform.requestAppRestart(detail.surfaceId);
      detail.respond({ ok: true, result: { relaunch } satisfies AppRestartResponse });
      return;
    }
    default: {
      const unhandled: never = detail.method;
      throw new Error(`unhandled app control method '${String(unhandled)}'`);
    }
  }
}
