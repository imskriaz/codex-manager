import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { discoverClaudeModels } from '../src/services/claudeCliRuntime';
import { startClaudeSession, readClaudeSession, readClaudeHistory, sendClaudeMessage, mutateClaudeSession } from '../src/services/claudeSessions';
import { getCodexSessionLiveState } from '../src/services/codexSessionLive';
import { flushSessionRecording } from '../src/services/sessionRecording';

it.runIf(process.env['CODEX_MANAGER_TEST_NATIVE_CLAUDE']==='1')('installed native Claude starts, streams, resumes and persists without VS Code',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'manager-native-claude-'));
  const store=await SqliteStateStore.open(path.join(root,'manager.sqlite'));configureSqliteStateStore(store);
  let id: string|undefined;
  try {
    const catalogue=await discoverClaudeModels();
    expect(catalogue.warning).toBeUndefined();
    expect(catalogue.models.length).toBeGreaterThan(0);
    const model=catalogue.models.find(row=>row.id==='claude-code/haiku')??catalogue.models[0]!;
    id=await startClaudeSession({text:'Reply with exactly NATIVE_CLAUDE_OK. Do not use tools.',projectPath:root,model:model.id,reasoningEffort:model.reasoningEfforts.includes('low')?'low':undefined,sandboxMode:'read-only',autoApprove:false});
    await expect.poll(()=>getCodexSessionLiveState(id!)?.status,{timeout:60000,interval:100}).not.toMatch(/starting|running/);
    expect(getCodexSessionLiveState(id)).toMatchObject({provider:'claude',status:'completed'});
    expect((await readClaudeHistory(id)).messages.some(row=>row.text.includes('NATIVE_CLAUDE_OK'))).toBe(true);
    await sendClaudeMessage(id,{text:'Reply exactly NATIVE_RESUME_OK. Do not use tools.',model:model.id,reasoningEffort:model.reasoningEfforts.includes('low')?'low':undefined});
    expect((await readClaudeHistory(id)).messages.some(row=>row.text.includes('NATIVE_RESUME_OK'))).toBe(true);
    expect(readClaudeSession(id)?.tokenUsage?.output).toBeGreaterThan(0);
    await mutateClaudeSession(id,'rename','Native Claude verification');
    await mutateClaudeSession(id,'archive');expect(readClaudeSession(id)?.archived).toBe(true);
    await mutateClaudeSession(id,'restore');expect(readClaudeSession(id)?.archived).toBe(false);
  } finally {
    if(id&&readClaudeSession(id)?.status==='idle')await mutateClaudeSession(id,'delete');
    flushSessionRecording();configureSqliteStateStore(undefined);store.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
},100000);
