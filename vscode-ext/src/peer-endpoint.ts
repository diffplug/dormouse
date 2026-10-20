/**
 * The two platform facts the peer link's arbitration turns on, in a module of
 * their own so `vscode-ext/test/peer-endpoint.test.ts` can run Windows'
 * published-endpoint arbitration over unix sockets. The contract lives in
 * `docs/specs/vscode.md` → "Burrow: a service in the extension host".
 */

import { randomBytes } from 'node:crypto';

/**
 * Whether the broker binds a fresh name per bind and publishes it in the
 * extension's storage, rather than binding one derived path. Windows only: its
 * named pipes live in one namespace every account can list and create in, so a
 * derived name could be created first by another account, while unix keeps its
 * derived path in a directory only this user can write.
 */
export function publishesEndpoint(): boolean {
  return process.platform === 'win32';
}

/** A pipe name nobody can predict: 128 CSPRNG bits, minted per bind. */
export function freshEndpointName(): string {
  return `\\\\.\\pipe\\dormouse-peer-${randomBytes(16).toString('hex')}`;
}
