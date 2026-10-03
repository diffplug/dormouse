/**
 * Whether anyone can see a Surface's pixels in this window — the one input
 * every resource rule for a hidden Surface reads (docs/specs/dor-browser.md →
 * "Resource Policy"). Pure: React hooks and hosts feed it what they observe.
 *
 * Sight is about the pane, not the Surface: a popped-out browser is seen in its
 * own window while its pane shows a stub, so headedness is its consumers'
 * business, not an input here. It reads the existing View states and never
 * defines new ones: `Doored`/`Hidden` arrive as `parked`, `Zoomed` over another
 * leaf as `covered` (docs/specs/glossary.md).
 */

export interface SurfaceSightInputs {
  /** The window — in VS Code, the webview — is shown, not backgrounded. */
  windowShown: boolean;
  /** The Surface's Workspace is the one on screen. */
  workspaceActive: boolean;
  /** Its leaf is parked: `Doored` or `Hidden`, its DOM kept, painting nothing. */
  parked: boolean;
  /** Another leaf is zoomed over it. */
  covered: boolean;
}

/** Why nobody sees a Surface, the first that applies in this order. */
export type UnseenReason = 'parked' | 'workspace' | 'window' | 'covered';

export function unseenReason(inputs: SurfaceSightInputs): UnseenReason | null {
  if (inputs.parked) return 'parked';
  if (!inputs.workspaceActive) return 'workspace';
  if (!inputs.windowShown) return 'window';
  if (inputs.covered) return 'covered';
  return null;
}

export function isSeen(inputs: SurfaceSightInputs): boolean {
  return unseenReason(inputs) === null;
}

/** Whether `zoomedId`, the Workspace's zoomed leaf, covers leaf `id`. */
export function coveredByZoom(id: string, zoomedId: string | null): boolean {
  return zoomedId !== null && zoomedId !== id;
}
