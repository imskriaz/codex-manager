import { useEffect, useRef, useState } from "preact/hooks";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type InstallWindow = Window & { codexInstallPrompt?: InstallPrompt };

export async function browserPushRequest(path: string, body?: unknown): Promise<{ publicKey?: string; subscribed?: boolean; subscriptions?: number; accepted?: number; failed?: number }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/push/${path}`, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
      ...(body
        ? { headers: { "Content-Type": "application/json", "X-Codex-Dashboard": "1" }, body: JSON.stringify(body) }
        : {})
    });
    const result = (await response.json()) as { error?: string; publicKey?: string; subscribed?: boolean; subscriptions?: number; accepted?: number; failed?: number };
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Your session expired. Sign in again."
          : (result.error ?? "Could not update notifications. Try again.")
      );
    return result;
  } finally {
    window.clearTimeout(timer);
  }
}

async function notificationDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () =>
            reject(
              new Error(
                "Notifications took too long. Check your connection and try again."
              )
            ),
          15_000
        );
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function workerReady(): Promise<ServiceWorkerRegistration> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("The app is not ready. Reload and try again.")),
          15_000
        );
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export function BrowserNotifications(props: { offerOnLoad?: boolean } = {}) {
  const supported =
    window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  const [install, setInstall] = useState((window as InstallWindow).codexInstallPrompt);
  const [initialized, setInitialized] = useState(!props.offerOnLoad);
  const [dismissed, setDismissed] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let disposed = false;
    const initialRevision = revision.current;
    if (supported)
      void workerReady()
        .then(async (worker) => {
          const subscription = await notificationDeadline(worker.pushManager.getSubscription());
          const subscribed = subscription ? (await browserPushRequest("status", { endpoint: subscription.endpoint })).subscribed === true : false;
          if (!disposed && revision.current === initialRevision) {
            setEnabled(subscribed);
            setInitialized(true);
            if (props.offerOnLoad && subscribed) setDismissed(true);
          }
        })
        .catch(() => undefined);
    const prompt = (event: Event) => setInstall(event as InstallPrompt);
    const changed = () => {
      revision.current++;
      setEnabled(document.documentElement.dataset["pushSubscribed"] === "true");
      if (props.offerOnLoad && document.documentElement.dataset["pushSubscribed"] !== "true") setDismissed(true);
    };
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("codex:push-subscription-changed", changed);
    return () => {
      disposed = true;
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("codex:push-subscription-changed", changed);
    };
  }, [supported]);

  const toggle = async () => {
    if (busy) return;
    revision.current++;
    setBusy(true);
    setFeedback("");
    setFailed(false);
    try {
      // Permission must be requested directly in the click, before awaiting worker startup.
      const permission = enabled ? "granted" : await notificationDeadline(Notification.requestPermission());
      if (permission !== "granted")
        throw new Error(
          permission === "denied"
            ? "Notifications are blocked. Allow them in browser settings."
            : "Notification permission cancelled."
        );
      const worker = await workerReady();
      let subscription = await notificationDeadline(worker.pushManager.getSubscription());
      if (enabled && subscription) {
        await browserPushRequest("unsubscribe", { endpoint: subscription.endpoint });
        if (!(await notificationDeadline(subscription.unsubscribe())))
          throw new Error(
            "Notifications stopped, but this device could not be cleared. Try again."
          );
        setEnabled(false);
        document.documentElement.dataset["pushSubscribed"] = "false";
        window.dispatchEvent(new Event("codex:push-subscription-changed"));
        setFeedback("Notifications are off.");
      } else {
        const { publicKey } = await browserPushRequest("key");
        if (!publicKey) throw new Error("Notification setup is unavailable. Try again.");
        const encoded = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
        const applicationServerKey = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
        let created = false;
        if (!subscription) {
          subscription = await notificationDeadline(
            worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
          );
          created = true;
        }
        try {
          await browserPushRequest("subscribe", { subscription: subscription.toJSON() });
        } catch (error) {
          if (created) await notificationDeadline(subscription.unsubscribe()).catch(() => false);
          throw error;
        }
        setEnabled(true);
        document.documentElement.dataset["pushSubscribed"] = "true";
        window.dispatchEvent(new Event("codex:push-subscription-changed"));
        setFeedback(
          "Notifications are on for this device."
        );
      }
    } catch (error) {
      setFailed(true);
      setFeedback(error instanceof Error ? error.message : "Could not update notifications. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const installApp = async () => {
    if (!install || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await notificationDeadline(install.prompt());
      const result = await notificationDeadline(install.userChoice);
      setFeedback(
        result.outcome === "accepted"
          ? "App installed."
          : "Installation cancelled."
      );
      (window as InstallWindow).codexInstallPrompt = undefined;
      setInstall(undefined);
    } catch {
      setFailed(true);
      setFeedback("Installation failed. Try your browser menu.");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (busy) return;
    setBusy(true); setFailed(false); setFeedback("");
    try {
      const result = await browserPushRequest("test", {});
      if (![result.subscriptions, result.accepted, result.failed].every(value => Number.isSafeInteger(value) && value! >= 0 && value! <= 64) || result.accepted! + result.failed! !== result.subscriptions)
        throw new Error("Delivery was not confirmed. Try again.");
      const accepted = result.accepted!;
      const failures = result.failed!;
      setFailed(!accepted || failures > 0);
      setFeedback(!result.subscriptions ? "No devices are connected." :
        `${accepted} device${accepted === 1 ? " is" : "s are"} connected.${failures ? ` ${failures} failed.` : ""}`);
    } catch (error) {
      setFailed(true);
      setFeedback(error instanceof Error && error.name !== "AbortError" ? error.message : "Test timed out. Check your phone.");
    } finally { setBusy(false); }
  };

  if (props.offerOnLoad && (!initialized || dismissed || (enabled && !feedback))) return null;
  const bell = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>;
  const feedbackView = feedback ? <p class={`browser-notification-feedback ${failed ? "is-failed" : ""}`} role={failed ? "alert" : "status"}>{feedback}</p> : null;
  if (props.offerOnLoad) return <aside class={`browser-notification-offer ${enabled ? "is-enabled" : ""}`} aria-label="Notification subscription" role="region">
    <div class="browser-notification-heading"><span class="browser-notification-mark">{bell}</span><div><strong>{enabled ? "Notifications enabled" : "Get notifications on this device"}</strong><p>{enabled ? "You're ready for important updates." : "Account switches, important alerts, and actions while this tab is closed."}</p></div><button type="button" class="browser-notification-dismiss" aria-label="Dismiss notification offer" title="Dismiss" disabled={busy} onClick={() => setDismissed(true)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
    {feedbackView}
    <div class="browser-notification-actions">{enabled ? <button type="button" class="browser-notification-button is-primary" onClick={() => setDismissed(true)}>Done</button> : <><button type="button" class="browser-notification-button is-primary" aria-label="Subscribe to browser notifications" aria-busy={busy} disabled={busy || !supported} onClick={() => void toggle()}>{busy ? <><span class="browser-notification-spinner" aria-hidden="true"/> Please wait…</> : "Enable notifications"}</button><button type="button" class="browser-notification-button is-quiet" disabled={busy} onClick={() => setDismissed(true)}>Not now</button></>}</div>
  </aside>;
  return <div class="settings-block settings-block-wide browser-notification-settings">
    <div class="browser-notification-heading"><span class="browser-notification-mark">{bell}</span><div><div class="settings-block-title">Browser notifications</div><p class="settings-block-sub" title="Get account switches and alerts on this device.">{enabled ? "Notifications are on for this device." : "Get account switches and alerts on this device."}</p></div><span class={`browser-notification-badge ${enabled ? "is-enabled" : ""}`}>{enabled ? "On" : "Off"}</span></div>
    {!supported ? <p class="settings-note">Notifications are unavailable in this browser.</p> : null}
    <div class="browser-notification-actions"><button type="button" class={`browser-notification-button ${enabled ? "" : "is-primary"}`} aria-busy={busy} disabled={busy || !supported} onClick={() => void toggle()}>{busy ? "Please wait…" : enabled ? "Disable notifications" : "Enable notifications"}</button><button type="button" class="browser-notification-button" disabled={busy || !supported} onClick={() => void sendTest()}>Send test notification</button>{install ? <button type="button" class="browser-notification-button" disabled={busy} onClick={() => void installApp()}>Install app</button> : null}</div>
    {feedbackView}
    <details class="browser-notification-help"><summary>Install & offline help</summary><p class="settings-note">On iPhone or iPad, use Share → Add to Home Screen. Drafts stay saved while offline.</p></details>
  </div>;
}
