import type { IncomingMessage } from 'node:http';

/** This listener owns its URLs: a per-process 256-bit capability authorizes
 * each read. Host and Origin checks also reject rebinding and foreign scripts.
 * See docs/specs/security-local.md -> Local-file viewer. The Host/Origin rule is
 * the one `lib/src/host/loopback-guard.ts` states for every loopback listener;
 * `dor` cannot import `lib`, so it is restated here (exact-match, so a
 * mixed-case `Host` is refused rather than folded). */
export function allowsFileViewerRequest(req: IncomingMessage, port: number, prefix: string): boolean {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return (req.method === 'GET' || req.method === 'HEAD')
    && origins.includes(`http://${req.headers.host ?? ''}`)
    && (!req.headers.origin || origins.includes(req.headers.origin))
    && !!req.url?.startsWith(prefix);
}
