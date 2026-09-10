import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspace,
  generateWorkspaceId,
  renameWorkspace,
  resetWorkspaces,
  setActiveWorkspace,
} from "dormouse-lib/lib/workspace-store";
import {
  acceptRegistrySnapshot,
  getRegistrySnapshot,
  installWorkspaceRegistry,
  resetWorkspaceRegistry,
  type WorkspaceRegistrySnapshot,
} from "./workspace-registry";

function host() {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "workspace_reserve_ids") {
      const count = Number(args?.count);
      return Array.from({ length: count }, (_, i) => `workspace-${50 + i}`);
    }
    if (cmd === "workspace_registry") return { revision: 3, windows: [{ label: "main", workspaces: [] }] };
    return null;
  });
  let push: ((snapshot: WorkspaceRegistrySnapshot) => void) | null = null;
  return {
    invoke: invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
    onSnapshot: (handler: (snapshot: WorkspaceRegistrySnapshot) => void) => {
      push = handler;
      return () => { push = null; };
    },
    push: (snapshot: WorkspaceRegistrySnapshot) => push?.(snapshot),
    reports: () => invoke.mock.calls.filter(([cmd]) => cmd === "workspace_report").map(([, args]) => args?.entries),
  };
}

describe("workspace registry", () => {
  let uninstall: (() => void) | null = null;
  beforeEach(() => {
    resetWorkspaces();
    resetWorkspaceRegistry();
  });
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("mints from the host's block and reports the store once per change, coalesced", async () => {
    const h = host();
    uninstall = await installWorkspaceRegistry(h);
    expect(h.invoke).toHaveBeenCalledWith("workspace_reserve_ids", { count: 16 });
    expect(generateWorkspaceId()).toBe("workspace-50");
    await Promise.resolve();
    // The boot report: the store as it stood at install.
    expect(h.reports()).toEqual([[{ id: "workspace-1", name: "Workspace 1", active: true }]]);

    const created = createWorkspace({ name: "build" });
    renameWorkspace(created.id, "docs");
    setActiveWorkspace(created.id);
    await Promise.resolve();
    // Three mutations in one task: one report, with the final state.
    expect(h.reports()).toHaveLength(2);
    expect(h.reports()[1]).toEqual([
      { id: "workspace-1", name: "Workspace 1", active: false },
      { id: "workspace-51", name: "docs", active: true },
    ]);
  });

  it("takes the host's snapshot at install and drops one older than it holds", async () => {
    const h = host();
    uninstall = await installWorkspaceRegistry(h);
    expect(getRegistrySnapshot().revision).toBe(3);
    h.push({ revision: 2, windows: [] });
    expect(getRegistrySnapshot().revision).toBe(3);
    h.push({ revision: 4, windows: [{ label: "ws-2", workspaces: [{ id: "workspace-9", ref: "workspace:9", name: "n", active: true }] }] });
    expect(getRegistrySnapshot().windows[0].label).toBe("ws-2");
    acceptRegistrySnapshot({ revision: 4, windows: [] });
    expect(getRegistrySnapshot().windows).toEqual([]);
  });
});
