/** Correlates one local input batch with its receipt and optional cancellation. */
export async function deliverPtyInput(
  send: (inputId: string) => Promise<{ delivered?: boolean; error?: string } | null | undefined>,
  cancel: (inputId: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const cancelled = () => new Error('PTY input cancelled; some input may have been delivered');
  if (signal?.aborted) throw cancelled();
  const inputId = crypto.randomUUID();
  let cancellationSent = false;
  const cancelBatch = () => {
    if (cancellationSent) return;
    cancellationSent = true;
    try { cancel(inputId); } catch { /* A failed transport may already be gone. */ }
  };
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { cancelBatch(); reject(cancelled()); };
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.race([send(inputId).then(result => {
      if (!result?.delivered) throw new Error(result?.error ?? 'PTY input delivery was not acknowledged');
    }), interrupted]);
  } catch (error) {
    cancelBatch();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
