import { mintSurfaceId } from '../../lib/surface-ids';
import { registry } from '../../lib/terminal-store';
import { wallHandleOwning } from './wall-handles';

/** A new Surface id that no Session or Wall in this page already holds. */
export function mintWallSurfaceId(): string {
  return mintSurfaceId((id) => registry.has(id) || wallHandleOwning(id) !== null);
}
