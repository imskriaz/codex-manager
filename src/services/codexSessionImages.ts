import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNativePath } from "../utils/nativePaths";
import { coalesceSessionQuestionMessages } from "../domain/sessionQuestions";
import type { DashboardCliSessionMessage } from "../domain/dashboard/types";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../domain/chatAttachments";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
const MAX_SESSION_IMAGE_BYTES = MAX_CHAT_ATTACHMENT_BYTES;
const MAX_SESSION_IMAGE_TOTAL_BYTES = MAX_CHAT_ATTACHMENT_BYTES;
const mediaDisplayLabel = (source: string) => path.basename(source);

export async function hydrateSessionImages(
  messages: DashboardCliSessionMessage[]
): Promise<DashboardCliSessionMessage[]> {
  let totalBytes = 0;
  const hydrated: DashboardCliSessionMessage[] = [];
  // Keep in-flight local image buffers bounded while applying the page budget.
  for (const message of messages) {
    if (!message.images?.length) {
      hydrated.push(message);
      continue;
    }
    const images: Array<{ src: string; alt?: string }> = [];
    for (const image of message.images) {
      if (/^(?:https?:\/\/|data:image\/)/i.test(image.src)) {
        images.push(image);
        continue;
      }
      if (totalBytes >= MAX_SESSION_IMAGE_TOTAL_BYTES) continue;
      let localPath: string;
      try {
        localPath = image.src.startsWith("file:") ? localPathFromSource(image.src) : normalizeNativePath(image.src);
      } catch {
        continue;
      }
      try {
        const snapshot = await readSafeFileSnapshot(localPath, {
          maxBytes: Math.min(MAX_SESSION_IMAGE_BYTES, MAX_SESSION_IMAGE_TOTAL_BYTES - totalBytes),
          rejectIfLarger: true
        });
        totalBytes += snapshot.size;
        if (totalBytes > MAX_SESSION_IMAGE_TOTAL_BYTES) continue;
        const buffer = snapshot.buffer;
        const mimeType = sniffImageMime(buffer);
        if (!mimeType) continue;
        images.push({
          src: `data:${mimeType};base64,${buffer.toString("base64")}`,
          alt: image.alt ?? mediaDisplayLabel(image.src)
        });
      } catch {
        /* A deleted temp image is a normal unavailable preview. */
      }
    }
    hydrated.push({ ...message, images });
  }
  return coalesceSessionQuestionMessages(hydrated);
}

export function localPathFromSource(source: string): string {
  return fileURLToPath(source);
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  )
    return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0)
    return "image/x-icon";
  return undefined;
}
