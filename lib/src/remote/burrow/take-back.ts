/**
 * A held pane's Take back, as its strip runs it (`docs/specs/remote-api.md` →
 * "Size authority"). Apart from the surface responder so the strip pulls in
 * nothing of it.
 */

import { getPlatform } from '../../lib/platform';
import type { TakeBackParams } from '../../host/remote/service-protocol';
import { getSizeHolds, releaseSizeHold, type SizeHold } from '../../lib/size-hold-store';

/**
 * End every remote session holding `surfaceId`'s size; their releases re-fit
 * the pane. Each hold is cleared here too once the Burrow has answered for it,
 * either way — a holder the Burrow no longer knows (ended already, or held
 * under a broker window that is gone) would otherwise leave a strip nothing
 * can take down. Only the holds asked about are cleared: a holder that
 * arrived since keeps the pane.
 */
export async function takeBackSize(surfaceId: string): Promise<void> {
  await Promise.all(getSizeHolds(surfaceId).map((hold) => takeBackHold(surfaceId, hold)));
}

async function takeBackHold(surfaceId: string, hold: SizeHold): Promise<void> {
  try {
    await getPlatform().burrow?.command('takeBack', { holder: hold.holder } satisfies TakeBackParams);
  } catch (error) {
    console.warn('[burrow] take back failed', error);
  }
  releaseSizeHold(surfaceId, hold);
}
