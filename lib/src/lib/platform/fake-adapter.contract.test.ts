import { afterEach, beforeEach, vi } from 'vitest';
import { adapterContract } from './adapter-contract-test-utils';
import { FakePtyAdapter } from './fake-adapter';

/**
 * The fake under the shared contract. It is its own host, so the harness plays
 * output and exits through what a page drives it with — `sendOutput` into a
 * spawned PTY, and a scenario that ends with a code — on faked timers.
 */
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

adapterContract('fake', async () => {
  const adapter = new FakePtyAdapter();
  const spawned = (id: string) => { if (!adapter.hasPty(id)) adapter.spawnPty(id); };
  return {
    adapter,
    data: (id, data) => {
      spawned(id);
      adapter.sendOutput(id, data);
    },
    exit: async (id, exitCode) => {
      adapter.setScenario(id, { name: 'exits', chunks: [], exitCode });
      adapter.spawnPty(id);
      await vi.advanceTimersByTimeAsync(100);
    },
    show: async (id) => spawned(id),
    settle: async (promise) => {
      await vi.advanceTimersByTimeAsync(1_000);
      return promise;
    },
  };
});
