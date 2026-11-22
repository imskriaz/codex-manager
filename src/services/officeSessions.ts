import { claimOfficeRequest, OfficeQuotaError } from "./officeQuota";
import { officeCapacityMessage } from "../domain/officeCapacity";
import { readTeamSettings } from "./teamSettings";
import { createHash, randomUUID } from "node:crypto";
import { getSqliteStateStore } from "../storage/sqliteState";
import { needsChatAttachmentFiles, prepareChatInput, validateChatAttachments } from "../domain/chatAttachments";
import type { DashboardActionResultPayload, DashboardCliSessionMessage, DashboardCliSessionSummary, DashboardHostMessage } from "../domain/dashboard/types";
import type { OfficeUser } from "./officeUsers";
import { readOfficeInstructions } from "./officePreferences";
import { readWorkspaceProjects } from "./workspaceProjects";
import * as path from "node:path";
import { userSessionActivity } from '../domain/teamWorkspacePresentation';
import { messageSessionPlan } from '../domain/sessionPlan';
import { MAX_CODEX_LIVE_ITEMS, MAX_CODEX_LIVE_STATE_BYTES, validMessage } from '../domain/codexSessionLive';
import { waitWithin } from '../utils/concurrency';

type Turn = { scheduled?: boolean; id: string; requestId: string; fingerprint: string; user: DashboardCliSessionMessage; assistant?: DashboardCliSessionMessage; error?: string; activities?:DashboardCliSessionMessage[]; state: "queued" | "working" | "waiting" | "done" | "cancelled" | "uncertain"; model?: string; retryAt?: number; lease?: string; leaseUntil?: number };
type Session = { id: string; owner: string; title: string; projectPath: string; model?: string; archived?: boolean; updatedAt: string; turns: Turn[] };
type Action = Extract<import("../domain/dashboard/types").DashboardClientMessage, { type: "dashboard:action" }>;
export class OfficeCapacityError extends Error {}
export class OfficeModelSelectionError extends Error {}
export class OfficeActionError extends Error {}
const WAITING = "Your message is queued. We will start as soon as an assistant is available.";
const UNCERTAIN = "The response could not be confirmed. Your message is saved. Check the conversation before sending again.";
const BLOCKED = "Earlier work could not be confirmed, so this message was not run. Your draft is saved here. Review the conversation and start a new chat to continue.";
const namespace = (owner: string) => `office-sessions:${owner}`;
function store() { const value = getSqliteStateStore(); if (!value) throw new Error("Conversation storage is unavailable. Please try again shortly."); return value; }
function summary(session: Session): DashboardCliSessionSummary {
  const pending = session.turns.find(turn => ["queued", "working", "waiting"].includes(turn.state));
  const uncertain = session.turns.some(turn => turn.state === "uncertain");
  return { id: session.id, title: session.title, projectPath: session.projectPath, model: session.model, updatedAt: session.updatedAt, archived: session.archived,
    status: pending ? "running" : "idle", canStop: !!pending, autoResumeEnabled: false,
    queueEnabled: pending?.state === "waiting" || pending?.state === "queued", queueRetryAt: pending && pending.state !== "working" ? pending.retryAt : undefined, queueError: pending && pending.state !== "working" ? pending.retryAt ? officeCapacityMessage(pending.retryAt) : WAITING : uncertain ? UNCERTAIN : undefined };
}
function messages(session: Session): DashboardCliSessionMessage[] {
  return session.turns.flatMap(turn => [turn.user,...(turn.activities??[]), ...(turn.assistant ? [turn.assistant] : []), ...(turn.error ? [{id: `${turn.id}:error`, kind: "error" as const, text: turn.error, timestamp: session.updatedAt}] : []), ...(turn.state === "uncertain" ? [{ id: `${turn.id}:unconfirmed`, kind: "error" as const, text: UNCERTAIN, timestamp: session.updatedAt }] : [])].map(message=>({...message,turnId:turn.id})));
}

function stopBlockedMessages(session: Session): boolean {
  if (!session.turns.some(turn => turn.state === 'uncertain')) return false;
  let changed=false;
  for (const turn of session.turns) if (turn.state === 'queued' || turn.state === 'waiting') { turn.state = 'cancelled'; turn.error = BLOCKED; changed=true; }
  return changed;
}

/** Team conversations use the model endpoint only; this module never opens a native Codex thread. */
export class OfficeSessionService {
  private timer?: NodeJS.Timeout;
  private running = new Map<string, AbortController>();
  private stopped = false;
  constructor(private readonly options: {
    models?: (user: OfficeUser) => Promise<import("../domain/dashboard/types").DashboardCliModelOption[]>;
    readUser: (id: string) => Promise<OfficeUser | undefined>;
    generate: (user: OfficeUser, model: string | undefined, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal: AbortSignal, projectPath: string, report: (message: DashboardCliSessionMessage) => void, scheduled?: boolean) => Promise<string>;
    changed: (owner: string, messages: DashboardHostMessage[]) => void;
  }) {}
  start(): void { this.stopped = false; this.timer ??= setInterval(() => void this.pump(), 2_000); this.timer.unref?.(); void this.pump(); }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const controller of this.running.values()) controller.abort(); }
  list(owner: string): DashboardCliSessionSummary[] {
    return store().keys(namespace(owner)).map(id => store().get<Session>(namespace(owner), id)).filter((session): session is Session => !!session && session.owner === owner)
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary);
  }
  relocateProject(owner:string,removed:string,root:string):void {
    for(const item of this.list(owner)){
      if(!item.projectPath)continue;
      const relative=path.relative(removed,item.projectPath);
      if(relative.startsWith('..')||path.isAbsolute(relative))continue;
      const session=this.read(owner,item.id);session.projectPath=root;this.save(session);this.publish(session);
    }
  }
  project(owner: string, id: string): string { return this.read(owner,id).projectPath; }
  private read(owner: string, id: string): Session {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("This conversation is unavailable.");
    const session = store().get<Session>(namespace(owner), id);
    if (!session || session.owner !== owner) throw new Error("This conversation is unavailable.");
    return session;
  }
  private save(session: Session): void { session.updatedAt = new Date().toISOString(); store().set(namespace(session.owner),session.id,session); }
  private publish(session: Session, notice?: string): void {
    session=this.read(session.owner,session.id);
    let sequence!:number;
    store().transaction(()=>{sequence=Math.max(Date.now(),(store().get<number>(`office-session-revisions:${session.owner}`,session.id)??0)+1);store().set(`office-session-revisions:${session.owner}`,session.id,sequence);});
    const turn=session.turns.find(value=>['working','queued','waiting'].includes(value.state))??session.turns.at(-1);
    const current=messages(session).filter(message=>message.turnId===turn?.id),live:DashboardCliSessionMessage[]=[];
    let bytes=2048,truncated=current.length>MAX_CODEX_LIVE_ITEMS;
    for(const message of current.slice(-MAX_CODEX_LIVE_ITEMS)){
      const size=Buffer.byteLength(JSON.stringify(message),'utf8');
      if(!validMessage(message)||bytes+size>MAX_CODEX_LIVE_STATE_BYTES){truncated=true;continue;}
      live.push(message);bytes+=size;
    }
    this.options.changed(session.owner, [
      { type: "dashboard:action-result", requestId: `auto-team-${session.id}`, action: "listCodexCliSessions", status: "completed", payload: { cliSessions: this.list(session.owner) } },
      { type: "dashboard:codex-session-live", state: { sessionId: session.id, streamId: turn?.id??session.id, turnId:turn?.id, sequence, status: summary(session).status === "running" ? "running" : "completed", updatedAt: sequence, messages: live, ...(truncated?{truncated:true}:{}) } },
      ...(notice ? [{ type: "dashboard:notice" as const, level: "info" as const, message: notice }] : [])
    ]);
  }
  // eslint-disable-next-line @typescript-eslint/require-await -- Action failures must remain asynchronous for dashboard callers.
  async handle(user: OfficeUser, action: Action, internal?: {scheduled: boolean}): Promise<DashboardActionResultPayload> {
    const p = action.payload ?? {};
    if (!user.enabled || user.role !== "user" || !user.features.some(value => value === "tasks" || value === "generalChat")) throw new Error("Chat is not enabled for your workspace.");
    if (p.targetDeviceId && p.targetDeviceId !== "local") throw new Error("Choose your own workspace.");
    if (action.action === "listCodexCliSessions") {
      const projects=readWorkspaceProjects(`office-projects:${user.id}`).filter(project=>{const relative=path.relative(user.workspacePath,project.path);return relative!==""&&!relative.startsWith("..")&&!path.isAbsolute(relative);});
      let models: import("../domain/dashboard/types").DashboardCliModelOption[] = [], modelDiscoveryWarning: string | undefined;
      try { models = await waitWithin(this.options.models?.(user)??Promise.resolve([]),3000,'Models are still loading.'); if (!models.length) modelDiscoveryWarning = "Models are temporarily unavailable. Your selected model is kept. Try again shortly."; }
      catch { modelDiscoveryWarning = "Models could not be loaded. Your selected model is kept. Try again shortly."; }
      return { cliSessions: this.list(user.id), cliComposerConfig: { models, modelDiscoveryWarning, defaultModel: readTeamSettings().defaultModel || undefined, projects: [{ id: user.id, label: "My workspace", path: user.workspacePath },...projects], defaultSandboxMode: "workspace-write", terminalSupported:false } };
    }
    if (action.action === "getCodexSkills") return { cliSkills: [] };
    if (action.action === "startCodexCliSession" || action.action === "sendCodexCliSessionMessage" || action.action === "steerCodexCliSessionTurn") {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if(p.model !== undefined && (typeof p.model !== "string" || p.model.length > 128)) throw new Error("Choose an available model.");
      if (text.length > 32_000 || !action.requestId || action.requestId.length > 256) throw new Error("Send a message of up to 32,000 characters.");
      const attachments = validateChatAttachments(p.attachments);
      if (attachments.some(item => item.kind !== "text")) throw new Error("Attach text files to this conversation. Other file types are available in Files.");
      if (needsChatAttachmentFiles(attachments)) throw new Error('These attachments are too large for chat. Use Files to add them to your workspace.');
      const input = prepareChatInput(text, attachments);
      const fingerprint = createHash("sha256").update(JSON.stringify([text,attachments,p.model,p.projectPath])).digest("hex");
      let session!: Session;
      store().transaction(() => {
        const prior = store().get<string>(`office-session-requests:${user.id}`,action.requestId);
        if (prior) {
          session = this.read(user.id,prior);
          if (!session.turns.some(turn => turn.requestId === action.requestId && turn.fingerprint === fingerprint)) throw new Error("This request changed. Refresh the conversation before retrying.");
          return;
        }
        session = action.action === "startCodexCliSession" ? { id: randomUUID(),owner: user.id,title: text.slice(0,80) || "New conversation",projectPath: p.projectPath || user.workspacePath,model: p.model,updatedAt: new Date().toISOString(),turns: [] } : this.read(user.id,p.sessionId!);
        if (session.archived) throw new Error("Restore this conversation before sending a message.");
        if (session.turns.some(turn=>turn.state==='uncertain')) throw new Error('Earlier work could not be confirmed. Review the conversation and start a new chat to continue.');
        const model = p.model || session.model || readTeamSettings().defaultModel;
        if (!model || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model)) throw new OfficeModelSelectionError('Choose a model before sending your message.');
        if (session.turns.length >= 200 || session.turns.filter(turn => ["queued","working","waiting"].includes(turn.state)).length >= 20) throw new Error("This conversation is full. Start a new chat or wait for queued messages to finish.");
        claimOfficeRequest(user);
        const id = randomUUID();
        session.turns.push({ ...(internal?.scheduled?{scheduled:true}:{}),id,requestId:action.requestId,fingerprint,model,state:"queued",user:{ id,role:"user",text:input.text,timestamp:new Date().toISOString() } });
        session.model = model;
        this.save(session); store().set(`office-session-requests:${user.id}`,action.requestId,session.id); store().set("office-session-owners",user.id,true);
      });
      this.publish(session); this.start();
      session = this.read(user.id, session.id);
      return { cliSession: summary(session), cliSessionMessages: messages(session), cliSessions: this.list(user.id), notice: { level:"info", message:"Message accepted and queued." } };
    }
    let session = this.read(user.id,p.sessionId!);
    const hadWorking=session.turns.some(turn=>turn.state==='working');
    if (action.action === "getCodexCliSessionMessages") return { cliSession: summary(session), cliSessionMessages: messages(session) };
    store().transaction(() => {
      session = this.read(user.id,p.sessionId!);
      if (action.action === "cancelCodexCliSessionTurn" || action.action === "setCodexSessionQueue" && p.queueEnabled === false) {
        for (const turn of session.turns) if (["queued","waiting","working","uncertain"].includes(turn.state)) { turn.state="cancelled";for(const activity of turn.activities??[])if(activity.status==="inProgress")activity.status="interrupted";this.running.get(turn.id)?.abort(); }
      } else if (action.action === "renameCodexCliSession") {
        if (typeof p.text !== "string" || !p.text.trim() || p.text.length > 120) throw new Error("Enter a conversation name of up to 120 characters.");
        session.title=p.text.trim();
      } else if (action.action === "archiveCodexCliSession" || action.action === "unarchiveCodexCliSession") {
        if (session.turns.some(turn => ["queued","waiting","working"].includes(turn.state))) throw new Error("Stop queued work before archiving this conversation.");
        session.archived=action.action === "archiveCodexCliSession";
      } else if (action.action === "deleteCodexCliSession") {
        if (!p.confirmed) throw new Error("Confirm deletion first.");
        if (session.turns.some(turn => ["queued","waiting","working"].includes(turn.state))) throw new Error("Stop queued work before deleting this conversation.");
        store().set(namespace(user.id),session.id,undefined); return;
      } else throw new Error("This action is unavailable for this conversation.");
      this.save(session);
    });
    if(action.action==='deleteCodexCliSession')this.options.changed(user.id,[{type:'dashboard:action-result',requestId:`auto-team-${session.id}`,action:'listCodexCliSessions',status:'completed',payload:{cliSessions:this.list(user.id)}}]);
    else this.publish(session);
    return { cliSessions:this.list(user.id), ...(action.action === "deleteCodexCliSession" ? {} : {cliSession:summary(session),cliSessionMessages:messages(session)}), notice:{level:"info",message:action.action === "cancelCodexCliSessionTurn" || action.action === "setCodexSessionQueue" ? hadWorking?'Stop requested. A file already being saved may still finish. Check Files before retrying.':"Queued work stopped." : "Conversation updated."} };
  }
  pump(): void {
    if (this.stopped) return;
    try {
      const oldest = (owner: string) => Math.min(...store().keys(namespace(owner)).flatMap(id => this.read(owner, id).turns.filter(turn => turn.state === "queued" || turn.state === "waiting").map(turn => Date.parse(turn.user.timestamp ?? "") || 0)));
      for (const owner of store().keys("office-session-owners").sort((a,b) => oldest(a) - oldest(b))) {
        if (this.stopped) break;
        let claimed: {session:Session;turn:Turn} | undefined;
        store().transaction(() => {
          const sessions=store().keys(namespace(owner)).map(id=>this.read(owner,id));
          for (const session of sessions) {
            let changed=false;
            for (const turn of session.turns) if(turn.state==="working" && (turn.leaseUntil??0)<Date.now()){turn.state="uncertain";for(const activity of turn.activities??[])if(activity.status==="inProgress")activity.status="unknown";changed=true;}
            changed=stopBlockedMessages(session)||changed;
            if(changed){this.save(session);this.publish(session,UNCERTAIN);}
          }
          const active = store().keys("office-session-owners").flatMap(id => store().keys(namespace(id)).map(key => this.read(id, key))).reduce((count, value) => count + value.turns.filter(turn => turn.state === "working" && (turn.leaseUntil ?? 0) > Date.now()).length, 0);
          if (active >= readTeamSettings().maxActiveRequests || sessions.some(session=>session.turns.some(turn=>turn.state==="working"))) {
            for (const session of sessions) {
              let changed = false;
              for (const turn of session.turns) if (turn.state === "queued" || turn.state === "waiting") { turn.retryAt = Math.max(turn.retryAt ?? 0, Date.now() + 2000); changed = true; }
              if (changed) { this.save(session); this.publish(session); }
            }
            return;
          }
          for(const session of sessions){
            if(session.archived || session.turns.some(turn=>turn.state==="uncertain"))continue;
            const turn=session.turns.find(turn=>turn.state==="queued" || turn.state==="waiting");
            if(!turn || turn.state === "waiting" && (turn.retryAt??0)>Date.now())continue;
            turn.state="working";turn.lease=randomUUID();turn.leaseUntil=Date.now()+120_000;this.save(session);claimed={session,turn};break;
          }
        });
        if(claimed){ const {session,turn}=claimed;const controller=new AbortController();this.running.set(turn.id,controller);void this.execute(session,turn,controller); }
      }
    }catch(error){console.warn("[codexManager] Team queue check delayed",error);}
  }
  private async execute(session:Session,turn:Turn,controller:AbortController):Promise<void>{
    const timeout=setTimeout(()=>controller.abort(),90_000);timeout.unref?.();
    let content:string|undefined,failure:unknown;
    try{
      const user=await waitWithin(this.options.readUser(session.owner),90_000,UNCERTAIN,controller.signal);
      controller.signal.throwIfAborted();
      if(!user?.enabled || user.role!=='user' || !user.features.some(value=>value==="generalChat"||value==="tasks"))throw new Error("Workspace access changed.");
      const history=session.turns.slice(0,session.turns.findIndex(value=>value.id===turn.id)+1).flatMap(value=>value.state==="cancelled"?[]:[{role:"user" as const,content:value.user.text},...(value.activities??[]).filter(activity=>messageSessionPlan(activity)||activity.role==='assistant').map(activity=>({role:'assistant' as const,content:activity.questions?.length?JSON.stringify({message:activity.text,questions:activity.questions}):activity.text})),...(value.assistant?[{role:"assistant" as const,content:value.assistant.text}]:[])]);
      const report=(activity:DashboardCliSessionMessage)=>{
        if(controller.signal.aborted)return;
        let updated:Session|undefined;
        store().transaction(()=>{
          const currentSession=this.read(session.owner,session.id),current=currentSession.turns.find(value=>value.id===turn.id);
          if(!current||current.state!=="working"||current.lease!==turn.lease)return;
          const safe=userSessionActivity({...activity,timestamp:activity.timestamp??new Date().toISOString()},[user.workspacePath,session.projectPath]);
          current.activities??=[];const index=current.activities.findIndex(value=>value.id===safe.id);
          if(index<0)current.activities.push(safe);else current.activities[index]=safe;
          this.save(currentSession);updated=currentSession;
        });
        if(updated)this.publish(updated);
      };
      this.publish(session);
      const instructions = readOfficeInstructions(user.id);
      const globalPrompt = readTeamSettings().globalPrompt;
      content=await waitWithin(this.options.generate(user,turn.model === "" ? undefined : turn.model ?? session.model,[...(globalPrompt?[{role:"system" as const,content:globalPrompt}]:[]),...(user.defaultPrompt?[{role:"system" as const,content:user.defaultPrompt}]:[]),...(instructions?[{role:"system" as const,content:instructions}]:[]),...history],controller.signal,session.projectPath,report,turn.scheduled),90_000,UNCERTAIN,controller.signal);
      controller.signal.throwIfAborted();
      if(!content?.trim())throw new Error("Empty response.");
      content=userSessionActivity({id:turn.id,role:'assistant',text:content},[user.workspacePath,session.projectPath]).text;
    }catch(error){content=undefined;failure=error;}
    finally{clearTimeout(timeout);}
    try{
      let updated!:Session,completed=false;
      store().transaction(()=>{
        updated=this.read(session.owner,session.id);const current=updated.turns.find(value=>value.id===turn.id);
        if(!current || current.state!=="working" || current.lease!==turn.lease)return;
        completed=true;
        if(content){if(!current.activities?.at(-1)?.questions?.length)current.assistant={id:randomUUID(),role:"assistant",text:content,timestamp:new Date().toISOString()};current.state="done";for(const activity of current.activities??[])if(activity.status==="inProgress")activity.status="unknown";}
        else if(failure instanceof OfficeCapacityError && !controller.signal.aborted){current.state="waiting";current.retryAt=Date.now()+5_000;for(const activity of current.activities??[])if(activity.status==='inProgress')activity.status='unknown';}
        else if (failure instanceof OfficeQuotaError || failure instanceof OfficeModelSelectionError || failure instanceof OfficeActionError) {current.state="done"; current.error=failure.message; for (const activity of current.activities ?? []) if (activity.status === "inProgress") activity.status = "unknown";}
        else {current.state="uncertain";for(const activity of current.activities??[])if(activity.status==="inProgress")activity.status="unknown";}
        stopBlockedMessages(updated);
        this.save(updated);
      });
      if(completed)this.publish(updated,content?updated.turns.find(value=>value.id===turn.id)?.activities?.at(-1)?.questions?.length?'Your assistant has a question.':"Your response is ready.":failure instanceof OfficeQuotaError || failure instanceof OfficeModelSelectionError || failure instanceof OfficeActionError?failure.message:failure instanceof OfficeCapacityError?officeCapacityMessage(updated.turns.find(value=>value.id===turn.id)?.retryAt ?? Date.now()+5000):UNCERTAIN);
    }catch(error){console.warn("[codexManager] Team response could not be saved",error);}
    finally{this.running.delete(turn.id);if(!this.stopped)void this.pump();}
  }
}
