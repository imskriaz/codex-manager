import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ query: vi.fn(), stat: vi.fn(), identity: vi.fn(() => 'account') }));
vi.mock('node:module', () => ({ createRequire: () => () => ({ query: native.query }) }));
vi.mock('fs/promises', () => ({ stat: native.stat }));
vi.mock('../src/services/apiAccounts', () => ({ apiAccountEnvironment: (_provider: string, env: unknown) => env, apiAccountIdentity: native.identity }));

afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks(); });

it.each([false, true])('does not repeat successful or failed discovery on dashboard polling (failure: %s)', async failed => {
  vi.useFakeTimers();
  native.stat.mockResolvedValue({ isFile: () => true });
  native.query.mockImplementation(() => ({
    initializationResult: async () => {
      if (failed) throw new Error('Authentication failed');
      return { models: [{ value: 'haiku', displayName: 'Haiku' }], account: {} };
    },
    async *[Symbol.asyncIterator]() { yield { type: 'result', is_error: false }; },
    close: vi.fn()
  }));
  const { discoverClaudeModels } = await import('../src/services/claudeCliRuntime');
  const first = await discoverClaudeModels();
  expect(first.warning).toBe(failed ? 'Claude models unavailable: Authentication failed' : undefined);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await discoverClaudeModels()).toMatchObject(first);
  expect(native.query).toHaveBeenCalledTimes(1);
  await discoverClaudeModels(true);
  expect(native.query).toHaveBeenCalledTimes(2);
  native.identity.mockReturnValueOnce('another-account');
  await discoverClaudeModels();
  expect(native.query).toHaveBeenCalledTimes(3);
});
