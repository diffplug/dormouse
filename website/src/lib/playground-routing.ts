import { useEffect, useState } from "react";

export const DESKTOP_PLAYGROUND_PATH = "/playground/desktop";
export const POCKET_PLAYGROUND_PATH = "/playground/pocket";

export type PreferredPlayground = "desktop" | "pocket";

const POCKET_PLAYGROUND_QUERY = "(max-width: 767px), (pointer: coarse)";

function getPreferredPlayground(): PreferredPlayground {
  if (typeof window === "undefined") return "desktop";
  return window.matchMedia(POCKET_PLAYGROUND_QUERY).matches ? "pocket" : "desktop";
}

export function usePreferredPlayground() {
  const [preferred, setPreferred] = useState<PreferredPlayground | null>(null);

  useEffect(() => {
    const media = window.matchMedia(POCKET_PLAYGROUND_QUERY);
    const update = () => setPreferred(getPreferredPlayground());
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return preferred;
}
