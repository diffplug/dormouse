import type { IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** This listener owns its URLs: a per-process 256-bit capability authorizes
 * each read. Host and Origin checks also reject rebinding and foreign scripts.
 * See docs/specs/security-local.md -> Local-file viewer. The Host/Origin rule is
 * the one `lib/src/host/loopback-guard.ts` states for every loopback listener;
 * `dor` cannot import `lib`, so it is restated here with case-insensitive Host comparison. */
export function allowsFileViewerRequest(req: IncomingMessage, port: number, prefix: string): boolean {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return (req.method === 'GET' || req.method === 'HEAD')
    && origins.includes(`http://${(req.headers.host ?? '').toLowerCase()}`)
    && (!req.headers.origin || origins.includes(req.headers.origin))
    // Hash both sides so malformed lengths cannot make timingSafeEqual throw.
    && timingSafeEqual(sha256(req.url?.slice(0, prefix.length) ?? ''), sha256(prefix));
}
