import { useEffect, useRef, useState } from "preact/hooks";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type InstallWindow = Window & { codexInstallPrompt?: InstallPrompt };

export async function browserPushRequest(path: string, body?: unknown): Promise<{ publicKey?: string; subscribed?: boolean }> {
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
    const result = (await response.json()) as { error?: string; publicKey?: string; subscribed?: boolean };
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Dashboard login expired. Sign in again before enabling notifications."
          : (result.error ?? "Notification request failed. Retry when connected.")
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
                "Notification setup was not confirmed in time. Check browser permissions and reconnect before retrying."
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
          () => reject(new Error("The installed app is not ready. Reload while connected, then retry.")),
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
            ? "Notifications are blocked. Allow them in browser settings, then retry."
            : "Notification permission was cancelled. You can enable it later."
        );
      const worker = await workerReady();
      let subscription = await notificationDeadline(worker.pushManager.getSubscription());
      if (enabled && subscription) {
        await browserPushRequest("unsubscribe", { endpoint: subscription.endpoint });
        if (!(await notificationDeadline(subscription.unsubscribe())))
          throw new Error(
            "The server stopped notifications, but the browser subscription could not be removed. Retry disabling it."
          );
        setEnabled(false);
        document.documentElement.dataset["pushSubscribed"] = "false";
        window.dispatchEvent(new Event("codex:push-subscription-changed"));
        setFeedback("Notifications disabled on this device.");
      } else {
        const { publicKey } = await browserPushRequest("key");
        if (!publicKey) throw new Error("The dashboard returned no notification key. Retry when connected.");
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
          "Subscribed on this device. Major changes and available actions will notify you even when the app is closed."
        );
      }
    } catch (error) {
      setFailed(true);
      setFeedback(error instanceof Error ? error.message : "Notification setup failed. Retry when connected.");
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
          ? "App installation accepted. Open Codex Manager from your apps."
          : "App installation cancelled. You can install it later from your browser menu."
      );
      (window as InstallWindow).codexInstallPrompt = undefined;
      setInstall(undefined);
    } catch {
      setFailed(true);
      setFeedback("App installation failed. Try Add to Home Screen from the browser menu.");
    } finally {
      setBusy(false);
    }
  };

  if (props.offerOnLoad && (!initialized || dismissed || (enabled && !feedback))) return null;
  const content = (
    <div class="settings-block settings-block-wide">
      <div class="settings-block-title">{props.offerOnLoad ? "Get notifications on this device" : "Browser notifications & installed app"}</div>
      <p class="settings-note">
        Receive account switches, warnings, failures, and actions on this device. On iPhone or iPad, use Share → Add to
        Home Screen and open the installed app first. The app opens a recovery screen offline and reconnects when the
        host returns.
      </p>
      {!supported && (
        <p class="settings-note">
          Push is unavailable here. Use an HTTPS dashboard in a supported browser or installed app.
        </p>
      )}
      <button type="button" class="settings-btn" aria-label={props.offerOnLoad ? "Subscribe to browser notifications" : undefined} disabled={busy || !supported} onClick={() => void toggle()}>
        {busy ? "Please wait…" : enabled ? "Disable notifications" : "Enable notifications"}
      </button>
      {install && (
        <button type="button" class="settings-btn" disabled={busy} onClick={() => void installApp()}>
          Install app
        </button>
      )}
      {feedback && (
        <p class="settings-note" role={failed ? "alert" : "status"}>
          {feedback}
        </p>
      )}
    </div>
  );
  return props.offerOnLoad ? <aside class="browser-notification-offer" aria-label="Notification subscription" role="region">
    {content}<button type="button" class="settings-btn" disabled={busy} onClick={() => setDismissed(true)}>{enabled ? "Done" : "Later"}</button>
  </aside> : content;
}
