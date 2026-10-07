import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { chromeButton, TabWallJoin } from "dormouse-lib/components/design";
import { WorkspaceStrip } from "dormouse-lib/components/WorkspaceStrip";

/** The playground title bar's Workspace strip and its join band, loaded with
 *  the rest of the playground's lib. */
export function PlaygroundTabs() {
  return (
    <>
      <WorkspaceStrip
        className="self-stretch"
        afterNew={
          // What a refresh always did, where a visitor looks for it.
          <button
            type="button"
            className={chromeButton({ kind: "labeled", class: "mb-0.5 shrink-0 text-muted hover:text-app-fg" })}
            title="Reset the playground to how it started"
            onClick={() => window.location.reload()}
          >
            <ArrowCounterClockwiseIcon size={12} weight="bold" aria-hidden="true" />
            Reset playground
          </button>
        }
      />
      <TabWallJoin />
    </>
  );
}
