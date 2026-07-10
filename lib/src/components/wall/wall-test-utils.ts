import { vi } from 'vitest';
import type { WallActions } from './wall-context';

/** The full `WallActions` surface as inert vi.fn stubs, so a new member is one
 *  edit here instead of one per component test. */
export function stubWallActions(overrides: Partial<WallActions> = {}): WallActions {
  return {
    onKill: vi.fn(),
    onMinimize: vi.fn(),
    onAlertButton: vi.fn(() => 'noop'),
    onToggleTodo: vi.fn(),
    onSplitH: vi.fn(),
    onSplitV: vi.fn(),
    onZoom: vi.fn(),
    onClickPanel: vi.fn(),
    onFocusPane: vi.fn(),
    onStartRename: vi.fn(),
    onFinishRename: vi.fn(() => ({ accepted: true })),
    onCancelRename: vi.fn(),
    onSwapRenderMode: vi.fn(),
    resolveSurfaceRef: vi.fn((id: string) => id),
    onConnectPort: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

/** jsdom lacks ResizeObserver; the pane headers' responsive-tier observer needs it. */
export function ensureResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
