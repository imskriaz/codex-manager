import { providerConversation } from './sessionProviders';
import { randomUUID } from 'crypto';
import type { CanUseTool, ElicitationRequest, ElicitationResult, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { clearNativeCodexPrompts, listPendingCodexAppServerPrompts, syncNativeCodexPrompts } from './codexAppServerPrompts';
import type { AppServerRequest } from './codexAppServerRpc';

function ask(threadId: string, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const source = {}, id = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); clearNativeCodexPrompts(source); };
    const abort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error('Claude cancelled the request.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Claude approval expired without an answer. The action was not approved.')); }, 5 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    syncNativeCodexPrompts(source, threadId, [{ id, method, params: { ...params, threadId, provider: 'claude' } }], (_request: AppServerRequest, result) => {
      cleanup(); resolve(result as Record<string, unknown>); return Promise.resolve();
    });
    if (!listPendingCodexAppServerPrompts().some(request => request.threadId === (providerConversation(threadId)?.id ?? threadId))) {
      cleanup(); reject(new Error('The Claude request cannot be displayed safely. The action was not approved.'));
    }
  });
}

export function claudeToolApproval(threadId: string, cwd: string, readOnly: () => boolean): CanUseTool {
  return async (name, input, { signal }) => {
    try {
      if (name === 'AskUserQuestion') {
        const raw = Array.isArray(input['questions']) ? input['questions'] as Array<Record<string, unknown>> : [];
        const questions = raw.map((question, index) => ({ ...question, id: `q-${index}` }));
        const result = await ask(threadId, 'item/tool/requestUserInput', { questions }, signal);
        const answers = result['answers'] as Record<string, { answers: string[] }> | undefined;
        if (!answers || !Object.keys(answers).length) return { behavior: 'deny', message: 'The question was cancelled.' };
        return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(raw.map((question, index) => [String(question['question']), answers[`q-${index}`]?.answers.join(', ') ?? ''])) } };
      }
      if (readOnly() && !['Read', 'Glob', 'Grep', 'LS'].includes(name)) return { behavior: 'deny', message: 'This Claude session is in read-only mode.' };
      const result = await ask(threadId, 'item/commandExecution/requestApproval', { command: `${name}\n${JSON.stringify(input)}`, cwd, reason: 'Claude requires your approval for this tool.' }, signal);
      return result['decision'] === 'accept' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this Claude action.' };
    } catch (error) { return { behavior: 'deny', message: error instanceof Error ? error.message : String(error), interrupt: signal.aborted } satisfies PermissionResult; }
  };
}

export async function claudeElicitation(threadId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
  const result = await ask(threadId, 'mcpServer/elicitation/request', { serverName: request.serverName, message: request.message,
    mode: request.mode, url: request.url, requestedSchema: request.requestedSchema }, signal);
  return result as ElicitationResult;
}
