import { expect,it } from 'vitest';
import { userProjectLabel,userWorkspaceNotice,userSessionActivity } from '../webview-src/dashboard/userWorkspacePresentation';

it('uses project labels without displaying physical workspace folders',()=>{
 const projects=[{id:'personal',path:'C:/team/alex',label:'My workspace'},{id:'planning',path:'C:/team/alex/plan',label:'Planning'}];
 expect(userProjectLabel('C:\\team\\alex',projects)).toBe('My workspace');
 expect(userProjectLabel('C:/team/alex/plan',projects)).toBe('Planning');
 expect(userProjectLabel('C:/private/internal')).toBe('My workspace');
});
it.each(['Cannot read C:\\private\\file.txt','ENOENT /home/service/work','API HTTP 503 token expired','Codex provider disconnected','Postgres error'])('replaces technical UI diagnostics: %s',message=>{
 expect(userWorkspaceNotice(message)).toBe('This request could not be completed. Please try again. Your work is saved.');
});
it('preserves useful plain-language outcomes',()=>{
 for(const message of ['Project added.','Please wait; your request is queued.','The file changed. Refresh before saving.','File saved.'])expect(userWorkspaceNotice(message)).toBe(message);
});
it('preserves command text, full output and activity identity while masking only the host path and private diagnostics',()=>{
 const message={id:'command-1',kind:'command' as const,text:'Run checks',command:'cd "C:/team/alex" && npm test',cwd:'C:/team/alex',output:'Checked C:/team/alex/index.ts\nAll 83 tests passed.',status:'completed' as const,debug:'Provider account credentials'};
 const safe=userSessionActivity(message,['C:/team/alex']);
 expect(safe.id).toBe(message.id);expect(safe.kind).toBe('command');expect(safe.command).toBe('cd "[workspace]" && npm test');
 expect(safe.output).toBe('Checked [workspace]/index.ts\nAll 83 tests passed.');expect(safe.cwd).toBeUndefined();expect(safe.debug).toBeUndefined();
 expect(message.cwd).toBe('C:/team/alex');
});
