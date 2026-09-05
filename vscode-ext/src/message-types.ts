import type {
  AwaitOutcome,
  AwaitUntil,
} from '../../lib/src/lib/alert-manager';
import type { AlertSettings } from '../../lib/src/lib/alert-settings';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';
import type { TerminalColors } from '../../lib/src/lib/terminal-protocol';
import type { DorControlCancelPayload, DorControlRequestPayload, DorControlResponsePayload } from '../../dor/src/protocol';
import type { AgentBrowserStreamStatusResult, AlertStateDetail, IframeProxyResult, OpenPort } from '../../lib/src/lib/platform/types';
import type { VSCodeWorkbenchCommand } from '../../lib/src/lib/vscode-keybindings';
import type { BurrowCommand, BurrowResult } from '../../lib/src/host/remote/service-protocol';
import type { VolatileNotepadSnapshot } from '../../lib/src/lib/notepad/types';

// Messages from webview → extension host
export type WebviewMessage =
  | { type: 'pty:spawn'; id: string; options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] } }
  | { type: 'pty:input'; id: string; data: string }
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
  // Alert actions
  | { type: 'alert:remove'; id: string }
  | { type: 'alert:initializeWatchedCommands'; names: string[] }
  | { type: 'alert:setCommandWatched'; name: string; watched: boolean }
  | { type: 'alert:initializeSettings'; settings: AlertSettings }
  | { type: 'alert:updateSettings'; settings: AlertSettings }
  | { type: 'alert:dismiss'; id: string }
  | { type: 'alert:attend'; id: string }
  | { type: 'alert:resize'; id: string }
  | { type: 'alert:clearAttention'; id?: string }
  | { type: 'alert:toggleTodo'; id: string }
  | { type: 'alert:markTodo'; id: string }
  | { type: 'alert:clearTodo'; id: string }
  // `dor await`: the AlertManager lives here, so the wait is parked in the
  // extension host and only its outcome crosses back (docs/specs/alert.md → Await).
  | { type: 'alert:await'; requestId: string; id: string; until: AwaitUntil; timeoutMs: number }
  | { type: 'alert:awaitCancel'; requestId: string };

export interface PtyInfo {
  id: string;
  alive: boolean;
  exitCode?: number;
  shell?: string;
}

// Messages from extension host → webview
export type ExtensionMessage =
  // `textData` is the chunk with string-control payloads removed, for the
  // prompt heuristic. Omitted when it would equal `data` — the common case —
  // so this never doubles the bytes on the wire (docs/specs/transport.md).
  | { type: 'pty:data'; id: string; data: string; textData?: string }
  | { type: 'pty:exit'; id: string; exitCode: number }
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
  // Alert state updates. The whole `AlertState` crosses as one piece, so a new
  // alert field needs no edit here — the other three adapters already spread it.
  | ({ type: 'alert:state' } & AlertStateDetail)
  | { type: 'alert:awaitResult'; requestId: string; outcome: AwaitOutcome }
  | { type: 'alert:watchedCommands'; names: string[] }
  | { type: 'alert:settings'; settings: AlertSettings };
