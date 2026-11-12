import type { SentRecord } from "dormouse-lib/lib/platform/adapter-contract-test-utils";

/**
 * The commands both sidecar adapters send — Tauri `invoke`s, and the browser
 * harness's `send`/`invoke` under the same names — in the contract's words
 * (`lib/src/lib/platform/adapter-contract-test-utils.ts`).
 */
export const SIDECAR_WIRE: Record<string, (args: Record<string, any>) => SentRecord> = {
  pty_spawn: ({ id, options }) => ({ op: "spawn", id, options }),
  pty_send_input: ({ id, events }) => ({ op: "sendInput", id, events }),
  pty_write: ({ id, data }) => ({ op: "write", id, data }),
  pty_resize: ({ id, cols, rows }) => ({ op: "resize", id, cols, rows }),
  pty_kill: ({ id }) => ({ op: "kill", id }),
  pty_ack: ({ id, chars }) => ({ op: "ack", id, chars }),
  pty_request_init: ({ requestId }) => ({ op: "init", requestId }),
  pty_theme_colors: ({ colors }) => ({ op: "theme", ...colors }),
  alert_command: ({ payload }) => ({ op: "alert", command: payload }),
  pty_get_cwds: ({ ids }) => ({ op: "cwds", ids }),
};

/** What the sidecar answers a harness's boot with: one id of each kind. */
export const sidecarAnswer = (command: string): unknown =>
  command === "boot_reserve_ids" ? { workspaces: ["workspace:2"], surfaces: ["surface:1"] } : undefined;

export const sidecarSent = (calls: Array<[string, Record<string, any> | undefined]>): SentRecord[] =>
  calls.flatMap(([command, args]) => SIDECAR_WIRE[command]?.(args ?? {}) ?? []);
