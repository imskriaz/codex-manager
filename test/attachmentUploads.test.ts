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
      this.readAsText(file);
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
  await expect(readChatAttachmentFiles([textFile("unsafe.txt", "a\0b")])).rejects.toThrow("32 KB");
  await expect(readChatAttachmentFiles([textFile()], 8)).rejects.toThrow("8 files");
  await expect(
    readChatAttachmentFiles([{ name: "program.exe", type: "application/octet-stream", size: 10 } as File])
  ).rejects.toThrow("unsupported");
});
it("reports the real file-read timeout even when abort fires synchronously", async () => {
  vi.useFakeTimers();
  reader(true);
  const reading = readChatAttachmentFiles([textFile()]);
  const outcome = expect(reading).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10000);
  await outcome;
  expect(vi.getTimerCount()).toBe(0);
});
