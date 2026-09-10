import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A listener registered with Tauri's default `Any` target receives every event
 * in the process, including the ones Rust addressed to one window
 * (`match_any_or_filter` in Tauri's event listener). The whole per-window
 * routing would then be decoration: every window would take every other
 * window's terminal output, its `pty:list`, its Workspace arrivals and its
 * teardown order.
 *
 * The failure is silent — nothing errors, the events simply go everywhere — so
 * this scans the source rather than trusting review.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** The one module allowed to reach the bare API: it is the wrapper. */
const WRAPPER = "window-label.ts";

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(here)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .filter((name) => !name.includes(".test."))
    .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));
}

describe("every window listener is scoped to its own window", () => {
  it("routes every listen through listenToWindow", () => {
    const offenders = sources()
      .filter((file) => file.name !== WRAPPER)
      // `listen(` preceded by a word character or a dot is something else
      // (`listenToWindow(`, `appWindow.listen(`).
      .filter((file) => /(?<![\w.])listen\s*\(/.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("keeps the wrapper the only importer of the bare event API", () => {
    const offenders = sources()
      .filter((file) => file.name !== WRAPPER)
      .filter((file) => /from ['"]@tauri-apps\/api\/event['"]/.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("names this window, and answers main in the harness", async () => {
    const { currentWindowLabel, isMainWindow, _setWindowLabelForTesting } =
      await import("./window-label");
    expect(currentWindowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
    _setWindowLabelForTesting("ws-2");
    expect(isMainWindow()).toBe(false);
    _setWindowLabelForTesting("main");
  });
});
