import type { HelperIdentity, TerminalContextRequest, TerminalContextInfo } from '../../lib/src/lib/terminal-context-types';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';
import type { TerminalColors, TerminalProtocolEvent } from '../../lib/src/lib/terminal-protocol';
import type { AlertCommand, AlertEvents } from '../../lib/src/host/alert-protocol';
import type { PersistedAlertState } from '../../lib/src/lib/session-types';
import type { DorControlCancelPayload, DorControlRequestPayload, DorControlResponsePayload } from '../../dor/src/protocol';
import type { AgentBrowserStreamStatusResult, IframeProxyResult, OpenPort, ToolControlResult, ToolHostRequest } from '../../lib/src/lib/platform/types';
import type { VSCodeWorkbenchCommand } from '../../lib/src/lib/vscode-keybindings';
import type { BurrowCommand, BurrowResult } from '../../lib/src/host/remote/service-protocol';
import type { VolatileNotepadSnapshot } from '../../lib/src/lib/notepad/types';

// Messages from webview → extension host
export type WebviewMessage =
  | { type: 'pty:context'; request: TerminalContextRequest; requestId: string }
  | { type: 'pty:spawn'; id: string; options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[]; helper?: HelperIdentity; alert?: PersistedAlertState } }
  | { type: 'pty:input'; id: string; data: string; paced?: boolean; userInput?: true }
  | { type: 'pty:resize'; id: string; cols: number; rows: number }
  | { type: 'pty:kill'; id: string }
  | { type: 'pty:getCwd'; id: string; requestId?: string }
  | { type: 'pty:getOpenPorts'; id: string; requestId?: string }
  | { type: 'pty:getShells'; requestId?: string }
  | { type: 'clipboard:readFiles'; requestId: string }
  | { type: 'clipboard:readImage'; requestId: string }
  | { type: 'dormouse:openExternal'; uri: string }
  | { type: 'dormouse:runWorkbenchCommand'; command: VSCodeWorkbenchCommand }
  | { type: 'agentBrowser:command'; session: string; args: string[]; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:edit'; session: string; op: 'selectAll' | 'copy' | 'cut'; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:screenshot'; session: string; format?: 'jpeg' | 'png'; quality?: number; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:streamStatus'; session: string; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:getStreamUrl'; port: number; requestId: string }
  | { type: 'agentBrowser:open'; url: string; headed?: boolean; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:popOut'; session: string; url?: string; rect?: { x: number; y: number; width: number; height: number }; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:popIn'; session: string; url?: string; binaryPath?: string; requestId: string }
  | { type: 'iframe:createProxyUrl'; url: string; embedderOrigins: string[]; requestId: string }
  | { type: 'tool:control'; request: ToolHostRequest; requestId: string }
  // Peer surfaces: the Burrow runs in the extension host, but the terminals
  // live in whichever webview opened them. See docs/specs/vscode.md → "Peer
  // surfaces". `op` is opaque to the router: the operation map lives in
  // `lib/src/remote/burrow/peer-surfaces.ts`, so a new peer operation adds no
  // message type here.
  | { type: 'peer:answer'; requestId: string; results: unknown[] }
  | { type: 'peer:notify' }
  // One command for the Burrow service (`lib/src/host/remote/service-protocol.ts`).
  | { type: 'burrow:command'; payload: BurrowCommand }
  // The notepad archive lives in shared storage, which only the extension host can
  // reach, so the webview drives it as compare-and-swap: `state` is the whole
  // serialized archive and `baseRevision` the token `notepad:load` handed back
  // (docs/specs/notepad.md). `notepad:volatile` is the live mirror — fire and
  // forget, since nothing waits on it and the next snapshot supersedes it.
  | { type: 'notepad:load'; requestId: string }
  | { type: 'notepad:save'; requestId: string; state: string; baseRevision: string | null }
  | { type: 'notepad:reset'; requestId: string }
  | { type: 'notepad:volatile'; snapshot: VolatileNotepadSnapshot }
  | { type: 'dormouse:init' }
  | ({ type: 'dormouse:themeColors' } & TerminalColors)
  | { type: 'dormouse:saveState'; state: unknown }
  | { type: 'dormouse:flushSessionSaveDone'; requestId: string }
  | ({ type: 'dor:controlResponse' } & DorControlResponsePayload)
  // Every alert verb, in the wire both hosts share (`lib/src/host/alert-protocol.ts`).
  | { type: 'alert:command'; command: AlertCommand };

export interface PtyInfo {
  helper?: HelperIdentity;
  id: string;
  alive: boolean;
  exitCode?: number;
  shell?: string;
}

// Messages from extension host → webview
export type ExtensionMessage =
  | { type: 'pty:contextResult'; result: TerminalContextInfo; requestId: string }
  // `textData` is the chunk with string-control payloads removed, for the
  // prompt heuristic. Omitted when it would equal `data` — the common case —
  // so this never doubles the bytes on the wire (docs/specs/transport.md).
  | { type: 'pty:data'; id: string; data: string; textData?: string }
  | { type: 'pty:exit'; id: string; exitCode: number }
  // A parse's Tool announcements, state and command-start resets, in stream order.
  | { type: 'terminal:toolEvents'; id: string; events: TerminalProtocolEvent[] }
  | { type: 'terminal:semanticEvents'; id: string; events: TerminalSemanticEvent[] }
  | { type: 'pty:list'; ptys: PtyInfo[] }
  | { type: 'pty:replay'; id: string; data: string }
  | { type: 'pty:cwd'; id: string; cwd: string | null; requestId?: string }
  | { type: 'pty:openPorts'; id: string; ports: OpenPort[]; requestId?: string }
  | { type: 'pty:shells'; shells: Array<{ name: string; path: string; args: string[] }>; requestId?: string }
  | { type: 'clipboard:files'; paths: string[] | null; requestId: string }
  | { type: 'clipboard:image'; path: string | null; requestId: string }
  | { type: 'agentBrowser:commandResult'; requestId: string; exitCode: number; stdout: string; stderr: string }
  | { type: 'agentBrowser:editResult'; requestId: string; ok: boolean; text?: string; error?: string }
  | { type: 'agentBrowser:screenshotResult'; requestId: string; ok: boolean; bytes?: Uint8Array; mime?: string; error?: string }
  | ({ type: 'agentBrowser:streamStatusResult'; requestId: string } & AgentBrowserStreamStatusResult)
  | { type: 'agentBrowser:streamUrl'; requestId: string; url: string | null }
  | { type: 'agentBrowser:openResult'; requestId: string; ok: boolean; session?: string; wsPort?: number; binaryPath?: string; error?: string }
  | { type: 'agentBrowser:popResult'; requestId: string; ok: boolean; wsPort?: number; error?: string }
  | { type: 'iframe:proxyUrl'; requestId: string; result: IframeProxyResult }
  | { type: 'tool:result'; requestId: string; result: ToolControlResult }
  | { type: 'peer:ask'; requestId: string; op: string; params: unknown }
  // Broadcast to every webview: `burrowRequestId` carries a per-adapter tag, so only the
  // one that asked finds a pending command to settle.
  | { type: 'burrow:result'; payload: BurrowResult }
  | { type: 'burrow:event'; payload: unknown }
  // One reply shape for all three archive requests: `result` carries whatever
  // that request returns, and a failure crosses as `ok: false` rather than
  // silence, because the webview's port turns it into the closure error path.
  | { type: 'notepad:result'; requestId: string; ok: boolean; result?: unknown; error?: string }
  | {
      type: 'dormouse:newTerminal';
      shell?: string;
      args?: string[];
      name?: string;
      replaceUntouched?: boolean;
      announce?: boolean;
    }
  | { type: 'dormouse:selectedShell'; shell?: string; args?: string[] }
  | { type: 'dormouse:openThemeDebugger' }
  | { type: 'dormouse:flushSessionSave'; requestId: string }
  | ({ type: 'dor:controlRequest' } & DorControlRequestPayload)
  | ({ type: 'dor:controlCancel' } & DorControlCancelPayload)
  // The alerts' events, named and shaped as in every host.
  | { [Event in keyof AlertEvents]: { type: Event } & AlertEvents[Event] }[keyof AlertEvents];
