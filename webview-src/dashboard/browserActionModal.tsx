import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type {
  DashboardAccountViewModel,
  DashboardActionName,
  DashboardState
} from "../../src/domain/dashboard/types";
import { ModalShell } from "./components";
import { useModalAccessibility } from "./primitives";

export type BrowserActionRequest =
  | {
      kind: "switch";
      accountIds: string[];
      targetDeviceId?: string;
    }
  | {
      kind: "quotaWarning";
      action: "switch";
      accountId: string;
      switchAccountId?: string;
      switchLabel?: string;
      resetLabel?: string;
      selectLabel: string;
      laterLabel: string;
      title: string;
      message: string;
    }
  | {
      kind: "notification";
      notificationId: string;
      level: "info" | "warning" | "error";
      message: string;
      actions: string[];
    }
  | {
      kind: "confirm";
      action: Extract<DashboardActionName, "reloadPrompt" | "remove" | "batchRemove" | "consumeResetCredit">;
      accountId?: string;
      accountIds?: string[];
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
    }
  | {
      kind: "tags";
      accountId?: string;
      accountIds: string[];
      mode: "set" | "add" | "remove";
      initialTags: string[];
      title: string;
    }
  | {
      kind: "password";
      action: Extract<DashboardActionName, "configureEncryptedSync" | "setEncryptedSyncRegistryOverride">;
      enabled?: boolean;
      title: string;
      message: string;
      confirmPassword: boolean;
    };

export function BrowserActionModal(props: {
  request?: BrowserActionRequest;
  accounts: DashboardAccountViewModel[];
  lang: DashboardState["lang"];
  closeLabel: string;
  onCancel: (request: BrowserActionRequest) => void;
  onConfirm: (request: BrowserActionRequest, submittedTags?: string[]) => void;
  presentation?: "modal" | "popover";
}) {
  const request = props.request;
  const [tagText, setTagText] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");

  useEffect(() => {
    setTagText(request?.kind === "tags" ? request.initialTags.join(", ") : "");
    setPassword("");
    setPasswordConfirmation("");
  }, [request]);

  if (!request) {
    return null;
  }

  const cancelLabel = props.lang === "zh" ? "取消" : props.lang === "zh-hant" ? "取消" : "Cancel";
  // Confirmation and choice dialogs need a stable, viewport-level placement.
  // Keeping them in the action popover makes a reset/remove prompt overlap the
  // quota cards (and can move it off-screen when the dashboard is scrolled).
  // Lightweight pickers and forms can still use the compact action popover.
  const useModalShell =
    request.kind === "confirm" ||
    request.kind === "quotaWarning" ||
    request.kind === "notification" ||
    request.kind === "password";
  const Shell = useModalShell || props.presentation !== "popover" ? ModalShell : ActionPopoverShell;
  if (request.kind === "switch") {
    const candidates = request.accountIds
      .map((id) => props.accounts.find((account) => account.id === id))
      .filter((account): account is DashboardAccountViewModel => Boolean(account));
    const title = props.lang === "zh" ? "切换账号" : props.lang === "zh-hant" ? "切換帳號" : "Switch account";
    const empty = props.lang === "zh"
      ? "没有可切换的账号。"
      : props.lang === "zh-hant"
        ? "沒有可切換的帳號。"
        : "No account is available to switch to.";
    return (
      <Shell
        open
        title={title}
        closeLabel={props.closeLabel}
        className="dashboard-modal-compact browser-action-modal"
        onClose={() => props.onCancel(request)}
      >
        <div class="modal-stack">
          {candidates.length ? (
            <div class="browser-account-picker" role="listbox" aria-label={title}>
              {candidates.map((account) => (
                <button
                  key={account.id}
                  class="browser-account-picker-item"
                  type="button"
                  role="option"
                  onClick={() => props.onConfirm({ ...request, accountIds: [account.id] })}
                >
                  <span>{account.email}</span>
                  <small>{account.planTypeLabel} · {account.workspaceLabel}</small>
                </button>
              ))}
            </div>
          ) : (
            <div class="modal-note">{empty}</div>
          )}
          <div class="modal-actions">
            <button class="modal-secondary-btn" type="button" onClick={() => props.onCancel(request)}>
              {cancelLabel}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (request.kind === "tags") {
    const help = props.lang === "zh"
      ? "用逗号分隔标签。留空可清除全部标签。"
      : props.lang === "zh-hant"
        ? "用逗號分隔標籤。留空可清除全部標籤。"
        : "Separate tags with commas. Leave empty to clear all tags.";
    const saveLabel = props.lang === "zh" ? "保存" : props.lang === "zh-hant" ? "儲存" : "Save";
    return (
      <Shell
        open
        title={request.title}
        closeLabel={props.closeLabel}
        className="dashboard-modal-compact browser-action-modal"
        onClose={() => props.onCancel(request)}
      >
        <form
          class="modal-stack"
          onSubmit={(event) => {
            event.preventDefault();
            props.onConfirm(request, parseSubmittedTags(tagText));
          }}
        >
          <label class="modal-note" for="browser-action-tags">{help}</label>
          <input
            id="browser-action-tags"
            class="modal-input"
            type="text"
            value={tagText}
            autoFocus
            onInput={(event) => setTagText(event.currentTarget.value)}
          />
          <div class="modal-actions">
            <button class="modal-secondary-btn" type="button" onClick={() => props.onCancel(request)}>
              {cancelLabel}
            </button>
            <button class="modal-primary-btn" type="submit">{saveLabel}</button>
          </div>
        </form>
      </Shell>
    );
  }

  if (request.kind === "password") {
    const submitLabel = props.lang === "zh" ? "继续" : props.lang === "zh-hant" ? "繼續" : "Continue";
    const mismatch = request.confirmPassword && passwordConfirmation !== password;
    return (
      <Shell
        open
        title={request.title}
        closeLabel={props.closeLabel}
        className="dashboard-modal-compact browser-action-modal"
        onClose={() => props.onCancel(request)}
      >
        <form
          class="modal-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!password || mismatch) {
              return;
            }
            props.onConfirm(request, [password, passwordConfirmation]);
          }}
        >
          <div class="modal-note">{request.message}</div>
          <input
            class="modal-input"
            type="password"
            name="codex-manager-password"
            autoComplete="current-password"
            spellcheck={false}
            value={password}
            placeholder="Password"
            aria-label="Password"
            autoFocus
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
          {request.confirmPassword ? (
            <input
              class="modal-input"
              type="password"
              name="codex-manager-password-confirmation"
              autoComplete="new-password"
              spellcheck={false}
              value={passwordConfirmation}
              placeholder="Confirm password"
              aria-label="Confirm password"
              onInput={(event) => setPasswordConfirmation(event.currentTarget.value)}
            />
          ) : null}
          {mismatch && passwordConfirmation ? <div class="modal-error">The passwords do not match.</div> : null}
          <div class="modal-actions">
            <button class="modal-secondary-btn" type="button" onClick={() => props.onCancel(request)}>
              {cancelLabel}
            </button>
            <button class="modal-primary-btn" type="submit" disabled={!password || mismatch}>
              {submitLabel}
            </button>
          </div>
        </form>
      </Shell>
    );
  }

  if (request.kind === "quotaWarning") {
    return (
      <Shell
        open
        title={request.title}
        closeLabel={props.closeLabel}
        className="dashboard-confirm-modal"
        onClose={() => props.onCancel(request)}
      >
        <div class="modal-stack">
          <div class="modal-note">{request.message}</div>
          <div class="modal-actions action-popover-choice-grid">
            {request.switchAccountId && request.switchLabel ? (
              <button class="modal-primary-btn" type="button" onClick={() => props.onConfirm(request, ["switch"])}>
                {request.switchLabel}
              </button>
            ) : null}
            {request.resetLabel ? (
              <button class="modal-primary-btn" type="button" onClick={() => props.onConfirm(request, ["reset"])}>
                {request.resetLabel}
              </button>
            ) : null}
            <button class="modal-secondary-btn" type="button" onClick={() => props.onConfirm(request, ["select"])}>
              {request.selectLabel}
            </button>
            <button class="modal-secondary-btn" type="button" onClick={() => props.onCancel(request)}>
              {request.laterLabel}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (request.kind === "notification") {
    const title = props.lang === "zh" ? "VS Code 通知" : props.lang === "zh-hant" ? "VS Code 通知" : "VS Code notification";
    return (
      <Shell
        open
        title={title}
        closeLabel={props.closeLabel}
        className="dashboard-confirm-modal"
        onClose={() => props.onCancel(request)}
      >
        <div class="modal-stack">
          <div class="modal-note">{request.message}</div>
          <div class="modal-actions action-popover-choice-grid">
            {request.actions.map((action) => (
              <button key={action} class="modal-primary-btn" type="button" onClick={() => props.onConfirm(request, [action])}>
                {action}
              </button>
            ))}
            <button class="modal-secondary-btn" type="button" onClick={() => props.onCancel(request)}>
              {cancelLabel}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      open
      title={request.title}
      closeLabel={props.closeLabel}
      className="dashboard-modal-compact browser-action-modal dashboard-confirm-modal"
      onClose={() => props.onCancel(request)}
    >
      <div class="modal-stack">
        <div class="modal-note">{request.message}</div>
        <div class="modal-actions">
          <button class="modal-secondary-btn" type="button" onClick={() => props.onCancel(request)}>
            {cancelLabel}
          </button>
          <button
            class={`modal-primary-btn ${request.danger ? "danger" : ""}`}
            type="button"
            onClick={() => props.onConfirm(request)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </Shell>
  );
}

function ActionPopoverShell(props: {
  open: boolean;
  title: string;
  closeLabel: string;
  className?: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const accessibility = useModalAccessibility(props.open, props.onClose);
  return (
    <div class="action-popover-layer" aria-hidden={!props.open}>
      <div
        ref={accessibility.modalRef}
        class={`dashboard-action-popover ${props.className ?? ""}`.trim()}
        role="dialog"
        aria-modal="false"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={accessibility.onKeyDown}
      >
        <div class="action-popover-head">
          <div class="action-popover-title">{props.title}</div>
          <button class="action-popover-close" type="button" aria-label={props.closeLabel} onClick={props.onClose}>×</button>
        </div>
        <div class="action-popover-body">{props.children}</div>
      </div>
    </div>
  );
}

export function parseSubmittedTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}
