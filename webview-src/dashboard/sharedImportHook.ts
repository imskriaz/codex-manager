import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { reduceSharedImportActionResult, type SharedImportState } from "./sessionModalState";

export function useSharedImportModal(params: { sendAction: SendAction; importJsonFileReadError: string }) {
  const [importJsonText, setImportJsonText] = useState("");
  const [importState, setImportState] = useState<SharedImportState>({});

  const pendingRead = useRef<{ reader: FileReader; timer: ReturnType<typeof setTimeout> }>();
  const invalidateRead = (): void => {
    const pending = pendingRead.current;
    pendingRead.current = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reader.onload = pending.reader.onerror = pending.reader.onabort = null;
    if (pending.reader.readyState === 1) pending.reader.abort();
  };
  useEffect(() => () => invalidateRead(), []);

  const clearImportFeedback = (): void => {
    invalidateRead();
    setImportState({});
  };

  const handleImportFileSelected = (file: File): void => {
    clearImportFeedback();
    const reader = new FileReader();
    const fail = (): void => {
      if (pendingRead.current?.reader !== reader) return;
      invalidateRead();
      setImportState((current) => ({
        ...current,
        importJsonError: params.importJsonFileReadError
      }));
    };
    pendingRead.current = { reader, timer: setTimeout(fail, 15000) };
    reader.onload = () => {
      if (pendingRead.current?.reader !== reader) return;
      const text = typeof reader.result === "string" ? reader.result : "";
      invalidateRead();
      setImportState({});
      setImportJsonText(text);
    };
    reader.onerror = reader.onabort = fail;
    try {
      reader.readAsText(file);
    } catch {
      fail();
    }
  };

  const handleImportTextChange = (value: string): void => {
    setImportJsonText(value);
    clearImportFeedback();
  };

  const handleSubmitImport = (recoveryMode: boolean): void => {
    setImportState((current) => ({ ...current, importJsonError: undefined }));
    params.sendAction("importSharedJson", undefined, {
      jsonText: importJsonText,
      recoveryMode
    });
  };

  const applyActionResult = (message: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>): boolean => {
    const reduced = reduceSharedImportActionResult(importState, message);
    if (!reduced.handled) {
      return false;
    }
    setImportState(reduced.next);
    return true;
  };

  return {
    importJsonText,
    importJsonError: importState.importJsonError,
    importResult: importState.importResult,
    clearImportFeedback,
    handleImportFileSelected,
    handleImportTextChange,
    handleSubmitImport,
    applyActionResult
  };
}
