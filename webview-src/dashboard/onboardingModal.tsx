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
  onSubmitSetup: (values: { syncEnabled: boolean; password: string; confirmation: string }) => void;
  onImportCurrent: () => void;
  onContinueImport: () => void;
  onContinueCloudflare: (values: { cloudflaredDomain: string; dashboardEnabled: boolean }) => void;
  onFinish: () => void;
}) {
  const [syncEnabled, setSyncEnabled] = useState(props.settings.encryptedSyncEnabled);
  const [dashboardEnabled, setDashboardEnabled] = useState(props.settings.webDashboardEnabled);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [domain, setDomain] = useState(props.settings.cloudflaredDomain ?? "");

  useEffect(() => {
    if (props.step === "setup") {
      setSyncEnabled(props.settings.encryptedSyncEnabled);
      setDashboardEnabled(props.settings.webDashboardEnabled);
      setPassword("");
      setConfirmation("");
    }
    if (props.step === "cloudflare") setDomain(props.settings.cloudflaredDomain ?? "");
  }, [
    props.step,
    props.settings.encryptedSyncEnabled,
    props.settings.webDashboardEnabled,
    props.settings.cloudflaredDomain
  ]);

  if (!props.open) return null;
  const copy =
    props.lang === "zh"
      ? {
          welcome: "开始使用 Codex Manager",
          agreement: "保存账号前，请确认凭据默认只保存在本机；只有单独启用完整跨电脑账号同步后才会传输凭据。",
          termsTitle: "条款与责任",
          terms:
            "本项目按“现状”提供，不作任何形式的保证。作者和贡献者不对因使用、误用、依赖或无法使用本项目而造成的损失承担责任。",
          accept: "接受并继续",
          setup: "连接你的工作区",
          setupSub: "立即保存配置并继续。首次账号占用声明同步将在后台使用客户端加密运行。",
          sync: "启用跨电脑账号占用检查",
          syncHint: "在已登录 VS Code Settings Sync 的设备之间仅共享账号 ID 和电脑占用声明。",
          password: "密码",
          confirm: "确认密码",
          dashboard: "启用 Web Dashboard",
          continue: "保存并继续",
          skipPassword: "暂时跳过密码",
          importTitle: "检查当前账号",
          importSub: "首次同步在后台继续时，我们会避免重复添加已有账号。",
          import: "导入",
          skip: "继续",
          cloudflare: "最后一步：Cloudflare",
          cloudflareSub: "需要从其他电脑访问？输入你的 HTTPS 域名，并按下方指引创建 Cloudflare Tunnel。",
          domain: "Cloudflare HTTPS 域名",
          finish: "完成设置"
        }
      : props.lang === "zh-hant"
        ? {
            welcome: "開始使用 Codex Manager",
            agreement: "儲存帳號前，請確認憑證預設只保存在本機；只有另外啟用完整跨電腦帳號同步後才會傳輸憑證。",
            termsTitle: "條款與責任",
            terms:
              "本專案按「現狀」提供，不作任何形式的保證。作者與貢獻者不對因使用、誤用、依賴或無法使用本專案而造成的損失承擔責任。",
            accept: "接受並繼續",
            setup: "連接你的工作區",
            setupSub: "立即儲存設定並繼續。首次帳號占用聲明同步會在背景以用戶端加密執行。",
            sync: "啟用跨電腦帳號占用檢查",
            syncHint: "在已登入 VS Code Settings Sync 的裝置之間只共享帳號 ID 和電腦占用聲明。",
            password: "密碼",
            confirm: "確認密碼",
            dashboard: "啟用 Web Dashboard",
            continue: "儲存並繼續",
            skipPassword: "暫時略過密碼",
            importTitle: "檢查目前帳號",
            importSub: "首次同步在背景繼續時，我們會避免重複加入已有帳號。",
            import: "匯入",
            skip: "繼續",
            cloudflare: "最後一步：Cloudflare",
            cloudflareSub: "需要從其他電腦存取？輸入 HTTPS 網域，並依下方指引建立 Cloudflare Tunnel。",
            domain: "Cloudflare HTTPS 網域",
            finish: "完成設定"
          }
        : {
            welcome: "Welcome to Codex Manager",
            agreement:
              "Before saving accounts, confirm that credentials stay on this PC unless Full cross-PC account sync is separately enabled.",
            termsTitle: "Terms and responsibility",
            terms:
              "This project is provided as-is without warranties. The author and contributors are not liable for losses caused by use, misuse, reliance on, or inability to use this project.",
            accept: "Accept & continue",
            setup: "Connect your workspace",
            setupSub:
              "Save the configuration now and continue immediately. Initial claim sync runs in the background with client-side encryption.",
            sync: "Enable cross-PC claim checks",
            syncHint: "Share only account IDs and PC ownership claims through VS Code Settings Sync.",
            password: "Password",
            confirm: "Confirm password",
            dashboard: "Enable Web Dashboard",
            continue: "Save & continue",
            skipPassword: "Skip password for now",
            importTitle: "Check your current account",
            importSub:
              "We’ll avoid adding an account that is already saved while initial sync continues in the background.",
            import: "Import",
            skip: "Continue",
            cloudflare: "One last step: Cloudflare",
            cloudflareSub:
              "Need access from another PC? Add your Cloudflared hostname (no https:// required) and follow the quick tunnel setup below.",
            domain: "Cloudflared hostname",
            finish: "Finish setup"
          };
  const mismatch = syncEnabled && confirmation.length > 0 && password !== confirmation;
  const title =
    props.step === "agreement"
      ? copy.welcome
      : props.step === "setup"
        ? copy.setup
        : props.step === "import"
          ? copy.importTitle
          : props.step === "cloudflare"
            ? copy.cloudflare
            : "Welcome to Codex Manager";
  const progress = ["agreement", "setup", "import", "cloudflare", "donation"].indexOf(props.step) + 1;

  return (
    <ModalShell
      open
      title={title}
      closeLabel="Close"
      className="onboarding-modal"
      closeOnBackdrop={false}
      onClose={props.onClose}
    >
      <div class="onboarding-progress" aria-label={`Step ${progress} of 5`}>
        {[1, 2, 3, 4, 5].map((item) => (
          <span key={item} class={item <= progress ? "is-active" : ""} />
        ))}
        <span class="onboarding-progress-label">{progress} / 5</span>
      </div>
      {props.step === "agreement" ? (
        <div class="onboarding-content">
          <div class="onboarding-mark" aria-hidden="true">
            ✦
          </div>
          <p class="onboarding-lead">{copy.agreement}</p>
          <div class="onboarding-callout">
            <strong>Private by default</strong>
            <span>
              Accounts are stored in VS Code Secret Storage. Encrypted sync is opt-in and protected by your shared
              password.
            </span>
          </div>
          <div class="onboarding-terms" role="note">
            <strong>{copy.termsTitle}</strong>
            <span>{copy.terms}</span>
          </div>
          <div class="modal-actions">
            <button class="modal-primary-btn" type="button" onClick={props.onAccept}>
              {copy.accept} <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      ) : null}
      {props.step === "setup" ? (
        <form
          class="onboarding-content"
          onSubmit={(event) => {
            event.preventDefault();
            if (!mismatch && (!syncEnabled || password)) {
              props.onSubmitSetup({ syncEnabled, password, confirmation });
            }
          }}
        >
          <p class="onboarding-subtitle">{copy.setupSub}</p>
          <label class="onboarding-option">
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(event) => setSyncEnabled(event.currentTarget.checked)}
            />
            <span>
              <strong>{copy.sync}</strong>
              <small>{copy.syncHint}</small>
            </span>
          </label>
          {syncEnabled ? (
            <div class="onboarding-field-grid">
              <label>
                <span>{copy.password}</span>
                <input
                  class="modal-input"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onInput={(event) => setPassword(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>{copy.confirm}</span>
                <input
                  class="modal-input"
                  type="password"
                  value={confirmation}
                  autoComplete="new-password"
                  onInput={(event) => setConfirmation(event.currentTarget.value)}
                />
              </label>
            </div>
          ) : null}
          {mismatch ? <div class="modal-error">Passwords do not match.</div> : null}
          {props.error ? <div class="modal-error">{props.error}</div> : null}
          <div class="modal-actions">
            <button
              class="modal-secondary-btn"
              type="button"
              disabled={props.busy}
              onClick={() => {
                setSyncEnabled(false);
                setPassword("");
                setConfirmation("");
                props.onSubmitSetup({ syncEnabled: false, password: "", confirmation: "" });
              }}
            >
              {copy.skipPassword}
            </button>
            <button
              class="modal-primary-btn"
              type="submit"
              disabled={props.busy || (syncEnabled && (!password || mismatch))}
            >
              {props.busy ? "Working…" : copy.continue} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      ) : null}
      {props.step === "import" ? (
        <div class="onboarding-content">
          <p class="onboarding-subtitle">{copy.importSub}</p>
          {props.currentAuthAlreadyAdded ? (
            <div class="onboarding-callout is-success">
              <strong>Already added</strong>
              <span>{props.currentAuthEmail ?? "The current account is already saved."}</span>
            </div>
          ) : props.currentAuthEmail ? (
            <div class="onboarding-import-card">
              <span>{props.currentAuthEmail}</span>
              <button class="modal-primary-btn" type="button" disabled={props.busy} onClick={props.onImportCurrent}>
                {props.busy ? "Importing…" : `${copy.import} ${props.currentAuthEmail}`}
              </button>
            </div>
          ) : (
            <div class="onboarding-callout">
              <strong>No current account found</strong>
              <span>Sign in with Codex, then use Add Account from the dashboard whenever you are ready.</span>
            </div>
          )}
          {props.importCompleted ? (
            <div class="onboarding-callout is-success">
              <strong>Imported</strong>
              <span>The current account is now available in Codex Manager.</span>
            </div>
          ) : null}
          {props.error ? <div class="modal-error">{props.error}</div> : null}
          <div class="modal-actions">
            <button class="modal-primary-btn" type="button" disabled={props.busy} onClick={props.onContinueImport}>
              {copy.skip} <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      ) : null}
      {props.step === "cloudflare" ? (
        <form
          class="onboarding-content"
          onSubmit={(event) => {
            event.preventDefault();
            props.onContinueCloudflare({ cloudflaredDomain: domain.trim(), dashboardEnabled });
          }}
        >
          <p class="onboarding-subtitle">{copy.cloudflareSub}</p>
          <label class="onboarding-option">
            <input
              type="checkbox"
              checked={dashboardEnabled}
              onChange={(event) => setDashboardEnabled(event.currentTarget.checked)}
            />
            <span>
              <strong>{copy.dashboard}</strong>
              <small>Open the local browser dashboard on 127.0.0.1:39875.</small>
            </span>
          </label>
          {dashboardEnabled ? (
            <>
              <label>
                <span>{copy.domain}</span>
                <input
                  class="modal-input"
                  type="text"
                  value={domain}
                  placeholder="codex.example.com"
                  autoCapitalize="none"
                  spellcheck={false}
                  onInput={(event) => setDomain(event.currentTarget.value)}
                />
              </label>
              <div class="onboarding-instructions">
                <strong>Quick setup</strong>
                <code>cloudflared tunnel --url http://127.0.0.1:39875</code>
                <span>
                  Point the tunnel at your local dashboard. Set the shared Password under General settings before remote
                  login.
                </span>
              </div>
            </>
          ) : (
            <div class="onboarding-callout">
              <strong>Dashboard skipped</strong>
              <span>You can enable the Web Dashboard and add a Cloudflare domain later from Settings.</span>
            </div>
          )}
          {props.error ? <div class="modal-error">{props.error}</div> : null}
          <div class="modal-actions">
            <button class="modal-primary-btn" type="submit" disabled={props.busy}>
              {props.busy ? "Saving…" : copy.finish} <span aria-hidden="true">✓</span>
            </button>
          </div>
        </form>
      ) : null}
      {props.step === "donation" ? (
        <div class="onboarding-content onboarding-donation-content">
          <div class="onboarding-mark" aria-hidden="true">
            ♡
          </div>
          <p class="onboarding-lead">Thank you for using Codex Manager.</p>
          <p class="onboarding-subtitle">
            If this project helps your work, a donation is deeply appreciated and helps keep development and maintenance
            going.
          </p>
          <div class="onboarding-donation-card">
            <div>
              <span>PayPal or Wise</span>
              <strong class="is-mono">skriaz@live.com</strong>
            </div>
          </div>
          <div class="modal-actions">
            <button class="modal-primary-btn" type="button" disabled={props.busy} onClick={props.onFinish}>
              {props.busy ? "Saving…" : "Finish setup"} <span aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}
