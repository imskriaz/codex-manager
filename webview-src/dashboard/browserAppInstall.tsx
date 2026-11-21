import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { DashboardNotice } from '../../src/domain/dashboard/types';
import { dismissBrowserOffer } from './browserOfferDismissal';

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type InstallWindow = Window & { codexInstallPrompt?: InstallPrompt; codexInstallPending?: boolean };

export function useBrowserAppInstall() {
  const host = window as InstallWindow;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const [installed, setInstalled] = useState(standalone);
  const [available, setAvailable] = useState(Boolean(host.codexInstallPrompt));
  const [busy, setBusy] = useState(Boolean(host.codexInstallPending));
  const [notice, setNotice] = useState<DashboardNotice>();
  const revision = useRef(0);
  useEffect(() => {
    const refresh = () => { setAvailable(Boolean(host.codexInstallPrompt)); setBusy(Boolean(host.codexInstallPending)); };
    const prompt = (event: Event) => { event.preventDefault(); host.codexInstallPrompt = event as InstallPrompt; refresh(); };
    const installed = () => { revision.current++; host.codexInstallPrompt = undefined; setInstalled(true); refresh(); setNotice({ level: 'info', message: 'App installed. Open Codex Manager from your apps or taskbar, then choose Keep on top in the conversation header to keep the workspace above other windows.' }); };
    const mode = window.matchMedia('(display-mode: standalone)');
    const changed = () => setInstalled(standalone());
    window.addEventListener('beforeinstallprompt', prompt);
    window.addEventListener('appinstalled', installed);
    window.addEventListener('codex:app-install-changed', refresh);
    mode.addEventListener('change', changed);
    return () => {
      revision.current++;
      window.removeEventListener('beforeinstallprompt', prompt);
      window.removeEventListener('appinstalled', installed);
      window.removeEventListener('codex:app-install-changed', refresh);
      mode.removeEventListener('change', changed);
    };
  }, []);
  const installApp = async () => {
    if (host.codexInstallPending) return;
    const prompt = host.codexInstallPrompt;
    if (!prompt) {
      setNotice({ level: 'warning', message: window.isSecureContext
        ? 'To install, use Chrome or Edge menu > Install Codex Manager (or Apps > Install this site as an app). On iPhone or iPad, use Safari Share > Add to Home Screen. If already installed, open Codex Manager from your apps. The host must stay running for live work.'
        : 'App installation requires HTTPS or localhost. Open the dashboard securely, then use your browser menu to install Codex Manager.' });
      return;
    }
    // The browser prompt is single-use and must start inside the click gesture.
    host.codexInstallPrompt = undefined;
    host.codexInstallPending = true;
    window.dispatchEvent(new Event('codex:app-install-changed'));
    setNotice(undefined);
    const current = ++revision.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = prompt.prompt().then(() => prompt.userChoice);
      const result = await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Installation was not confirmed in time. Check your browser before trying again.')), 15_000);
      })]);
      if (result.outcome !== 'accepted') dismissBrowserOffer();
      if (revision.current === current) setNotice({ level: 'info', message: result.outcome === 'accepted' ? 'Installation requested. Finish in your browser, then open Codex Manager from your apps or taskbar.' : 'Installation cancelled.' });
    } catch (error) {
      if (revision.current === current) setNotice({ level: 'warning', message: `Installation failed. ${error instanceof Error ? error.message : 'Use your browser menu to install Codex Manager.'}` });
    } finally {
      clearTimeout(timer);
      host.codexInstallPending = false;
      window.dispatchEvent(new Event('codex:app-install-changed'));
    }
  };
  return { installed, available: available && !installed, busy, notice, installApp, dismissNotice: () => setNotice(undefined) };
}

export function BrowserAppInstall() {
  const app = useBrowserAppInstall();
  return <>
    {!app.installed && (app.available || app.busy) ? <button type="button" class="cli-icon-button" aria-label="Install app" title="Install app · use Codex Manager with browser windows closed" aria-busy={app.busy} disabled={app.busy} onClick={() => void app.installApp()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></svg></button> : null}
    {app.notice ? createPortal(<p class={`browser-notification-feedback browser-app-install-feedback ${app.notice.level === 'warning' ? 'is-failed' : ''}`} role={app.notice.level === 'warning' ? 'alert' : 'status'}><span>{app.notice.message}</span><button type="button" aria-label="Dismiss install message" onClick={app.dismissNotice}>×</button></p>, document.body) : null}
  </>;
}
