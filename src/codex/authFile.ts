/**
 * Codex 认证文件操作模块
 *
 * 优化内容:
 * - ChatGPT OAuth accounts use the explicit auth_mode="chatgpt" format emitted by Codex
 * - 原子写入 auth.json（临时文件 + rename），避免中断/磁盘满损坏
 * - macOS 下同步 Codex Keychain（service="Codex Auth"），避免 codex 扩展读旧凭证
 */

import * as crypto from "crypto";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CodexAuthFile, CodexTokens } from "../core/types";

/** macOS 下 Codex 读取凭证的 Keychain service */
const CODEX_KEYCHAIN_SERVICE = "Codex Auth";
const AUTH_READ_RETRY_DELAYS_MS = [20, 50, 100];

// Serialize all auth.json mutations. Account switching and background token
// refresh can complete at the same time; without a queue the slower write can
// replace a newer account's credentials.
let authFileOperationChain: Promise<void> = Promise.resolve();

/**
 * 获取 Codex 主目录
 *
 * @returns CODEX_HOME 路径
 */
export function getCodexHome(): string {
  const envHome = process.env["CODEX_HOME"]?.trim();
  if (envHome) {
    return path.resolve(envHome.replace(/^['"]|['"]$/g, ""));
  }
  return path.resolve(os.homedir(), ".codex");
}

/**
 * Stable, non-identifying bucket key for state that must follow one Codex
 * runtime home without storing the user's filesystem path in the account index.
 */
export function getCodexHomeStateKey(codexHome = getCodexHome()): string {
  const resolved = path.resolve(codexHome);
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * 获取 auth.json 文件路径
 */
export function getAuthJsonPath(): string {
  return path.join(getCodexHome(), "auth.json");
}

/**
 * 读取 auth.json 文件
 *
 * @returns 认证文件内容，如果不存在则返回 undefined
 */
export async function readAuthFile(): Promise<CodexAuthFile | undefined> {
  return enqueueAuthFileOperation(async () => {
    const filePath = getAuthJsonPath();
    let primaryMissing = false;
    try {
      const parsed = await readAuthCandidate(filePath);
      if (parsed) return parsed;
    } catch (error) {
      primaryMissing = isFileNotFound(error);
      if (!primaryMissing) {
        console.warn("[codexManager] unable to read auth.json:", getErrorMessage(error));
      }
    }

    // A process crash can leave a fully fsynced staging file behind while the
    // final rename never happened. Recover only when auth.json is absent; a
    // malformed existing file is left untouched for safe manual inspection.
    if (!primaryMissing) {
      return undefined;
    }
    const recovered = await readLatestValidAuthTemp(filePath);
    if (recovered) {
      try {
        await replaceAuthFileWithRetry(recovered.filePath, filePath);
        return recovered.auth;
      } catch (error) {
        console.warn("[codexManager] unable to promote recovered auth.json:", getErrorMessage(error));
      }
    }
    return undefined;
  });
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enqueueAuthFileOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = authFileOperationChain.catch(() => undefined).then(operation);
  authFileOperationChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function readAuthCandidate(filePath: string): Promise<CodexAuthFile> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= AUTH_READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return parseAuthFile(raw);
    } catch (error) {
      lastError = error;
      const retryable = isTransientFileError(error) || error instanceof SyntaxError;
      if (!retryable || attempt === AUTH_READ_RETRY_DELAYS_MS.length) break;
      await delay(AUTH_READ_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to read Codex auth.json.");
}

function parseAuthFile(raw: string): CodexAuthFile {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("Codex auth.json must contain a JSON object.");

  const apiKey = value["OPENAI_API_KEY"];
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
    throw new Error("Codex auth.json contains an invalid OPENAI_API_KEY.");
  }
  if (value["auth_mode"] !== undefined && typeof value["auth_mode"] !== "string") {
    throw new Error("Codex auth.json contains an invalid auth_mode.");
  }
  const tokens = value["tokens"];
  if (tokens !== undefined) {
    if (!isRecord(tokens)) throw new Error("Codex auth.json contains invalid tokens.");
    if (typeof tokens["id_token"] !== "string" || !tokens["id_token"].trim()) {
      throw new Error("Codex auth.json is missing tokens.id_token.");
    }
    if (typeof tokens["access_token"] !== "string" || !tokens["access_token"].trim()) {
      throw new Error("Codex auth.json is missing tokens.access_token.");
    }
    for (const key of ["refresh_token", "account_id"] as const) {
      if (tokens[key] !== undefined && typeof tokens[key] !== "string") {
        throw new Error(`Codex auth.json contains an invalid tokens.${key}.`);
      }
    }
  }
  const hasTokenCredentials =
    isRecord(tokens) &&
    typeof tokens["id_token"] === "string" &&
    Boolean(tokens["id_token"].trim()) &&
    typeof tokens["access_token"] === "string" &&
    Boolean(tokens["access_token"].trim());
  const hasApiKeyCredentials = typeof apiKey === "string" && Boolean(apiKey.trim());
  if (!hasTokenCredentials && !hasApiKeyCredentials) {
    throw new Error("Codex auth.json does not contain usable credentials.");
  }
  if (value["last_refresh"] !== undefined && typeof value["last_refresh"] !== "string") {
    throw new Error("Codex auth.json contains an invalid last_refresh.");
  }

  return value as unknown as CodexAuthFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransientFileError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["EACCES", "EBUSY", "EPERM", "EAGAIN"].includes(String((error as { code?: unknown }).code));
}

async function readLatestValidAuthTemp(
  filePath: string
): Promise<{ filePath: string; auth: CodexAuthFile } | undefined> {
  const directory = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.tmp.`;
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
  const candidates = await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        const candidatePath = path.join(directory, name);
        const stat = await fs.stat(candidatePath).catch(() => undefined);
        return stat?.isFile() ? { filePath: candidatePath, modifiedAt: stat.mtimeMs } : undefined;
      })
  );
  for (const candidate of candidates
    .filter((value): value is { filePath: string; modifiedAt: number } => Boolean(value))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)) {
    try {
      return { filePath: candidate.filePath, auth: await readAuthCandidate(candidate.filePath) };
    } catch {
      // Ignore incomplete or stale staging files and continue with older ones.
    }
  }
  return undefined;
}

function assertWritableTokens(tokens: CodexTokens): void {
  if (!tokens || typeof tokens.idToken !== "string" || !tokens.idToken.trim()) {
    throw new Error("Cannot write auth.json without a valid id token.");
  }
  if (typeof tokens.accessToken !== "string" || !tokens.accessToken.trim()) {
    throw new Error("Cannot write auth.json without a valid access token.");
  }
  if (tokens.refreshToken !== undefined && typeof tokens.refreshToken !== "string") {
    throw new Error("Cannot write auth.json with an invalid refresh token.");
  }
  if (tokens.accountId !== undefined && typeof tokens.accountId !== "string") {
    throw new Error("Cannot write auth.json with an invalid account id.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 写入 auth.json 文件
 *
 * ChatGPT sign-in uses Codex's explicit chatgpt auth mode, matching Codex's
 * current auth.json format.
 * 写入采用原子替换，并在 macOS 下同步 Keychain。
 *
 * @param tokens - 认证令牌
 */
export async function writeAuthFile(tokens: CodexTokens): Promise<void> {
  return enqueueAuthFileOperation(async () => {
    assertWritableTokens(tokens);
    const authFile = buildCodexAuthFile(tokens);
    const content = JSON.stringify(authFile, null, 2);

    await writeAuthJsonAtomic(getAuthJsonPath(), content);
    await syncCodexKeychain(content);
  });
}

/**
 * Remove only the credentials currently loaded by Codex. Saved accounts in
 * the manager are intentionally left untouched so the user can switch back
 * to one later.
 */
export async function unloadAuthFile(): Promise<void> {
  return enqueueAuthFileOperation(async () => {
    await deleteCodexKeychainCredential();
    await fs.rm(getAuthJsonPath(), { force: true });
  });
}

/**
 * Upgrade a legacy token-based auth.json that omitted auth_mode. Existing
 * credentials and last_refresh are preserved byte-for-value in the new JSON.
 */
export async function ensureCodexAuthFileFormat(): Promise<boolean> {
  return enqueueAuthFileOperation(async () => {
    const filePath = getAuthJsonPath();
    let parsed: CodexAuthFile;
    try {
      parsed = await readAuthCandidate(filePath);
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }

    if (parsed.auth_mode === "chatgpt") {
      return false;
    }
    if (
      parsed.OPENAI_API_KEY != null ||
      typeof parsed.tokens?.id_token !== "string" ||
      !parsed.tokens.id_token ||
      typeof parsed.tokens.access_token !== "string" ||
      !parsed.tokens.access_token
    ) {
      // Never relabel API-key or unrecognized credential formats.
      return false;
    }

    const normalized: CodexAuthFile = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: parsed.tokens.id_token,
        access_token: parsed.tokens.access_token,
        refresh_token: parsed.tokens.refresh_token ?? "",
        account_id: parsed.tokens.account_id ?? ""
      },
      last_refresh: parsed.last_refresh ?? ""
    };
    const content = JSON.stringify(normalized, null, 2);
    await writeAuthJsonAtomic(filePath, content);
    await syncCodexKeychain(content);
    return true;
  });
}

/**
 * 构建 auth.json 内容。
 */
export function buildCodexAuthFile(tokens: CodexTokens, refreshedAt = new Date()): CodexAuthFile {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken ?? "",
      account_id: tokens.accountId ?? ""
    },
    last_refresh: refreshedAt.toISOString()
  };
}

/**
 * 原子写入文件：先写临时文件，再 rename 替换，避免半写入。
 */
async function writeAuthJsonAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`
  );
  // Tokens are credentials: keep the staging file private even before rename.
  const handle = await fs.open(tmpPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceAuthFileWithRetry(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function replaceAuthFileWithRetry(
  tmpPath: string,
  filePath: string,
  operations: { rename?: typeof fs.rename; wait?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const rename = operations.rename ?? fs.rename;
  const wait = operations.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = [20, 50, 100, 200, 400];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      await fs.chmod(filePath, 0o600).catch(() => undefined);
      return;
    } catch (error) {
      lastError = error;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (!(code === "EACCES" || code === "EBUSY" || code === "EPERM") || attempt === delays.length) {
        break;
      }
      await wait(delays[attempt]!);
    }
  }

  // Never copy over the live auth.json: copyFile truncates it first and an
  // extension update can terminate the host before the replacement completes.
  throw lastError instanceof Error ? lastError : new Error("Unable to replace Codex auth.json safely.");
}

/**
 * macOS 下同步 Codex Keychain。
 *
 * codex 在 macOS 优先从 Keychain（service="Codex Auth"，account="cli|<sha256(codex_home)[:16]>"）
 * 读取凭证。仅写 auth.json 会导致 codex 扩展仍使用旧账号凭证，表现为登出/账号串台。
 * 失败仅记录，不阻断主流程。
 */
async function syncCodexKeychain(authJsonContent: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    const account = await buildCodexKeychainAccount();
    await new Promise<void>((resolve, reject) => {
      execFile(
        "security",
        ["add-generic-password", "-U", "-s", CODEX_KEYCHAIN_SERVICE, "-a", account, "-w", authJsonContent],
        (error) => {
          if (error) {
            reject(error instanceof Error ? error : new Error("Failed to update the Codex keychain", { cause: error }));
          } else {
            resolve();
          }
        }
      );
    });
  } catch {
    // Keychain 同步为 best-effort，失败不阻断 auth.json 写入。
  }
}

async function deleteCodexKeychainCredential(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const account = await buildCodexKeychainAccount();
  await new Promise<void>((resolve, reject) => {
    execFile(
      "security",
      ["delete-generic-password", "-s", CODEX_KEYCHAIN_SERVICE, "-a", account],
      (error, _stdout, stderr) => {
        const detail = String(stderr ?? "");
        if (!error || detail.toLowerCase().includes("could not be found")) {
          resolve();
          return;
        }
        reject(
          error instanceof Error ? error : new Error("Failed to remove the Codex keychain credential", { cause: error })
        );
      }
    );
  });
}

/**
 * 计算 Codex Keychain account 标识：cli|<sha256(canonicalize(codex_home))[:16]>。
 * 与 cockpit-tools / codex 官方读取逻辑保持一致。
 */
async function buildCodexKeychainAccount(): Promise<string> {
  const home = getCodexHome();
  let resolved = home;
  try {
    resolved = await fs.realpath(home);
  } catch {
    resolved = home;
  }
  const digest = crypto.createHash("sha256").update(resolved).digest("hex");
  return `cli|${digest.slice(0, 16)}`;
}
