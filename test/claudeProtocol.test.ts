import { describe, expect, it } from 'vitest';
import { claudeMessage, claudePermissionMode, claudeQuota, claudeUsage, claudeUserMessage } from '../src/services/claudeProtocol';

describe('Claude native protocol', () => {
  it.each([
    ['read-only',true,'plan'], ['read-only',false,'plan'], ['workspace-write',true,'acceptEdits'],
    ['workspace-write',false,'default'], ['danger-full-access',true,'bypassPermissions'], ['danger-full-access',false,'default']
  ])('maps Access=%s and Auto approve=%s to native %s', (access, auto, mode) => {
    expect(claudePermissionMode(access as string,auto as boolean)).toBe(mode);
  });
  it('preserves text and native image blocks without shell arguments', () => {
    expect(claudeUserMessage('session','hello $(unsafe)')).toMatchObject({type:'user',message:{content:[{type:'text',text:'hello $(unsafe)'}]}});
    expect(()=>claudeUserMessage('session','')).toThrow('Write a message');
  });
  it('renders reasoning, native tools and their errors without dropping results', () => {
    const messages = claudeMessage({type:'assistant',uuid:'a',message:{id:'m',content:[
      {type:'thinking',thinking:'Plan'}, {type:'text',text:'Hello'}, {type:'tool_use',id:'tool',name:'Read',input:{file_path:'a'}}
    ]}});
    expect(messages).toEqual([
      expect.objectContaining({kind:'reasoning',text:'Plan'}),expect.objectContaining({role:'assistant',text:'Hello'}),
      expect.objectContaining({id:'tool-tool',kind:'tool-call',title:'Read',arguments:'{"file_path":"a"}'})
    ]);
    expect(claudeMessage({type:'user',uuid:'u',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'denied',is_error:true}]}})).toEqual([expect.objectContaining({id:'tool-tool',result:'denied',status:'failed'})]);
  });
  it('tracks every reported quota window and reset, without inventing percentages', () => {
    let quota = claudeQuota(undefined,{status:'allowed_warning',rateLimitType:'five_hour',utilization:0.8,resetsAt:2_000_000_000});
    quota = claudeQuota(quota,{status:'rejected',rateLimitType:'seven_day_opus',resetsAt:2_000_000_100});
    expect(quota?.limits).toEqual([{kind:'five_hour',status:'allowed_warning',usedPercent:80,resetsAt:2_000_000_000},{kind:'seven_day_opus',status:'rejected',resetsAt:2_000_000_100}]);
    expect(claudeQuota(quota,{status:'allowed',rateLimitType:'five_hour',utilization:NaN})?.limits.find(row=>row.kind==='five_hour')?.usedPercent).toBeUndefined();
    expect(claudeQuota(undefined,{status:'invented',utilization:0})).toBeUndefined();
  });
  it('keeps cached tokens and context separate from cumulative usage', () => {
    expect(claudeUsage({input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:30,output_tokens:5},{model:{contextWindow:200000}},61)).toEqual({input:60,cachedInput:20,output:5,total:65,contextWindow:200000,contextTokens:61});
  });
  it('includes native subagent model usage without treating cumulative tokens as context', () => {
    expect(claudeUsage({ input_tokens: 1, output_tokens: 1 }, { main: { inputTokens: 10, cacheReadInputTokens: 20, outputTokens: 5, contextWindow: 200000 }, agent: { inputTokens: 3, cacheCreationInputTokens: 4, outputTokens: 2 } }, 50)).toEqual({ input: 37, cachedInput: 20, output: 7, total: 44, contextWindow: 200000, contextTokens: 50 });
  });
});
