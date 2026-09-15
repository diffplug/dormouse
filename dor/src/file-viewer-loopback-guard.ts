import type { IncomingMessage } from 'node:http';

/** This listener owns its URLs: a per-process 256-bit capability authorizes
 * each read. Host and Origin checks also reject rebinding and foreign scripts.
 * See docs/specs/security-local.md -> Local-file viewer. */
export function allowsFileViewerRequest(req: IncomingMessage, port: number, prefix: string): boolean {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return (req.method === 'GET' || req.method === 'HEAD')
    && origins.includes(`http://${req.headers.host ?? ''}`)
    && (!req.headers.origin || origins.includes(req.headers.origin))
    && !!req.url?.startsWith(prefix);
}
