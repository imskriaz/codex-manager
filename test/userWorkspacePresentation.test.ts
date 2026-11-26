import { isNamedProject } from '../webview-src/dashboard/projectPicker';
import { expect,it } from 'vitest';
import { currentUserWorkspacePlan,currentUserWorkspaceQuestion,userProjectLabel,userWorkspaceNotice,userSessionActivity,userCommandSummary,userToolSummary } from '../webview-src/dashboard/userWorkspacePresentation';
import { userWorkspacePathText, userWorkspaceActivityText } from '../src/domain/teamWorkspacePresentation';
import { messageSessionPlan, sessionPlanMessage } from '../src/domain/sessionPlan';
import { sessionQuestionReply } from '../src/domain/sessionQuestions';
it('prioritizes the latest unanswered question and restores it when an unsent answer is removed',()=>{
 const question={id:'question',role:'assistant' as const,text:'Choose',questions:[{title:'Which file?'},{title:'Which format?'}]};
 const reply={id:'answer',role:'user' as const,text:sessionQuestionReply(question,{'0':'Notes','1':'Text'})};
 expect(currentUserWorkspaceQuestion([question])).toBe(question);
 expect(currentUserWorkspaceQuestion([{...question,role:'user'}])).toBeUndefined();
 expect(currentUserWorkspaceQuestion([question],[reply])).toBeUndefined();
 expect(currentUserWorkspaceQuestion([question],[])).toBe(question);
 expect(currentUserWorkspaceQuestion([question,reply])).toBeUndefined();
 expect(currentUserWorkspaceQuestion([question,{...reply,text:'Do something else'}])).toBeUndefined();
 expect(currentUserWorkspaceQuestion([question],[{...reply,text:sessionQuestionReply(question,{'0':'Notes'})}])).toBe(question);
});
it('summarizes file tool envelopes without showing file contents or metadata and preserves failures',()=>{
 const message={id:'save',text:'Update file',title:'Update file',kind:'tool-call' as const,status:'completed' as const,arguments:JSON.stringify({path:'index.html',content:'<html>private content</html>'}),result:JSON.stringify({status:'completed',payload:{workspaceFile:{content:'<html>private content</html>',revision:'internal'},notice:{message:'File created.'}}})};
 expect(userToolSummary(message)).toBe('File created.');expect(message.result).toContain('internal');
 expect(userToolSummary({...message,status:'inProgress'})).toContain('Working');
 expect(userToolSummary({...message,result:JSON.stringify({status:'failed',error:'The file changed. Read it again before saving.'})})).toBe('The file changed. Read it again before saving.');
 expect(userToolSummary({...message,status:'failed',text:'The source could not be reached.',result:'not JSON'})).toBe('The source could not be reached.');
 expect(userToolSummary({...message,status:'failed',text:message.title,result:'not JSON'})).toContain('could not be completed');
 expect(userToolSummary({...message,status:'unknown'})).toContain('could not be confirmed');
 expect(userToolSummary({...message,status:'interrupted'})).toContain('stopped');
 for(const result of ['null','42','[]','{broken','plain contents'])expect(userToolSummary({...message,result})).toBe('Action completed.');
});
it('keeps the working turn plan pinned while a later follow-up is queued, and never reuses it for a new turn',()=>{
 const plan={...sessionPlanMessage('plan',{steps:[{step:'Write',status:'inProgress'},{step:'Check',status:'pending'}]}),turnId:'working'};
 const messages=[{id:'user',role:'user' as const,text:'First',turnId:'working'},plan,{id:'later',role:'user' as const,text:'Later',turnId:'queued'}];
 expect(currentUserWorkspacePlan(messages,'working',true)).toBe(plan);expect(currentUserWorkspacePlan(messages,'queued',true)).toBeUndefined();expect(currentUserWorkspacePlan(messages,undefined,false)).toBeUndefined();
 expect(currentUserWorkspacePlan(messages.slice(0,-1),undefined,false)?.status).toBe('unknown');
});
it('masks question choices and structured plan paths without corrupting JSON or changing user content',()=>{
 const safe=userSessionActivity({id:'q',role:'assistant',text:'Choose',questions:[{title:'Read C:/private/alex/file.txt?',options:['C:/private/alex/file.txt','Other']} ]},['C:/private/alex']);expect(JSON.stringify(safe)).not.toContain('C:/');
 const plan=userSessionActivity(sessionPlanMessage('plan',{steps:[{step:'Read "C:\\private\\alex\\file.txt"',status:'inProgress'}]}),['C:\\private\\alex']);expect(messageSessionPlan(plan)?.steps[0]?.step).not.toContain('C:');expect(messageSessionPlan(plan)?.steps).toHaveLength(1);
 const user={id:'user',role:'user' as const,text:'C:/private/alex/file.txt'};expect(userSessionActivity(user,['C:/private/alex'])).toBe(user);
});

it('uses project labels without displaying physical workspace folders',()=>{
 const projects=[{id:'personal',path:'C:/team/alex',label:'My workspace'},{id:'planning',path:'C:/team/alex/plan',label:'Planning'}];
 expect(userProjectLabel('C:\\team\\alex',projects)).toBe('My Workspace');
 expect(userProjectLabel('C:/team/alex/plan',projects)).toBe('Planning');
 expect(userProjectLabel('C:/private/internal')).toBe('My Workspace');
});
it.each(['Cannot read C:\\private\\file.txt','ENOENT /home/service/work','API HTTP 503 token expired','Codex provider disconnected','Postgres error'])('replaces technical UI diagnostics: %s',message=>{
 expect(userWorkspaceNotice(message)).toBe('This request could not be completed. Please try again.');
});
it('preserves useful plain-language outcomes',()=>{
 for(const message of ['Project added.','Please wait; your request is queued.','The file changed. Refresh before saving.','File saved.'])expect(userWorkspaceNotice(message)).toBe(message);
});
it('preserves command text, full output and activity identity while masking only the host path and private diagnostics',()=>{
 const message={id:'command-1',kind:'command' as const,text:'Run checks',command:'cd "C:/team/alex" && npm test',cwd:'C:/team/alex',output:'Checked C:/team/alex/index.ts\nAll 83 tests passed.',status:'completed' as const,debug:'Provider account credentials'};
 const safe=userSessionActivity(message,['C:/team/alex']);
 expect(safe.id).toBe(message.id);expect(safe.kind).toBe('command');expect(safe.command).toBe('cd "alex" && npm test');
 expect(safe.output).toBe('Checked alex/index.ts\nAll 83 tests passed.');expect(safe.cwd).toBeUndefined();expect(safe.debug).toBeUndefined();
 expect(message.cwd).toBe('C:/team/alex');
});
it.each([
 ['D:\\projects\\codex-manager\\output\\commit.cjs','codex-manager\\output\\commit.cjs'],
 ['d:\\PROJECTS\\CODEX-MANAGER\\output\\commit.cjs','codex-manager\\output\\commit.cjs'],
 ['D:/projects/codex-manager/output/commit.cjs','codex-manager/output/commit.cjs'],
 ['"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command \'$r=1\'','"PowerShell" -NoProfile -Command \'$r=1\''],
 ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command npm test','"PowerShell" -Command npm test'],
 ['C:\\Windows\\System32\\cmd.exe /c npm test','cmd.exe /c npm test'],
 ['C:\\ /tmp','[folder] [folder]'],
 ['"C:\\Program Files\\Tools\\check.exe" --output report.txt','"check.exe" --output report.txt'],
 [JSON.stringify({command:'"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command \'$r=1\''}),JSON.stringify({command:'"PowerShell" -NoProfile -Command \'$r=1\''})],
 ['/usr/bin/pwsh -NoProfile -Command npm test','PowerShell -NoProfile -Command npm test'],
 ['\'/usr/bin/node output/check.js\'','\'node output/check.js\''],
 ['/home/service/private/log.txt /etc /tmp','log.txt [folder] [folder]'],
 ['\\\\server\\private\\report.txt','report.txt'],
 ['https://example.test/a/b codex-manager/output/file.txt npm test','https://example.test/a/b codex-manager/output/file.txt npm test'],
 ['D:\\projects\\codex-manager-other\\file.txt','file.txt'],
 [JSON.stringify({path:'D:\\projects\\codex-manager\\output\\file.txt'}),JSON.stringify({path:'codex-manager\\output\\file.txt'})],
])('shortens host and system paths without changing commands: %s',(input,expected)=>{
 const safe=userWorkspacePathText(input,['D:\\projects\\codex-manager']);
 expect(safe).toBe(expected);expect(userWorkspacePathText(safe,['D:\\projects\\codex-manager'])).toBe(safe);
});
it('masks paths in every activity surface without dropping details or changing the source',()=>{
 const path='D:\\projects\\codex-manager\\output\\commit.cjs';
 const message={id:'file',kind:'file-change' as const,text:path,title:path,subtitle:path,arguments:JSON.stringify({path}),result:path,output:path,changes:[{path,kind:'update',diff:'+ '+path}]};
 const safe=userSessionActivity(message,['D:\\projects\\codex-manager']);
 for(const value of [safe.text,safe.title,safe.subtitle,safe.arguments,safe.result,safe.output,safe.changes?.[0]?.path,safe.changes?.[0]?.diff])expect(value).not.toMatch(/[a-z]:[\\/]/i);
 expect(safe.changes?.[0]?.path).toBe('codex-manager\\output\\commit.cjs');expect(message.text).toBe(path);
});
it.each([
 ['"PowerShell" -NoProfile -Command \'$r=1; npm test\'','PowerShell: $r=1; npm test'],
 ['PowerShell -NoLogo -NonInteractive -c npm test','PowerShell: npm test'],
 ['npm test\nnpm run build','npm test'],
 ['PowerShell -File check.ps1','PowerShell -File check.ps1'],
])('uses readable command summaries while preserving the executed script: %s',(command,summary)=>{
 expect(userCommandSummary(command)).toBe(summary);
});
it('labels file reads with the project-relative file while retaining all recorded information',()=>{
 const safe=userSessionActivity({id:'read',kind:'tool-call',title:'Read file',text:'Read the whole file',arguments:JSON.stringify({path:'D:\\projects\\codex-manager\\notes.txt'}),result:'All contents'},['D:\\projects\\codex-manager']);
 expect(safe.title).toBe('Read File · codex-manager\\notes.txt');expect(safe.text).toBe('Read the whole file');expect(safe.result).toBe('All contents');
 const legacy=userSessionActivity({id:'read',kind:'tool-call',title:'Read /srv/projects/codex-manager/notes.txt',text:'Read'},['/srv/projects/codex-manager']);
 expect(legacy.title).toBe('Read File · codex-manager/notes.txt');
});
it('labels browsing with its recorded URL and keeps connected sources separate from file reads', () => {
 const browsing = userSessionActivity({id:'web',kind:'tool-call',title:'Read website',text:'Source read.',arguments:JSON.stringify({url:'https://example.test/report/2026?q=wages'})},[]);
 expect(browsing.title).toBe('Browse website · https://example.test/report/2026?q=wages');
 expect(userSessionActivity(browsing,[]).title).toBe(browsing.title);
 expect(userToolSummary({...browsing,status:'completed'})).toBe('Website read.');
 expect(userSessionActivity({id:'legacy',kind:'tool-call',title:'Read File · website',text:''},[]).title).toBe('Browse website');
 expect(userSessionActivity({id:'source',kind:'tool-call',title:'Read connected source',text:''},[]).title).toBe('Read connected source');
 expect(userSessionActivity({...browsing,title:'Read website',arguments:JSON.stringify({url:'https://user:secret@example.test/'})},[]).title).toBe('Browse website');
});
it('preserves useful tool arguments and results while hiding credentials and private system details', () => {
 const value=JSON.parse(userWorkspaceActivityText(JSON.stringify({tool:'list_orders',arguments:{buyer:'Example',limit:10},result:{count:42,filename:'report.xlsx'},password:'private-password',api_key:'private-key',endpoint:'http://10.0.0.1/admin',guidance:'private system prompt',url:'https://example.test/report?token=abc'}),[]));
 expect(value.tool).toBe('list_orders');expect(value.arguments).toEqual({buyer:'Example',limit:10});expect(value.result.count).toBe(42);
 expect(value.url).not.toContain('abc');
 expect(value.password).toBe('[hidden]');expect(value.api_key).toBe('[hidden]');expect(value.endpoint).toBe('[hidden]');expect(value.guidance).toBe('[hidden]');
 expect(userWorkspaceActivityText('Authorization: Bearer abc-secret https://localhost:39875/admin',[])).not.toContain('abc-secret');
 expect(userWorkspaceActivityText('Read https://example.test/report?q=verified',[])).toContain('https://example.test/report?q=verified');
 expect(userWorkspaceActivityText(JSON.stringify({content:[{type:'text',text:JSON.stringify({password:'nested-secret',count:42})}]}),[])).not.toContain('nested-secret');
});

 it('keeps only named projects outside My Workspace', () => {
   expect(isNamedProject({label:'My workspace',path:'C:/users/work'})).toBe(false);
   expect(isNamedProject({label:'Chat',path:'C:/users/work/Chat-cf22e8c4-8c62-4576-a329-123456789abc'})).toBe(false);
   expect(isNamedProject({label:'Planning',path:'C:/users/work/plan'})).toBe(true);
 });
