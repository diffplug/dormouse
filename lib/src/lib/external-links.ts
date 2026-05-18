const BLOCKED_EXTERNAL_URI_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:', 'about:']);

export type ExternalUriDecision =
  | {
    status: 'openable';
    rawUri: string;
    uri: string;
    scheme: string;
    displayUri: string;
  }
  | {
    status: 'blocked';
    rawUri: string;
    scheme: string | null;
    displayUri: string;
    reason: string;
  };

export function inspectExternalUri(input: string): ExternalUriDecision {
  const trimmed = input.trim();
  if (!trimmed) {
    return blocked(input, trimmed, null, 'No URL was provided.');
  }

  if (/[\x00-\x1f\x7f-\x9f]/.test(trimmed)) {
    return blocked(input, trimmed, null, 'The URL contains control characters.');
  }

  try {
    const uri = new URL(trimmed);
    const scheme = uri.protocol.slice(0, -1);
    if (BLOCKED_EXTERNAL_URI_PROTOCOLS.has(uri.protocol)) {
      return blocked(input, trimmed, scheme, `${scheme}: URLs cannot be opened from terminal output.`);
    }
    return {
      status: 'openable',
      rawUri: input,
      uri: uri.href,
      scheme,
      displayUri: trimmed,
    };
  } catch {
    return blocked(input, trimmed, null, 'The URL is not valid.');
  }
}

export function normalizeExternalUri(input: string): string | null {
  const decision = inspectExternalUri(input);
  return decision.status === 'openable' ? decision.uri : null;
}

function blocked(
  rawUri: string,
  displayUri: string,
  scheme: string | null,
  reason: string,
): ExternalUriDecision {
  return {
    status: 'blocked',
    rawUri,
    scheme,
    displayUri,
    reason,
  };
}
