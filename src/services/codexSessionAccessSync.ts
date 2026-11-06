import { matchesCodexSessionAccess, parseCodexSessionAccess } from '../domain/codexSessionAccess';
import type { CodexAppServerRpc } from './codexAppServerRpc';
import { waitWithin } from '../utils/concurrency';

/** A request acknowledgment alone does not prove which permissions Codex applied. */
export async function syncCodexSessionAccess(rpc: Pick<CodexAppServerRpc, 'request' | 'onNotification'>, id: string, settings: Record<string, unknown>, current?: unknown) {
  const expected = parseCodexSessionAccess(settings);
  if (!expected || !expected.mode && !expected.approvalPolicy) throw new Error('The requested access mode is invalid.');
  const known = parseCodexSessionAccess(current);
  if (known && matchesCodexSessionAccess(known, expected) && (!expected.mode || !known.profile || known.profile.startsWith(':'))) return { access: known, settings: current };
  let confirm!: (value: { access: NonNullable<ReturnType<typeof parseCodexSessionAccess>>; settings: unknown }) => void;
  const confirmed = new Promise<Parameters<typeof confirm>[0]>(resolve => { confirm = resolve; });
  const off = rpc.onNotification((method, raw) => {
    const event = raw as { threadId?: unknown; threadSettings?: unknown } | undefined;
    if (method !== 'thread/settings/updated' || event?.threadId !== id) return;
    const access = parseCodexSessionAccess(event.threadSettings);
    if (access) confirm({ access, settings: event.threadSettings });
  });
  try {
    await rpc.request('thread/settings/update', { threadId: id, ...settings }, 10_000);
    const result = await waitWithin(confirmed, 3000, 'Codex did not confirm its applied permissions. Refresh before retrying.');
    if (!matchesCodexSessionAccess(result.access, expected)) throw new Error('Codex applied different permissions or approval policy. Its current access is shown; review it before retrying.');
    return result;
  } finally { off(); }
}
