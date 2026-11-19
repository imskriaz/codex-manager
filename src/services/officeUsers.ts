import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";

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

export function listOfficeUsers(): OfficeUser[] {
  return readUsers().map(publicUser);
}

export type OfficeMcpServer = { id: string; label: string; endpoint: string; enabled: boolean; allowedRoles: OfficeRole[] };
export function listOfficeMcpServers(): OfficeMcpServer[] {
  const value = store()?.get<unknown>(NAMESPACE, MCP_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is OfficeMcpServer => Boolean(item && typeof item === "object" && typeof (item as OfficeMcpServer).id === "string" && typeof (item as OfficeMcpServer).endpoint === "string"));
}
export function saveOfficeMcpServers(servers: OfficeMcpServer[]): void {
  const current = store();
  if (!current) throw new Error("Office MCP storage is unavailable. Retry when the host is ready.");
  current.set(NAMESPACE, MCP_KEY, servers.slice(0, 128));
}

export function getOfficeUser(id: string | undefined): OfficeUser | undefined {
  if (!id) return undefined;
  const user = readUsers().find(item => item.id === id);
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
    const users = readUsers();
    if (users.some(item => item.username === username)) throw new Error("That office username is already in use.");
    const salt = crypto.randomBytes(24).toString("hex");
    const row: StoredOfficeUser = {
      id: crypto.randomUUID(), username, displayName: (input.displayName?.trim() || username).slice(0, 120),
      role: input.role ?? "user", enabled: input.enabled !== false, features: normalizeFeatures(input.features),
      defaultPrompt: (input.defaultPrompt ?? "").trim().slice(0, 8_000), workspacePath: input.workspacePath,
      mcpServers: [...new Set((input.mcpServers ?? []).filter(item => typeof item === "string" && item.length <= 160))].slice(0, 64),
      createdAt: Date.now(), salt, passwordHash: await derive(input.password, salt)
    };
    saveUsers([...users, row]);
    await fs.mkdir(row.workspacePath, { recursive: true });
    return publicUser(row);
  }, { waitMs: 2_000 });
}

export async function updateOfficeUser(id: string, patch: Partial<Omit<OfficeUser, "id" | "username" | "createdAt">> & { password?: string }): Promise<OfficeUser> {
  return runCrossWindowExclusive("state:office-users", "Office user update", async () => {
    const users = readUsers();
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
    const updated = [...users]; updated[index] = next; saveUsers(updated);
    await fs.mkdir(next.workspacePath, { recursive: true });
    return publicUser(next);
  }, { waitMs: 2_000 });
}

export async function deleteOfficeUser(id: string): Promise<void> {
  await runCrossWindowExclusive("state:office-users", "Office user deletion", async () => {
    const users = readUsers();
    if (!users.some(item => item.id === id)) throw new Error("Office user was not found.");
    if (users.filter(item => item.enabled && item.role !== "user").length === 1 && users.find(item => item.id === id)?.role !== "user") throw new Error("Keep at least one enabled admin.");
    saveUsers(users.filter(item => item.id !== id));
    await Promise.resolve();
  }, { waitMs: 2_000 });
}

export async function authenticateOfficeUser(username: string, password: string, verifyMaster: () => Promise<boolean>): Promise<OfficeUser | undefined> {
  const normalized = username.trim().toLowerCase();
  const user = readUsers().find(item => item.username === normalized);
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
