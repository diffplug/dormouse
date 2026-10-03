#!/usr/bin/env node

import { runCli } from './cli.js';
import type { PickerTerminal } from './commands/types.js';

runCli(process.argv.slice(2), { env: process.env, readStdin, terminal: ttyTerminal() }).then(
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

/** The picker's terminal (`dor open` with no path), only when a person is at one. */
function ttyTerminal(): PickerTerminal | undefined {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  return {
    columns: () => stdout.columns || 80,
    rows: () => stdout.rows || 24,
    write: (text) => { stdout.write(text); },
    listen(onInput, onResize) {
      const input = (chunk: Buffer | string) => onInput(String(chunk));
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.on('data', input);
      stdin.resume();
      stdout.on('resize', onResize);
      return () => {
        stdin.off('data', input);
        stdout.off('resize', onResize);
        stdin.setRawMode(false);
        stdin.pause();
      };
    },
  };
}
