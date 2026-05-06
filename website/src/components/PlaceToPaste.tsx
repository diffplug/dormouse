import { useRef, useState } from "react";

interface PlaceToPasteProps {
  onClose: () => void;
}

const INITIAL = { x: 360, y: 140, w: 420, h: 280 };

export function PlaceToPaste({ onClose }: PlaceToPasteProps) {
  const [pos, setPos] = useState({ x: INITIAL.x, y: INITIAL.y });
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);

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

  return (
    <div
      role="dialog"
      aria-label="Place To Paste"
      className="fixed flex flex-col overflow-hidden border border-[var(--vscode-widget-border,_#454545)] bg-[var(--vscode-editor-background,_#1e1e1e)] text-[var(--vscode-editor-foreground,_#d4d4d4)] shadow-lg"
      style={{
        left: pos.x,
        top: pos.y,
        width: INITIAL.w,
        height: INITIAL.h,
        resize: "both",
        zIndex: 50,
      }}
    >
      <div
        className="flex flex-none cursor-move items-center justify-between border-b border-[var(--vscode-widget-border,_#454545)] bg-[var(--vscode-titleBar-activeBackground,_#3c3c3c)] px-2 py-1 text-xs select-none"
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
        className="flex-1 resize-none bg-transparent p-2 font-mono text-xs outline-none"
        placeholder="Paste here, then drag the bottom-right corner to resize and watch the text reflow (or not)."
        spellCheck={false}
      />
    </div>
  );
}
