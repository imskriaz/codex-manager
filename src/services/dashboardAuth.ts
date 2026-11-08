import * as crypto from "crypto";
import { promisify } from "util";
import type * as vscode from "vscode";
import { getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";

export const DASHBOARD_PASSPHRASE_KEY = "codexManager.encryptedSync.passphrase";
const SESSION_KEY = "codexManager.webDashboard.sessions.v1";
const NAMESPACE = "dashboard-auth";
const scrypt = promisify(crypto.scrypt);
type Credential = { salt: string; hash: string };
type PasswordSource = {
  hasDashboardPassphrase(): Promise<boolean>;
  verifyDashboardPassphrase(candidate: string): Promise<boolean>;
  getDashboardPassphraseFingerprint(): Promise<string | undefined>;
};

/** Only a salted verifier and session fingerprints cross the host boundary. */
export class DashboardAuth {
  private synchronizedPassword: string | undefined;
  private synchronizedCredential: string | undefined;
  private refreshing: Promise<void> = Promise.resolve();

  constructor(private readonly secrets: vscode.SecretStorage, private readonly source?: PasswordSource) {}

  refresh(): Promise<void> {
    const task = this.refreshing.catch(() => undefined).then(async () => {
      const store = getSqliteStateStore();
      if (!store || !this.source) return;
      const password = await this.secrets.get(DASHBOARD_PASSPHRASE_KEY);
      if (this.synchronizedPassword === password && this.synchronizedCredential === JSON.stringify(store.get(NAMESPACE, "credential")) && store.get(NAMESPACE, "migrated")) return;
      await runCrossWindowExclusive("state:dashboard-sessions", "Dashboard authentication", async () => {
        const currentPassword = await this.secrets.get(DASHBOARD_PASSPHRASE_KEY);
        const previous = store.get<Credential>(NAMESPACE, "credential");
        const matches = currentPassword && this.isCredential(previous) && await this.verify(currentPassword, previous);
        const credential = !currentPassword ? undefined : matches ? previous : await this.createCredential(currentPassword);
        const firstMigration = !store.get(NAMESPACE, "migrated");
        const legacySessions = firstMigration && currentPassword ? await this.secrets.get(SESSION_KEY) : undefined;
        store.transaction(() => {
          if (firstMigration) store.set(NAMESPACE, "sessions", legacySessions);
          else if (!matches) store.set(NAMESPACE, "sessions", undefined);
          store.set(NAMESPACE, "credential", credential);
          store.set(NAMESPACE, "migrated", true);
        });
        this.synchronizedPassword = currentPassword;
        this.synchronizedCredential = JSON.stringify(credential);
      }, { waitMs: 2_000 });
    });
    this.refreshing = task;
    return task;
  }

  async hasDashboardPassphrase(): Promise<boolean> {
    await this.refresh();
    const store = getSqliteStateStore();
    if (!store) return await this.source?.hasDashboardPassphrase() ?? false;
    return Boolean(this.fingerprint(store.get<Credential>(NAMESPACE, "credential")));
  }

  async verifyDashboardPassphrase(candidate: string): Promise<boolean> {
    await this.refresh();
    const store = getSqliteStateStore();
    if (!store) return await this.source?.verifyDashboardPassphrase(candidate) ?? false;
    const credential = store.get<Credential>(NAMESPACE, "credential");
    return Boolean(credential && await this.verify(candidate, credential));
  }

  async getDashboardPassphraseFingerprint(): Promise<string | undefined> {
    await this.refresh();
    const store = getSqliteStateStore();
    if (!store) return this.source?.getDashboardPassphraseFingerprint();
    const credential = store.get<Credential>(NAMESPACE, "credential");
    return this.fingerprint(credential);
  }

  async readSessions(): Promise<string | undefined> {
    const store = getSqliteStateStore();
    return store ? store.get<string>(NAMESPACE, "sessions") : this.secrets.get(SESSION_KEY);
  }

  async writeSessions(sessions: string, credential?: string): Promise<void> {
    const store = getSqliteStateStore();
    if (store) store.transaction(() => {
      if (credential !== undefined && credential !== this.fingerprint(store.get<Credential>(NAMESPACE, "credential"))) throw new Error("The dashboard password changed during sign-in. Sign in again.");
      store.set(NAMESPACE, "sessions", sessions);
    });
    else {
      if (credential !== undefined && credential !== await this.source?.getDashboardPassphraseFingerprint()) throw new Error("The dashboard password changed during sign-in. Sign in again.");
      await this.secrets.store(SESSION_KEY, sessions);
    }
  }

  private async createCredential(password: string): Promise<Credential> {
    const salt = crypto.randomBytes(32).toString("hex");
    return { salt, hash: (await scrypt(password, salt, 64) as Buffer).toString("hex") };
  }

  private async verify(password: string, credential: Credential): Promise<boolean> {
    if (!this.isCredential(credential)) throw new Error("The shared dashboard credential is invalid. Set the password again in VS Code.");
    const actual = await scrypt(password, credential.salt, 64) as Buffer;
    return crypto.timingSafeEqual(Buffer.from(credential.hash, "hex"), actual);
  }

  private isCredential(value: unknown): value is Credential {
    const credential = value as Credential | undefined;
    return !!credential && typeof credential.salt === "string" && typeof credential.hash === "string" && /^[a-f0-9]{64}$/.test(credential.salt) && /^[a-f0-9]{128}$/.test(credential.hash);
  }

  private fingerprint(credential: Credential | undefined): string | undefined {
    if (credential && !this.isCredential(credential)) throw new Error("The shared dashboard credential is invalid. Set the password again in VS Code.");
    return credential ? crypto.createHash("sha256").update(JSON.stringify(credential)).digest("base64url") : undefined;
  }
}
