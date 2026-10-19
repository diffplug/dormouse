import { IS_MAC, IS_WINDOWS } from "dormouse-lib/lib/platform";

/** The adapters' native clipboard write, through the host's
 *  `write_clipboard_text`: on macOS and Windows only. Linux keeps the
 *  browser's write, since its native one needs xclip or wl-copy installed. */
export function nativeClipboardWriter(
  invoke: (command: "write_clipboard_text", args: { text: string }) => Promise<unknown>,
): ((text: string) => Promise<void>) | undefined {
  if (!IS_MAC && !IS_WINDOWS) return undefined;
  return async (text) => { await invoke("write_clipboard_text", { text }); };
}
