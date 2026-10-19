// cross-spawn ships no types. Declare the single call shape we use; with
// @types/node present, ChildProcess/SpawnOptions are the real Node types.
// `spawn.ts` references this file, so it enters every program that compiles
// that module from source; the emitted `.d.ts` still names no cross-spawn type.
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';
  export default function spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;
}
