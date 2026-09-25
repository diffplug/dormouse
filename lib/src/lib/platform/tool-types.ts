/**
 * The `toolControl` wire shapes (`docs/specs/dor-tool.md`).
 *
 * Their own module, like `iframe-proxy-types.ts`: the webview, both adapters,
 * and the Node host all reference them, and the Node side must not drag
 * `lib/src/host` (and its `yaml` dependency) into a browser bundle.
 */

import type { BrowserViewportConfig, BrowserViewportSetting } from 'dor-lib-common/browser-viewports';

export type ToolHostRequest =
  | { op: 'open'; target: string; cwd: string; tool?: string }
  | { op: 'lookup'; name: string; cwd: string; args?: string[]; global?: boolean }
  | { op: 'trust'; kind: 'upstream' | 'folder'; projectRoot: string }
  | { op: 'browser-config'; cwd: string };

/** Which authority declared a Tool, namespacing its dedupe key and persisted
 *  `scope`. Project Tools carry none. `docs/specs/dor-tool.md` -> Identity and
 *  dedupe. */
export type ToolKeyScope = 'user' | 'builtin';
export const isToolKeyScope = (value: unknown): value is ToolKeyScope => value === 'user' || value === 'builtin';

/** Where a tool's browser renders once it serves. `iframe` frames the page;
 *  `agent-browser-screencast` drives a real browser, which is what makes a tool
 *  agent-drivable via `dor agent-browser --surface` (`docs/specs/dor-tool.md`). The repo
 *  declares it rather than the tool: which renderer suits a tool is a Dormouse-
 *  side judgement, not something the tool knows about itself. The only render
 *  modes a Tool Surface ever takes, so the Display modal and the Wall's swap
 *  consult it too. */
export type ToolRender = 'iframe' | 'agent-browser-screencast' | 'playwright-screencast';
export const TOOL_RENDERS: readonly ToolRender[] = ['iframe', 'agent-browser-screencast', 'playwright-screencast'];
export const isToolRender = (value: unknown): value is ToolRender => (TOOL_RENDERS as readonly unknown[]).includes(value);

/** Result of resolving a tool name. `ok` carries the rendered dedupe key: the
 *  host owns `$PROJECT_ROOT`, so the webview never sees a template.
 *
 *  The `ok` and `untrusted` arms carry the parsed file's `warnings`, so a
 *  config lint reaches the caller on the path it hits first — an untrusted
 *  repo's `pending` answer — and not only on a later already-trusted run
 *  (`docs/specs/dor-tool.md` -> Declaring tools). */
export type ToolLookupResult =
  | { status: 'no-file' }
  | { status: 'unknown-tool'; projectRoot: string; path: string; names: string[] }
  | {
      status: 'untrusted';
      projectRoot: string;
      path: string;
      name: string;
      run: string | readonly string[];
      /** Canonical upstream URL, or null when there is no resolvable remote. */
      upstreamUrl: string | null;
      warnings: string[];
    }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      projectRoot: string;
      path: string;
      name: string;
      run: string | readonly string[];
      /** Renderer for the tool's browser once it serves; 'iframe' by default. */
      render: ToolRender;
      viewport?: BrowserViewportSetting;
      scope?: ToolKeyScope;
      /** How to pick the port to frame absent an announcement; 'announced' by
       *  default, meaning nothing is framed without OSC 367. */
      port: 'announced' | 'auto';
      key: string[] | null;
      warnings: string[];
    };

export type ToolControlResult = ToolLookupResult | { status: 'trust-recorded' } | { status: 'browser-config'; config: BrowserViewportConfig };
