import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

export const log = {
  init() {
    if (!channel) {
      channel = vscode.window.createOutputChannel('Dormouse');
    }
  },
  info(...args: unknown[]) {
    const msg = args.map(String).join(' ');
    channel?.appendLine(`[info] ${msg}`);
  },
  error(...args: unknown[]) {
    const msg = args.map(String).join(' ');
    channel?.appendLine(`[error] ${msg}`);
  },
};
