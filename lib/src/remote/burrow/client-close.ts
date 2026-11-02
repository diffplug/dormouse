/**
 * A Client's close of one of this webview's Surfaces, answered to the Burrow
 * (`docs/specs/remote-api.md` -> "Closing a surface").
 */

import type { SurfaceCloseParams, SurfaceCloseResult } from 'remote-lib-common';
import { messageOf } from '../../lib/errors';

export type ClientCloseConsent = Pick<SurfaceCloseParams, 'confirmed' | 'unsaved'>;

/** One Workspace's Wall, which alone can close its Surfaces. */
export interface ClientCloser {
  owns(surfaceId: string): boolean;
  close(surfaceId: string, consent: ClientCloseConsent): Promise<SurfaceCloseResult>;
}

const closers = new Set<ClientCloser>();

export function registerClientCloser(closer: ClientCloser): () => void {
  closers.add(closer);
  return () => void closers.delete(closer);
}

/** No answer means this webview does not own the Surface. */
export async function answerClientClose({ surfaceId, confirmed, unsaved }: SurfaceCloseParams): Promise<SurfaceCloseResult[]> {
  const closer = [...closers].find((candidate) => candidate.owns(surfaceId));
  if (!closer) return [];
  try {
    return [await closer.close(surfaceId, { confirmed, unsaved })];
  } catch (error) {
    return [{ outcome: 'refused', message: messageOf(error) }];
  }
}
