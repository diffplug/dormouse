import { createContext } from 'react';

/**
 * True when the surrounding UI is the touch-first mobile terminal, where
 * keyboard shortcut hints (e.g. on the copy editor) are not shown. Defaults to
 * false for the desktop UI.
 */
export const TouchUiContext = createContext(false);
