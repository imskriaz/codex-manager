import { validateOfficeLimits, type OfficeLimits } from "./officeQuota";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";

export type OfficeRole = "admin" | "user" | "unrestricted-admin";
export type OfficeFeature = "generalChat" | "tasks" | "files" | "browser" | "env" | "terminal" | "git" | "github";
export type OfficePlan={name:string;status:'active'|'paused';expiresAt?:number;models:string[]};
export function validateOfficePlan(value:unknown):OfficePlan{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Choose valid plan settings.');
  const plan=value as Record<string,unknown>;
  if(typeof plan['name']!=='string'||!plan['name'].trim()||plan['name'].length>80||!['active','paused'].includes(String(plan['status']))||!Array.isArray(plan['models'])||plan['models'].length>100||plan['models'].some(model=>typeof model!=='string'||!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model))||plan['expiresAt']!==undefined&&(typeof plan['expiresAt']!=='number'||!Number.isSafeInteger(plan['expiresAt'])||plan['expiresAt']<0))throw new Error('Choose a plan name, status, expiry and valid models.');
  return {name:plan['name'].trim(),status:plan['status'] as OfficePlan['status'],models:[...new Set(plan['models'] as string[])],...(plan['expiresAt']!==undefined?{expiresAt:plan['expiresAt'] as number}:{})};
}
export class OfficeEntitlementError extends Error {}
export function checkOfficeEntitlement(user:OfficeUser,model?:string):void{
  if(user.role!=='user'||!user.plan)return;
  if(user.plan.status!=='active'||user.plan.expiresAt!==undefined&&user.plan.expiresAt<=Date.now())throw new OfficeEntitlementError('Your plan is inactive. Contact your workspace administrator to continue. Your saved files are available in Library.');
  if(model&&user.plan.models.length&&!user.plan.models.includes(model))throw new OfficeEntitlementError('This model is not included in your plan. Choose an available model.');
}
export interface OfficeUser {
  plan?:OfficePlan;
  id: string;
  username: string;
  displayName: string;
  role: OfficeRole;
  enabled: boolean;
  features: OfficeFeature[];
  limits?: OfficeLimits;
  defaultPrompt: string;
  workspacePath: string;
  mcpServers: string[];
  createdAt: number;
  sessionVersion?: string;
}
type StoredOfficeUser = OfficeUser & { salt: string; passwordHash: string };

const NAMESPACE = "office-users";
const KEY = "users";
const MCP_KEY = "mcp-servers";
export const MASTER_USERNAME_ENV = "CODEX_MANAGER_ADMIN_USERNAME";
const scrypt = promisify(crypto.scrypt);
const DEFAULT_FEATURES: OfficeFeature[] = ["generalChat", "tasks", "files", "browser"];
let masterUsernameInFlight: { file: string; promise: Promise<string> } | undefined;

function validMasterUsername(value: string | undefined): string | undefined {
  const username = value?.trim().toLowerCase();
  return username && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(username) ? username : undefined;
}

export async function resolveMasterOfficeUsername(expectedUsername?: string): Promise<string> {
  const environment = process.env[MASTER_USERNAME_ENV];
  const configured = validMasterUsername(environment);
  if (environment !== undefined) {
    if (!configured) throw new Error(`${MASTER_USERNAME_ENV} must contain a username with 2-64 letters, numbers, dots, dashes, or underscores.`);
    if (expectedUsername !== undefined) throw new Error("The master username is controlled by an environment override. Remove that override and restart the host to rotate it here.");
    return configured;
  }
  const file = path.join(getCodexManagerStorageRoot(), "codex-manager.env");
  if (expectedUsername === undefined && masterUsernameInFlight?.file === file) return masterUsernameInFlight.promise;
  const operation = runCrossWindowExclusive(`state:master-username:${file}`, "Dashboard username setup", async () => {
    let text: string;
    try { text = await fs.readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const generated = `manager-${crypto.randomBytes(16).toString("hex")}`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      text = `${MASTER_USERNAME_ENV}=${generated}\n`;
      try { await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        text = await fs.readFile(file, "utf8");
      }
    }
    const stored = validMasterUsername(text.match(/^CODEX_MANAGER_ADMIN_USERNAME=([^\r\n]*)$/m)?.[1]);
    if (!stored) throw new Error(`The dashboard username in ${file} is invalid. Set ${MASTER_USERNAME_ENV} to a valid username and restart the host.`);
    if (expectedUsername !== undefined) {
      if (expectedUsername !== stored) throw new Error("The master username changed in another window. Reload the username before rotating again.");
      const replacement = `manager-${crypto.randomBytes(16).toString("hex")}`;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, text.replace(/^CODEX_MANAGER_ADMIN_USERNAME=[^\r\n]*$/m, `${MASTER_USERNAME_ENV}=${replacement}`), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      } finally {
        await fs.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[codexManager] username rotation temporary file cleanup failed", error); });
      }
      return replacement;
    }
    return stored;
  }, { waitMs: 2_000 });
  if (expectedUsername !== undefined) return operation;
  const promise = operation.finally(() => {
    if (masterUsernameInFlight?.promise === promise) masterUsernameInFlight = undefined;
  });
  masterUsernameInFlight = { file, promise };
  return promise;
}

export function masterOfficeUser(username: string): OfficeUser {
  return { id: "master", username, displayName: "Administrator", role: "unrestricted-admin", enabled: true,
    features: ["generalChat", "tasks", "files", "browser", "env", "terminal", "git", "github"], defaultPrompt: "",
    workspacePath: "", mcpServers: [], createdAt: 0 };
}

function store(): ReturnType<typeof getSqliteStateStore> {
  return getSqliteStateStore();
}

function readUsers(): StoredOfficeUser[] {
  const value = store()?.get<unknown>(NAMESPACE, KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredOfficeUser => {
    if (!item || typeof item !== "object") return false;
    const row = item as Partial<StoredOfficeUser>;
    return typeof row.id === "string" && typeof row.username === "string" && typeof row.passwordHash === "string" &&
      typeof row.salt === "string" && (row.role === "admin" || row.role === "user" || row.role === "unrestricted-admin");
  });
}

function publicUser(user: StoredOfficeUser): OfficeUser {
  const { salt: _salt, passwordHash: _hash, ...publicValue } = user;
  return { ...publicValue, features: [...publicValue.features], mcpServers: [...publicValue.mcpServers] };
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  const email = username.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
  if (!email) throw new Error("Use a valid email address for the username.");
  return username;
}

function normalizeFeatures(value: unknown): OfficeFeature[] {
  if (!Array.isArray(value)) return [...DEFAULT_FEATURES];
  const allowed = new Set<OfficeFeature>(["generalChat", "tasks", "files", "browser", "env", "terminal", "git", "github"]);
  return [...new Set(value.filter((item): item is OfficeFeature => typeof item === "string" && allowed.has(item as OfficeFeature)))];
}

async function derive(password: string, salt: string): Promise<string> {
  return (await scrypt(password, salt, 64) as Buffer).toString("hex");
}

function saveUsers(users: StoredOfficeUser[], expected: StoredOfficeUser[]): void {
  const current = store();
  if (!current) throw new Error("Office user storage is unavailable. Retry when the host is ready.");
  current.transaction(() => {
    if (JSON.stringify(readUsers()) !== JSON.stringify(expected)) throw new Error('Office users changed in another window. Refresh and retry.');
    current.set(NAMESPACE, KEY, users);
  });
}

// eslint-disable-next-line @typescript-eslint/require-await -- Keep storage failures asynchronous for dashboard callers.
export async function listOfficeUsers(): Promise<OfficeUser[]> {
  return readUsers().map(publicUser);
}

export type OfficeMcpServer = { id: string; label: string; endpoint: string; enabled: boolean; allowedRoles: OfficeRole[] };
function normalizeMcpServer(value: unknown): OfficeMcpServer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<OfficeMcpServer>;
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(row.id) || typeof row.endpoint !== "string") return undefined;
  let endpoint: URL;
  try { endpoint = new URL(row.endpoint); } catch { return undefined; }
  if (!['http:', 'https:'].includes(endpoint.protocol)) return undefined;
  if ('transport' in row && row.transport !== undefined) return undefined;
  const allowedRoles: OfficeRole[] = Array.isArray(row.allowedRoles) ? [...new Set(row.allowedRoles.filter((role): role is OfficeRole => role === 'admin' || role === 'user' || role === 'unrestricted-admin'))] : ['user'];
  return { id: row.id, label: typeof row.label === 'string' ? row.label.trim().slice(0, 120) || row.id : row.id, endpoint: endpoint.toString(), enabled: row.enabled !== false, allowedRoles };
}
// eslint-disable-next-line @typescript-eslint/require-await -- Keep storage failures asynchronous for dashboard callers.
export async function listOfficeMcpServers(): Promise<OfficeMcpServer[]> {
  const value = store()?.get<unknown>(NAMESPACE, MCP_KEY);
  return Array.isArray(value) ? value.flatMap(item => { const normalized = normalizeMcpServer(item); return normalized ? [normalized] : []; }) : [];
}
// eslint-disable-next-line @typescript-eslint/require-await -- Keep storage failures asynchronous for dashboard callers.
export async function saveOfficeMcpServers(servers: OfficeMcpServer[]): Promise<void> {
  const current = store();
  if (!current) throw new Error("Office MCP storage is unavailable. Retry when the host is ready.");
  current.set(NAMESPACE, MCP_KEY, servers.flatMap(item => { const normalized = normalizeMcpServer(item); return normalized ? [normalized] : []; }).slice(0, 128));
}

// eslint-disable-next-line @typescript-eslint/require-await -- Keep storage failures asynchronous for dashboard callers.
export async function getOfficeUser(id: string | undefined): Promise<OfficeUser | undefined> {
  if (!id) return undefined;
  const user = readUsers().find(item => item.id === id);
  return user ? publicUser(user) : undefined;
}

async function canonicalOfficeWorkspace(folder:string):Promise<string>{
  try{return await fs.realpath(folder);}catch(error){
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    const parent=path.dirname(path.resolve(folder));
    if(parent===path.resolve(folder))throw error;
    return path.join(await canonicalOfficeWorkspace(parent),path.basename(folder));
  }
}
async function validateSeparateOfficeWorkspace(users:StoredOfficeUser[],candidate:OfficeUser):Promise<void>{
  if(candidate.role!=="user")return;
  const folder=await canonicalOfficeWorkspace(candidate.workspacePath);
  const inside=(parent:string,child:string)=>{const relative=path.relative(parent,child);return relative===""||!relative.startsWith("..")&&!path.isAbsolute(relative);};
  for(const other of users){
    if(other.id===candidate.id||other.role!=="user")continue;
    const existing=await canonicalOfficeWorkspace(other.workspacePath);
    if(inside(folder,existing)||inside(existing,folder))throw new Error("Choose a separate workspace folder. User workspaces cannot share or contain another user's folder.");
  }
}

export async function createOfficeUser(input: {
  username: string;
  password: string;
  displayName?: string;
  role?: OfficeRole;
  enabled?: boolean;
  features?: OfficeFeature[];
  defaultPrompt?: string;
  workspacePath: string;
  mcpServers?: string[];
  limits?: OfficeLimits;
  plan?:OfficePlan;
}): Promise<OfficeUser> {
  const username = normalizeUsername(input.username);
  if (input.password.length < 8 || input.password.length > 256) throw new Error("Use a password between 8 and 256 characters.");
  if (!path.isAbsolute(input.workspacePath)) throw new Error("The office workspace folder must be an absolute path.");
  return runCrossWindowExclusive("state:office-users", "Office user creation", async () => {
    const users = readUsers();
    if (users.some(item => item.username === username)) throw new Error("That office username is already in use.");
    const salt = crypto.randomBytes(24).toString("hex");
    const row: StoredOfficeUser = {
      id: crypto.randomUUID(), username, displayName: (input.displayName?.trim() || username).slice(0, 120),
      role: input.role ?? "user", enabled: input.enabled !== false, features: normalizeFeatures(input.features),
      defaultPrompt: (input.defaultPrompt ?? "").trim().slice(0, 8_000), workspacePath: input.workspacePath,
      mcpServers: [...new Set((input.mcpServers ?? []).filter(item => typeof item === "string" && item.length <= 160))].slice(0, 64),
      limits: input.limits === undefined ? undefined : validateOfficeLimits(input.limits),
      ...(input.plan?{plan:validateOfficePlan(input.plan)}:{}),
      createdAt: Date.now(), sessionVersion: crypto.randomUUID(), salt, passwordHash: await derive(input.password, salt)
    };
    await validateSeparateOfficeWorkspace(users,row);
    await fs.mkdir(row.workspacePath, { recursive: true });
    saveUsers([...users, row], users);
    return publicUser(row);
  }, { waitMs: 2_000 });
}

export async function updateOfficeUser(id: string, patch: Partial<Omit<OfficeUser, "id" | "username" | "createdAt">> & { password?: string }, expected?:{sessionVersion?:string;displayName?:string}): Promise<OfficeUser> {
  if (patch.role !== undefined && !["user", "admin", "unrestricted-admin"].includes(patch.role)) throw new Error("Choose a valid Team role.");
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("Choose a valid sign-in status.");
  for (const key of ["displayName", "defaultPrompt", "workspacePath", "password"] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "string") throw new Error("Send valid user settings.");
  }
  if (patch.mcpServers !== undefined && (!Array.isArray(patch.mcpServers) || patch.mcpServers.some(value => typeof value !== "string"))) throw new Error("Choose valid data connections.");
  return runCrossWindowExclusive("state:office-users", "Office user update", async () => {
    const users = readUsers();
    const index = users.findIndex(item => item.id === id);
    if (index < 0) throw new Error("Office user was not found.");
    const current = users[index]!;
    if(expected&&('sessionVersion' in expected&&expected.sessionVersion!==current.sessionVersion||'displayName' in expected&&expected.displayName!==current.displayName))throw new Error('Your account changed. Reopen settings or sign in again before saving.');
    const next: StoredOfficeUser = { ...current };
    if (patch.plan !== undefined) next.plan=validateOfficePlan(patch.plan);
    if (patch.sessionVersion !== undefined) next.sessionVersion=crypto.randomUUID();
    if (patch.limits !== undefined) next.limits = validateOfficeLimits(patch.limits);
    if (patch.displayName !== undefined) next.displayName = patch.displayName.trim().slice(0, 120) || current.username;
    if (patch.role !== undefined) next.role = patch.role;
    if (patch.enabled !== undefined) { next.enabled = patch.enabled; if (!patch.enabled) next.sessionVersion = crypto.randomUUID(); }
    if (patch.features !== undefined) next.features = normalizeFeatures(patch.features);
    if (patch.defaultPrompt !== undefined) next.defaultPrompt = patch.defaultPrompt.trim().slice(0, 8_000);
    if (patch.workspacePath !== undefined) {
      if (!path.isAbsolute(patch.workspacePath)) throw new Error("The office workspace folder must be an absolute path.");
      next.workspacePath = patch.workspacePath;
    }
    if (patch.mcpServers !== undefined) next.mcpServers = [...new Set(patch.mcpServers)].slice(0, 64);
    if (patch.password !== undefined) {
      if (patch.password.length < 8 || patch.password.length > 256) throw new Error("Use a password between 8 and 256 characters.");
      next.salt = crypto.randomBytes(24).toString("hex");
      next.passwordHash = await derive(patch.password, next.salt);
      next.sessionVersion = crypto.randomUUID();
    }
    await validateSeparateOfficeWorkspace(users,next);
    await fs.mkdir(next.workspacePath, { recursive: true });
    const updated = [...users]; updated[index] = next; saveUsers(updated, users);
    return publicUser(next);
  }, { waitMs: 2_000 });
}

export async function deleteOfficeUser(id: string): Promise<void> {
  await runCrossWindowExclusive("state:office-users", "Office user deletion", () => {
    const users = readUsers();
    if (!users.some(item => item.id === id)) throw new Error("Office user was not found.");
    if (users.filter(item => item.enabled && item.role !== "user").length === 1 && users.find(item => item.id === id)?.role !== "user") throw new Error("Keep at least one enabled admin.");
    saveUsers(users.filter(item => item.id !== id), users);
    return Promise.resolve();
  }, { waitMs: 2_000 });
}

export async function authenticateOfficeUser(username: string, password: string, verifyMaster: () => Promise<boolean>, masterUsername: string): Promise<OfficeUser | undefined> {
  const normalized = username.trim().toLowerCase();
  if (normalized === masterUsername) return await verifyMaster() ? masterOfficeUser(masterUsername) : undefined;
  const user = readUsers().find(item => item.username === normalized);
  if (user) {
    if (!user.enabled || !crypto.timingSafeEqual(Buffer.from(user.passwordHash, "hex"), Buffer.from(await derive(password, user.salt), "hex"))) return undefined;
    return publicUser(user);
  }
  return undefined;
}

export function officeUserWorkspace(user: OfficeUser, project?: string): string {
  const safe = (project ?? "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return safe ? path.join(user.workspacePath, "projects", safe) : user.workspacePath;
}

export const defaultOfficeFeatures = DEFAULT_FEATURES;
