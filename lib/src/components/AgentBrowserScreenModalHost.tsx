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
 * ExternalLinkModalHost, titled with the Surface's id.
 */
export function AgentBrowserScreenModalHost() {
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
      label={id}
      onClose={closeAgentBrowserScreenModal}
    />
  );
}
