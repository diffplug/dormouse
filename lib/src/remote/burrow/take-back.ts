/**
 * A held pane's Take back, as its strip runs it (`docs/specs/remote-api.md` →
 * "Size authority"). Apart from the surface responder so the strip pulls in
 * nothing of it.
 */

import { getPlatform } from '../../lib/platform';
import type { TakeBackParams } from '../../host/remote/service-protocol';
import { getSizeHold, releaseSizeHold } from '../../lib/size-hold-store';

/**
 * End the remote session holding `surfaceId`'s size; its release re-fits the
 * pane. The hold is cleared here too once the Burrow has answered, either way
 * — a holder the Burrow no longer knows (ended already, or held under a broker
 * window that is gone) would otherwise leave a strip nothing can take down.
 * Only the hold asked about is cleared: a newer holder keeps the pane.
 */
export async function takeBackSize(surfaceId: string): Promise<void> {
  const hold = getSizeHold(surfaceId);
  if (!hold) return;
  try {
    await getPlatform().burrow?.command('takeBack', { holder: hold.holder } satisfies TakeBackParams);
  } catch (error) {
    console.warn('[burrow] take back failed', error);
  }
  releaseSizeHold(surfaceId, hold);
}
