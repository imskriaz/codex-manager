import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";

export type OfficeRole = "admin" | "user" | "unrestricted-admin";
export type OfficeFeature = "generalChat" | "tasks" | "files" | "browser" | "env" | "terminal" | "git" | "github";
export interface OfficeUser {
  id: string;
  username: string;
  displayName: string;
  role: OfficeRole;
  enabled: boolean;
  features: OfficeFeature[];
  defaultPrompt: string;
  workspacePath: string;
  mcpServers: string[];
  createdAt: number;
}
type StoredOfficeUser = OfficeUser & { salt: string; passwordHash: string };

const NAMESPACE = "office-users";
const KEY = "users";
const MCP_KEY = "mcp-servers";
const scrypt = promisify(crypto.scrypt);
const DEFAULT_FEATURES: OfficeFeature[] = ["generalChat", "tasks", "files", "browser"];

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

type OfficePostgresPool = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ record?: unknown }> }>; end?: () => Promise<void> };
let postgresPoolPromise: Promise<OfficePostgresPool | undefined> | undefined;
async function postgresPool(): Promise<OfficePostgresPool | undefined> {
  const config = getCodexManagerConfiguration();
  const url = config.get<string>("officePostgresUrl", "").trim();
  if (config.get<string>("officeDatabaseProvider", "sqlite") !== "postgres" || !url) return undefined;
  if (postgresPoolPromise) return postgresPoolPromise;
  postgresPoolPromise = (async () => {
    try {
      const pg = await import("pg") as unknown as { Pool: new (options: { connectionString: string; connectionTimeoutMillis: number; max: number }) => OfficePostgresPool };
      const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 1_500, max: 4 });
      await pool.query("CREATE TABLE IF NOT EXISTS codex_manager_office_users (id TEXT PRIMARY KEY, record JSONB NOT NULL)");
      await pool.query("CREATE TABLE IF NOT EXISTS codex_manager_office_mcp (id TEXT PRIMARY KEY, record JSONB NOT NULL)");
      return pool;
    } catch { return undefined; }
  })();
  return postgresPoolPromise;
}

async function readUsersBackend(): Promise<{ users: StoredOfficeUser[]; pool?: OfficePostgresPool }> {
  const pool = await postgresPool();
  if (!pool) return { users: readUsers() };
  try {
    const result = await pool.query("SELECT record FROM codex_manager_office_users");
    const users = result.rows.flatMap(row => row.record && typeof row.record === "object" ? [row.record as StoredOfficeUser] : []);
    if (!users.length) {
      const legacy = readUsers();
      for (const user of legacy) await pool.query("INSERT INTO codex_manager_office_users (id, record) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING", [user.id, JSON.stringify(user)]);
      return { users: legacy, pool };
    }
    return { users, pool };
  } catch { postgresPoolPromise = undefined; return { users: readUsers() }; }
}

async function saveUsersBackend(users: StoredOfficeUser[], pool?: OfficePostgresPool): Promise<void> {
  if (!pool) { saveUsers(users); return; }
  try {
    await pool.query("DELETE FROM codex_manager_office_users");
    for (const user of users) await pool.query("INSERT INTO codex_manager_office_users (id, record) VALUES ($1, $2::jsonb)", [user.id, JSON.stringify(user)]);
  } catch {
    // A configured server may go offline after startup. Keep the local store
    // usable and let the next process retry PostgreSQL.
    saveUsers(users);
    postgresPoolPromise = undefined;
  }
}

function publicUser(user: StoredOfficeUser): OfficeUser {
  const { salt: _salt, passwordHash: _hash, ...publicValue } = user;
  return { ...publicValue, features: [...publicValue.features], mcpServers: [...publicValue.mcpServers] };
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) throw new Error("Use a username with 2-64 letters, numbers, dots, dashes, or underscores.");
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

function saveUsers(users: StoredOfficeUser[]): void {
  const current = store();
  if (!current) throw new Error("Office user storage is unavailable. Retry when the host is ready.");
  current.set(NAMESPACE, KEY, users);
}

export async function listOfficeUsers(): Promise<OfficeUser[]> {
  return (await readUsersBackend()).users.map(publicUser);
}

export type OfficeMcpServer = { id: string; label: string; endpoint: string; enabled: boolean; allowedRoles: OfficeRole[] };
function normalizeMcpServer(value: unknown): OfficeMcpServer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<OfficeMcpServer>;
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(row.id) || typeof row.endpoint !== "string") return undefined;
  let endpoint: URL;
  try { endpoint = new URL(row.endpoint); } catch { return undefined; }
  if (!['http:', 'https:'].includes(endpoint.protocol)) return undefined;
  const allowedRoles: OfficeRole[] = Array.isArray(row.allowedRoles) ? [...new Set(row.allowedRoles.filter((role): role is OfficeRole => role === 'admin' || role === 'user' || role === 'unrestricted-admin'))] : ['user'];
  return { id: row.id, label: typeof row.label === 'string' ? row.label.trim().slice(0, 120) || row.id : row.id, endpoint: endpoint.toString(), enabled: row.enabled !== false, allowedRoles };
}
export async function listOfficeMcpServers(): Promise<OfficeMcpServer[]> {
  const pool = await postgresPool();
  let value: unknown;
  if (pool) {
    try { value = (await pool.query("SELECT record FROM codex_manager_office_mcp")).rows.map(row => row.record); }
    catch { postgresPoolPromise = undefined; value = store()?.get<unknown>(NAMESPACE, MCP_KEY); }
  } else value = store()?.get<unknown>(NAMESPACE, MCP_KEY);
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => { const normalized = normalizeMcpServer(item); return normalized ? [normalized] : []; });
}
export async function saveOfficeMcpServers(servers: OfficeMcpServer[]): Promise<void> {
  const pool = await postgresPool();
  if (pool) {
    try {
      await pool.query("DELETE FROM codex_manager_office_mcp");
      for (const server of servers.flatMap(item => { const normalized = normalizeMcpServer(item); return normalized ? [normalized] : []; })) await pool.query("INSERT INTO codex_manager_office_mcp (id, record) VALUES ($1, $2::jsonb)", [server.id, JSON.stringify(server)]);
      return;
    } catch { postgresPoolPromise = undefined; }
  }
  const current = store();
  if (!current) throw new Error("Office MCP storage is unavailable. Retry when the host is ready.");
  current.set(NAMESPACE, MCP_KEY, servers.flatMap(item => { const normalized = normalizeMcpServer(item); return normalized ? [normalized] : []; }).slice(0, 128));
}

export async function getOfficeUser(id: string | undefined): Promise<OfficeUser | undefined> {
  if (!id) return undefined;
  const user = (await readUsersBackend()).users.find(item => item.id === id);
  return user ? publicUser(user) : undefined;
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
}): Promise<OfficeUser> {
  const username = normalizeUsername(input.username);
  if (input.password.length < 8 || input.password.length > 256) throw new Error("Use a password between 8 and 256 characters.");
  if (!path.isAbsolute(input.workspacePath)) throw new Error("The office workspace folder must be an absolute path.");
  return runCrossWindowExclusive("state:office-users", "Office user creation", async () => {
    const backend = await readUsersBackend(), users = backend.users;
    if (users.some(item => item.username === username)) throw new Error("That office username is already in use.");
    const salt = crypto.randomBytes(24).toString("hex");
    const row: StoredOfficeUser = {
      id: crypto.randomUUID(), username, displayName: (input.displayName?.trim() || username).slice(0, 120),
      role: input.role ?? "user", enabled: input.enabled !== false, features: normalizeFeatures(input.features),
      defaultPrompt: (input.defaultPrompt ?? "").trim().slice(0, 8_000), workspacePath: input.workspacePath,
      mcpServers: [...new Set((input.mcpServers ?? []).filter(item => typeof item === "string" && item.length <= 160))].slice(0, 64),
      createdAt: Date.now(), salt, passwordHash: await derive(input.password, salt)
    };
    await saveUsersBackend([...users, row], backend.pool);
    await fs.mkdir(row.workspacePath, { recursive: true });
    return publicUser(row);
  }, { waitMs: 2_000 });
}

export async function updateOfficeUser(id: string, patch: Partial<Omit<OfficeUser, "id" | "username" | "createdAt">> & { password?: string }): Promise<OfficeUser> {
  return runCrossWindowExclusive("state:office-users", "Office user update", async () => {
    const backend = await readUsersBackend(), users = backend.users;
    const index = users.findIndex(item => item.id === id);
    if (index < 0) throw new Error("Office user was not found.");
    const current = users[index]!;
    const next: StoredOfficeUser = { ...current };
    if (patch.displayName !== undefined) next.displayName = patch.displayName.trim().slice(0, 120) || current.username;
    if (patch.role !== undefined) next.role = patch.role;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
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
    }
    const updated = [...users]; updated[index] = next; await saveUsersBackend(updated, backend.pool);
    await fs.mkdir(next.workspacePath, { recursive: true });
    return publicUser(next);
  }, { waitMs: 2_000 });
}

export async function deleteOfficeUser(id: string): Promise<void> {
  await runCrossWindowExclusive("state:office-users", "Office user deletion", async () => {
    const backend = await readUsersBackend(), users = backend.users;
    if (!users.some(item => item.id === id)) throw new Error("Office user was not found.");
    if (users.filter(item => item.enabled && item.role !== "user").length === 1 && users.find(item => item.id === id)?.role !== "user") throw new Error("Keep at least one enabled admin.");
    await saveUsersBackend(users.filter(item => item.id !== id), backend.pool);
  }, { waitMs: 2_000 });
}

export async function authenticateOfficeUser(username: string, password: string, verifyMaster: () => Promise<boolean>): Promise<OfficeUser | undefined> {
  const normalized = username.trim().toLowerCase();
  const user = (await readUsersBackend()).users.find(item => item.username === normalized);
  if (user) {
    if (!user.enabled || !crypto.timingSafeEqual(Buffer.from(user.passwordHash, "hex"), Buffer.from(await derive(password, user.salt), "hex"))) return undefined;
    return publicUser(user);
  }
  // Preserve the existing master passphrase as an implicit unrestricted admin until
  // the first explicit office account is created.
  if ((normalized === "admin" || normalized === "" ) && await verifyMaster()) {
    return { id: "master", username: "admin", displayName: "Administrator", role: "unrestricted-admin", enabled: true, features: ["generalChat", "tasks", "files", "browser", "env", "terminal", "git", "github"], defaultPrompt: "", workspacePath: "", mcpServers: [], createdAt: 0 };
  }
  return undefined;
}

export function officeUserWorkspace(user: OfficeUser, project?: string): string {
  const safe = (project ?? "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return safe ? path.join(user.workspacePath, "projects", safe) : user.workspacePath;
}

export const defaultOfficeFeatures = DEFAULT_FEATURES;
