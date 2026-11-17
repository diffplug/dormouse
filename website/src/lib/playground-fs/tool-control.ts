/**
 * The desktop playground's `toolControl` (docs/specs/tutorial.md -> Playground
 * filesystem): a host whose user `dormouse.yml` is inert, so every target
 * opens with a built-in, resolved as the hosts resolve one.
 */
import { builtinHandler } from "dor-tools-builtin/file-viewer-format";
import { defaultBrowserViewportConfig } from "dor-lib-common/browser-viewports";
import type { IframeProxyResult } from "dormouse-lib/lib/platform/iframe-proxy-types";
import type { ToolControlResult, ToolHostRequest } from "dormouse-lib/lib/platform/tool-types";
import { builtinOpenResult, noUserToolMessage, offerBuiltins } from "dormouse-lib/lib/tool-open-builtin";
import { isLoopbackHostname } from "dormouse-lib/lib/ip-literal";
import { USER_CONFIG, type VirtualFs } from "./vfs";
import { VIEWER_SCOPE } from "./viewers";
import { YOUTUBE_MUSIC_VIDEO, youtubeEmbedUrl } from "../youtube";

export function playgroundToolControl(fs: VirtualFs) {
  /** `input` as an existing snapshot path and its built-in candidates, or the host's error. */
  function target(input: string, cwd: string) {
    const path = fs.resolve(cwd, input);
    if (path === null) return new Error("expected a local path or file: URL, not another URL or a Surface handle");
    const kind = fs.kind(path);
    if (!kind) return new Error(`no such file or folder: ${input}`);
    const candidates = new Map<string, string>();
    offerBuiltins(candidates, path, kind === "dir");
    return { path, directory: kind === "dir", candidates };
  }

  return async (request: ToolHostRequest): Promise<ToolControlResult> => {
    switch (request.op) {
      case "open": {
        const resolved = target(request.target, request.cwd);
        if (resolved instanceof Error) return { status: "error", message: resolved.message };
        const name = request.tool ?? resolved.candidates.keys().next().value;
        return builtinOpenResult(request, name, resolved.path, resolved.directory, USER_CONFIG, [])
          ?? { status: "error", message: noUserToolMessage(request, USER_CONFIG) };
      }
      case "open-handlers": {
        const resolved = target(request.target, request.cwd);
        if (resolved instanceof Error) throw resolved;
        const handlers = [...resolved.candidates].map(([tool, reason]) => ({
          tool, description: builtinHandler("tool", tool)!.describe(resolved.path), reason,
        }));
        return { status: "open-handlers", handlers: { handlers, config: USER_CONFIG } };
      }
      case "lookup":
        return { status: "no-file" };
      case "browser-config":
        return { status: "browser-config", config: defaultBrowserViewportConfig() };
      default:
        return { status: "error", message: "the playground has no Tool files" };
    }
  };
}

/** Fronts the playground's own viewers and frames the music video embed
 * unproxied: `useToolServing` frames an announced port at its listener's
 * loopback address, and the page that answers is this origin's
 * `/playground-fs/` service worker. Every other page is refused, since nothing
 * here can proxy it. */
export async function playgroundIframeUrl(targetUrl: string): Promise<IframeProxyResult> {
  const url = new URL(targetUrl);
  if (url.href === youtubeEmbedUrl(YOUTUBE_MUSIC_VIDEO)) return { ok: true, url: url.href };
  return isLoopbackHostname(url.hostname) && url.pathname.startsWith(VIEWER_SCOPE)
    ? { ok: true, url: `${location.origin}${url.pathname}${url.search}${url.hash}` }
    : { ok: false, reason: "scheme", detail: "the playground frames only its own file viewers and the music video" };
}
