import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OpenHandler } from 'dor/commands/types';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { ExternalLinkModal } from './ExternalLinkModal';
import {
  clearExternalLinkConfirmation,
  getExternalLinkConfirmationSnapshot,
  subscribeExternalLinkConfirmation,
  type PendingExternalLink,
} from '../lib/external-link-confirmation';
import { getPlatform } from '../lib/platform';
import { dispatchDorControlRequest } from '../lib/platform/dor-control-dispatch';
import { useDialogKeyboardOwner } from './wall/wall-context';
import { wallHandleOwning } from './wall/wall-handles';

export function ExternalLinkModalHost() {
  const pending = useSyncExternalStore(
    subscribeExternalLinkConfirmation,
    getExternalLinkConfirmationSnapshot,
  );
  useDialogKeyboardOwner(pending !== null);
  // Each click owns its lookup, selection and launch result, even for the same URL.
  return pending ? <PendingLinkDialog key={pending.id} request={pending} /> : null;
}

function PendingLinkDialog({ request }: { request: PendingExternalLink }) {
  const [handlers, setHandlers] = useState<OpenHandler[]>([]);
  const [selectedTool, setSelectedTool] = useState('');
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const submitting = useRef(false);
  const openable = request.decision.status === 'openable' && request.verdict !== 'deceptive';
  const file = openable && request.decision.scheme === 'file';
  const [loading, setLoading] = useState(file);

  useEffect(() => {
    if (!file) return;
    let active = true;
    const lookup = async () => {
      try {
        const platform = getPlatform();
        if (!platform.toolControl) throw new Error('This host cannot open local files.');
        if (!request.source?.cwd) throw new Error('The originating terminal or file directory is unavailable.');
        const result = await platform.toolControl({ op: 'open-handlers', target: request.uri, cwd: request.source.cwd });
        if (!active) return;
        if (result.status !== 'open-handlers') throw new Error(result.status === 'error' ? result.message : 'Could not load file viewers.');
        setHandlers(result.handlers.handlers);
      } catch (err) {
        if (active) setError(errorMessage(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    void lookup();
    return () => { active = false; };
  }, [request, file]);

  const confirm = () => {
    if (getExternalLinkConfirmationSnapshot() !== request || !openable || submitting.current || loading) return;
    setError(undefined);
    try {
      if (request.decision.status !== 'openable') return;
      if (!file) {
        const platform = getPlatform();
        if (!platform.openExternal) throw new Error('This host cannot open external links.');
        platform.openExternal(request.decision.uri);
        clearExternalLinkConfirmation();
        return;
      }
      if (!getPlatform().toolControl) throw new Error('This host cannot open local files.');
      if (!request.source?.cwd) throw new Error('The originating terminal or file directory is unavailable.');
      if (!wallHandleOwning(request.source.surfaceId)) throw new Error('The originating terminal is no longer available.');
      submitting.current = true;
      setOpening(true);
      dispatchDorControlRequest({
        requestId: `confirmed-link-${crypto.randomUUID()}`,
        surfaceId: request.source.surfaceId,
        method: SURFACE_CONTROL_METHODS.tool,
        params: { file: request.decision.uri, surface: request.source.surfaceId, cwd: request.source.cwd, ...(selectedTool ? { tool: selectedTool } : {}) },
      }, response => {
        // A cancelled or replaced dialog cannot be reopened or dismissed by an old reply.
        if (getExternalLinkConfirmationSnapshot() !== request) return;
        submitting.current = false;
        setOpening(false);
        if (response.ok) clearExternalLinkConfirmation();
        else setError(response.error);
      });
    } catch (err) {
      submitting.current = false;
      setOpening(false);
      setError(errorMessage(err));
    }
  };

  return (
    <ExternalLinkModal
      request={request}
      onCancel={clearExternalLinkConfirmation}
      onConfirm={confirm}
      handlers={handlers}
      selectedTool={selectedTool}
      onSelectTool={setSelectedTool}
      busy={loading || opening}
      error={error}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
