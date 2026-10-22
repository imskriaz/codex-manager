import * as vscode from "vscode";
import { waitWithin } from "../../utils/concurrency";
import {
  completeOAuthLoginSession,
  listenForPreparedOAuthLoginSession,
  prepareOAuthLoginSession,
  PreparedOAuthLoginSession
} from "../../auth/oauth";
import { refreshImportedAccountQuota } from "../../application/accounts/quota";
import {
  activateQueuedAccountIfCurrentMissing,
  type QueuedAccountActivationResult
} from "../../application/accounts/queuedAccountActivation";
import type { AccountsRepository } from "../../storage";
import type { DashboardHostMessage, DashboardNotice } from "../../domain/dashboard/types";
import type { TranslationKey, TranslationParams } from "../../utils/i18n";
import { buildAccountStorageId } from "../../utils/accountIdentity";
import { extractClaims } from "../../utils/jwt";

export class DashboardOAuthCoordinator {
  private static readonly SESSION_TTL_MS = 10 * 60 * 1000;
  private readonly authorizations = new Map<string, Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"]>>();
  private readonly pendingAuthorizations = new Set<string>();
  private readonly autoFlows = new Map<string, Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined>>();
  private readonly oauthSessions = new Map<string, PreparedOAuthLoginSession>();
  private readonly oauthSessionCreatedAt = new Map<string, number>();
  private readonly oauthSessionAccountIds = new Map<string, string | undefined>();
  private readonly oauthCancellationSources = new Map<string, vscode.CancellationTokenSource>();

  constructor(
    private readonly repo: AccountsRepository,
    private readonly schedulePublishState: () => void,
    private readonly syncAccountChange?: () => Promise<boolean | undefined>,
    private readonly notifyAuthorized?: (sessionId: string, email: string) => void
  ) {}

  dispose(): void {
    this.oauthCancellationSources.forEach((source) => {
      source.cancel();
      source.dispose();
    });
    this.oauthCancellationSources.clear();
    this.oauthSessions.clear();
    this.authorizations.clear();
    this.pendingAuthorizations.clear();
    this.autoFlows.clear();
    this.oauthSessionCreatedAt.clear();
    this.oauthSessionAccountIds.clear();
  }

  prepareSession(
    translate: (key: TranslationKey, values?: TranslationParams) => string,
    accountId?: string
  ): Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] {
    try {
      for (const id of this.oauthSessions.keys()) if (this.isSessionExpired(id)) this.cancelSession(id);
      if (this.oauthSessions.size >= 32) throw new Error("The authorization queue is full. Cancel an unused login and retry.");
      const prepared = prepareOAuthLoginSession();
      const sessionId = `oauth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.oauthSessions.set(sessionId, prepared);
      this.oauthSessionCreatedAt.set(sessionId, Date.now());
      this.oauthSessionAccountIds.set(sessionId, accountId);
      return {
        oauthSession: {
          sessionId,
          authUrl: prepared.authUrl,
          redirectUri: prepared.redirectUri
        }
      };
    } catch (error) {
      const message = translate("message.oauthPrepareFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }
  }

  cancelSession(oauthSessionId: string | undefined): void {
    if (!oauthSessionId) {
      return;
    }

    const source = this.oauthCancellationSources.get(oauthSessionId);
    if (source) {
      source.cancel();
      source.dispose();
      this.oauthCancellationSources.delete(oauthSessionId);
    }
    this.oauthSessions.delete(oauthSessionId);
    this.oauthSessionCreatedAt.delete(oauthSessionId);
    this.oauthSessionAccountIds.delete(oauthSessionId);
  }

  async startAutoFlow(
    oauthSessionId: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
    if (oauthSessionId) {
      const current = this.autoFlows.get(oauthSessionId);
      if (current) return current;
    }
    const result = this.startAutoFlowInternal(oauthSessionId, translate).finally(() => {
      if (oauthSessionId && this.autoFlows.get(oauthSessionId) === result) this.autoFlows.delete(oauthSessionId);
    });
    if (oauthSessionId) this.autoFlows.set(oauthSessionId, result);
    return result;
  }

  private async startAutoFlowInternal(
    oauthSessionId: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
    if (!oauthSessionId) {
      const message = translate("message.oauthPrepareFailed", {
        message: "Missing OAuth session"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    const session = this.oauthSessions.get(oauthSessionId);
    if (!session || this.isSessionExpired(oauthSessionId)) {
      this.cancelSession(oauthSessionId);
      const message = translate("message.oauthPrepareFailed", {
        message: "OAuth session expired"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    const expectedAccountId = this.oauthSessionAccountIds.get(oauthSessionId);
    try {
      const source = new vscode.CancellationTokenSource();
      this.oauthCancellationSources.set(oauthSessionId, source);
      const tokens = await listenForPreparedOAuthLoginSession(session, source.token);
      const result = await this.finishAuthorization(oauthSessionId, tokens, translate, expectedAccountId);
      this.cancelSession(oauthSessionId);
      return result;
    } catch (error) {
      const cancelled = error instanceof Error && error.message === "OAuth login cancelled by user.";
      this.oauthCancellationSources.get(oauthSessionId)?.dispose();
      this.oauthCancellationSources.delete(oauthSessionId);
      if (cancelled) {
        const completed = this.authorizations.get(oauthSessionId);
        if (completed) return completed;
        this.cancelSession(oauthSessionId);
        return undefined;
      }
      const message = translate("message.oauthCallbackFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }
  }

  async completeSession(
    oauthSessionId: string | undefined,
    callbackUrl: string | undefined,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"]> {
    if (!oauthSessionId || !callbackUrl?.trim()) {
      const message = translate("message.oauthCallbackFailed", {
        message: "Missing OAuth session or callback URL"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    const completed = this.authorizations.get(oauthSessionId);
    if (completed) return completed;
    const session = this.oauthSessions.get(oauthSessionId);
    if (!session || this.isSessionExpired(oauthSessionId)) {
      this.cancelSession(oauthSessionId);
      const message = translate("message.oauthPrepareFailed", {
        message: "OAuth session expired"
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    const expectedAccountId = this.oauthSessionAccountIds.get(oauthSessionId);
    try {
      const tokens = await completeOAuthLoginSession(session, callbackUrl.trim());
      const result = await this.finishAuthorization(oauthSessionId, tokens, translate, expectedAccountId);
      this.cancelSession(oauthSessionId);
      return result;
    } catch (error) {
      const message = translate("message.oauthCallbackFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }
  }

  private finishAuthorization(sessionId: string, tokens: Awaited<ReturnType<typeof completeOAuthLoginSession>>, translate: (key: TranslationKey, values?: TranslationParams) => string, expectedAccountId?: string) {
    const previous = this.authorizations.get(sessionId);
    if (previous) return previous;
    if (!this.oauthSessions.has(sessionId)) throw new Error("OAuth login cancelled by user.");
    if (this.authorizations.size >= 64) {
      const completed = [...this.authorizations.keys()].find(id => !this.pendingAuthorizations.has(id));
      if (!completed) throw new Error("Authorization completion is busy. Retry shortly.");
      this.authorizations.delete(completed);
    }
    this.pendingAuthorizations.add(sessionId);
    const result = (async () => {
      const created = await this.upsertAuthorizedAccount(tokens, expectedAccountId);
      this.schedulePublishState();
      this.reportAuthorized(sessionId, created.email);
      const completion = await this.finishAuthorizedAccount(created.id, created.email, translate);
      this.schedulePublishState();
      showOAuthCompletion(completion);
      return { email: created.email, ...(completion.level === "warning" ? { notice: completion } : {}) };
    })().catch((error: unknown) => {
      if (this.authorizations.get(sessionId) === result) this.authorizations.delete(sessionId);
      throw error;
    }).finally(() => { this.pendingAuthorizations.delete(sessionId); });
    this.authorizations.set(sessionId, result);
    return result;
  }

  private reportAuthorized(sessionId: string, email: string): void {
    try {
      this.notifyAuthorized?.(sessionId, email);
    } catch (error) {
      // A disconnected dashboard must not turn a saved account into an auth failure.
      console.warn("[codexManager] OAuth success notification failed", error);
    }
  }

  private async finishAuthorizedAccount(
    accountId: string,
    email: string,
    translate: (key: TranslationKey, values?: TranslationParams) => string
  ): Promise<DashboardNotice> {
    const baseMessage = translate("message.oauthCompleted", { email });
    try {
      // Reauthorization clears stale auth errors during upsert. Quota, sync,
      // and queued activation are follow-up work; a failure here must not
      // report the already-saved authorization as failed.
      const quotaResult = await refreshImportedAccountQuota(this.repo, accountId);
      const synced = this.syncAccountChange
        ? await waitWithin(this.syncAccountChange(), 500, "Cross-PC sync is still pending")
        : undefined;
      const queuedActivation = await activateQueuedAccountIfCurrentMissing(this.repo);
      if (quotaResult?.error) return { level: "warning", message: `${baseMessage}. ${quotaResult.error.message}` };
      return resolveOAuthCompletion(baseMessage, queuedActivation, synced);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        level: "warning",
        message: `${baseMessage}. Follow-up account setup could not be completed: ${detail}. Refresh the account or retry sync.`
      };
    }
  }

  private async upsertAuthorizedAccount(
    tokens: Parameters<AccountsRepository["upsertFromTokens"]>[0],
    expectedAccountId?: string
  ) {
    if (expectedAccountId) {
      const claims = extractClaims(tokens.idToken, tokens.accessToken);
      const authorizedAccountId = claims.email
        ? buildAccountStorageId(claims.email, claims.accountId ?? tokens.accountId, claims.organizationId)
        : undefined;
      if (authorizedAccountId !== expectedAccountId) {
        throw new Error("The authorized account does not match the account selected for reauthorization.");
      }

      const existing = await this.repo.getAccount(expectedAccountId);
      if (!existing) {
        throw new Error("The account selected for reauthorization no longer exists.");
      }

      // Update the existing record instead of replacing it. updateTokens clears
      // stale auth errors, preserves tags/quota metadata, and mirrors auth.json
      // when the reauthorized account is active.
      return this.repo.updateTokens(expectedAccountId, {
        ...tokens,
        accountId: tokens.accountId ?? existing.accountId
      });
    }
    const created = await this.repo.upsertFromTokens(tokens, false);
    return created;
  }

  private isSessionExpired(sessionId: string): boolean {
    const createdAt = this.oauthSessionCreatedAt.get(sessionId);
    return !createdAt || Date.now() - createdAt > DashboardOAuthCoordinator.SESSION_TTL_MS;
  }
}

function resolveOAuthCompletion(
  baseMessage: string,
  result: QueuedAccountActivationResult,
  synced?: boolean
): DashboardNotice {
  const syncSuffix =
    synced === false ? " Cross-PC sync could not be completed; run Sync Cross-PC Claims Now to retry." : "";
  if (result.status === "activated") {
    return {
      level: synced === false ? "warning" : "info",
      message: `${baseMessage}. Activated queued account ${result.account.email} because no current account was available.${syncSuffix}`
    };
  }
  if (result.status === "failed") {
    return {
      level: "warning",
      message: `${baseMessage}. The account was added, but queued-account activation failed: ${result.message}${syncSuffix}`
    };
  }
  if (synced === false) {
    return { level: "warning", message: `${baseMessage}.${syncSuffix}` };
  }
  return { level: "info", message: baseMessage };
}

function showOAuthCompletion(notice: DashboardNotice): void {
  if (notice.level === "warning") {
    void vscode.window.showWarningMessage(notice.message);
  }
}
