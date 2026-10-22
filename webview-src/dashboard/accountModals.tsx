import type {
  DashboardAccountViewModel,
  DashboardCopy,
  DashboardOAuthSessionDescriptor,
  DashboardState
} from "../../src/domain/dashboard/types";
import { useEffect, useRef, useState } from "preact/hooks";
import { normalizeAccountTags, MAX_ACCOUNT_TAGS } from '../../src/domain/accountTags';
import type { CliSubmissionResult } from './cliSessionComposerState';
import type { CodexImportResultSummary } from "../../src/core/types";
import { ImportResultPanel, ModalShell } from "./components";
import { createShareFileName, formatTemplate, getSensitiveDisplayValue, maskSharedJson } from "./helpers";
import { CopyIcon, DownloadIcon, EditTagsIcon, EyeIcon, EyeOffIcon, GlobeIcon, ImportIcon, SuccessIcon, renderRemoveIcon } from "./icons";

export function TagManagerModal(props: {
  accounts: DashboardAccountViewModel[];
  connected: boolean;
  results: CliSubmissionResult[];
  onClose: () => void;
  onFilter: (tag: string) => void;
  onAction: (tag: string, operation: 'rename' | 'remove' | 'enable' | 'disable', accountIds: string[], replacement?: string) => string;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ tag: string; operation: 'rename' | 'remove' | 'enable' | 'disable'; replacement: string }>();
  const [requestId, setRequestId] = useState<string>();
  const renameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing?.operation === 'rename') { renameInput.current?.focus(); renameInput.current?.select(); } }, [editing?.tag, editing?.operation]);
  const result = props.results.find(item => item.requestId === requestId);
  const pending = Boolean(requestId && !result);
  useEffect(() => { if (result?.status === 'completed') setEditing(undefined); }, [result?.status]);
  const groups = new Map<string, { tag: string; accounts: DashboardAccountViewModel[] }>();
  for (const account of props.accounts) for (const tag of new Map((account.tags ?? []).map(tag => [tag.toLowerCase(), tag])).values()) {
    const key = tag.toLowerCase(), group = groups.get(key) ?? { tag, accounts: [] };
    group.accounts.push(account); groups.set(key, group);
  }
  let validation = '';
  if (editing?.operation === 'rename') { try { if (!normalizeAccountTags([editing.replacement]).length) validation = 'Enter a tag name.'; } catch (error) { validation = error instanceof Error ? error.message : String(error); } }
  const visibleGroups = [...groups.values()].filter(group => group.tag.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => a.tag.localeCompare(b.tag));
  const taggedCount = props.accounts.filter(account => account.tags?.length).length;
  return <ModalShell open title="Tags" closeLabel="Close tag management" className="dashboard-modal-compact tag-manager-modal" closeDisabled={pending} onClose={props.onClose}>
    <div class="tag-manager-summary"><span>{groups.size} tag{groups.size === 1 ? '' : 's'} · {taggedCount} account{taggedCount === 1 ? '' : 's'}</span><input type="search" aria-label="Find tags" placeholder="Find a tag…" value={query} onInput={event => setQuery(event.currentTarget.value)} /></div>
    <div class="tag-manager-list">{visibleGroups.map(group => <div class="tag-manager-entry" key={group.tag.toLowerCase()}>
      <div class="tag-manager-row"><div class="tag-manager-name"><strong title={group.tag}>{group.tag}</strong><span>{group.accounts.length} account{group.accounts.length === 1 ? '' : 's'} · {group.accounts.filter(account => account.enabled).length} enabled</span></div><div class="tag-manager-tools">
        <button type="button" title={`Filter accounts by ${group.tag}`} aria-label={`Filter accounts by ${group.tag}`} disabled={pending} onClick={() => props.onFilter(group.tag)}><EyeIcon /></button>
        <button type="button" title={`Rename ${group.tag}`} aria-label={`Rename ${group.tag}`} disabled={pending || !props.connected} onClick={() => setEditing({ tag: group.tag, operation: 'rename', replacement: group.tag })}><EditTagsIcon /></button>
        <button type="button" title={`Enable accounts tagged ${group.tag}`} aria-label={`Enable accounts tagged ${group.tag}`} disabled={pending || !props.connected || group.accounts.every(account => account.enabled)} onClick={() => setEditing({ tag: group.tag, operation: 'enable', replacement: '' })}><SuccessIcon /></button>
        <button type="button" title={`Disable accounts tagged ${group.tag}`} aria-label={`Disable accounts tagged ${group.tag}`} disabled={pending || !props.connected || group.accounts.every(account => !account.enabled)} onClick={() => setEditing({ tag: group.tag, operation: 'disable', replacement: '' })}><EyeOffIcon /></button>
        <button type="button" class="danger" title={`Remove tag ${group.tag}`} aria-label={`Remove tag ${group.tag}`} disabled={pending || !props.connected} onClick={() => setEditing({ tag: group.tag, operation: 'remove', replacement: '' })}>{renderRemoveIcon()}</button>
      </div></div>
      {editing?.tag.toLowerCase() === group.tag.toLowerCase() ? <form class="tag-manager-confirm" onSubmit={event => { event.preventDefault(); if (!pending && props.connected && !validation) setRequestId(props.onAction(group.tag, editing.operation, group.accounts.map(account => account.id), editing.replacement)); }}>
        {editing.operation === 'rename' ? <label>New tag name<input ref={renameInput} aria-label="New tag name" value={editing.replacement} maxLength={24} readOnly={pending} onInput={event => setEditing({ ...editing, replacement: event.currentTarget.value })} /></label> : <span>{editing.operation === 'remove' ? `Remove this tag from ${group.accounts.length} accounts? Accounts are kept.` : `${editing.operation === 'enable' ? 'Enable' : 'Disable'} ${group.accounts.length} tagged accounts?`}</span>}
        <div><button type="button" disabled={pending} onClick={() => setEditing(undefined)}>Cancel</button><button type="submit" disabled={pending || !props.connected || !!validation || editing.operation === 'rename' && editing.replacement === group.tag}>{pending ? 'Applying…' : editing.operation === 'rename' ? 'Rename tag' : editing.operation === 'remove' ? 'Remove tag' : 'Confirm'}</button></div>
        {validation ? <small role="alert">{validation}</small> : null}
      </form> : null}
    </div>)}</div>
    {!groups.size ? <p class="account-tags-help">No tags yet. Add tags from an account's menu.</p> : null}
    {groups.size > 0 && !visibleGroups.length ? <p class="account-tags-help">No matching tags.</p> : null}
    {result?.message || !props.connected ? <div class={result?.status === 'failed' || !props.connected ? 'account-tags-error' : 'tag-manager-status'} role="status">{!props.connected ? 'Offline. Reconnect to change tagged accounts.' : result?.message}</div> : null}
  </ModalShell>;
}

export function AccountTagsModal(props: {
  account: DashboardAccountViewModel;
  privacyMode: boolean;
  connected: boolean;
  results: CliSubmissionResult[];
  onSave: (tags: string[], expectedTags: string[]) => string;
  onClose: () => void;
}) {
  const [text, setText] = useState(() => (props.account.tags ?? []).join(', '));
  const [requestId, setRequestId] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const result = props.results.find(item => item.requestId === requestId);
  const pending = Boolean(requestId && !result);
  let tags: string[] = [], validation = '';
  try { tags = normalizeAccountTags(text.split(/[,\n]/)); }
  catch (error) { validation = error instanceof Error ? error.message : String(error); }
  useEffect(() => { if (result?.status === 'completed') props.onClose(); }, [result?.status]);
  const changed = JSON.stringify(tags) !== JSON.stringify(props.account.tags ?? []);
  return <ModalShell open title="Account tags" closeLabel="Close tags" className="dashboard-modal-compact account-tags-modal" closeDisabled={pending} onClose={props.onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!pending && props.connected && !validation && changed) setRequestId(props.onSave(tags, props.account.tags ?? []));
    }}>
      <div class="account-tags-identity" title={getSensitiveDisplayValue(props.account.email, props.privacyMode, 'email')}>{getSensitiveDisplayValue(props.account.email, props.privacyMode, 'email')}</div>
      <label class="account-tags-field"><span>Tags <small>{tags.length}/{MAX_ACCOUNT_TAGS}</small></span><input ref={input} aria-label="Tags" value={text} maxLength={512} autoComplete="off" readOnly={pending} placeholder="Work, Personal, Team…" onInput={event => setText(event.currentTarget.value)} aria-describedby="account-tags-help" aria-invalid={Boolean(validation)} /></label>
      <p id="account-tags-help" class="account-tags-help">Separate with commas · Up to 10 tags, 24 characters each</p>
      {tags.length ? <div class="account-tags-preview">{tags.map(tag => <button type="button" key={tag.toLowerCase()} disabled={pending} title={`Remove ${tag}`} aria-label={`Remove tag ${tag}`} onClick={() => setText(tags.filter(value => value !== tag).join(', '))}><span>{tag}</span><span aria-hidden="true">×</span></button>)}</div> : null}
      {validation || result?.status === 'failed' || result?.status === 'cancelled' || !props.connected ? <div class="account-tags-error" role="alert">{validation || result?.message || (!props.connected ? 'Offline. Your draft is kept; reconnect to save.' : 'Tags were not saved. Your draft is kept.')}</div> : null}
      <div class="account-tags-actions"><button type="button" disabled={pending} onClick={props.onClose}>Cancel</button><button type="submit" disabled={pending || !props.connected || !!validation || !changed}>{pending ? 'Saving…' : 'Save tags'}</button></div>
    </form>
  </ModalShell>;
}

export function resolveCreateOAuthLinkLabel(lang: DashboardState["lang"]): string {
  if (lang === "zh") return "创建链接";
  if (lang === "zh-hant") return "建立連結";
  return "Create Link";
}

export function resolveAccountModalTitle(defaultTitle: string, reauthorizeEmail?: string): string {
  const email = reauthorizeEmail?.trim();
  return email ? `Re Auth ${email}` : defaultTitle;
}

function resolveAccountInfoCopy(lang: DashboardState["lang"]): {
  title: string;
  workspace: string;
  subscription: string;
  addedBy: string;
  created: string;
  status: string;
  userId: string;
  accountId: string;
  organizationId: string;
} {
  if (lang === "zh") {
    return {
      title: "账号信息",
      workspace: "工作区",
      subscription: "订阅",
      addedBy: "添加方式",
      created: "创建时间",
      status: "状态",
      userId: "用户 ID",
      accountId: "账号 ID",
      organizationId: "组织 ID"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "帳號資訊",
      workspace: "工作區",
      subscription: "訂閱",
      addedBy: "新增方式",
      created: "建立時間",
      status: "狀態",
      userId: "使用者 ID",
      accountId: "帳號 ID",
      organizationId: "組織 ID"
    };
  }
  return {
    title: "Account info",
    workspace: "Workspace",
    subscription: "Subscription",
    addedBy: "Added by",
    created: "Created",
    status: "Status",
    userId: "User ID",
    accountId: "Account ID",
    organizationId: "Organization ID"
  };
}

export function AccountInfoModal(props: {
  account?: DashboardAccountViewModel;
  lang: DashboardState["lang"];
  privacyMode: boolean;
  closeLabel: string;
  onClose: () => void;
}) {
  const account = props.account;
  const copy = resolveAccountInfoCopy(props.lang);
  return (
    <ModalShell
      open={Boolean(account)}
      title={
        account ? `${copy.title}: ${getSensitiveDisplayValue(account.email, props.privacyMode, "email")}` : copy.title
      }
      closeLabel={props.closeLabel}
      className="dashboard-modal-compact account-info-modal"
      onClose={props.onClose}
    >
      {account ? (
        <div class="account-info-grid">
          <InfoRow label={copy.workspace} value={account.workspaceLabel} />
          <InfoRow label={copy.subscription} value={account.subscriptionText} title={account.subscriptionTitle} />
          <InfoRow label={copy.addedBy} value={account.addMethodLabel} />
          <InfoRow label={copy.created} value={account.addedAtLabel} />
          <InfoRow label={copy.status} value={account.healthLabel} />
          <InfoRow
            label={copy.userId}
            value={getSensitiveDisplayValue(account.userId, props.privacyMode, "id", "—")}
            mono
          />
          <InfoRow
            label={copy.accountId}
            value={getSensitiveDisplayValue(account.accountId, props.privacyMode, "id", "—")}
            mono
          />
          <InfoRow
            label={copy.organizationId}
            value={getSensitiveDisplayValue(account.organizationId, props.privacyMode, "id", "—")}
            mono
          />
        </div>
      ) : null}
    </ModalShell>
  );
}

function InfoRow(props: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <div class="account-info-row">
      <span class="account-info-label">{props.label}</span>
      <span class={`account-info-value ${props.mono ? "is-mono" : ""}`} title={props.title}>
        {props.value}
      </span>
    </div>
  );
}

export function AddAccountModal(props: {
  open: boolean;
  inline?: boolean;
  title: string;
  tab: "oauth" | "import";
  copy: DashboardCopy;
  oauthSession?: DashboardOAuthSessionDescriptor;
  oauthCallbackUrl: string;
  oauthError?: string;
  importJsonText: string;
  importJsonError?: string;
  importResult?: CodexImportResultSummary;
  copyFeedbackKey: string | null;
  lang: DashboardState["lang"];
  prepareOAuthPending: boolean;
  startOAuthAutoPending: boolean;
  completeOAuthPending: boolean;
  importCurrentPending: boolean;
  importSharedPending: boolean;
  onClose: () => void;
  onSelectTab: (tab: "oauth" | "import") => void;
  onCreateOauthLink: () => void;
  onCopyOauthLink: () => void;
  onOpenInBrowser: () => void;
  onOauthCallbackChange: (value: string) => void;
  onCompleteOAuth: () => void;
  onImportCurrent: () => void;
  onImportFileSelected: (file: File) => void;
  onImportTextChange: (value: string) => void;
  onSubmitImport: () => void;
}) {
  const oauthLinkReady = Boolean(props.oauthSession?.authUrl);
  const [layer, setLayer] = useState<"oauth" | "callback" | "import">("oauth");

  useEffect(() => {
    if (!props.open && !props.inline) setLayer("oauth");
  }, [props.inline, props.open]);

  useEffect(() => {
    if (!props.oauthSession && layer === "callback") setLayer("oauth");
  }, [layer, props.oauthSession]);

  const controls = (
    <div class={`modal-stack account-add-flow ${props.inline ? "is-inline" : ""}`}>
      {layer === "oauth" ? (
        <>
          <div class="modal-stack oauth-modal-stack">
            <div class="oauth-link-field account-add-layer-card">
              <div class="modal-label">{props.copy.authorizationLink}</div>
              <div class={`oauth-link-row ${oauthLinkReady ? "" : "is-create"}`}>
                <input
                  class="modal-input oauth-link-input"
                  type="text"
                  readOnly
                  value={props.oauthSession?.authUrl ?? ""}
                  placeholder={props.copy.authorizationLink}
                  aria-label={props.copy.authorizationLink}
                />
                {oauthLinkReady ? (
                  <>
                    <button
                      class={`modal-mini-btn modal-icon-btn oauth-copy-btn ${props.copyFeedbackKey === "oauth-link" ? "is-success" : ""}`}
                      type="button"
                      aria-label={props.copyFeedbackKey === "oauth-link" ? props.copy.copySuccess : props.copy.copyLink}
                      title={props.copyFeedbackKey === "oauth-link" ? props.copy.copySuccess : props.copy.copyLink}
                      onClick={() => {
                        props.onCopyOauthLink();
                        setLayer("callback");
                      }}
                    >
                      <span class="modal-btn-icon" aria-hidden="true">
                        {props.copyFeedbackKey === "oauth-link" ? <SuccessIcon /> : <CopyIcon />}
                      </span>
                    </button>
                    <button
                      class="modal-mini-btn modal-icon-btn oauth-open-btn"
                      type="button"
                      aria-label={props.copy.openInBrowser}
                      title={props.copy.openInBrowser}
                      onClick={() => {
                        props.onOpenInBrowser();
                        setLayer("callback");
                      }}
                    >
                      <span class="modal-btn-icon" aria-hidden="true">
                        <GlobeIcon />
                      </span>
                    </button>
                  </>
                ) : (
                  <button
                    class="modal-primary-btn oauth-create-link-btn"
                    type="button"
                    disabled={props.prepareOAuthPending}
                    aria-busy={props.prepareOAuthPending}
                    onClick={props.onCreateOauthLink}
                  >
                    <span class="modal-btn-icon" aria-hidden="true">
                      <GlobeIcon />
                    </span>
                    {props.prepareOAuthPending ? "..." : resolveCreateOAuthLinkLabel(props.lang)}
                  </button>
                )}
              </div>
            </div>
            {props.oauthError ? <div class="modal-error">{props.oauthError}</div> : null}
          </div>
          <div class="account-add-choice-divider" role="separator" aria-label="Alternative account import methods">
            <span>{props.lang === "zh" ? "或" : "OR"}</span>
          </div>
          <div class="account-add-layer-actions" aria-label="Other ways to add an account">
            <label class="account-add-layer-action">
              <span class="modal-btn-icon" aria-hidden="true">
                <ImportIcon />
              </span>
              <span>{props.copy.importJsonChooseFile}</span>
              <input
                class="modal-file-input"
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    props.onImportFileSelected(file);
                    setLayer("import");
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <div class="account-add-choice-divider" role="separator" aria-label="Alternative account import method">
            <span>{props.lang === "zh" ? "或" : "OR"}</span>
          </div>
          <button
            class="account-add-layer-action"
            type="button"
            disabled={props.importCurrentPending}
            onClick={props.onImportCurrent}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              <ImportIcon />
            </span>
            <span>{props.importCurrentPending ? "..." : props.copy.importCurrent}</span>
          </button>
        </>
      ) : null}
      {layer === "callback" ? (
        <div class="account-add-layer-card account-add-callback-layer">
          <div class="account-add-layer-head">
            <div class="modal-label">{props.copy.manualCallbackLabel}</div>
            <button class="account-add-back" type="button" onClick={() => setLayer("oauth")}>
              Back
            </button>
          </div>
          <form
            class="oauth-callback-row"
            onSubmit={(event) => {
              event.preventDefault();
              props.onCompleteOAuth();
            }}
          >
            <textarea
              class="modal-input oauth-callback-input"
              rows={3}
              value={props.oauthCallbackUrl}
              placeholder={props.copy.manualCallbackLabel}
              aria-label={props.copy.manualCallbackLabel}
              spellcheck={false}
              autoFocus
              onInput={(event) => props.onOauthCallbackChange(event.currentTarget.value)}
            />
            <button
              class="modal-primary-btn"
              type="submit"
              disabled={!props.oauthSession || !props.oauthCallbackUrl.trim() || props.completeOAuthPending}
            >
              {props.completeOAuthPending ? "..." : props.copy.authorizedContinue}
            </button>
          </form>
          {props.oauthError ? <div class="modal-error">{props.oauthError}</div> : null}
        </div>
      ) : null}
      {layer === "import" ? (
        <div class="account-add-layer-card account-add-file-layer">
          <div class="account-add-layer-head">
            <div>
              <div class="modal-label">{props.copy.importJsonChooseFile}</div>
              <div class="account-add-file-status">
                {props.importJsonText ? "JSON file ready" : "Reading JSON file…"}
              </div>
            </div>
            <button class="account-add-back" type="button" onClick={() => setLayer("oauth")}>
              Back
            </button>
          </div>
          {props.importResult ? <ImportResultPanel copy={props.copy} summary={props.importResult} /> : null}
          {props.importJsonError ? <div class="modal-error">{props.importJsonError}</div> : null}
          <div class="modal-actions account-add-file-actions">
            <label class="modal-secondary-btn">
              <span class="modal-btn-icon" aria-hidden="true">
                <ImportIcon />
              </span>
              {props.copy.importJsonChooseFile}
              <input
                class="modal-file-input"
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    props.onImportFileSelected(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button
              class="modal-primary-btn"
              type="button"
              disabled={!props.importJsonText.trim() || props.importSharedPending}
              onClick={props.onSubmitImport}
            >
              {!props.importSharedPending ? (
                <span class="modal-btn-icon" aria-hidden="true">
                  <ImportIcon />
                </span>
              ) : null}
              {props.importSharedPending ? "..." : props.copy.importJsonSubmit}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (props.inline) return controls;

  return (
    <ModalShell
      open={props.open}
      title={props.title}
      closeLabel={props.copy.closeModal}
      className="dashboard-modal-compact account-add-popover"
      closeOnBackdrop={false}
      onClose={props.onClose}
    >
      {controls}
    </ModalShell>
  );
}

export function ConfirmCancelOauthModal(props: {
  open: boolean;
  title: string;
  copy: DashboardCopy;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      open={props.open}
      title={props.title}
      closeLabel={props.copy.closeModal}
      className="dashboard-modal-compact dashboard-confirm-modal"
      onClose={props.onClose}
    >
      <div class="modal-stack">
        <div class="modal-note">{props.copy.cancelOauthConfirm}</div>
        <div class="modal-actions">
          <button class="modal-secondary-btn" type="button" onClick={props.onClose}>
            {props.copy.continueOauthBtn}
          </button>
          <button class="modal-primary-btn" type="button" onClick={props.onConfirm}>
            {props.copy.cancelOauthBtn}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ShareTokenModal(props: {
  open: boolean;
  copy: DashboardCopy;
  selectedCount: number;
  shareModalJson: string;
  shareModalFilename?: string;
  sharePreviewExpanded: boolean;
  copyFeedbackKey: string | null;
  downloadSharePending: boolean;
  onClose: () => void;
  onTogglePreview: () => void;
  onCopyJson: () => void;
  onDownloadJson: (filename: string, text: string) => void;
}) {
  const previewValue = props.sharePreviewExpanded ? props.shareModalJson : maskSharedJson(props.shareModalJson);

  return (
    <ModalShell
      open={props.open}
      title={props.copy.shareTokenModalTitle}
      closeLabel={props.copy.closeModal}
      className="dashboard-modal-wide"
      onClose={props.onClose}
    >
      <div class="modal-stack">
        <div class="modal-toolbar">
          <button
            class={`modal-toolbar-btn ${props.sharePreviewExpanded ? "active" : ""}`}
            type="button"
            onClick={props.onTogglePreview}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              {props.sharePreviewExpanded ? <EyeOffIcon /> : <EyeIcon />}
            </span>
            {props.copy.jsonPreview}
          </button>
          <button
            class={`modal-toolbar-btn ${props.copyFeedbackKey === "share-json" ? "is-success" : ""}`}
            type="button"
            onClick={props.onCopyJson}
          >
            <span class="modal-btn-icon" aria-hidden="true">
              {props.copyFeedbackKey === "share-json" ? <SuccessIcon /> : <CopyIcon />}
            </span>
            {props.copyFeedbackKey === "share-json" ? props.copy.copySuccess : props.copy.copyJson}
          </button>
          <button
            class="modal-toolbar-btn"
            type="button"
            disabled={props.downloadSharePending}
            onClick={() =>
              props.onDownloadJson(props.shareModalFilename ?? createShareFileName(), props.shareModalJson)
            }
          >
            <span class="modal-btn-icon" aria-hidden="true">
              <DownloadIcon />
            </span>
            {props.copy.downloadJson}
          </button>
        </div>
        <div class="modal-note">
          {formatTemplate(props.copy.shareSelectedCount, {
            count: props.selectedCount
          })}
        </div>
        <div class="modal-note">{props.copy.shareTokenModeHint}</div>
        <textarea class="modal-textarea share-preview" readOnly value={previewValue} />
      </div>
    </ModalShell>
  );
}
