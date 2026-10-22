import type { ThemePaintProfile } from "dormouse-lib/lib/themes";

/** How the app paints, for its shell's boot tag: no default of its own, so a
 *  first launch takes the first bundled theme, as `restoreActiveTheme` does. */
export const STANDALONE_PAINT_PROFILE: ThemePaintProfile = {};
