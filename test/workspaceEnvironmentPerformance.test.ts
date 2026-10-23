import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import * as childProcess from 'child_process';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {readWorkspaceEnvironment} from '../src/services/workspaceTools';

vi.mock('child_process', {spy:true});
afterEach(()=>vi.restoreAllMocks());

describe('workspace environment inspection',()=>{
  function processes(failure?:'remote'|'diff'|'rev-parse'){
    const children:Array<{child:EventEmitter;stdout:PassThrough;stderr:PassThrough;args:string[]}>=[];
    const spawn=vi.spyOn(childProcess,'spawn').mockImplementation((_command,args)=>{
      const child=new EventEmitter(),stdout=new PassThrough(),stderr=new PassThrough();
      Object.assign(child,{stdout,stderr,exitCode:0,killed:false,kill:vi.fn()});
      children.push({child,stdout,stderr,args:args as string[]});
      if(children.length===4)setTimeout(()=>{
        for(const record of children){
          const command=record.args.find(arg=>['status','diff','remote','rev-parse'].includes(arg))!;
          record.stdout.write(command==='status'?'## main\0 M proof.txt\0':command==='diff'?'2\t1\tproof.txt\n':command==='remote'?'origin\n':'');
          if(command===failure)record.stderr.write('inspection unavailable');
          record.child.emit('close',command===failure?1:0,null);
        }
      },20);
      return child as never;
    });
    return spawn;
  }
  it('starts independent Git reads together and shares simultaneous project inspections',async()=>{
    const spawn=processes();
    const [first,second]=await Promise.all([readWorkspaceEnvironment(process.cwd()),readWorkspaceEnvironment(process.cwd())]);
    expect(spawn).toHaveBeenCalledTimes(4);expect(first).toEqual(second);
    expect(first).toMatchObject({changes:1,additions:2,deletions:1,hasRemote:true});
    expect(spawn.mock.calls.some(([,args])=>args?.includes('--no-optional-locks'))).toBe(true);
  });
  it.each(['remote','diff','rev-parse'] as const)('reports %s failures instead of presenting fabricated zero values',async failure=>{
    processes(failure);
    await expect(readWorkspaceEnvironment(process.cwd())).rejects.toThrow(/could not be verified|inspection unavailable/);
  });
});
