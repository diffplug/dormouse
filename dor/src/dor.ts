#!/usr/bin/env node

import { runCli } from './cli.js';
import { runFileViewer } from './file-viewer.js';

type ProcessLike = {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  stdin: {
    setEncoding?(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    resume?(): void;
  };
};

declare const process: ProcessLike;

const execution = process.argv[2] === '__view-file' && process.argv.length === 4
  ? runFileViewer(process.argv[3]).then(() => ({ stdout: '', stderr: '', exitCode: 0 }))
  : runCli(process.argv.slice(2), { env: process.env, readStdin });
execution.then(
  (result) => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  },
  (error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding?.('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
    process.stdin.resume?.();
  });
}
