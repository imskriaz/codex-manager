import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { recordPersistentEvent } from "../utils/persistentLog";
import { needsChatAttachmentFiles, type ChatAttachment } from "../domain/chatAttachments";
import { saveCodexAttachmentFiles } from "./projectTaskAttachments";

/** Images are argv file paths for CLI; app-server uses inline data URLs. */
export async function withCliImageAttachments<T>(files: ChatAttachment[] | undefined, run: (paths: string[]) => Promise<T>): Promise<T> {
  const images = files?.filter((file) => file.kind === "image") ?? [];
  if (!images.length) return run([]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-manager-attachments-"));
  try {
    const paths: string[] = [];
    for (const [index, image] of images.entries()) {
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png";
      const file = path.join(directory, `${index}.${extension}`);
      await fs.writeFile(file, Buffer.from(image.data.slice(image.data.indexOf(",") + 1), "base64"), { mode: 0o600 });
      paths.push(file);
    }
    return await run(paths);
  } finally {
    // This directory was created by mkdtemp and every filename is generated.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error: unknown) => {
      // Cleanup must not turn an already completed Codex turn into a retryable failure.
      recordPersistentEvent("warning", "chat-attachments", "Temporary attachment cleanup failed", { reason: error instanceof Error ? error.message : String(error) });
    });
  }
}

export function appServerChatInput(text: string, attachments?: ChatAttachment[]) {
  return [{ type: "text", text, text_elements: [] }, ...(attachments ?? []).filter((file) => file.kind === "image").map((file) => ({ type: "image", url: file.data }))];
}

export async function materializeChatAttachments(text: string, files: ChatAttachment[] | undefined, projectPath: string, signal?: AbortSignal): Promise<string> {
  if (!files || !needsChatAttachmentFiles(files)) return text;
  const stored = await saveCodexAttachmentFiles(projectPath, files.filter(file => file.kind !== 'image'), signal);
  return text + '\n\n<attachment_paths>\nRead complete uploaded files from these paths:\n' + stored.map(file => `${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n') + '\n</attachment_paths>';
}
