#!/usr/bin/env node

import { runCli } from './cli.js';

runCli(process.argv.slice(2), { env: process.env, readStdin }).then(
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
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(String(chunk)));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}
