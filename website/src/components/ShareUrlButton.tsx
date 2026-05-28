import { useEffect, useRef, useState } from "react";
import { ShareIcon } from "@phosphor-icons/react";

interface ShareUrlButtonProps {
  path?: string;
  title: string;
  children?: React.ReactNode;
}

export function ShareUrlButton({ path, title, children }: ShareUrlButtonProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  async function handleShare() {
    const url = path
      ? new URL(`${path}${window.location.search}${window.location.hash}`, window.location.origin).href
      : window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ url, title });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      window.prompt("Copy this URL to your phone:", url);
    }
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label={`Share ${title}`}
      className="inline-flex items-center gap-1 align-[-0.2em] rounded text-[var(--color-text)]/90 transition duration-150 hover:scale-120 hover:text-[var(--color-text)]"
    >
      <ShareIcon size={22} weight="bold" />
      {children}
      {copied && <span className="text-sm">copied!</span>}
    </button>
  );
}
