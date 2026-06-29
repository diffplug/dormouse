import { useEffect } from 'react';
import { AgentBrowserScreenModal } from './wall/AgentBrowserScreenModal';
import {
  closeAgentBrowserScreenModal,
  useAgentBrowserScreenController,
  useOpenAgentBrowserScreenModalId,
} from './wall/agent-browser-screen';

/**
 * Mounts the agent-browser screen modal when a surface requests it, mirroring
 * ExternalLinkModalHost. `resolveLabel` turns a surface id into its display ref
 * (e.g. `surface:3`) for the title.
 */
export function AgentBrowserScreenModalHost({
  onKeyboardActiveChange,
  resolveLabel,
}: {
  onKeyboardActiveChange: (active: boolean) => void;
  resolveLabel: (surfaceId: string) => string;
}) {
  const id = useOpenAgentBrowserScreenModalId();
  const controller = useAgentBrowserScreenController(id ?? '');
  const open = id !== null && controller !== null;

  useEffect(() => {
    onKeyboardActiveChange(open);
    return () => onKeyboardActiveChange(false);
  }, [onKeyboardActiveChange, open]);

  // The surface was killed (or detached) while its modal was open — drop it.
  useEffect(() => {
    if (id !== null && controller === null) closeAgentBrowserScreenModal();
  }, [id, controller]);

  if (!id || !controller) return null;

  return (
    <AgentBrowserScreenModal
      controller={controller}
      label={resolveLabel(id)}
      onClose={closeAgentBrowserScreenModal}
    />
  );
}
