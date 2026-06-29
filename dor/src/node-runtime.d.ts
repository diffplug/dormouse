declare module 'node:net' {
  export interface Socket {
    setEncoding(encoding: string): this;
    write(data: string): boolean;
    destroy(): this;
    on(event: 'connect', listener: () => void): this;
    on(event: 'data', listener: (chunk: string) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'end', listener: () => void): this;
  }

  export function createConnection(options: { path: string }): Socket;
}

declare module 'node:child_process' {
  export function execFileSync(command: string, args: readonly string[], options: {
    encoding: 'utf8';
    timeout?: number;
  }): string;

  export interface ChildProcessStream {
    on(event: 'data', listener: (chunk: unknown) => void): void;
  }

  export interface ChildProcess {
    stdout: ChildProcessStream;
    stderr: ChildProcessStream;
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
  }

  export function spawn(command: string, args: readonly string[], options: {
    stdio: readonly ['ignore', 'pipe', 'pipe'];
  }): ChildProcess;
}

// cross-spawn ships no types and dor avoids @types/node, so declare the one call
// shape we use. Drop-in for the node:child_process spawn above; returns the same
// minimal ChildProcess.
declare module 'cross-spawn' {
  import type { ChildProcess } from 'node:child_process';
  export default function spawn(command: string, args: readonly string[], options: {
    stdio: readonly ['ignore', 'pipe', 'pipe'];
  }): ChildProcess;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string;
}

declare const process: {
  platform: string;
  ppid: number;
  cwd(): string;
};

declare function setTimeout(callback: () => void, ms?: number): number;
declare function clearTimeout(timeoutId: number): void;
