import { useRef, useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { reduceOAuthActionResult, type OAuthModalState } from "./sessionModalState";

export function useOAuthSessionModal(params: {
  sendAction: SendAction;
  showCopyFeedback: (key: string) => void;
  openAuthorizationInClient: boolean;
  getPrepareAccountId?: () => string | undefined;
}) {
  const [oauthState, setOauthState] = useState<OAuthModalState>({
    oauthFlowStarted: false,
    oauthCallbackUrl: ""
  });
  const actionInFlight = useRef<"prepare" | "start" | "complete" | undefined>(undefined);
  const oauthCopyPending = useRef(false);

  const reset = (): void => {
    setOauthState({
      oauthSession: undefined,
      oauthFlowStarted: false,
      oauthCallbackUrl: "",
      oauthError: undefined
    });
    actionInFlight.current = undefined;
    oauthCopyPending.current = false;
  };

  const cancelSession = (): void => {
    if (oauthState.oauthSession) {
      params.sendAction("cancelOAuthSession", undefined, {
        oauthSessionId: oauthState.oauthSession.sessionId
      });
    }
    reset();
  };

  const handlePrepareOauthLink = (): void => {
    if (oauthState.oauthSession?.authUrl || actionInFlight.current) {
      return;
    }
    actionInFlight.current = "prepare";
    params.sendAction("prepareOAuthSession", params.getPrepareAccountId?.());
  };

  const handleCopyOauthLink = (): void => {
    if (!oauthState.oauthSession?.authUrl) {
      handlePrepareOauthLink();
      return;
    }
    copyOauthLink(oauthState.oauthSession.authUrl);
  };

  const copyOauthLink = (authUrl: string): void => {
    if (params.openAuthorizationInClient) {
      void copyOAuthAuthorizationLink(authUrl).then((copied) => {
        if (copied) {
          params.showCopyFeedback("oauth-link");
          return;
        }
        setOauthState((current) => ({
          ...current,
          oauthError: "The authorization link could not be copied automatically. Use the copy icon to try again."
        }));
      });
      return;
    }
    oauthCopyPending.current = true;
    params.sendAction("copyText", undefined, { text: authUrl });
  };

  const handleStartOAuthAutoFlow = (): void => {
    if (!oauthState.oauthSession?.authUrl) {
      handlePrepareOauthLink();
      return;
    }
    if (params.openAuthorizationInClient) {
      if (!openOAuthAuthorizationWindow(oauthState.oauthSession.authUrl)) {
        setOauthState((current) => ({
          ...current,
          oauthError: "The browser blocked the authorization window. Allow pop-ups or copy the authorization link."
        }));
      }
      return;
    }
    params.sendAction("openExternalUrl", undefined, { url: oauthState.oauthSession.authUrl });
  };

  const handleCompleteOAuth = (): void => {
    if (!oauthState.oauthSession || !oauthState.oauthCallbackUrl.trim() || actionInFlight.current) {
      return;
    }
    actionInFlight.current = "complete";
    setOauthState((current) => ({
      ...current,
      oauthFlowStarted: true,
      oauthError: undefined
    }));
    params.sendAction("completeOAuthSession", undefined, {
      oauthSessionId: oauthState.oauthSession.sessionId,
      callbackUrl: oauthState.oauthCallbackUrl
    });
  };

  const applyActionResult = (
    message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>
  ): { handled: boolean; shouldCloseModal?: boolean } => {
    const copyOutcome = resolveOAuthCopyActionOutcome(message, oauthCopyPending.current);
    if (copyOutcome) {
      oauthCopyPending.current = false;
      if (copyOutcome === "copied") {
        params.showCopyFeedback("oauth-link");
      } else {
        setOauthState((current) => ({
          ...current,
          oauthError: message.error ?? "The authorization link could not be copied. Use the copy icon to try again."
        }));
      }
      return { handled: true };
    }
    const reduced = reduceOAuthActionResult(oauthState, message);
    if (!reduced.handled) {
      return { handled: false };
    }
    if (message.action === "startOAuthAutoFlow" || message.action === "completeOAuthSession") {
      actionInFlight.current = undefined;
    }
    if (message.action === "prepareOAuthSession") {
      actionInFlight.current = undefined;
      const session = message.status === "completed" ? message.payload?.oauthSession : undefined;
      if (session) {
        copyOauthLink(session.authUrl);
        actionInFlight.current = "start";
        params.sendAction("startOAuthAutoFlow", undefined, { oauthSessionId: session.sessionId });
      }
    }
    setOauthState(reduced.next);
    return {
      handled: true,
      shouldCloseModal: reduced.shouldCloseModal
    };
  };

  return {
    oauthSession: oauthState.oauthSession,
    oauthCallbackUrl: oauthState.oauthCallbackUrl,
    oauthError: oauthState.oauthError,
    oauthFlowStarted: oauthState.oauthFlowStarted,
    cancelSession,
    reset,
    handlePrepareOauthLink,
    handleCopyOauthLink,
    handleStartOAuthAutoFlow,
    handleCompleteOAuth,
    applyActionResult,
    setOauthCallbackUrl: (value: string) => {
      setOauthState((current) => ({ ...current, oauthCallbackUrl: value }));
    }
  };
}

export function resolveOAuthCopyActionOutcome(
  message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>,
  copyPending: boolean
): "copied" | "failed" | undefined {
  if (!copyPending || message.action !== "copyText") return undefined;
  return message.status === "completed" ? "copied" : "failed";
}

export function openOAuthAuthorizationWindow(authUrl: string): boolean {
  try {
    return Boolean(window.open(authUrl, "_blank", "noopener,noreferrer"));
  } catch {
    return false;
  }
}

export async function copyOAuthAuthorizationLink(authUrl: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(authUrl);
    return true;
  } catch {
    return false;
  }
}
