import type { ActivityNotification, SessionStatus, TodoState } from '../../lib/src/lib/alert-manager';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';
import type { DorControlRequestPayload, DorControlResponsePayload } from '../../dor/src/protocol';
import type { OpenPort } from '../../lib/src/lib/platform/types';
import type { VSCodeWorkbenchCommand } from '../../lib/src/lib/vscode-keybindings';

// Messages from webview → extension host
export type WebviewMessage =
  | { type: 'pty:spawn'; id: string; options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] } }
  | { type: 'pty:input'; id: string; data: string }
  | { type: 'pty:resize'; id: string; cols: number; rows: number }
  | { type: 'pty:kill'; id: string }
  | { type: 'pty:getCwd'; id: string; requestId?: string }
  | { type: 'pty:getOpenPorts'; id: string; requestId?: string }
  | { type: 'pty:getScrollback'; id: string; requestId?: string }
  | { type: 'pty:getShells'; requestId?: string }
  | { type: 'clipboard:readFiles'; requestId: string }
  | { type: 'clipboard:readImage'; requestId: string }
  | { type: 'dormouse:openExternal'; uri: string }
  | { type: 'dormouse:runWorkbenchCommand'; command: VSCodeWorkbenchCommand }
  | { type: 'agentBrowser:command'; session: string; args: string[]; binaryPath?: string; requestId: string }
  | { type: 'agentBrowser:getStreamUrl'; port: number; requestId: string }
  | { type: 'dormouse:init' }
  | { type: 'dormouse:saveState'; state: unknown }
  | { type: 'dormouse:flushSessionSaveDone'; requestId: string }
  | ({ type: 'dor:controlResponse' } & DorControlResponsePayload)
  // Alert actions
  | { type: 'alert:remove'; id: string }
  | { type: 'alert:toggle'; id: string }
  | { type: 'alert:disable'; id: string }
  | { type: 'alert:dismiss'; id: string }
  | { type: 'alert:dismissOrToggle'; id: string; displayedStatus: string }
  | { type: 'alert:attend'; id: string }
  | { type: 'alert:resize'; id: string }
  | { type: 'alert:clearAttention'; id?: string }
  | { type: 'alert:toggleTodo'; id: string }
  | { type: 'alert:markTodo'; id: string }
  | { type: 'alert:clearTodo'; id: string };

export interface PtyInfo {
  id: string;
  alive: boolean;
  exitCode?: number;
}

// Messages from extension host → webview
export type ExtensionMessage =
  | { type: 'pty:data'; id: string; data: string }
  | { type: 'pty:exit'; id: string; exitCode: number }
  | { type: 'terminal:semanticEvents'; id: string; events: TerminalSemanticEvent[] }
  | { type: 'pty:list'; ptys: PtyInfo[] }
  | { type: 'pty:replay'; id: string; data: string }
  | { type: 'pty:cwd'; id: string; cwd: string | null; requestId?: string }
  | { type: 'pty:openPorts'; id: string; ports: OpenPort[]; requestId?: string }
  | { type: 'pty:scrollback'; id: string; data: string | null; requestId?: string }
  | { type: 'pty:shells'; shells: Array<{ name: string; path: string; args: string[] }>; requestId?: string }
  | { type: 'clipboard:files'; paths: string[] | null; requestId: string }
  | { type: 'clipboard:image'; path: string | null; requestId: string }
  | { type: 'agentBrowser:commandResult'; requestId: string; exitCode: number; stdout: string; stderr: string }
  | { type: 'agentBrowser:streamUrl'; requestId: string; url: string | null }
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
  // Alert state updates
  | {
    type: 'alert:state';
    id: string;
    status: SessionStatus;
    watchingEnabled: boolean;
    todo: TodoState;
    notification: ActivityNotification | null;
    attentionDismissedRing: boolean;
  };
