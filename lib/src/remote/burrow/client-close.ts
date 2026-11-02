/**
 * A Client's close of one of this webview's Surfaces, answered to the Burrow
 * (`docs/specs/remote-api.md` -> "Closing a surface"). A peer op answers at once
 * and within a budget, and a close can wait on a helper's inspection or a save,
 * so the op starts it and the Burrow polls for the outcome.
 */

import type { SurfaceCloseParams, SurfaceCloseResult } from 'remote-lib-common';

export type ClientCloseParams = SurfaceCloseParams & {
  /** Asks after a close already started, rather than starting one. */
  poll?: boolean;
};
export type ClientCloseAnswer = SurfaceCloseResult | { outcome: 'pending' };
export type ClientCloseConsent = Pick<SurfaceCloseParams, 'confirmed' | 'unsaved'>;

/** One Workspace's Wall, which alone can close its Surfaces. */
export interface ClientCloser {
  owns(surfaceId: string): boolean;
  close(surfaceId: string, consent: ClientCloseConsent): Promise<SurfaceCloseResult>;
}

const closers = new Set<ClientCloser>();
const running = new Map<string, { result: SurfaceCloseResult | null }>();

export function registerClientCloser(closer: ClientCloser): () => void {
  closers.add(closer);
  return () => void closers.delete(closer);
}

/** No answer means this webview has no such close: another window's, or none. */
export function answerClientClose({ surfaceId, confirmed, unsaved, poll }: ClientCloseParams): ClientCloseAnswer[] {
  const run = running.get(surfaceId);
  if (run && !run.result) return [{ outcome: 'pending' }];
  // A settled close nobody polled for, its session gone, is no answer to a new one.
  if (run) running.delete(surfaceId);
  if (poll) return run?.result ? [run.result] : [];
  const closer = [...closers].find((candidate) => candidate.owns(surfaceId));
  if (!closer) return [];
  const started: { result: SurfaceCloseResult | null } = { result: null };
  running.set(surfaceId, started);
  closer.close(surfaceId, { confirmed, unsaved }).then(
    (result) => { started.result = result; },
    (error: unknown) => {
      started.result = { outcome: 'refused', message: error instanceof Error ? error.message : String(error) };
    },
  );
  return [{ outcome: 'pending' }];
}
