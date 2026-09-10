/** Host-owned operations for the Playwright provider. No arbitrary code or CDP crosses this boundary. */
export type { BrowserAutomationProvider } from 'dor/commands/types';
export type PlaywrightRequest = { binaryPath?: string; cwd?: string } & (
  | { op: 'open'; url: string; headed?: boolean }
  | { op: 'streamUrl'; port: number }
  | { op: 'command'; session: string; args: string[] }
  | { op: 'edit'; session: string; edit: 'selectAll' | 'copy' | 'cut' }
  | { op: 'screenshot'; session: string; format?: 'jpeg' | 'png'; quality?: number }
  | { op: 'streamStatus'; session: string }
  | { op: 'popOut' | 'popIn'; session: string; url?: string }
);
export interface PlaywrightResult {
  headed?: boolean;
  nativeIdentity?: string;
  ok: boolean;
  error?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  text?: string;
  session?: string;
  cwd?: string;
  binaryPath?: string;
  wsPort?: number;
  url?: string;
  bytes?: Uint8Array;
  path?: string;
  mime?: string;
}
