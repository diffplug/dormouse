// cross-spawn ships no types. Declare the single call shape we use; with
// @types/node present, ChildProcess/SpawnOptions are the real Node types, so
// this stays internal to dor-lib-common and never leaks into the public surface.
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';
  export default function spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;
}
