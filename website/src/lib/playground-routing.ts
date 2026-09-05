import { useSyncExternalStore } from "react";

export const DESKTOP_PLAYGROUND_PATH = "/playground/desktop";
export const POCKET_PLAYGROUND_PATH = "/playground/pocket";

export type PreferredPlayground = "desktop" | "pocket";

const POCKET_PLAYGROUND_QUERY = "(max-width: 700px), (pointer: coarse)";

export function getPreferredPlayground(): PreferredPlayground {
  if (typeof window === "undefined") return "desktop";
  return window.matchMedia(POCKET_PLAYGROUND_QUERY).matches ? "pocket" : "desktop";
}

function subscribeToPreferredPlayground(onChange: () => void): () => void {
  const media = window.matchMedia(POCKET_PLAYGROUND_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function usePreferredPlayground(): PreferredPlayground {
  return useSyncExternalStore(
    subscribeToPreferredPlayground,
    getPreferredPlayground,
    // Hydrate the desktop prerender before reconciling the browser's media.
    () => "desktop",
  );
}
