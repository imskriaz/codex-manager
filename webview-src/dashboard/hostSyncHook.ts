import { useEffect, useRef } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import { postMessageToHost } from "./host";

export function useDashboardHostSync(params: {
  handleHostMessage: (message: DashboardHostMessage) => void;
  handleEscape: () => boolean;
}) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    // Embedded previews may run scripts, but cannot impersonate host events.
    const blockEmbeddedMessage = (event: MessageEvent) => {
      if (event.source && event.source !== window && event.source !== window.parent) event.stopImmediatePropagation();
    };
    const onMessage = (event: MessageEvent<DashboardHostMessage>) => {
      if (event.data) {
        paramsRef.current.handleHostMessage(event.data);
      }
    };

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        paramsRef.current.handleEscape();
      }
    };

    window.addEventListener("message", blockEmbeddedMessage, true);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeydown);
    postMessageToHost({ type: "dashboard:ready" });

    return () => {
      window.removeEventListener("message", blockEmbeddedMessage, true);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeydown);
    };
  }, []);
}
