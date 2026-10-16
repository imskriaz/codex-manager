import * as vscode from "vscode";
import { CodexTokens } from "../core/types";

const SECRET_PREFIX = "codex.account.";

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  onDidChange(listener: (accountId: string) => void): vscode.Disposable | undefined {
    return this.secrets.onDidChange?.(event => {
      if (event.key.startsWith(SECRET_PREFIX)) listener(event.key.slice(SECRET_PREFIX.length));
    });
  }

  async getTokens(accountId: string): Promise<CodexTokens | undefined> {
    const raw = await this.secrets.get(`${SECRET_PREFIX}${accountId}`);
    if (!raw) {
      return undefined;
    }
    let value: Partial<CodexTokens> | null;
    try { value = JSON.parse(raw) as Partial<CodexTokens> | null; }
    catch { throw new Error("Stored credentials are invalid. Reauthorize this account to replace them."); }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.idToken !== "string" || !value.idToken.trim() ||
      typeof value.accessToken !== "string" || !value.accessToken.trim() ||
      (value.refreshToken !== undefined && typeof value.refreshToken !== "string") ||
      (value.accountId !== undefined && typeof value.accountId !== "string")) {
      throw new Error("Stored credentials are invalid. Reauthorize this account to replace them.");
    }
    return value as CodexTokens;
  }

  async setTokens(accountId: string, tokens: CodexTokens): Promise<void> {
    await this.secrets.store(`${SECRET_PREFIX}${accountId}`, JSON.stringify(tokens));
  }

  async deleteTokens(accountId: string): Promise<void> {
    await this.secrets.delete(`${SECRET_PREFIX}${accountId}`);
  }
}
