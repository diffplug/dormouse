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

declare module 'node:crypto' {
  // Opaque stand-in for Buffer: this package ships without @types/node (see the
  // hand-written shims around it), and nothing here needs more than "the thing
  // digest() returns, which timingSafeEqual accepts".
  export interface BinaryDigest {
    readonly length: number;
  }

  export interface Hash {
    update(data: string): Hash;
    digest(): BinaryDigest;
    digest(encoding: 'hex'): string;
  }

  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: string): Hash;
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
  export function timingSafeEqual(a: BinaryDigest, b: BinaryDigest): boolean;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string;
}

declare const process: {
  platform: string;
  cwd(): string;
};

declare function setTimeout(callback: () => void, ms?: number): number;
declare function clearTimeout(timeoutId: number): void;
