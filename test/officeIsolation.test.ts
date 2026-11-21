import { afterEach,beforeEach,expect,it,vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WebDashboardServer } from "../src/services/webDashboardServer";
import { createOfficeUser, updateOfficeUser, type OfficeUser } from "../src/services/officeUsers";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";
import { readWorkspaceProjects } from "../src/services/workspaceProjects";
import { publishDashboardRealtime } from "../src/services/dashboardRealtime";
let root:string,store:SqliteStateStore,server:WebDashboardServer,user:OfficeUser;
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),"team-isolation-"));vi.stubEnv("CODEX_MANAGER_STORAGE_ROOT",root);
 await configureCrossWindowOperationCoordinator(root);store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(store);
 user=await createOfficeUser({username:"alex@example.test",password:"password-123",workspacePath:path.join(root,"alex")});
 server=new WebDashboardServer({extensionUri:{fsPath:"extension"},secrets:{get:vi.fn(async()=>undefined)}} as never,{} as never);
});
afterEach(async()=>{server.dispose();vi.restoreAllMocks();configureSqliteStateStore(undefined);store.close();vi.unstubAllEnvs();await removeTestDirectory(root);});
it("rejects overlapping user workspaces during creation and editing",async()=>{
 await expect(createOfficeUser({username:"same@example.test",password:"password-123",workspacePath:user.workspacePath})).rejects.toThrow("separate workspace");
 await expect(createOfficeUser({username:"nested@example.test",password:"password-123",workspacePath:path.join(user.workspacePath,"nested")})).rejects.toThrow("separate workspace");
 const other=await createOfficeUser({username:"sam@example.test",password:"password-123",workspacePath:path.join(root,"sam")});
 await expect(updateOfficeUser(other.id,{workspacePath:root})).rejects.toThrow("separate workspace");
});
it("rejects another workspace, traversal, symlink escapes, peers and unknown native sessions",async()=>{
 const internal=server as any;
 const scope=(payload:unknown)=>internal.scopePrivateOfficeAction(user,{type:"dashboard:action",action:"readWorkspaceFile",requestId:"scope",payload});
 await expect(scope({projectPath:root})).rejects.toThrow();
 await expect(scope({projectPath:user.workspacePath,filePath:"../private.txt"})).rejects.toThrow();
 await expect(scope({targetDeviceId:"other",projectPath:user.workspacePath})).rejects.toThrow();
 await expect(scope({sessionId:"11111111-1111-1111-1111-111111111111"})).rejects.toThrow();
 const outside=path.join(root,"outside");await fs.mkdir(outside);await fs.symlink(outside,path.join(user.workspacePath,"escape"),"junction");
 await expect(scope({projectPath:path.join(user.workspacePath,"escape")})).rejects.toThrow();
});
it("returns only personal state and keeps admin state intact",()=>{
 const source={lang:"en",copy:{},logoUri:"logo",panelTitle:"Admin",brandSub:"Internal",accounts:[{email:"private-account@example.test"}],terminalNotice:{message:"secret"},usageHistory:[{id:"private"}],connectedPeers:[{name:"private-host"}],settings:{cloudflaredDomain:"private-host",officePostgresUrl:"postgres://secret",dashboardTheme:"light",apiAccessEnabled:true},tokenAutomation:{enabled:true},indexHealth:{status:"healthy",availableBackups:0}};
 const internal=server as any;
 const safe=internal.stateForOfficeUser(source,user);expect(JSON.stringify(safe)).not.toMatch(/private-account|private-host|postgres:\/\/secret|terminalNotice|usageHistory/);
 expect(safe.office.id).toBe(user.id);expect(safe.accounts).toEqual([]);
 expect(internal.stateForOfficeUser(source,{...user,role:"admin"}).accounts).toEqual(source.accounts);
});
it("hides technical action feedback without changing the user's file contents",()=>{
 const internal=server as any;
 const [result]=internal.sanitizeOfficeMessages([{type:"dashboard:action-result",requestId:"read",action:"readWorkspaceFile",status:"completed",payload:{workspaceFilesWarning:"ENOENT C:/team/alex/missing",notice:{level:"warning",message:"Provider API HTTP 503"},workspaceFile:{path:"notes.txt",content:"My API notes are user content."}}}]);
 expect(result.payload.workspaceFilesWarning).not.toMatch(/ENOENT|C:\//);expect(result.payload.notice.message).not.toMatch(/Provider|API|503/);
 expect(result.payload.workspaceFile.content).toBe("My API notes are user content.");
});
it("never routes user chat or native-only session actions through the native action handler",async()=>{
 const internal=server as any,native=vi.spyOn(internal,"processClientMessage");
 await internal.processOfficeMessage(user,{type:"dashboard:action",action:"listCodexCliSessions",requestId:"list"});
 const result=await internal.processOfficeMessage(user,{type:"dashboard:action",action:"forkCodexCliSession",requestId:"fork",payload:{sessionId:"11111111-1111-1111-1111-111111111111"}});
 expect(native).not.toHaveBeenCalled();expect(result.messages[0].status).toBe("failed");
});
it("keeps project creation and labels out of the master and other users' lists",async()=>{
 const internal=server as any,native=vi.spyOn(internal,"processClientMessage");
 const created=await internal.processOfficeMessage(user,{type:"dashboard:action",action:"createWorkspaceProject",requestId:"create",payload:{projectName:"Planning",parentFolder:user.workspacePath}});
 expect(created.messages[0].status).toBe("completed");
 const project=created.messages[0].payload.workspaceProject;
 expect(project.path).toBe(path.join(user.workspacePath,"Planning"));
 expect((await fs.stat(project.path)).isDirectory()).toBe(true);
 const listed=await internal.processOfficeMessage(user,{type:"dashboard:action",action:"listCodexCliSessions",requestId:"list"});
 expect(listed.messages[0].payload.cliComposerConfig.projects.map((value:any)=>value.path)).toContain(project.path);
 expect(readWorkspaceProjects()).toEqual([]);expect(readWorkspaceProjects("office-projects:someone-else")).toEqual([]);
 expect(native).not.toHaveBeenCalled();
 await internal.processOfficeMessage(user,{type:"dashboard:action",action:"renameWorkspaceProject",requestId:"rename",payload:{projectPath:project.path,projectName:"Quarter plan"}});
 expect(readWorkspaceProjects(`office-projects:${user.id}`)[0]?.label).toBe("Quarter plan");
});
it("blocks hidden panels, unknown terminal handles and project symlink destinations",async()=>{
 const internal=server as any,scope=(action:string,payload:unknown)=>internal.scopePrivateOfficeAction(user,{type:"dashboard:action",action,requestId:"scope",payload});
 await expect(scope("workspacePanel",{panelRequest:{operation:"open",tab:"terminal"}})).rejects.toThrow();
 await expect(scope("workspaceTerminal",{terminalId:"other-user-terminal"})).rejects.toThrow();
 const outside=path.join(root,"outside-project");await fs.mkdir(outside);await fs.symlink(outside,path.join(user.workspacePath,"Escape"),"junction");
 await expect(scope("createWorkspaceProject",{parentFolder:user.workspacePath,projectName:"Escape"})).rejects.toThrow();
});
it("does not broadcast master notices, native sessions or account activity to a Team socket",async()=>{
 const internal=server as any;
 internal.settingsStore={getDashboardSettings:()=>({teamWorkspaceEnabled:true,webSocketServerEnabled:false})};
 vi.spyOn(internal,"isAuthorized").mockResolvedValue(true);vi.spyOn(internal,"officeUserForRequest").mockResolvedValue(user);
 const team={readyState:1,bufferedAmount:0,send:vi.fn(),close:vi.fn()},master={readyState:1,bufferedAmount:0,send:vi.fn(),close:vi.fn()};
 vi.spyOn(internal.webSocketServer,"handleUpgrade").mockImplementation((_request:any,_socket:any,_head:any,done:any)=>done(team));
 vi.spyOn(internal.webSocketServer,"emit").mockReturnValue(true);
 await internal.handleWebSocketUpgrade({url:"/ws",headers:{host:"127.0.0.1:39875",origin:"http://127.0.0.1:39875"},socket:{remoteAddress:"127.0.0.1"}}, {destroy:vi.fn()},Buffer.alloc(0));
 internal.webSocketClients.add(team);internal.webSocketClients.add(master);
 try{
   publishDashboardRealtime({type:"dashboard:notice",level:"info",message:"private account@example.test switched"});
   publishDashboardRealtime({type:"dashboard:action-result",requestId:"native-list",action:"listCodexCliSessions",status:"completed",payload:{cliSessions:[{id:"native-private",title:"Master conversation",status:"idle"}]}});
   expect(team.send).not.toHaveBeenCalled();expect(master.send).toHaveBeenCalled();
 }finally{internal.webSocketClients.clear();}
});
it.each(["/api/office/users","/api/office/settings","/api/push/test","/api/share/create","/api/schema"])("denies user access to admin endpoint %s",async url=>{
 const internal=server as any;vi.spyOn(internal,"isAuthorized").mockResolvedValue(true);vi.spyOn(internal,"officeUserForRequest").mockResolvedValue(user);
 const response={statusCode:200,setHeader:vi.fn(),end:vi.fn()};await internal.handle({method:url==="/api/share/create"?"POST":"GET",url,headers:{host:"127.0.0.1:39875"},socket:{remoteAddress:"127.0.0.1"}},response);expect(response.statusCode).toBe(403);
});
