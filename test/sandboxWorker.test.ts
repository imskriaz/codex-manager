import {expect,it} from 'vitest';
import {dockerArgs,validRun} from '../tools/sandbox-worker.mjs';
it('hardens the sandbox without mounting the host, allowing networking, or exposing secrets',()=>{
 const args=dockerArgs('job','workspace-sandbox:local');for(const expected of ['--read-only','--network','none','--pids-limit','--memory','256m','--cap-drop','ALL','no-new-privileges','65534:65534'])expect(args).toContain(expected);
 expect(args).not.toContain('--privileged');expect(args).not.toContain('--volume');expect(args).not.toContain('--mount');expect(args.join(' ')).not.toMatch(/docker\.sock|host\.docker|--network host/);
});
it('rejects invalid runtime payloads before starting Docker',()=>{
 const input={language:'python',code:'print(1)',files:[{path:'data.csv',data:'eA=='}]};expect(validRun(input)).toBe(true);
 for(const change of [{language:'shell'},{code:''},{files:[{path:'../secret',data:'eA=='}]},{files:[{path:'.env',data:'eA=='}]},{files:[{path:'C:/secret',data:'eA=='}]},{files:[{path:'x',data:'invalid'}]},{files:[{path:'x',data:'eA=='},{path:'X',data:'eA=='}]}])expect(validRun({...input,...change})).toBe(false);
});
