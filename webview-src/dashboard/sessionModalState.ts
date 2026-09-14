import type { DashboardHostMessage, DashboardOAuthSessionDescriptor } from "../../src/domain/dashboard/types";
import type { CodexImportPreviewSummary, CodexImportResultSummary } from "../../src/core/types";

export type OAuthModalState = {
  oauthSession?: DashboardOAuthSessionDescriptor;
  oauthFlowStarted: boolean;
  oauthCallbackUrl: string;
  oauthError?: string;
};

export type SharedImportState = {
  importJsonError?: string;
  importPreview?: CodexImportPreviewSummary;
  importResult?: CodexImportResultSummary;
};

export function reduceOAuthAuthorized(
  state: OAuthModalState,
  oauthSessionId: string
): { matched: boolean; next: OAuthModalState } {
  if (state.oauthSession?.sessionId !== oauthSessionId) return { matched: false, next: state };
  return {
    matched: true,
    next: {
      oauthSession: undefined,
      oauthFlowStarted: false,
      oauthCallbackUrl: "",
      oauthError: undefined
    }
  };
}

export function isCurrentOAuthActionResult(
  message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>,
  requestIds: { prepare?: string; start?: string; complete?: string }
): boolean {
  const requestKind = message.action === "prepareOAuthSession" ? "prepare"
    : message.action === "startOAuthAutoFlow" ? "start"
    : message.action === "completeOAuthSession" ? "complete"
    : undefined;
  return !requestKind || requestIds[requestKind] === message.requestId;
}

export function reduceOAuthActionResult(
  state: OAuthModalState,
  message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>
): { handled: boolean; next: OAuthModalState; shouldCloseModal?: boolean } {
  if (
    message.status === "failed" &&
    (message.action === "prepareOAuthSession" ||
      message.action === "completeOAuthSession" ||
      message.action === "startOAuthAutoFlow")
  ) {
    return {
      handled: true,
      next: {
        ...state,
        oauthFlowStarted:
          message.action === "completeOAuthSession" || message.action === "startOAuthAutoFlow"
            ? false
            : state.oauthFlowStarted,
        oauthError: message.error
      }
    };
  }

  if (message.action === "prepareOAuthSession" && message.payload?.oauthSession) {
    return {
      handled: true,
      next: {
        ...state,
        oauthSession: message.payload.oauthSession,
        oauthFlowStarted: false,
        oauthError: undefined
      }
    };
  }

  if (message.action === "completeOAuthSession" || message.action === "startOAuthAutoFlow") {
    return {
      handled: true,
      shouldCloseModal: true,
      next: {
        oauthSession: undefined,
        oauthFlowStarted: false,
        oauthCallbackUrl: "",
        oauthError: undefined
      }
    };
  }

  return {
    handled: false,
    next: state
  };
}

export function reduceSharedImportActionResult(
  state: SharedImportState,
  message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>
): { handled: boolean; next: SharedImportState } {
  if (message.status === "failed" && (message.action === "importSharedJson" || message.action === "previewImportSharedJson")) {
    return {
      handled: true,
      next: {
        ...state,
        importJsonError: message.error
      }
    };
  }

  if (message.action === "previewImportSharedJson" && message.payload?.importPreview) {
    return {
      handled: true,
      next: {
        importJsonError: undefined,
        importPreview: message.payload.importPreview,
        importResult: undefined
      }
    };
  }

  if (
    message.action === "importSharedJson" ||
    message.action === "restoreFromBackup" ||
    message.action === "restoreFromAuthJson"
  ) {
    return {
      handled: true,
      next: {
        ...state,
        importJsonError: undefined,
        importResult: message.action === "importSharedJson" ? message.payload?.importResult : state.importResult
      }
    };
  }

  return {
    handled: false,
    next: state
  };
}
