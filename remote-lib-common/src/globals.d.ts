// Globals every runtime this package targets provides, but neither the DOM nor
// the Node typings it deliberately omits (`"lib": ["ES2022"]`, `"types": []`)
// declares. Declared here so each module can reference this single declaration
// instead of duplicating it, naming only the members actually used.
declare const URL: {
  new (input: string): {
    readonly origin: string;
    readonly protocol: string;
    readonly username: string;
    readonly password: string;
    readonly hostname: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
  };
};

declare const TextEncoder: {
  new (): { encode(input: string): Uint8Array };
};
declare const TextDecoder: {
  new (label: 'utf-8', options: { fatal: true; ignoreBOM: true }): {
    decode(input: Uint8Array): string;
  };
};
