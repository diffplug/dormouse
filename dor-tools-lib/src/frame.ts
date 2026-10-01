/**
 * The Tool side of the iframe save channel (`./protocol.ts`): a framed page
 * reports its dirty state to the host and saves when the host's close prompt
 * asks. Outside a frame, or before a host connects, reports go nowhere.
 */

import { readHostMessage, type FrameMessage } from './protocol.js';

export interface ToolFrameOptions {
  /** The document's dirty state, or undefined while it is still loading. */
  dirty(): boolean | undefined;
  /** Writes the document. The host's Save closes the Tool only once this
   * resolves and `dirty()` is false. */
  save(): Promise<void>;
}

export interface ToolFrame {
  /** Reports `dirty()` at once; call it on every change. */
  report(): void;
  /** Stops answering the host. */
  close(): void;
}

type Unaddressed<T> = T extends unknown ? Omit<T, 'dorTool' | 'connection'> : never;

/** Answers the host that frames `scope`. A later `connect`, as after a reload,
 * replaces the earlier connection. */
export function connectToolFrame({ dirty, save }: ToolFrameOptions, scope: Window = window): ToolFrame {
  let host: { origin: string; connection: string } | null = null;
  const post = (message: Unaddressed<FrameMessage>) => {
    if (host) scope.parent.postMessage({ dorTool: 1, connection: host.connection, ...message }, host.origin);
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== scope.parent || scope.parent === scope) return;
    const message = readHostMessage(event.data);
    if (!message) return;
    if (message.kind === 'connect') {
      host = { origin: event.origin, connection: message.connection };
      const state = dirty();
      if (state !== undefined) post({ kind: 'ready', dirty: state });
      return;
    }
    if (!host || event.origin !== host.origin || message.connection !== host.connection || dirty() === undefined) return;
    const { request } = message;
    save().then(
      () => post({ kind: 'saved', request, dirty: dirty() ?? true }),
      reason => post({ kind: 'saved', request, error: reason instanceof Error ? reason.message : String(reason), dirty: dirty() ?? true }),
    );
  };
  scope.addEventListener('message', receive);
  return {
    report() {
      const state = dirty();
      if (state !== undefined) post({ kind: 'state', dirty: state });
    },
    close() {
      scope.removeEventListener('message', receive);
      host = null;
    },
  };
}
