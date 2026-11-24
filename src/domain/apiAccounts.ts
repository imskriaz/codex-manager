export type ApiAccountProvider = 'openai' | 'anthropic';
export type ApiAccountInput = { provider: ApiAccountProvider; name: string; apiKey: string; baseUrl?: string };
export type ApiAccount = { id: string; provider: ApiAccountProvider; name: string; baseUrl: string; createdAt: number; updatedAt: number; enabled?: boolean; queuePriority?: boolean };

export function normalizeApiAccount(input: ApiAccountInput): Required<ApiAccountInput> {
  if (!input || !['openai', 'anthropic'].includes(input.provider)) throw new Error('Choose OpenAI or Anthropic.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Enter an account name of up to 100 characters.');
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /\s/.test(input.apiKey.trim())) throw new Error('Enter a valid API key without spaces.');
  if (input.baseUrl !== undefined && (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048)) throw new Error('Enter an API base URL of up to 2048 characters.');
  let url: URL;
  try { url = new URL(input.baseUrl?.trim() || (input.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com')); }
  catch { throw new Error('Enter a valid API base URL.'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost, without credentials, query parameters or fragments.');
  return { provider: input.provider, name: input.name.trim(), apiKey: input.apiKey.trim(), baseUrl: url.toString().replace(/\/+$/, '') };
}
