import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  DESKTOP_PLAYGROUND_PATH,
  POCKET_PLAYGROUND_PATH,
  usePreferredPlayground,
} from "../lib/playground-routing";

export { PlaygroundRedirect as Component };

function PlaygroundRedirect() {
  const navigate = useNavigate();
  const preferred = usePreferredPlayground();

  useEffect(() => {
    if (preferred === null) return;
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
  }, [navigate, preferred]);

  return (
    <main className="fixed inset-0 bg-[var(--color-bg)] text-[var(--color-text)]" />
  );
}
