import {afterEach,beforeEach,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {configureSqliteStateStore,SqliteStateStore} from '../src/storage/sqliteState';
import {configureCrossWindowOperationCoordinator} from '../src/utils/crossWindowOperations';
import {writeOfficeBinary,importOfficeAttachment} from '../src/services/officeFiles';
import {listOfficeFileHistory,restoreOfficeFile,discardOfficeFile} from '../src/services/officeFileHistory';
import {manageOfficeWorkspacePaths} from '../src/services/officeWorkspacePaths';
import {createOfficeDocument,extractOfficeDocument} from '../src/services/officeDocuments';
import type {OfficeUser} from '../src/services/officeUsers';
import {removeTestDirectory} from './testFilesystem';
let directory:string,store:SqliteStateStore,user:OfficeUser;
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'workspace-recovery-'));store=await SqliteStateStore.open(path.join(directory,'state.sqlite'));configureSqliteStateStore(store);await configureCrossWindowOperationCoordinator(directory);const root=path.join(directory,'files');await fs.mkdir(root);user={id:'alex',username:'alex@example.test',displayName:'Alex',role:'user',enabled:true,features:['files','tasks'],workspacePath:root,defaultPrompt:'',mcpServers:[],createdAt:0};});
afterEach(async()=>{configureSqliteStateStore(undefined);store.close();await removeTestDirectory(directory);});
it('versions an edit and restores it only with the current revision, without losing the replaced contents',async()=>{
 const first=await writeOfficeBinary(user,user.workspacePath,'reports/buyer.txt',Buffer.from('First draft'));
 await expect(writeOfficeBinary(user,user.workspacePath,'reports/buyer.txt',Buffer.from('Stale edit'),'wrong')).rejects.toThrow('changed');
 const second=await writeOfficeBinary(user,user.workspacePath,'reports/buyer.txt',Buffer.from('Updated'),first.revision);const old=listOfficeFileHistory(user)[0]!;
 await expect(restoreOfficeFile(user,old.id,'wrong')).rejects.toThrow('changed');await restoreOfficeFile(user,old.id,second.revision);
 expect(await fs.readFile(path.join(user.workspacePath,old.path),'utf8')).toBe('First draft');expect(listOfficeFileHistory(user)).toHaveLength(2);
 await expect(restoreOfficeFile({...user,id:'sam'},old.id,second.revision)).rejects.toThrow('unavailable');
});
it('moves a complete project to Trash, protects the root and restores without overwriting a new file',async()=>{
 await writeOfficeBinary(user,user.workspacePath,'project/a.txt',Buffer.from('Original'));let inspected=await manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'inspect',path:'project'});
 await manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'delete',path:'project',revision:inspected.revision});const saved=listOfficeFileHistory(user)[0]!;expect(saved.kind).toBe('trash');await expect(fs.stat(path.join(user.workspacePath,'project'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'inspect',path:'.'})).toMatchObject({files:0});
 inspected=await manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'inspect',path:'.'});await expect(manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'delete',path:'.',revision:inspected.revision})).rejects.toThrow('root');
 await restoreOfficeFile(user,saved.id);expect(await fs.readFile(path.join(user.workspacePath,'project/a.txt'),'utf8')).toBe('Original');expect(listOfficeFileHistory(user)).toEqual([]);
 inspected=await manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'inspect',path:'project'});await manageOfficeWorkspacePaths(user,user.workspacePath,{operation:'delete',path:'project',revision:inspected.revision});await fs.mkdir(path.join(user.workspacePath,'project'));const collision=listOfficeFileHistory(user)[0]!;await expect(restoreOfficeFile(user,collision.id)).rejects.toThrow('already exists');await discardOfficeFile(user,collision.id);expect(listOfficeFileHistory(user)).toEqual([]);
});
it('imports large text idempotently, and rejects changing an existing upload, private paths and quota growth',async()=>{
 const file={id:'order',name:'buyer.txt',kind:'text' as const,mimeType:'text/plain',size:40000,data:'a'.repeat(40000)};const first=await importOfficeAttachment(user,file);expect(first.text.length).toBeLessThan(31000);expect((await importOfficeAttachment(user,file)).path).toBe(first.path);
 await expect(importOfficeAttachment(user,{...file,data:'different'})).rejects.toThrow('changed');
 for(const file of ['../escape.txt','.workspace-trash/secret.txt','.workspace-history/secret.txt'])await expect(writeOfficeBinary(user,user.workspacePath,file,Buffer.from('no'))).rejects.toThrow();
 await expect(writeOfficeBinary({...user,limits:{storageMb:1,dailyTokens:0,dailyRequests:0}},user.workspacePath,'large.txt',Buffer.alloc(1048576))).rejects.toThrow('storage');
});
it('creates real XLSX, DOCX, PPTX and PDF documents and reads them in bounded workers',async()=>{
 for(const extension of ['xlsx','docx','pptx','pdf']){
 const data=await createOfficeDocument({path:'costing.'+extension,text:'# Buyer follow-up\nLab dip approval needed',slides:[{title:'Buyer follow-up',bullets:['Lab dip approval needed'],notes:'Confirm with buyer.'}],sheets:[{name:'Costing',rows:[['Style','Quantity','Unit cost','Order value'],['ST100',2400,2.75,{formula:'B2*C2'}]]}]});
 expect(data.length).toBeGreaterThan(500);let text:string;try{text=await extractOfficeDocument('costing.'+extension,data);}catch(error){throw new Error(extension+': '+String(error));}expect(text).toMatch(extension==='xlsx'?/ST100/:/Lab dip/);
 if(extension==='xlsx')expect(text).toMatch(/B2\*C2/);
 }
},30000);
it('rejects invalid document headers, external spreadsheet formulas and unsupported exports',async()=>{
 await expect(extractOfficeDocument('empty.docx',Buffer.from('x'))).rejects.toThrow('incomplete');
 await expect(extractOfficeDocument('fake.pdf',Buffer.from('not a PDF'))).rejects.toThrow('format');
 await expect(createOfficeDocument({path:'attack.xlsx',sheets:[{name:'Sheet',rows:[[{formula:'WEBSERVICE("https://invalid.test")'}]]}]})).rejects.toThrow('local');
 await expect(createOfficeDocument({path:'bad.exe',text:'No'})).rejects.toThrow('XLSX');
 await expect(createOfficeDocument({path:'bad.pptx',slides:[{title:'Oversized',bullets:['x'.repeat(261)]}]})).rejects.toThrow('short bullets');
 await expect(createOfficeDocument({path:'bad.pptx',slides:[{title:'Test',bullets:[]}],theme:{accent:'url(external)'}})).rejects.toThrow('hexadecimal');
});

it('renders spreadsheet tables and PDF pages as sandboxable document previews, including Bengali text',async()=>{
 const pdf=await createOfficeDocument({path:'buyer.pdf',text:'Buyer follow-up: নমুনা অনুমোদন প্রয়োজন'});expect(await extractOfficeDocument('buyer.pdf',pdf,'html')).toMatch(/data:image\/png;base64,/);
 const xlsx=await createOfficeDocument({path:'buyer.xlsx',sheets:[{name:'Buyer',rows:[['<script>unsafe</script>',2400]]}]});const html=await extractOfficeDocument('buyer.xlsx',xlsx,'html');expect(html).toContain('<table>');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
 const pptx=await createOfficeDocument({path:'buyer.pptx',slides:[{title:'<script>Buyer</script>',bullets:['Approval pending']}]});const outline=await extractOfficeDocument('buyer.pptx',pptx,'html');expect(outline).toContain('Text content only');expect(outline).toContain('&lt;script&gt;Buyer');expect(outline).not.toContain('<script>');
},30000);

it('keeps each conversation upload in its own folder and charges its bytes',async()=>{
 const id=crypto.randomUUID(),file={id:'upload',name:'brief.txt',kind:'text' as const,mimeType:'text/plain',size:5,data:'brief'};
 const first=await importOfficeAttachment(user,file,true,id),second=await importOfficeAttachment(user,file,true,crypto.randomUUID());expect(first.path).toContain('.workspace-sessions/'+id+'/');expect(first.path).not.toBe(second.path);expect(await fs.readFile(path.join(user.workspacePath,first.path),'utf8')).toBe('brief');
});
