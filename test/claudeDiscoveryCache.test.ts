import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ query: vi.fn(), stat: vi.fn(), readFile: vi.fn(), account: undefined as { baseUrl: string } | undefined }));
vi.mock('node:module', () => ({ createRequire: () => () => ({ query: native.query }) }));
vi.mock('fs/promises', () => ({ stat: native.stat, readFile: native.readFile }));
vi.mock('../src/services/apiAccounts', () => ({ apiAccountEnvironment: (_provider: string, env: object) => ({...env, ANTHROPIC_BASE_URL: native.account?.baseUrl}) }));

beforeEach(() => {
  for (const key of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD']) vi.stubEnv(key, undefined);
  native.readFile.mockRejectedValue(Object.assign(new Error('Not found'), {code: 'ENOENT'}));
  native.stat.mockRejectedValue(Object.assign(new Error('Not found'), {code: 'ENOENT'}));
});
afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks(); native.account = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('does not inject or fetch manually configured API accounts during native Claude discovery', async () => {
  native.account = { baseUrl: 'https://gateway.example.test/v1' };
  native.stat.mockResolvedValue({isFile: () => true});
  native.query.mockReturnValue({initializationResult: async () => ({models: [{value: 'sonnet', displayName: 'Sonnet'}], account: {apiProvider: 'firstParty'}}), close: vi.fn()});
  vi.stubGlobal('fetch', vi.fn());
  const { discoverClaudeModels } = await import('../src/services/claudeCliRuntime');
  expect((await discoverClaudeModels()).models).toHaveLength(1);
  expect(native.query.mock.calls[0][0].options.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])('excludes custom infrastructure selected by %s before launching Claude', async key => {
  vi.stubEnv(key, key === 'ANTHROPIC_BASE_URL' ? 'https://gateway.example.test' : '1');
  const { discoverClaudeModels } = await import('../src/services/claudeCliRuntime');
  expect(await discoverClaudeModels()).toMatchObject({models: [], warning: expect.stringContaining('Custom Claude infrastructure')});
  expect(native.query).not.toHaveBeenCalled();
});

it('excludes user/project Claude settings and invalidates the cached catalogue when settings change', async () => {
  native.stat.mockResolvedValue({isFile: () => true, size: 100});
  let custom = false;
  native.readFile.mockImplementation(async (file: string) => JSON.stringify({env: custom && file.endsWith('settings.local.json') ? {ANTHROPIC_BASE_URL: 'https://private.example.test'} : {}}));
  native.query.mockReturnValue({initializationResult: async () => ({models: [{value: 'sonnet', displayName: 'Sonnet'}], account: {apiProvider: 'firstParty'}}), close: vi.fn()});
  const { discoverClaudeModels, cachedClaudeConnection } = await import('../src/services/claudeCliRuntime');
  expect((await discoverClaudeModels()).models).toHaveLength(1);
  custom = true;
  expect((await discoverClaudeModels()).models).toEqual([]);
  expect(cachedClaudeConnection()?.account).toBeUndefined();
  custom = false;
  expect((await discoverClaudeModels()).models).toHaveLength(1);
  expect(native.query).toHaveBeenCalledTimes(2);
});

it.each(['gateway', 'bedrock', 'vertex', 'foundry'])('excludes the SDK-reported %s provider and closes discovery', async apiProvider => {
  native.stat.mockResolvedValue({isFile: () => true});
  const close = vi.fn();
  native.query.mockReturnValue({initializationResult: async () => ({models: [{value: 'sonnet', displayName: 'Sonnet'}], account: {apiProvider}}), close});
  const { discoverClaudeModels } = await import('../src/services/claudeCliRuntime');
  expect(await discoverClaudeModels()).toMatchObject({models: [], warning: expect.stringContaining('Custom Claude infrastructure')});
  expect(close).toHaveBeenCalledOnce();
});

it('allows the official Anthropic endpoint and ignores disabled provider flags', async () => {
  const {isCustomClaudeInfrastructure} = await import('../src/services/claudeCliRuntime');
  expect(isCustomClaudeInfrastructure({ANTHROPIC_BASE_URL: 'https://api.anthropic.com/', CLAUDE_CODE_USE_VERTEX: '0'}, 'firstParty')).toBe(false);
  expect(isCustomClaudeInfrastructure({ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.test'})).toBe(true);
});

it('reports unreadable settings without exposing their contents or starting Claude', async () => {
  native.stat.mockResolvedValue({size: 100});
  native.readFile.mockResolvedValue('{ private-key:');
  const {discoverClaudeModels} = await import('../src/services/claudeCliRuntime');
  const result = await discoverClaudeModels();
  expect(result).toMatchObject({models: [], warning: expect.stringContaining('settings could not be checked')});
  expect(JSON.stringify(result)).not.toContain('private-key');
  expect(native.query).not.toHaveBeenCalled();
});

it('bounds settings detection and surfaces an inconclusive outcome', async () => {
  vi.useFakeTimers(); native.stat.mockImplementation(() => new Promise(() => {}));
  const {discoverClaudeModels} = await import('../src/services/claudeCliRuntime');
  const pending = discoverClaudeModels();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({models: [], warning: expect.stringContaining('timed out')});
  expect(native.query).not.toHaveBeenCalled();
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
  vi.stubEnv('CLAUDE_CLI_PATH', 'another-claude-runtime');
  await discoverClaudeModels();
  expect(native.query).toHaveBeenCalledTimes(3);
});
