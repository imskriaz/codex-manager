import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fetch} from 'undici';
const configuration=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('../src/infrastructure/config/extensionSettings',()=>({getCodexManagerConfiguration:()=>({get:(key:string,fallback:unknown)=>configuration.get(key)??fallback})}));
vi.mock('undici',async original=>({...await original<typeof import('undici')>(),fetch:vi.fn()}));
import {DEFAULT_OFFICE_INTEGRATIONS,validateOfficeIntegrations,publicOfficeIntegrations,checkOfficeIntegrations,readOfficeIntegrations} from '../src/services/officeIntegrations';
import {searchOfficeWeb,readOfficeWebPage} from '../src/services/officeSources';
import {renderOfficeThumbnails,officeDocumentPdf} from '../src/services/officeRendering';
import {runOfficeRuntime} from '../src/services/officeRuntime';
import {createOfficeDocument} from '../src/services/officeDocuments';
import * as users from '../src/services/officeUsers';
import {configureSqliteStateStore,SqliteStateStore} from '../src/storage/sqliteState';
import {configureCrossWindowOperationCoordinator} from '../src/utils/crossWindowOperations';
import {removeTestDirectory} from './testFilesystem';
let root:string,project:string,store:SqliteStateStore,user:users.OfficeUser;
beforeEach(async()=>{configuration.clear();vi.mocked(fetch).mockReset();root=await fs.mkdtemp(path.join(os.tmpdir(),'office-services-'));project=path.join(root,'files','project');await fs.mkdir(project,{recursive:true});store=await SqliteStateStore.open(path.join(root,'state.sqlite'));configureSqliteStateStore(store);await configureCrossWindowOperationCoordinator(root);user={id:'alex',username:'alex',displayName:'Alex',role:'user',enabled:true,features:['files','generalChat','terminal','browser'],workspacePath:path.dirname(project),mcpServers:[],createdAt:0,defaultPrompt:''};vi.spyOn(users,'getOfficeUser').mockResolvedValue(user);});
afterEach(async()=>{vi.restoreAllMocks();configureSqliteStateStore(undefined);store.close();await removeTestDirectory(root);});
it('validates configured endpoints, preserves omitted keys and never publishes secrets',()=>{
 const value=validateOfficeIntegrations({rendererUrl:'http://127.0.0.1:39900/',searchDomains:['ISO.ORG','iso.org']},{...DEFAULT_OFFICE_INTEGRATIONS,searchToken:'secret'});expect(value.rendererUrl).toBe('http://127.0.0.1:39900');expect(value.searchDomains).toEqual(['iso.org']);expect(JSON.stringify(publicOfficeIntegrations(value))).not.toContain('secret');expect(publicOfficeIntegrations(value).searchConfigured).toBe(true);
 for(const rendererUrl of ['http://private.example','https://user:secret@host.test','https://host.test?key=secret','file:///private'])expect(()=>validateOfficeIntegrations({rendererUrl})).toThrow();expect(()=>validateOfficeIntegrations({searchDomains:['bad domain']})).toThrow();expect(validateOfficeIntegrations({searchToken:''},value).searchToken).toBe('');
});
it('keeps unavailable services explicit without leaking endpoints or credentials',async()=>{
 configuration.set('officeServices',{...DEFAULT_OFFICE_INTEGRATIONS,runtimeUrl:'https://runner.test',runtimeToken:'private-key'});vi.mocked(fetch).mockRejectedValue(new Error('network private-key'));expect(await checkOfficeIntegrations(new AbortController().signal)).toMatchObject({runtime:{status:'unavailable'},renderer:{status:'disabled'},search:{status:'disabled'}});
});
it('disables invalid optional settings without breaking chat and reports them to the administrator',async()=>{
 configuration.set('officeServices',{rendererUrl:'file:///private',rendererToken:'secret'});expect(readOfficeIntegrations()).toEqual(DEFAULT_OFFICE_INTEGRATIONS);expect(publicOfficeIntegrations().configurationWarning).toContain('invalid');expect(JSON.stringify(publicOfficeIntegrations())).not.toContain('secret');expect(await checkOfficeIntegrations(new AbortController().signal)).toMatchObject({configuration:{status:'invalid'},runtime:{status:'disabled'}});
});
it('filters search to approved HTTPS sources and treats snippets as leads',async()=>{
 configuration.set('officeServices',{...DEFAULT_OFFICE_INTEGRATIONS,searchToken:'key',searchDomains:['iso.org']});vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({web:{results:[{title:'Standard',url:'https://www.iso.org/standard/1',description:'<b>Scope</b>'},{url:'https://outside.test/claim'},{url:'http://iso.org/unsafe'},{url:'https://www.iso.org/standard/1'}]}})) as never);
 const result=await searchOfficeWeb('textile test method',new AbortController().signal);expect(result.results).toEqual([{title:'Standard',url:'https://www.iso.org/standard/1',snippet:'Scope',published:undefined}]);expect(result.instruction).toContain('not verified evidence');expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({'X-Subscription-Token':'key'});await expect(readOfficeWebPage('https://outside.test/',new AbortController().signal)).rejects.toThrow('outside');
});
it('renders real PDF thumbnails locally and reuses unchanged previews',async()=>{
 const pdf=await createOfficeDocument({path:'brief.pdf',text:'Buyer approval'});await fs.writeFile(path.join(project,'brief.pdf'),pdf);const first=await renderOfficeThumbnails(user,project,{path:'brief.pdf'},new AbortController().signal),next=await renderOfficeThumbnails(user,project,{path:'brief.pdf'},new AbortController().signal);expect(first.previews).toHaveLength(1);expect(next.previews).toEqual(first.previews);expect((await fs.readFile(path.join(project,first.previews[0].path))).subarray(1,4).toString()).toBe('PNG');expect(fetch).not.toHaveBeenCalled();
},30000);
it('uses the configured converter for Office pages and rejects non-PDF output',async()=>{
 const docx=await createOfficeDocument({path:'brief.docx',text:'Approved'});await expect(officeDocumentPdf('brief.docx',docx,new AbortController().signal)).rejects.toThrow('not configured');configuration.set('officeServices',{...DEFAULT_OFFICE_INTEGRATIONS,rendererUrl:'http://127.0.0.1:39900',rendererToken:'key'});vi.mocked(fetch).mockResolvedValue(new Response('not a pdf') as never);await expect(officeDocumentPdf('brief.docx',docx,new AbortController().signal)).rejects.toThrow('invalid');
});
it('supplies only named project inputs and imports isolated output without replacing user files',async()=>{
 configuration.set('officeServices',{...DEFAULT_OFFICE_INTEGRATIONS,runtimeUrl:'http://127.0.0.1:39901',runtimeToken:'key'});await fs.writeFile(path.join(project,'input.csv'),'a,b');await fs.writeFile(path.join(project,'.env'),'secret');await fs.writeFile(path.join(project,'report.txt'),'original');vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'completed',stdout:'3',stderr:'',files:[{path:'report.txt',data:Buffer.from('output').toString('base64')}]})) as never);
 const value=await runOfficeRuntime(user,project,{language:'python',code:'print(3)',files:['input.csv']},new AbortController().signal);const body=String(vi.mocked(fetch).mock.calls[0][1]?.body);expect(body).not.toMatch(/secret|\.env/);expect(body).not.toContain(root);expect(value.status).toBe('completed');expect(await fs.readFile(path.join(project,value.files[0]),'utf8')).toBe('output');expect(await fs.readFile(path.join(project,'report.txt'),'utf8')).toBe('original');
 await expect(runOfficeRuntime(user,project,{language:'node',code:'x',files:['.env']},new AbortController().signal)).rejects.toThrow('script');await expect(runOfficeRuntime({...user,features:['files']},project,{language:'node',code:'x',files:[]},new AbortController().signal)).rejects.toThrow('not enabled');
});
it('rejects runtime traversal and never imports failed execution outputs',async()=>{
 configuration.set('officeServices',{...DEFAULT_OFFICE_INTEGRATIONS,runtimeUrl:'http://127.0.0.1:39901'});vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'completed',stdout:'',stderr:'',files:[{path:'../escape',data:'eA=='}]})) as never);await expect(runOfficeRuntime(user,project,{language:'node',code:'x',files:[]},new AbortController().signal)).rejects.toThrow('invalid');
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'failed',stdout:'',stderr:'test failed',files:[{path:'x.txt',data:'eA=='}]})) as never);expect(await runOfficeRuntime(user,project,{language:'node',code:'x',files:[]},new AbortController().signal)).toMatchObject({status:'failed',files:[]});await expect(fs.stat(path.join(project,'runtime-output'))).rejects.toThrow();
});
it('rejects changed inputs, revoked permission and cancellation before importing runtime output',async()=>{
 configuration.set('officeServices',{...DEFAULT_OFFICE_INTEGRATIONS,runtimeUrl:'http://127.0.0.1:39901'});const result=()=>new Response(JSON.stringify({status:'completed',stdout:'',stderr:'',files:[{path:'x.txt',data:'eA=='}]}));await fs.writeFile(path.join(project,'input.txt'),'original');
 vi.mocked(fetch).mockImplementationOnce(async()=>{await fs.writeFile(path.join(project,'input.txt'),'changed');return result() as never;});await expect(runOfficeRuntime(user,project,{language:'node',code:'x',files:['input.txt']},new AbortController().signal)).rejects.toThrow('input file changed');
 vi.mocked(fetch).mockResolvedValue(result() as never);vi.mocked(users.getOfficeUser).mockResolvedValueOnce({...user,features:['files']});await expect(runOfficeRuntime(user,project,{language:'node',code:'x',files:[]},new AbortController().signal)).rejects.toThrow('access changed');
 const controller=new AbortController();controller.abort();await expect(runOfficeRuntime(user,project,{language:'node',code:'x',files:[]},controller.signal)).rejects.toThrow();await expect(fs.stat(path.join(project,'runtime-output'))).rejects.toThrow();
});
