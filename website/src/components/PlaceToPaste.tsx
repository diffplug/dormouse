import { useRef, useState } from "react";

interface PlaceToPasteProps {
  onClose: () => void;
}

const INITIAL = { x: 360, y: 140, w: 420, h: 280 };
const MIN = { w: 240, h: 140 };

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_HANDLES: { dir: ResizeDir; cls: string; cursor: string }[] = [
  { dir: "n", cls: "top-0 left-0 right-0 h-1.5", cursor: "cursor-ns-resize" },
  { dir: "s", cls: "bottom-0 left-0 right-0 h-1.5", cursor: "cursor-ns-resize" },
  { dir: "w", cls: "top-0 bottom-0 left-0 w-1.5", cursor: "cursor-ew-resize" },
  { dir: "e", cls: "top-0 bottom-0 right-0 w-1.5", cursor: "cursor-ew-resize" },
  { dir: "nw", cls: "top-0 left-0 w-2.5 h-2.5", cursor: "cursor-nwse-resize" },
  { dir: "ne", cls: "top-0 right-0 w-2.5 h-2.5", cursor: "cursor-nesw-resize" },
  { dir: "sw", cls: "bottom-0 left-0 w-2.5 h-2.5", cursor: "cursor-nesw-resize" },
  { dir: "se", cls: "bottom-0 right-0 w-2.5 h-2.5", cursor: "cursor-nwse-resize" },
];

export function PlaceToPaste({ onClose }: PlaceToPasteProps) {
  const [pos, setPos] = useState({ x: INITIAL.x, y: INITIAL.y });
  const [size, setSize] = useState({ w: INITIAL.w, h: INITIAL.h });
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const resizeRef = useRef<
    | {
        dir: ResizeDir;
        mx: number;
        my: number;
        px: number;
        py: number;
        pw: number;
        ph: number;
      }
    | null
  >(null);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
  };

  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ x: d.px + e.clientX - d.mx, y: d.py + e.clientY - d.my });
  };

  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  const onResizeDown = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = {
      dir,
      mx: e.clientX,
      my: e.clientY,
      px: pos.x,
      py: pos.y,
      pw: size.w,
      ph: size.h,
    };
  };

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.mx;
    const dy = e.clientY - r.my;
    let x = r.px;
    let y = r.py;
    let w = r.pw;
    let h = r.ph;
    if (r.dir.includes("e")) w = r.pw + dx;
    if (r.dir.includes("w")) {
      w = r.pw - dx;
      x = r.px + dx;
    }
    if (r.dir.includes("s")) h = r.ph + dy;
    if (r.dir.includes("n")) {
      h = r.ph - dy;
      y = r.py + dy;
    }
    if (w < MIN.w) {
      if (r.dir.includes("w")) x = r.px + (r.pw - MIN.w);
      w = MIN.w;
    }
    if (h < MIN.h) {
      if (r.dir.includes("n")) y = r.py + (r.ph - MIN.h);
      h = MIN.h;
    }
    setPos({ x, y });
    setSize({ w, h });
  };

  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    resizeRef.current = null;
  };

  return (
    <div
      role="dialog"
      aria-label="Place To Paste"
      className="fixed flex flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-terminal-bg)] text-[var(--color-terminal-fg)] shadow-lg"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        zIndex: 50,
      }}
    >
      <div
        className="flex flex-none cursor-move items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-header-active-bg)] px-2 py-1 text-[var(--color-header-active-fg)] select-none"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="pointer-events-none">Place To Paste</span>
        <button
          type="button"
          className="cursor-pointer px-1 leading-none hover:opacity-70"
          onClick={onClose}
          aria-label="Close Place To Paste"
        >
          ×
        </button>
      </div>
      <textarea
        className="flex-1 resize-none bg-transparent p-2 font-mono outline-none"
        placeholder="Paste here, then drag any edge or corner to resize and watch the text reflow (or not)."
        spellCheck={false}
      />
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.dir}
          className={`absolute ${h.cls} ${h.cursor}`}
          onPointerDown={onResizeDown(h.dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      ))}
    </div>
  );
}
