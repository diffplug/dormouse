#!/usr/bin/env node

import { runCli } from './cli.js';

type ProcessLike = {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare const process: ProcessLike;

runCli(process.argv.slice(2), { env: process.env }).then(
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
