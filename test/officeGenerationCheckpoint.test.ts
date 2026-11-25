import {expect,it} from 'vitest';
import {officeGenerationCheckpoint,resumeOfficeGeneration,type OfficeGenerationCheckpoint} from '../src/domain/officeGenerationCheckpoint';

const checkpoint=(messages:Record<string,unknown>[]):OfficeGenerationCheckpoint=>({messages,sideEffects:true,failedActions:[],deliverables:[['report.pptx',false]],researchSources:[['https://example.test','Confirmed source']]});
const call=(id:string)=>({id,type:'function',function:{name:'save_file',arguments:JSON.stringify({path:id+'.json',content:'Saved input'})}});
it('retains confirmed results and marks a partially completed tool batch unknown without replaying it',()=>{
 const saved=checkpoint([{role:'assistant',tool_calls:[call('done'),call('unknown')]},{role:'tool',tool_call_id:'done',content:'Saved done.json revision 123'}]);
 const resumed=resumeOfficeGeneration(saved);
 expect(resumed).toHaveLength(3);expect(resumed[1].content).toBe('Saved done.json revision 123');
 expect(resumed[2]).toMatchObject({role:'tool',tool_call_id:'unknown',content:expect.stringContaining('Do not repeat a write')});
 expect(saved.messages).toHaveLength(2);
});
it('bounds checkpoint size by retaining complete exchanges with the latest confirmed step',()=>{
 const messages=Array.from({length:20},(_,i)=>[{role:'assistant',tool_calls:[call('step-'+i)]},{role:'tool',tool_call_id:'step-'+i,content:'x'.repeat(40000)}]).flat();
 const saved=officeGenerationCheckpoint(checkpoint(messages));
 expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512000);expect(saved.messages[0].role).toBe('assistant');
 expect(saved.messages.at(-1)?.tool_call_id).toBe('step-19');expect(saved.deliverables).toEqual([['report.pptx',false]]);
 expect(resumeOfficeGeneration(saved)).toEqual(saved.messages);
});
