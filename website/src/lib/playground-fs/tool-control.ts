/**
 * The desktop playground's `toolControl` (docs/specs/tutorial.md -> Playground
 * filesystem): `lib/src/host/tool-open.ts` with no user `dormouse.yml`, so
 * every target opens with the built-in its kind and format select.
 */
import { BUILTIN_HANDLERS, builtinHandler, defaultBuiltin, viewerTitle } from "dor-tools-builtin/file-viewer-format";
import { defaultBrowserViewportConfig } from "dor-lib-common/browser-viewports";
import type { IframeProxyResult } from "dormouse-lib/lib/platform/iframe-proxy-types";
import type { ToolControlResult, ToolHostRequest } from "dormouse-lib/lib/platform/tool-types";
import { HOME, type VirtualFs } from "./vfs";
import { VIEWER_SCOPE } from "./viewers";

/** Where a real host would look for open rules; the playground has none. */
const USER_CONFIG = `${HOME}/.config/dormouse/dormouse.yml`;

export function playgroundToolControl(fs: VirtualFs) {
  /** `input` as an existing snapshot path and its kind, or the host's error. */
  function target(input: string, cwd: string): { path: string; directory: boolean } | Error {
    const path = fs.resolve(cwd, input);
    if (path === null) return new Error("expected a local path or file: URL, not another URL or a Surface handle");
    const kind = fs.kind(path);
    return kind ? { path, directory: kind === "dir" } : new Error(`no such file or folder: ${input}`);
  }

  return async (request: ToolHostRequest): Promise<ToolControlResult> => {
    switch (request.op) {
      case "open": {
        const resolved = target(request.target, request.cwd);
        if (resolved instanceof Error) return { status: "error", message: resolved.message };
        const { path, directory } = resolved;
        const kind = directory ? "folder" : "file";
        const name = request.tool ?? BUILTIN_HANDLERS.find((handler) => handler.opens === kind && handler.offered(path))?.tool;
        const builtin = builtinHandler("tool", name);
        if (!builtin) {
          return { status: "error", message: request.tool
            ? `no user Tool '${request.tool}' in ${USER_CONFIG}`
            : `no Tool matches '${request.target}'; add an open rule to ${USER_CONFIG}, or use dor open --tool <name> <file>` };
        }
        if (builtin.opens !== kind) {
          return { status: "error", message: `${name} cannot open the ${kind} '${request.target}'; use ${defaultBuiltin(directory).tool}` };
        }
        if (!directory && !builtin.format(path)) {
          return { status: "error", message: `${name} does not support '${viewerTitle(path)}'; add an open rule to ${USER_CONFIG} naming a user Tool` };
        }
        return {
          status: "ok", projectRoot: request.cwd, path: "<built-in>", name: builtin.kind, scope: "builtin",
          run: ["dor", builtin.argv, path], key: [path], render: "iframe", port: "announced", warnings: [], target: path,
        };
      }
      case "open-handlers": {
        const resolved = target(request.target, request.cwd);
        if (resolved instanceof Error) throw resolved;
        const kind = resolved.directory ? "folder" : "file";
        const offered = BUILTIN_HANDLERS.filter((handler) => handler.opens === kind && handler.offered(resolved.path));
        return {
          status: "open-handlers",
          handlers: {
            handlers: offered.map((handler, index) => ({
              tool: handler.tool, description: handler.describe(resolved.path), reason: index ? "built-in" : "built-in; no open rule matches",
            })),
            config: USER_CONFIG,
          },
        };
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

/** Fronts only the playground's own viewers, which instrument themselves; any
 * other page is refused, since nothing here can proxy it. */
export async function playgroundIframeUrl(targetUrl: string): Promise<IframeProxyResult> {
  return targetUrl.startsWith(`${location.origin}${VIEWER_SCOPE}`)
    ? { ok: true, url: targetUrl }
    : { ok: false, reason: "scheme", detail: "the playground frames only its own file viewers" };
}
