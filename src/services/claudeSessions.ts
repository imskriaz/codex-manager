import { randomUUID, createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DashboardCliSessionSummary, DashboardCliSessionMessage, DashboardCliSandboxMode } from '../domain/dashboard/types';
import type { CodexSessionAccess } from '../domain/codexSessionAccess';
import { isClaudeModel, nativeClaudeModel, createClaudeModelOptions } from '../domain/dashboard/claudeModels';
import { claudeSdk, claudeConfigHome, claudeEnvironment, claudeAccountKey, resolveClaudeCliExecutable } from './claudeCliRuntime';
import { claudeMessage, claudePermissionMode, claudeQuota, claudeUsage, claudeUserMessage, object } from './claudeProtocol';
import { claudeToolApproval, claudeElicitation } from './claudeNativePrompts';
import { getSqliteStateStore } from '../storage/sqliteState';
import { reserveCodexSessionLive, getCodexSessionLiveState } from './codexSessionLive';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { waitWithin } from '../utils/concurrency';
import type { ChatAttachment } from '../domain/chatAttachments';
import { publishDashboardRealtime } from './dashboardRealtime';

type SavedClaudeSession = { summary: DashboardCliSessionSummary; firstPrompt: string; ownerPid?: number; failure?: string; recentMessages?: DashboardCliSessionMessage[] };
export class ClaudeTurnCancelledError extends Error { constructor() { super('Claude turn was cancelled.'); } }
type Active = { query: Query; controller: AbortController; turnId: string; stopped: boolean; messages: Map<string, DashboardCliSessionMessage>; acknowledgements: Map<string, { resolve: () => void; reject: (error: Error) => void }>; notify: (method: string, params: unknown) => void; push: (value: SDKUserMessage) => void };
const active = new Map<string, Active>();
const nativeText = (value: unknown): string => typeof value === 'string' ? value : '';
const namespace = () => 'claude-sessions:' + createHash('sha256').update(claudeConfigHome()).digest('hex');
const leaseKey = (id: string) => `${namespace()}:${id}`;
const validId = (id: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
function storage() { const store = getSqliteStateStore(); if (!store) throw new Error('Claude session storage is unavailable. No action was started.'); return store; }
function saved(id: string): SavedClaudeSession | undefined { return validId(id) ? getSqliteStateStore()?.get<SavedClaudeSession>(namespace(), id.toLowerCase()) : undefined; }
function write(id: string, entry: SavedClaudeSession): void { storage().set(namespace(), id, entry); }
export function isClaudeSession(id: string): boolean { return !!saved(id); }
function requireSession(id: string): SavedClaudeSession { const entry = saved(id); if (!entry) throw new Error('The Claude session was not found. Refresh before retrying.'); return entry; }
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export function readClaudeSession(id: string): DashboardCliSessionSummary | undefined {
  id = id.toLowerCase();
  const entry = saved(id);
  if (!entry) return undefined;
  const running = active.get(id), otherOwner = entry.ownerPid !== process.pid && alive(entry.ownerPid);
  const interrupted = entry.summary.status === 'running' && !running && !otherOwner;
  return { ...entry.summary, provider: 'claude', status: running || otherOwner ? 'running' : 'idle', locked: !!otherOwner,
    canStop: !!running, runningBy: running ? 'Codex Manager' : otherOwner ? 'another Claude Manager process' : undefined,
    steerTurnId: running && !running.stopped ? running.turnId : undefined, interrupted: interrupted || entry.summary.interrupted,
    autoResumeEnabled: false, queueEnabled: false };
}

export function listClaudeSessions(): DashboardCliSessionSummary[] {
  const store = getSqliteStateStore();
  return store ? store.keys(namespace()).slice(-10_000).flatMap(id => readClaudeSession(id) ?? []) : [];
}

export async function readClaudeHistory(id: string, before?: string): Promise<{ messages: DashboardCliSessionMessage[]; olderThan?: string; warnings: string[] }> {
  id = id.toLowerCase();
  const entry = requireSession(id), sdk = await claudeSdk();
  if (before !== undefined && !/^\d{1,8}$/.test(before)) throw new Error('The Claude history cursor is invalid.');
  const count = before === undefined ? undefined : Number(before);
  const rows = await waitWithin(sdk.getSessionMessages(id, { dir: entry.summary.projectPath, ...(count !== undefined ? { limit: count } : {}) }), 5_000, 'Claude history could not be read. Refresh to retry.');
  const end = count ?? rows.length, start = Math.max(0, end - 200);
  const messages = new Map<string, DashboardCliSessionMessage>();
  for (const row of rows.slice(start, end)) for (const message of claudeMessage(row)) messages.set(message.id, { ...messages.get(message.id), ...message });
  if (!rows.length) for (const message of entry.recentMessages ?? [{ id: `initial-${id}`, role: 'user' as const, text: entry.firstPrompt }]) messages.set(message.id, message);
  if (entry.failure) messages.set(`claude-error-${id}`, { id: `claude-error-${id}`, kind: 'error', status: 'failed', text: entry.failure });
  return { messages: [...messages.values()], ...(start ? { olderThan: String(start) } : {}), warnings: [] };
}

export type ClaudeTurnOptions = { text: string; attachments?: ChatAttachment[]; model?: string; reasoningEffort?: string; sandboxMode?: DashboardCliSandboxMode; autoApprove?: boolean; projectPath?: string; signal?: AbortSignal; onStarted?: () => void };
export async function startClaudeSession(options: ClaudeTurnOptions): Promise<string> {
  const id = randomUUID();
  claudeUserMessage(id, options.text, options.attachments);
  const cwd = path.resolve(options.projectPath || process.cwd());
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The selected Claude project is not a folder.');
  const access: CodexSessionAccess = { mode: options.sandboxMode ?? 'danger-full-access', approvalPolicy: options.autoApprove === true ? 'never' : 'on-request', updatedAt: Date.now() };
  write(id, { firstPrompt: options.text, summary: { id, provider: 'claude', title: options.text.trim().slice(0, 160) || 'New Claude chat',
    model: options.model, reasoningEffort: options.reasoningEffort, projectPath: cwd, status: 'idle', archived: false, access, sandboxMode: access.mode, goal: null, updatedAt: new Date().toISOString() } });
  return new Promise((resolve, reject) => {
    let accepted = false;
    void runTurn(id, options, false, () => { accepted = true; resolve(id); }).catch(error => { if (!accepted) reject(error instanceof Error ? error : new Error('Claude could not start.')); });
  });
}

export async function sendClaudeMessage(id: string, options: ClaudeTurnOptions): Promise<'steered' | void> {
  id = id.toLowerCase();
  const entry = requireSession(id);
  if (options.model && !isClaudeModel(options.model)) throw new Error('This is a Claude conversation. Start a new conversation to use an OpenAI model.');
  if (active.has(id) && options.model && options.model !== entry.summary.model) throw new Error('Stop the active Claude turn before changing model. Your message was not sent.');
  if (options.projectPath && await fs.realpath(options.projectPath) !== await fs.realpath(entry.summary.projectPath!)) throw new Error('This Claude session belongs to another project. Your message was kept.');
  if (active.has(id)) { await steerClaudeSession(id, options, active.get(id)!.turnId); options.onStarted?.(); return 'steered'; }
  await runTurn(id, options, true, options.onStarted ?? (() => undefined));
}

async function runTurn(id: string, options: ClaudeTurnOptions, resume: boolean, accepted: () => void): Promise<void> {
  return runCrossWindowExclusive(leaseKey(id), 'Claude session', async leaseSignal => {
    let entry = requireSession(id);
    if (entry.summary.archived) throw new Error('Restore this Claude session before sending.');
    const executable = await waitWithin(resolveClaudeCliExecutable(), 2_000, 'Claude detection timed out.');
    if (!executable) throw new Error('Claude Code was not found. Install and sign in to Claude Code, then retry.');
    const sdk = await claudeSdk(), cwd = entry.summary.projectPath!;
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The Claude project folder is unavailable.');
    const controller = new AbortController();
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([controller.signal, leaseSignal]);
    const abortStartup = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortStartup, { once: true });
    signal.throwIfAborted();
    const model = options.model ?? entry.summary.model;
    if (!model || !isClaudeModel(model)) throw new Error('Choose a discovered Claude model.');
    if (options.reasoningEffort && !['low','medium','high','xhigh','max'].includes(options.reasoningEffort)) throw new Error('This reasoning level is not supported by Claude.');
    const input = claudeUserMessage(id, options.text, options.attachments);
    input.uuid = randomUUID();
    const queue: SDKUserMessage[] = []; let wake: (() => void) | undefined;
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      while (!signal.aborted) { if (queue.length) yield queue.shift()!; else await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve(); }); }
    }
    const access: CodexSessionAccess = { ...entry.summary.access, ...(options.sandboxMode ? { mode: options.sandboxMode } : {}), ...(options.autoApprove !== undefined ? { approvalPolicy: options.autoApprove ? 'never' : 'on-request' } : {}), updatedAt: Date.now() };
    const nativeMode = claudePermissionMode(access.mode, access.approvalPolicy === 'never');
    const turnId = randomUUID(), listeners = new Set<(method: string, params: unknown) => void>();
    const emit = (method: string, params: unknown) => { for (const listener of listeners) listener(method, { ...object(params), threadId: id, turnId }); };
    const live = reserveCodexSessionLive('claude');
    const queryOptions: Options = { pathToClaudeCodeExecutable: executable, cwd, model: nativeClaudeModel(model),
      ...(resume ? { resume: id } : { sessionId: id }), env: claudeEnvironment(),
      settingSources: ['user','project','local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true, permissionMode: nativeMode, allowDangerouslySkipPermissions: nativeMode === 'bypassPermissions',
      ...(options.reasoningEffort ? { effort: options.reasoningEffort as Options['effort'] } : {}),
      canUseTool: claudeToolApproval(id, cwd, () => requireSession(id).summary.access?.mode === 'read-only'),
      onElicitation: (request, context) => claudeElicitation(id, request, context.signal),
      extraArgs: { 'replay-user-messages': null },
      abortController: controller,
      stderr: chunk => { stderr = (stderr + chunk).slice(-2000); } };
    let stderr = '', connection: Query | undefined, timer: NodeJS.Timeout | undefined;
    const abort = () => { controller.abort(signal.reason); wake?.(); };
    signal.addEventListener('abort', abort, { once: true });
    let stopped = false, resultReceived = false, inputAccepted = false, accountKey: string | undefined, messageId = '', contextTokens: number | undefined;
    const blocks = new Map<number, DashboardCliSessionMessage>();
    try {
      connection = sdk.query({ prompt: prompts(), options: queryOptions });
      const running: Active = { query: connection, controller, turnId, stopped: false, messages: new Map(), acknowledgements: new Map(), notify: emit,
        push: value => { queue.push(value); wake?.(); wake = undefined; } };
      active.set(id, running);
      live.attach(id, { onNotification: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onDisconnect: () => () => undefined }, raw => {
        const turns = object(object(raw)['thread'])['turns'] as Array<{ items?: Array<{ message?: DashboardCliSessionMessage }> }> | undefined;
        return turns?.[0]?.items?.flatMap(item => item.message ?? []) ?? [];
      }, () => running.stopped);
      entry = { ...entry, failure: undefined, ownerPid: process.pid, summary: { ...entry.summary, access, sandboxMode: access.mode, model,
        reasoningEffort: options.reasoningEffort ?? entry.summary.reasoningEffort, status: 'running', interrupted: false, stopped: false, updatedAt: new Date().toISOString() } };
      write(id, entry);
      const info = await waitWithin(connection.initializationResult(), 12_000, 'Claude did not initialize. The outcome is unconfirmed; refresh before retrying.', signal);
      accountKey = claudeAccountKey(info.account);
      if (!accountKey || entry.summary.nativeQuota?.accountKey !== accountKey) entry.summary.nativeQuota = undefined;
      const available = createClaudeModelOptions(info.models).find(option => option.id === model);
      if (!available) throw new Error('This Claude model is no longer available. Refresh the model list before sending.');
      if (options.reasoningEffort && available && !available.reasoningEfforts.includes(options.reasoningEffort)) throw new Error('The selected reasoning level is not supported by this Claude model.');
      running.push(input);
      timer = setTimeout(() => controller.abort(new Error('Claude did not confirm the message. Its outcome is unconfirmed; refresh history before retrying.')), 15_000);
      const publish = (message: DashboardCliSessionMessage) => {
        const previous = running.messages.get(message.id);
        const merged = { ...previous, ...message, turnId };
        running.messages.set(message.id, merged);
        while (running.messages.size > 200) running.messages.delete(running.messages.keys().next().value!);
        emit('item/completed', { item: { id: message.id, message: merged } });
      };
      for await (const raw of connection) {
        if (raw.session_id !== id) throw new Error('Claude returned a different session identity. No further input was sent.');
        if (raw.type === 'user' && raw.uuid === input.uuid && !inputAccepted) {
          inputAccepted = true; clearTimeout(timer);
          options.signal?.removeEventListener('abort', abortStartup);
          live.started(turnId); accepted();
          timer = setTimeout(() => controller.abort(new Error('The Claude connection did not complete within 30 minutes. Its outcome is unconfirmed; refresh before retrying.')), 30 * 60_000);
        }
        if (raw.type === 'user' && raw.uuid) { running.acknowledgements.get(raw.uuid)?.resolve(); running.acknowledgements.delete(raw.uuid); }
        if (raw.type === 'assistant' || raw.type === 'user') for (const message of claudeMessage(raw)) publish(message);
        if (raw.type === 'stream_event') {
          const event = object(raw.event);
          if (event['type'] === 'message_start') {
            const message = object(event['message']); messageId = nativeText(message['id']) || randomUUID(); blocks.clear();
            const usage = claudeUsage(message['usage'], {}); contextTokens = usage?.input;
          }
          const index = Number(event['index'] ?? 0), block = object(event['content_block']), delta = object(event['delta']);
          if (event['type'] === 'content_block_start' && ['text','thinking'].includes(nativeText(block['type']))) blocks.set(index, { id: `${messageId}-${index}`, kind: block['type'] === 'thinking' ? 'reasoning' : 'message', ...(block['type'] === 'text' ? { role: 'assistant' as const } : {}), text: nativeText(block['text'] ?? block['thinking']) });
          if (event['type'] === 'content_block_delta' && blocks.has(index)) {
            const item = blocks.get(index)!; item.text = (item.text + nativeText(delta['text'] ?? delta['thinking'])).slice(0, 12_000); publish(item);
          }
        }
        if (raw.type === 'rate_limit_event') {
          const reported = claudeQuota(entry.summary.nativeQuota, raw.rate_limit_info);
          entry.summary.nativeQuota = reported ? { ...reported, accountKey } : undefined;
          entry.summary.access = requireSession(id).summary.access;
          write(id, entry);
          const limits = entry.summary.nativeQuota?.limits ?? [];
          const window = (kind: string) => { const limit = limits.find(row => row.kind === kind); return limit?.usedPercent !== undefined ? { usedPercent: limit.usedPercent, resetsAt: limit.resetsAt, windowDurationMins: kind === 'five_hour' ? 300 : 10080 } : undefined; };
          emit('account/rateLimits/updated', { rateLimits: { primary: window('five_hour'), secondary: window('seven_day') } });
          if (raw.rate_limit_info.status !== 'allowed') publish({ id: `claude-quota-${raw.rate_limit_info.rateLimitType ?? 'usage'}`, kind: 'tool-call', title: 'Claude usage limit', status: 'unknown', text: raw.rate_limit_info.status === 'rejected' ? 'Claude usage limit reached. Check the reported reset time or your Claude account.' : 'Claude reports that the usage limit is near.' });
        }
        if (raw.type === 'system' && raw.subtype === 'session_writes_lost') throw new Error('Claude could not save the conversation. Refresh history before resending or resuming.');
        if (raw.type === 'result') {
          resultReceived = true;
          stopped = running.stopped;
          entry.summary.tokenUsage = claudeUsage(raw.usage, raw.modelUsage, contextTokens);
          const usage = entry.summary.tokenUsage;
          emit('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: usage?.total, inputTokens: usage?.input, outputTokens: usage?.output, cachedInputTokens: usage?.cachedInput }, last: { totalTokens: contextTokens }, modelContextWindow: usage?.contextWindow } });
          if (raw.is_error && !stopped) throw new Error('errors' in raw ? raw.errors.join('\n') : raw.result || 'Claude failed to complete the turn.');
          if ((raw.queued_turn_count ?? 0) > 0 && !stopped) continue;
          break;
        }
      }
      if (!inputAccepted) throw new Error('Claude ended before confirming the message. Refresh history before retrying.');
      if (!resultReceived) throw new Error(`Claude disconnected before completion was confirmed.${stderr ? ' ' + stderr : ''}`);
    } catch (error) {
      stopped = active.get(id)?.stopped === true;
      const message = error instanceof Error ? error.message : String(error);
      entry.failure = stopped ? undefined : message;
      entry.summary.interrupted = true;
      if (!stopped) throw error;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      options.signal?.removeEventListener('abort', abortStartup);
      const running = active.get(id);
      if (running) {
        for (const pending of running.acknowledgements.values()) pending.reject(new Error('Claude finished before confirming the follow-up. Refresh history before retrying.'));
        entry.recentMessages = [...running.messages.values()]; active.delete(id);
      }
      controller.abort(); wake?.(); connection?.close();
      entry.ownerPid = undefined;
      entry.summary = { ...entry.summary, access: requireSession(id).summary.access, status: 'idle', canStop: false, stopped, interrupted: stopped || !!entry.failure, updatedAt: new Date().toISOString() };
      try {
        write(id, entry);
        live.finish(stopped ? 'cancelled' : entry.failure ? signal.aborted ? 'disconnected' : 'failed' : 'completed', entry.failure);
      } finally { live.dispose(); }
      publishDashboardRealtime({ type: 'dashboard:notice', level: stopped ? 'warning' : entry.failure ? 'error' : 'info', message: stopped ? 'Claude turn stopped.' : entry.failure ? `Claude failed: ${entry.failure}` : 'Claude completed the turn.' });
    }
    if (stopped) throw new ClaudeTurnCancelledError();
  });
}

export async function steerClaudeSession(id: string, options: Pick<ClaudeTurnOptions, 'text' | 'attachments'>, expectedTurnId: string): Promise<void> {
  id = id.toLowerCase();
  const running = active.get(id);
  if (!running || running.stopped || running.turnId !== expectedTurnId) throw new Error('The Claude turn changed. Your follow-up was not sent.');
  const input = claudeUserMessage(id, options.text, options.attachments); input.uuid = randomUUID();
  const acknowledged = new Promise<void>((resolve, reject) => running.acknowledgements.set(input.uuid!, { resolve, reject }));
  running.push(input);
  try { await waitWithin(acknowledged, 15_000, 'Claude has not confirmed the follow-up. It may still be queued; refresh history before retrying.'); }
  finally { running.acknowledgements.delete(input.uuid); }
}

export async function stopClaudeSession(id: string, expectedTurnId?: string): Promise<boolean> {
  id = id.toLowerCase();
  const running = active.get(id);
  if (!running || expectedTurnId && expectedTurnId !== running.turnId) throw new Error('The Claude turn owner is unavailable or changed. Stop was not confirmed.');
  running.stopped = true;
  await waitWithin(running.query.interrupt(), 5_000, 'Claude did not confirm Stop. Refresh before retrying.');
  return true;
}

export async function setClaudeAccess(id: string, mode?: DashboardCliSandboxMode, autoApprove?: boolean): Promise<CodexSessionAccess> {
  id = id.toLowerCase();
  if (mode && !['read-only','workspace-write','danger-full-access'].includes(mode) || autoApprove !== undefined && typeof autoApprove !== 'boolean') throw new Error('Choose a valid Claude permission setting.');
  const entry = requireSession(id), summary = readClaudeSession(id)!;
  if (summary.locked || summary.archived) throw new Error('Claude access cannot change while another process owns this session or it is archived.');
  const access: CodexSessionAccess = { ...entry.summary.access, ...(mode ? { mode } : {}), ...(autoApprove !== undefined ? { approvalPolicy: autoApprove ? 'never' : 'on-request' } : {}), updatedAt: Date.now() };
  const running = active.get(id);
  if (running) await waitWithin(running.query.setPermissionMode(claudePermissionMode(access.mode, access.approvalPolicy === 'never')), 5_000, 'Claude permission change was not confirmed. Refresh before retrying.');
  entry.summary = { ...entry.summary, access, sandboxMode: access.mode }; write(id, entry); return access;
}

export async function mutateClaudeSession(id: string, operation: 'rename' | 'archive' | 'restore' | 'delete' | 'fork', name?: string): Promise<string | void> {
  id = id.toLowerCase();
  return runCrossWindowExclusive(leaseKey(id), `Claude session ${operation}`, async () => {
    const entry = requireSession(id), sdk = await claudeSdk();
    if (active.has(id) || readClaudeSession(id)?.status === 'running') throw new Error('Stop the Claude turn before changing this session.');
    const options = { dir: entry.summary.projectPath };
    if (operation === 'rename') {
      const title = name?.trim().replace(/\s+/g, ' ');
      if (!title || title.length > 160) throw new Error('Enter a Claude session name of 1 to 160 characters.');
      await sdk.renameSession(id, title, options); entry.summary.title = title;
    } else if (operation === 'archive') { await sdk.archiveSession(id, options); entry.summary.archived = true; }
    else if (operation === 'restore') { await sdk.unarchiveSession(id, options); entry.summary.archived = false; }
    else if (operation === 'delete') { await sdk.deleteSession(id, options); storage().set(namespace(), id, undefined); return; }
    else {
      const fork = await sdk.forkSession(id, options);
      write(fork.sessionId, { ...entry, ownerPid: undefined, summary: { ...entry.summary, id: fork.sessionId, title: entry.summary.title + ' (fork)', archived: false } });
      return fork.sessionId;
    }
    entry.summary.updatedAt = new Date().toISOString(); write(id, entry);
    return undefined;
  });
}

export function claudeInitialPrompt(id: string): string { return requireSession(id).firstPrompt; }
export function rejectClaudeAutomation(id: string, feature: string): void { if (isClaudeSession(id)) throw new Error(`${feature} is a Codex-specific control. Use Claude's native tools and manual Resume for this conversation.`); }
export function claudeLive(id: string) { return getCodexSessionLiveState(id); }
