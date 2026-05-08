import type { ActivityNotification, SessionStatus, TodoState } from '../../lib/src/lib/alert-manager';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';

// Messages from webview → extension host
export type WebviewMessage =
  | { type: 'pty:spawn'; id: string; options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] } }
  | { type: 'pty:input'; id: string; data: string }
  | { type: 'pty:resize'; id: string; cols: number; rows: number }
  | { type: 'pty:kill'; id: string }
  | { type: 'pty:getCwd'; id: string; requestId?: string }
  | { type: 'pty:getScrollback'; id: string; requestId?: string }
  | { type: 'pty:getShells'; requestId?: string }
  | { type: 'clipboard:readFiles'; requestId: string }
  | { type: 'clipboard:readImage'; requestId: string }
  | { type: 'mouseterm:init' }
  | { type: 'mouseterm:saveState'; state: unknown }
  | { type: 'mouseterm:flushSessionSaveDone'; requestId: string }
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
  | { type: 'pty:scrollback'; id: string; data: string | null; requestId?: string }
  | { type: 'pty:shells'; shells: Array<{ name: string; path: string; args: string[] }>; requestId?: string }
  | { type: 'clipboard:files'; paths: string[] | null; requestId: string }
  | { type: 'clipboard:image'; path: string | null; requestId: string }
  | { type: 'mouseterm:newTerminal'; shell?: string; args?: string[] }
  | { type: 'mouseterm:selectedShell'; shell?: string; args?: string[] }
  | { type: 'mouseterm:openThemeDebugger' }
  | { type: 'mouseterm:flushSessionSave'; requestId: string }
  // Alert state updates
  | {
    type: 'alert:state';
    id: string;
    status: SessionStatus;
    todo: TodoState;
    notification: ActivityNotification | null;
    attentionDismissedRing: boolean;
  };
