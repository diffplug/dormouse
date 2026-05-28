import { createContext } from 'react';

/**
 * True when the surrounding UI is the touch-first mobile terminal, where there is
 * no physical keyboard — so keyboard shortcut hints (e.g. on the selection popup)
 * should be omitted. Defaults to false for the desktop UI.
 */
export const TouchUiContext = createContext(false);
