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
}

declare const process: {
  platform: string;
  ppid: number;
};

declare function setTimeout(callback: () => void, ms?: number): number;
declare function clearTimeout(timeoutId: number): void;
