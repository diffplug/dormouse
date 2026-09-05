import { useEffect } from "react";
import { useNavigate } from "react-router";
import {
  DESKTOP_PLAYGROUND_PATH,
  POCKET_PLAYGROUND_PATH,
  getPreferredPlayground,
} from "../lib/playground-routing";

export default function PlaygroundRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    // Routing reads the browser directly, never the hydration fallback.
    const preferred = getPreferredPlayground();
    navigate(
      {
        pathname: preferred === "pocket"
          ? POCKET_PLAYGROUND_PATH
          : DESKTOP_PLAYGROUND_PATH,
        search: window.location.search,
        hash: window.location.hash,
      },
      { replace: true },
    );
  }, [navigate]);

  return (
    <main className="fixed inset-0 bg-[var(--color-bg)] text-[var(--color-text)]" />
  );
}
