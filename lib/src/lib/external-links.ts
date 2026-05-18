const ALLOWED_EXTERNAL_URI_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function normalizeExternalUri(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /[\x00-\x1f\x7f-\x9f]/.test(trimmed)) return null;

  try {
    const uri = new URL(trimmed);
    return ALLOWED_EXTERNAL_URI_PROTOCOLS.has(uri.protocol) ? uri.href : null;
  } catch {
    return null;
  }
}
