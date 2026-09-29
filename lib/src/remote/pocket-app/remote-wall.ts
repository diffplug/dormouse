/**
 * The step every phone page takes once its ceremony has an established
 * session: stand the remote wall up on it (`docs/specs/pocket-app.md` → The
 * seam: the remote session is a platform adapter).
 */

import { RemotePtyAdapter, type RemoteAdapterClient } from '../client/remote-adapter';
import { setPlatform } from '../../lib/platform';
import { disposeAllSessions, initAlertStateReceiver } from '../../lib/terminal-registry';

/** An established session a wall can run on: `hello`, and the slice the adapter drives. */
export type RemoteWallClient = RemoteAdapterClient & { hello(): Promise<unknown> };

/**
 * Stand up the remote adapter as the platform and prep a clean registry — the
 * synchronous half of {@link mountRemoteWall}, for a caller that needs the
 * adapter during render. Starting it (`init`) is the caller's.
 */
export function installRemoteAdapter(client: RemoteAdapterClient): RemotePtyAdapter {
  const adapter = new RemotePtyAdapter(client);
  setPlatform(adapter);
  disposeAllSessions();
  initAlertStateReceiver();
  return adapter;
}

/**
 * Greet the Burrow, then stand up the remote adapter as the platform, prep a
 * clean registry, and start watching the directory — all before the wall
 * renders. Resolves with the adapter the wall renders.
 *
 * **An adapter that could not start is disposed before the throw**, so a
 * failed mount leaves nothing behind but the session — which the caller must
 * then close, since nothing on the screen it returns to can.
 */
export async function mountRemoteWall(client: RemoteWallClient): Promise<RemotePtyAdapter> {
  await client.hello();
  const adapter = installRemoteAdapter(client);
  try {
    await adapter.init();
  } catch (err) {
    void adapter.dispose();
    throw err;
  }
  return adapter;
}
