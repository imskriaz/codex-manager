import { useRef, useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { createShareFileName } from "./helpers";

export function useShareModal(params: {
  sendAction: SendAction;
  showCopyFeedback: (key: string) => void;
}) {
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareModalJson, setShareModalJson] = useState("");
  const [shareModalFilename, setShareModalFilename] = useState("codex-manager-share.json");
  const [sharePreviewExpanded, setSharePreviewExpanded] = useState(false);

  const pendingCopy = useRef<string>();
  const handleCopyShareJson = (): void => {
    pendingCopy.current = params.sendAction("copyText", undefined, { text: shareModalJson }) || undefined;
  };

  const handleDownloadShareJson = (filename: string, text: string): void => {
    params.sendAction("downloadJsonFile", undefined, { filename, text });
  };

  const applyActionResult = (message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>): boolean => {
    if (pendingCopy.current && message.action === "copyText" && message.requestId === pendingCopy.current) {
      pendingCopy.current = undefined;
      if (message.status !== "completed") return false;
      params.showCopyFeedback("share-json");
      return true;
    }
    if (message.status !== "completed") {
      return false;
    }
    if ((message.action === "shareTokens" || message.action === "exportBackup") && message.payload?.sharedJson) {
      setShareModalJson(message.payload.sharedJson);
      const filename = createShareFileName();
      setShareModalFilename(message.action === "exportBackup" ? filename.replace("-share-", "-backup-") : filename);
      setSharePreviewExpanded(false);
      setShareModalOpen(true);
      return true;
    }
    if (message.action === "exportAuthFile" && message.payload?.authJson) {
      setShareModalJson(message.payload.authJson);
      setShareModalFilename("auth.json");
      setSharePreviewExpanded(false);
      setShareModalOpen(true);
      return true;
    }
    return false;
  };

  const handleEscape = (): boolean => {
    if (!shareModalOpen) {
      return false;
    }
    setShareModalOpen(false);
    return true;
  };

  return {
    shareModalOpen,
    shareModalJson,
    shareModalFilename,
    sharePreviewExpanded,
    handleCopyShareJson,
    handleDownloadShareJson,
    applyActionResult,
    handleEscape,
    closeShareModal: () => setShareModalOpen(false),
    toggleSharePreview: () => setSharePreviewExpanded((current) => !current)
  };
}
