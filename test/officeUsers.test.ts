import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateOfficeUser, createOfficeUser, defaultOfficeFeatures, officeUserWorkspace, resolveMasterOfficeUsername, listOfficeMcpServers, saveOfficeMcpServers, type OfficeUser } from "../src/services/officeUsers";
import { removeTestDirectory } from "./testFilesystem";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";

let root: string;
vi.mock('node:fs/promises',async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,access:vi.fn(actual.access)};
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-office-login-"));
  vi.stubEnv("CODEX_MANAGER_STORAGE_ROOT", root);
  vi.stubEnv("CODEX_MANAGER_ADMIN_USERNAME", undefined);
  await configureCrossWindowOperationCoordinator(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTestDirectory(root);
});

describe("office workspace boundaries", () => {
  it.skipIf(process.platform !== 'win32')('discovers SmartOffice without granting access and preserves a saved global disable', async () => {
    const store = await SqliteStateStore.open(path.join(root, 'mcp.sqlite')); configureSqliteStateStore(store);
    try {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      const discovered = await listOfficeMcpServers();
      expect(discovered).toMatchObject([{id:'smartoffice',transport:'smartoffice',enabled:true,allowedRoles:['user']}]);
      const user = await createOfficeUser({username:'selective@example.test',password:'team-password',workspacePath:path.join(root,'selective')});
      expect(user.mcpServers).toEqual([]);
      await saveOfficeMcpServers(discovered.map(server=>({...server,enabled:false})));
      expect(await listOfficeMcpServers()).toMatchObject([{id:'smartoffice',transport:'smartoffice',enabled:false}]);
    } finally { configureSqliteStateStore(undefined); store.close(); }
  });
  it('does not discover a missing installation or accept alternate targets for the SmartOffice adapter', async () => {
    const store = await SqliteStateStore.open(path.join(root, 'mcp.sqlite')); configureSqliteStateStore(store);
    try {
      vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error('Missing'),{code:'ENOENT'}));
      expect(await listOfficeMcpServers()).toEqual([]);
      await saveOfficeMcpServers([
        {id:'remote',label:'Wrong target',endpoint:'https://other.example',transport:'smartoffice',enabled:true,allowedRoles:['user']},
        {id:'path',label:'Wrong route',endpoint:'http://127.0.0.1:3004/admin',transport:'smartoffice',enabled:true,allowedRoles:['user']},
        {id:'http',label:'Existing MCP',endpoint:'https://data.example/mcp',enabled:true,allowedRoles:['user']}
      ]);
      expect(await listOfficeMcpServers()).toEqual([{id:'http',label:'Existing MCP',endpoint:'https://data.example/mcp',enabled:true,allowedRoles:['user']}]);
    } finally { configureSqliteStateStore(undefined); store.close(); }
  });
  it("creates project folders below the assigned user root", () => {
    const user: OfficeUser = {
      id: "u1", username: "alex", displayName: "Alex", role: "user", enabled: true,
      features: defaultOfficeFeatures, defaultPrompt: "", workspacePath: "C:/office/alex", mcpServers: [], createdAt: 0
    };
    expect(officeUserWorkspace(user, "Quarterly plan")).toBe("C:\\office\\alex\\projects\\Quarterly-plan");
    expect(defaultOfficeFeatures).not.toContain("terminal");
  });

  it("reads the master username from the environment", async () => {
    vi.stubEnv("CODEX_MANAGER_ADMIN_USERNAME", "Office-Owner");
    await expect(resolveMasterOfficeUsername()).resolves.toBe("office-owner");
  });

  it("shares the generated username with a restarted host through the environment file", async () => {
    const username = await resolveMasterOfficeUsername();
    expect(username).toMatch(/^manager-[a-f0-9]{32}$/);
    expect(username).not.toBe("admin");
    expect(process.env.CODEX_MANAGER_ADMIN_USERNAME).toBeUndefined();
    expect(await fs.readFile(path.join(root, "codex-manager.env"), "utf8")).toBe(`CODEX_MANAGER_ADMIN_USERNAME=${username}\n`);
    vi.stubEnv("CODEX_MANAGER_ADMIN_USERNAME", undefined);
    await expect(resolveMasterOfficeUsername()).resolves.toBe(username);
  });

  it("keeps an explicit environment override ahead of the saved username", async () => {
    await fs.writeFile(path.join(root, "codex-manager.env"), "CODEX_MANAGER_ADMIN_USERNAME=saved-owner\n");
    vi.stubEnv("CODEX_MANAGER_ADMIN_USERNAME", "configured-owner");
    await expect(resolveMasterOfficeUsername()).resolves.toBe("configured-owner");
    expect(await fs.readFile(path.join(root, "codex-manager.env"), "utf8")).toContain("saved-owner");
  });

  it("preserves invalid files and fails closed without caching a replacement", async () => {
    const file = path.join(root, "codex-manager.env");
    await fs.writeFile(file, "CODEX_MANAGER_ADMIN_USERNAME=invalid username\n");
    await expect(resolveMasterOfficeUsername()).rejects.toThrow("invalid");
    expect(process.env.CODEX_MANAGER_ADMIN_USERNAME).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).toContain("invalid username");
  });

  it("reports a failed environment file write without accepting an ephemeral username", async () => {
    const file = path.join(root, "not-a-directory");
    await fs.writeFile(file, "preserved");
    vi.stubEnv("CODEX_MANAGER_STORAGE_ROOT", file);
    await expect(resolveMasterOfficeUsername()).rejects.toThrow();
    expect(process.env.CODEX_MANAGER_ADMIN_USERNAME).toBeUndefined();
    expect(await fs.readFile(file, "utf8")).toBe("preserved");
  });

  it("requires the generated master username and the shared password", async () => {
    const verify = vi.fn(async () => true);
    const username = await resolveMasterOfficeUsername();
    for (const candidate of ["", "admin", "wrong-user"]) {
      await expect(authenticateOfficeUser(candidate, "shared-password", verify, username)).resolves.toBeUndefined();
    }
    expect(verify).not.toHaveBeenCalled();
    await expect(authenticateOfficeUser(username.toUpperCase(), "shared-password", verify, username)).resolves.toMatchObject({ username, role: "unrestricted-admin" });
    verify.mockResolvedValue(false);
    await expect(authenticateOfficeUser(username, "wrong-password", verify, username)).resolves.toBeUndefined();
  });

  it("generates once across concurrent requests and rejects stale rotations", async () => {
    const names = await Promise.all(Array.from({ length: 4 }, () => resolveMasterOfficeUsername()));
    expect(new Set(names).size).toBe(1);
    const previous = names[0]!;
    const replacement = await resolveMasterOfficeUsername(previous);
    expect(replacement).not.toBe(previous);
    await expect(resolveMasterOfficeUsername()).resolves.toBe(replacement);
    await expect(resolveMasterOfficeUsername(previous)).rejects.toThrow("changed in another window");
    await expect(authenticateOfficeUser(previous, "password", async () => true, replacement)).resolves.toBeUndefined();
    expect(await fs.readdir(root)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
  });

  it("accepts a team member's email as the username and verifies their own password", async () => {
    const store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
    configureSqliteStateStore(store);
    try {
      const user = await createOfficeUser({ username: " Alex+Work@Example.test ", password: "team-password", workspacePath: path.join(root, "alex") });
      expect(user.username).toBe("alex+work@example.test");
      const verifyMaster = vi.fn(async () => true);
      await expect(authenticateOfficeUser("ALEX+WORK@EXAMPLE.TEST", "team-password", verifyMaster, "manager-owner")).resolves.toMatchObject({ id: user.id, role: "user" });
      await expect(authenticateOfficeUser(user.username, "wrong-password", verifyMaster, "manager-owner")).resolves.toBeUndefined();
      expect(verifyMaster).not.toHaveBeenCalled();
    } finally { configureSqliteStateStore(undefined); store.close(); }
  });
});
