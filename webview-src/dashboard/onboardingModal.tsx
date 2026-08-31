import { useEffect, useState } from "preact/hooks";
import type { DashboardSettings, DashboardState } from "../../src/domain/dashboard/types";
import { ModalShell } from "./components";

export type OnboardingStep = "agreement" | "setup" | "import" | "cloudflare" | "donation";

export function OnboardingModal(props: {
  open: boolean;
  step: OnboardingStep;
  settings: DashboardSettings;
  lang: DashboardState["lang"];
  currentAuthEmail?: string;
  currentAuthAlreadyAdded?: boolean;
  busy: boolean;
  error?: string;
  importCompleted: boolean;
  onClose: () => void;
  onAccept: () => void;
  onSubmitSetup: (values: { syncEnabled: boolean; passphrase: string; confirmation: string }) => void;
  onImportCurrent: () => void;
  onContinueImport: () => void;
  onContinueCloudflare: (values: { cloudflaredDomain: string; dashboardEnabled: boolean; dashboardPassword: string }) => void;
  onFinish: () => void;
}) {
  const [syncEnabled, setSyncEnabled] = useState(props.settings.encryptedSyncEnabled);
  const [dashboardEnabled, setDashboardEnabled] = useState(props.settings.webDashboardEnabled);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [dashboardPassword, setDashboardPassword] = useState("");
  const [domain, setDomain] = useState(props.settings.cloudflaredDomain ?? "");

  useEffect(() => {
    if (props.step === "setup") {
      setSyncEnabled(props.settings.encryptedSyncEnabled);
      setDashboardEnabled(props.settings.webDashboardEnabled);
      setPassphrase("");
      setConfirmation("");
      setDashboardPassword("");
    }
    if (props.step === "cloudflare") setDomain(props.settings.cloudflaredDomain ?? "");
  }, [props.step, props.settings.encryptedSyncEnabled, props.settings.webDashboardEnabled, props.settings.cloudflaredDomain]);

  if (!props.open) return null;
  const copy = props.lang === "zh"
    ? { welcome: "开始使用 Codex Manager", agreement: "在保存账号之前，请确认你了解这些凭据会保存在本机并可选择加密同步。", accept: "接受并继续", setup: "连接你的工作区", setupSub: "立即保存配置并继续。首次同步将在后台使用客户端加密运行。", sync: "启用加密同步", syncHint: "在已登录 VS Code Settings Sync 的设备之间共享账号会话。", pass: "同步密码短语", confirm: "确认密码短语", dashboard: "启用 Web Dashboard", dashboardPass: "Dashboard 密码", continue: "保存并继续", importTitle: "检查当前账号", importSub: "首次同步在后台继续时，我们会避免重复添加已有账号。", import: "导入", skip: "继续", cloudflare: "最后一步：Cloudflare", cloudflareSub: "需要从其他电脑访问？输入你的 HTTPS 域名，并按下方指引创建 Cloudflare Tunnel。", domain: "Cloudflare HTTPS 域名", finish: "完成设置" }
    : props.lang === "zh-hant"
      ? { welcome: "開始使用 Codex Manager", agreement: "儲存帳號前，請確認你了解憑證會保存在本機，並可選擇加密同步。", accept: "接受並繼續", setup: "連接你的工作區", setupSub: "立即儲存設定並繼續。首次同步會在背景以用戶端加密執行。", sync: "啟用加密同步", syncHint: "在已登入 VS Code Settings Sync 的裝置之間共享帳號工作階段。", pass: "同步密碼", confirm: "確認密碼", dashboard: "啟用 Web Dashboard", dashboardPass: "Dashboard 密碼", continue: "儲存並繼續", importTitle: "檢查目前帳號", importSub: "首次同步在背景繼續時，我們會避免重複加入已有帳號。", import: "匯入", skip: "繼續", cloudflare: "最後一步：Cloudflare", cloudflareSub: "需要從其他電腦存取？輸入 HTTPS 網域，並依下方指引建立 Cloudflare Tunnel。", domain: "Cloudflare HTTPS 網域", finish: "完成設定" }
      : { welcome: "Welcome to Codex Manager", agreement: "Before saving accounts, confirm that you understand credentials stay on this PC and can be shared only through encrypted sync.", accept: "Accept & continue", setup: "Connect your workspace", setupSub: "Save the configuration now and continue immediately. Initial sync runs in the background with client-side encryption.", sync: "Enable encrypted sync", syncHint: "Share account sessions across devices signed in to VS Code Settings Sync.", pass: "Sync passphrase", confirm: "Confirm passphrase", dashboard: "Enable Web Dashboard", dashboardPass: "Dashboard password", continue: "Save & continue", importTitle: "Check your current account", importSub: "We’ll avoid adding an account that is already saved while initial sync continues in the background.", import: "Import", skip: "Continue", cloudflare: "One last step: Cloudflare", cloudflareSub: "Need access from another PC? Add your Cloudflared hostname (no https:// required) and follow the quick tunnel setup below.", domain: "Cloudflared hostname", finish: "Finish setup" };
  const mismatch = syncEnabled && confirmation.length > 0 && passphrase !== confirmation;
  const title = props.step === "agreement" ? copy.welcome : props.step === "setup" ? copy.setup : props.step === "import" ? copy.importTitle : props.step === "cloudflare" ? copy.cloudflare : "Welcome to Codex Manager";
  const progress = ["agreement", "setup", "import", "cloudflare", "donation"].indexOf(props.step) + 1;

  return (
    <ModalShell open title={title} closeLabel="Close" className="onboarding-modal" closeOnBackdrop={false} onClose={props.onClose}>
      <div class="onboarding-progress" aria-label={`Step ${progress} of 5`}>
        {[1, 2, 3, 4, 5].map((item) => <span key={item} class={item <= progress ? "is-active" : ""} />)}
        <span class="onboarding-progress-label">{progress} / 5</span>
      </div>
      {props.step === "agreement" ? (
        <div class="onboarding-content">
          <div class="onboarding-mark" aria-hidden="true">✦</div>
          <p class="onboarding-lead">{copy.agreement}</p>
          <div class="onboarding-callout"><strong>Private by default</strong><span>Accounts are stored in VS Code Secret Storage. Encrypted sync is opt-in and protected by your passphrase.</span></div>
          <div class="modal-actions"><button class="modal-primary-btn" type="button" onClick={props.onAccept}>{copy.accept} <span aria-hidden="true">→</span></button></div>
        </div>
      ) : null}
      {props.step === "setup" ? (
        <form class="onboarding-content" onSubmit={(event) => { event.preventDefault(); if (!mismatch && (!syncEnabled || passphrase)) props.onSubmitSetup({ syncEnabled, passphrase, confirmation }); }}>
          <p class="onboarding-subtitle">{copy.setupSub}</p>
          <label class="onboarding-option"><input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.currentTarget.checked)} /><span><strong>{copy.sync}</strong><small>{copy.syncHint}</small></span></label>
          {syncEnabled ? <div class="onboarding-field-grid"><label><span>{copy.pass}</span><input class="modal-input" type="password" value={passphrase} autoComplete="new-password" onInput={(event) => setPassphrase(event.currentTarget.value)} /></label><label><span>{copy.confirm}</span><input class="modal-input" type="password" value={confirmation} autoComplete="new-password" onInput={(event) => setConfirmation(event.currentTarget.value)} /></label></div> : null}
          {mismatch ? <div class="modal-error">Passphrases do not match.</div> : null}
          {props.error ? <div class="modal-error">{props.error}</div> : null}
          <div class="modal-actions"><button class="modal-primary-btn" type="submit" disabled={props.busy || (syncEnabled && (!passphrase || mismatch))}>{props.busy ? "Working…" : copy.continue} <span aria-hidden="true">→</span></button></div>
        </form>
      ) : null}
      {props.step === "import" ? (
        <div class="onboarding-content">
          <p class="onboarding-subtitle">{copy.importSub}</p>
          {props.currentAuthAlreadyAdded ? <div class="onboarding-callout is-success"><strong>Already added</strong><span>{props.currentAuthEmail ?? "The current account is already saved."}</span></div> : props.currentAuthEmail ? <div class="onboarding-import-card"><span>{props.currentAuthEmail}</span><button class="modal-primary-btn" type="button" disabled={props.busy} onClick={props.onImportCurrent}>{props.busy ? "Importing…" : `${copy.import} ${props.currentAuthEmail}`}</button></div> : <div class="onboarding-callout"><strong>No current account found</strong><span>Sign in with Codex, then use Add Account from the dashboard whenever you are ready.</span></div>}
          {props.importCompleted ? <div class="onboarding-callout is-success"><strong>Imported</strong><span>The current account is now available in Codex Manager.</span></div> : null}
          {props.error ? <div class="modal-error">{props.error}</div> : null}
          <div class="modal-actions"><button class="modal-primary-btn" type="button" disabled={props.busy} onClick={props.onContinueImport}>{copy.skip} <span aria-hidden="true">→</span></button></div>
        </div>
      ) : null}
      {props.step === "cloudflare" ? (
        <form class="onboarding-content" onSubmit={(event) => { event.preventDefault(); props.onContinueCloudflare({ cloudflaredDomain: domain.trim(), dashboardEnabled, dashboardPassword }); }}>
          <p class="onboarding-subtitle">{copy.cloudflareSub}</p>
          <label class="onboarding-option"><input type="checkbox" checked={dashboardEnabled} onChange={(event) => setDashboardEnabled(event.currentTarget.checked)} /><span><strong>{copy.dashboard}</strong><small>Open the local browser dashboard on 127.0.0.1:39875.</small></span></label>
          {dashboardEnabled ? <label><span>{copy.dashboardPass}</span><input class="modal-input" type="password" minLength={8} value={dashboardPassword} autoComplete="new-password" placeholder="8+ characters" onInput={(event) => setDashboardPassword(event.currentTarget.value)} /></label> : null}
          {dashboardEnabled ? <>
            <label><span>{copy.domain}</span><input class="modal-input" type="text" value={domain} placeholder="codex.example.com" autoCapitalize="none" spellcheck={false} onInput={(event) => setDomain(event.currentTarget.value)} /></label>
            <div class="onboarding-instructions"><strong>Quick setup</strong><code>cloudflared tunnel --url http://127.0.0.1:39875</code><span>Point the tunnel at your local dashboard, then use the domain above when sharing access. Keep your dashboard password enabled.</span></div>
          </> : <div class="onboarding-callout"><strong>Dashboard skipped</strong><span>You can enable the Web Dashboard and add a Cloudflare domain later from Settings.</span></div>}
          {props.error ? <div class="modal-error">{props.error}</div> : null}
          <div class="modal-actions"><button class="modal-primary-btn" type="submit" disabled={props.busy || (dashboardEnabled && dashboardPassword.length > 0 && dashboardPassword.length < 8) || (dashboardEnabled && !props.settings.webDashboardEnabled && !dashboardPassword)}>{props.busy ? "Saving…" : copy.finish} <span aria-hidden="true">✓</span></button></div>
        </form>
      ) : null}
      {props.step === "donation" ? (
        <div class="onboarding-content onboarding-donation-content">
          <div class="onboarding-mark" aria-hidden="true">♡</div>
          <p class="onboarding-lead">Thank you for using Codex Manager.</p>
          <p class="onboarding-subtitle">If this project helps your work, a donation is deeply appreciated and helps keep development and maintenance going.</p>
          <div class="onboarding-donation-card">
            <div><span>PayPal or Wise</span><strong class="is-mono">skriaz@live.com</strong></div>
          </div>
          <div class="modal-actions"><button class="modal-primary-btn" type="button" disabled={props.busy} onClick={props.onFinish}>{props.busy ? "Saving…" : "Finish setup"} <span aria-hidden="true">✓</span></button></div>
        </div>
      ) : null}
    </ModalShell>
  );
}
