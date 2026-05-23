import { invoke } from '@tauri-apps/api/core';

export function openExternalUrl(url: string, context: string): void {
  invoke('open_external_url', { url }).catch((e) =>
    console.error(`[open] Failed to open ${context}:`, e),
  );
}
