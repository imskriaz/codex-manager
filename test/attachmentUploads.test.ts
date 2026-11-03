import { afterEach, expect, it, vi } from "vitest";
import { readChatAttachmentFiles } from "../webview-src/dashboard/attachmentUploads";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const textFile = (name = "brief.txt", content = "Requirements") =>
  ({ name, type: "text/plain", size: new TextEncoder().encode(content).length, content }) as unknown as File;
function reader(stall = false) {
  class Reader {
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    readAsText(file: File) {
      if (!stall)
        queueMicrotask(() => {
          this.result = (file as unknown as { content: string }).content;
          this.onload?.();
        });
    }
    readAsDataURL(file: File) {
      this.result = "data:application/octet-stream;base64,UEsDBA=="; queueMicrotask(() => this.onload?.());
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("FileReader", Reader);
  vi.stubGlobal("window", { setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay) });
}
it("uses bounded shared upload validation for task, comment and session readers", async () => {
  reader();
  expect(await readChatAttachmentFiles([textFile()])).toMatchObject([
    { name: "brief.txt", kind: "text", data: "Requirements", size: 12 }
  ]);
  await expect(readChatAttachmentFiles([textFile("unsafe.txt", "a\0b")])).rejects.toThrow("binary data");
  await expect(readChatAttachmentFiles([textFile()], 32)).rejects.toThrow("32 files");
  expect(await readChatAttachmentFiles([{ name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4 } as File])).toMatchObject([{ name: "report.docx", kind: "file", size: 4 }]);
});
it("reports the real file-read timeout even when abort fires synchronously", async () => {
  vi.useFakeTimers();
  reader(true);
  const reading = readChatAttachmentFiles([textFile()]);
  const outcome = expect(reading).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(60000);
  await outcome;
  expect(vi.getTimerCount()).toBe(0);
});
