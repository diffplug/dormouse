/**
 * The chunked replay buffer both Node-resident hosts keep per PTY, and the one
 * read the agent-recovery capture makes of it (docs/specs/transport.md ->
 * "Persisted session").
 *
 * Each host owns its own buffer record — `ptyBuffers` in
 * `vscode-ext/src/pty-manager.ts`, `sessions` in
 * `standalone/sidecar/pty-core.js` — and keeps only the lookup; the slicing
 * arithmetic below is shared, because getting the eviction clamp wrong in one of
 * them would silently hand the capture stale output.
 */

/**
 * The output received after a `receivedChars` mark, clamped to what the bounded
 * buffer still holds.
 *
 * Joins only the chunks that span the mark, so repeatedly reading a pane's
 * recent tail costs the tail, not the buffer.
 *
 * @param chunks        the buffer, oldest first
 * @param heldChars     total length of `chunks` (a trim decrements it)
 * @param receivedChars everything ever received, never decremented
 * @param mark          a previous `receivedChars` value
 */
export function sliceSince(
  chunks: readonly string[],
  heldChars: number,
  receivedChars: number,
  mark: number,
): string {
  // Chunk eviction can have carried the mark off the front; the oldest char the
  // buffer still holds is the furthest back this can honestly answer.
  const oldestHeld = receivedChars - heldChars;
  const wanted = receivedChars - Math.max(mark, oldestHeld);
  if (wanted <= 0) return '';
  const tail: string[] = [];
  let held = 0;
  for (let i = chunks.length - 1; i >= 0 && held < wanted; i--) {
    const chunk = chunks[i];
    tail.push(chunk);
    held += chunk.length;
  }
  const joined = tail.reverse().join('');
  return held > wanted ? joined.slice(held - wanted) : joined;
}
