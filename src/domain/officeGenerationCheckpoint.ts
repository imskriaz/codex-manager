export type OfficeGenerationCheckpoint = {
  planId?:string;
  messages:Record<string,unknown>[];
  sideEffects:boolean;
  failedActions:Array<[string,string]>;
  deliverables:Array<[string,boolean]>;
  researchSources:Array<[string,string]>;
};
export type OfficeGenerationContinuation = {
  checkpoint?:OfficeGenerationCheckpoint;
  save:(value:OfficeGenerationCheckpoint)=>void;
};

/** Missing tool results are unknown outcomes, never instructions to replay a write. */
export function resumeOfficeGeneration(checkpoint:OfficeGenerationCheckpoint):Record<string,unknown>[] {
  const messages=structuredClone(checkpoint.messages);
  for(let index=0;index<messages.length;index++) {
    const calls=messages[index]!['tool_calls'];
    if(!Array.isArray(calls))continue;
    let end=index+1;while(end<messages.length&&messages[end]!['role']==='tool')end++;
    const replies=new Set(messages.slice(index+1,end).map(message=>message['tool_call_id']));
    const missing=calls.filter((call:{id:string})=>!replies.has(call.id)).map((call:{id:string})=>({role:'tool',tool_call_id:call.id,content:JSON.stringify({outcome:'unknown',instruction:'The service stopped before this action result was saved. Inspect the current target, revisions and saved activities before continuing. Do not repeat a write or external action whose outcome is unknown.'})}));
    messages.splice(end,0,...missing);index=end+missing.length-1;
  }
  return messages;
}

/** Retain whole tool exchanges; never cut JSON or leave orphaned tool replies. */
export function officeGenerationCheckpoint(value:OfficeGenerationCheckpoint):OfficeGenerationCheckpoint {
  const saved=structuredClone(value);
  while(Buffer.byteLength(JSON.stringify(saved),'utf8')>512_000) {
    const next=saved.messages.findIndex((message,index)=>index>0&&message['role']==='assistant');
    if(next<0) {
      // Large completed file payloads are already durable; retain their paths and results.
      for(const message of saved.messages) {
        const calls=message['tool_calls'];
        if(Array.isArray(calls))for(const call of calls as Array<{function:{arguments:string}}>) {
          if(call.function.arguments.length<8000)continue;
          const args=JSON.parse(call.function.arguments) as Record<string,unknown>;
          for(const key of ['content','slides','sheets','text','code'])if(args[key]!==undefined)args[key]='[Large action input omitted from checkpoint; inspect saved files and activity for exact contents.]';
          call.function.arguments=JSON.stringify(args);
        }
        if(message['role']==='tool'&&typeof message['content']==='string'&&message['content'].length>24000)message['content']=message['content'].slice(0,24000)+'\n[Checkpoint excerpt; read the saved source or file for the remainder.]';
      }
      break;
    }
    saved.messages.splice(0,next);
  }
  return saved;
}
