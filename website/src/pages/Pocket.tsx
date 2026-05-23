import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { POCKET_PLAYGROUND_PATH } from "../lib/playground-routing";

export { Pocket as Component };

function Pocket() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(
      {
        pathname: POCKET_PLAYGROUND_PATH,
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
