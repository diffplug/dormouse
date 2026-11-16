import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ImageIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  TextBIcon,
  TextItalicIcon,
} from "@phosphor-icons/react";
import { GlbSpinner } from "./GlbSpinner";

/**
 * What `builtin:file`'s Markdown editor would show for a README that embeds a
 * `.glb` beside it, once the demo's agent has taught it to. A picture of the
 * editor, not the editor: the real one is a separate runtime bundle.
 */
export function DemoReadme({ modelUrl, spinning }: { modelUrl: string; spinning: boolean }) {
  const icon = { size: 15 } as const;
  return (
    <div className="flex h-full flex-col bg-[var(--vscode-editor-background)] text-[var(--vscode-editor-foreground)]">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-2.5 py-1.5 text-muted">
        <ArrowCounterClockwiseIcon {...icon} />
        <ArrowClockwiseIcon {...icon} />
        <span className="h-4 w-px bg-border" />
        <TextBIcon {...icon} />
        <TextItalicIcon {...icon} />
        <ListBulletsIcon {...icon} />
        <LinkSimpleIcon {...icon} />
        <ImageIcon {...icon} />
        <span className="ml-auto font-mono text-[0.65rem]">Saved</span>
      </div>
      <article className="min-h-0 flex-1 overflow-hidden px-4 py-3 text-[0.8rem] leading-relaxed">
        <h1 className="mb-1.5 text-xl font-semibold">Cheese Wedge</h1>
        <p className="mb-3 opacity-80">
          A tiny asset for the <strong>Dormouse</strong> pantry. Keep the model
          beside this README and link it like an image.
        </p>
        <figure className="mb-3 overflow-hidden rounded-md border border-border bg-black/20">
          <GlbSpinner src={modelUrl} spinning={spinning} label="A cheese wedge, turning" className="block aspect-[4/3] w-full" />
          <figcaption className="border-t border-border px-2 py-1 font-mono text-[0.65rem] text-muted">cheese.glb</figcaption>
        </figure>
        <h2 className="mb-1 text-base font-semibold">Usage</h2>
        <p className="opacity-80">
          <code className="rounded bg-black/25 px-1 font-mono text-[0.7rem]">![](cheese.glb)</code>{" "}
          renders in place, from this folder only.
        </p>
      </article>
    </div>
  );
}
