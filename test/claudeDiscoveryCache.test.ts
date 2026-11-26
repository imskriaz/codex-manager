import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ query: vi.fn(), stat: vi.fn(), identity: vi.fn(() => 'account'), account: undefined as { baseUrl: string } | undefined }));
vi.mock('node:module', () => ({ createRequire: () => () => ({ query: native.query }) }));
vi.mock('fs/promises', () => ({ stat: native.stat }));
vi.mock('../src/services/apiAccounts', () => ({ activeApiAccount: () => native.account, apiAccountCredential: () => 'gateway-key', apiAccountEnvironment: (_provider: string, env: unknown) => env, apiAccountIdentity: native.identity }));

afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks(); native.account = undefined; vi.unstubAllGlobals(); });

it('discovers models from an active custom Anthropic-compatible gateway', async () => {
  native.account = { baseUrl: 'https://gateway.example.test/v1' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gateway-sonnet', display_name: 'Gateway Sonnet' }] }), { status: 200 })));
  const { discoverClaudeApiModels } = await import('../src/services/claudeCliRuntime');
  await expect(discoverClaudeApiModels()).resolves.toMatchObject({ models: [{ id: 'claude-code/gateway-sonnet', label: 'Gateway Sonnet' }] });
  expect(fetch).toHaveBeenCalledWith('https://gateway.example.test/v1/models', expect.objectContaining({ headers: { 'x-api-key': 'gateway-key', 'anthropic-version': '2023-06-01' } }));
});

it('offers no Claude models and never starts the SDK when Claude is not installed', async () => {
  native.stat.mockRejectedValue(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
  const { discoverClaudeModels } = await import('../src/services/claudeCliRuntime');
  expect(await discoverClaudeModels()).toEqual({ models: [] });
  expect(native.query).not.toHaveBeenCalled();
});

it.each([false, true])('does not repeat successful or failed discovery on dashboard polling (failure: %s)', async failed => {
  vi.useFakeTimers();
  native.stat.mockResolvedValue({ isFile: () => true });
  native.query.mockImplementation(() => ({
    initializationResult: async () => {
      if (failed) throw new Error('Authentication failed');
      return { models: [{ value: 'haiku', displayName: 'Haiku' }], account: {} };
    },
    async *[Symbol.asyncIterator]() { yield { type: 'result', is_error: true }; },
    close: vi.fn()
  }));
  const { discoverClaudeModels } = await import('../src/services/claudeCliRuntime');
  const first = await discoverClaudeModels();
  expect(first.warning).toBe(failed ? 'Claude models unavailable: Authentication failed' : undefined);
  if (!failed) expect(first.models.map(model => model.id)).toEqual(['claude-code/haiku']);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await discoverClaudeModels()).toMatchObject(first);
  expect(native.query).toHaveBeenCalledTimes(1);
  await discoverClaudeModels(true);
  expect(native.query).toHaveBeenCalledTimes(2);
  native.identity.mockReturnValueOnce('another-account');
  await discoverClaudeModels();
  expect(native.query).toHaveBeenCalledTimes(3);
});
