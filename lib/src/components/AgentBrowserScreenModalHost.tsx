import { useEffect } from 'react';
import { AgentBrowserScreenModal } from './wall/AgentBrowserScreenModal';
import {
  closeAgentBrowserScreenModal,
  useAgentBrowserScreenController,
  useOpenAgentBrowserScreenModalId,
} from './wall/agent-browser-screen';
import { useDialogKeyboardOwner } from './wall/wall-context';

/**
 * Mounts the agent-browser screen modal when a surface requests it, mirroring
 * ExternalLinkModalHost. `resolveLabel` turns a surface id into its display ref
 * (e.g. `surface:3`) for the title.
 */
export function AgentBrowserScreenModalHost({
  resolveLabel,
}: {
  resolveLabel: (surfaceId: string) => string;
}) {
  const id = useOpenAgentBrowserScreenModalId();
  const controller = useAgentBrowserScreenController(id ?? '');
  const open = id !== null && controller !== null;

  useDialogKeyboardOwner(open);

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
