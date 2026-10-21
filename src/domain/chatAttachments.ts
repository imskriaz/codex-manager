export type ChatAttachment = { id: string; name: string; kind: "image" | "text"; mimeType: string; data: string; size: number };
export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_CHAT_TEXT_ATTACHMENT_BYTES = 32 * 1024;

/** Recover complete Manager upload blocks before conversation display text is shortened. */
export function readChatTextAttachments(text: string): Array<{ name: string; text: string }> {
  const files: Array<{ name: string; text: string }> = [];
  const source = text.slice(0, 64_000), closing = '\n</attached_file>';
  const pattern = /<attached_file name=("(?:\\.|[^"\\])*")(?: chars=(\d{1,5}))?>\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    try {
      const name: unknown = JSON.parse(match[1]!);
      const start = pattern.lastIndex;
      const legacyEnd = /\n<\/attached_file>(?=\s*(?:<attached_file name=|$))/g;
      legacyEnd.lastIndex = start;
      const end = match[2] === undefined ? legacyEnd.exec(source)?.index : start + Number(match[2]);
      if (end === undefined || source.slice(end, end + closing.length) !== closing) continue;
      const content = source.slice(start, end);
      pattern.lastIndex = end + closing.length;
      if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\\/\0]/.test(name) || content.includes('\0') || new TextEncoder().encode(content).length > MAX_CHAT_TEXT_ATTACHMENT_BYTES) continue;
      files.push({ name, text: content });
      if (files.length === MAX_CHAT_ATTACHMENTS) break;
    } catch { /* Incomplete or invalid historical upload metadata is not a file. */ }
  }
  return files;
}

export function withoutChatTextAttachments(text: string): string {
  return text.replace(/\s*<attached_file name="[\s\S]*$/, '').trimEnd();
}

/** Validate on both sides of the bridge; never trust browser size/type claims. */
export function validateChatAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) throw new Error("Attach up to 8 files, totaling at most 1 MB.");
  let total = 0;
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("The attachment is invalid. Remove it and attach the file again.");
    const file = item as Record<string, unknown>;
    const { id, name, kind, mimeType, data } = file;
    if (typeof id !== "string" || !id || ids.has(id) || typeof name !== "string" || !name.trim() || name.length > 160 || /[\\/\0]/.test(name) || typeof mimeType !== "string" || typeof data !== "string")
      throw new Error("The attachment is invalid. Remove it and attach the file again.");
    ids.add(id);
    let size: number;
    if (kind === "image") {
      const match = data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match || match[1] !== mimeType || match[2]!.length % 4 !== 0) throw new Error(`${name}: use a PNG, JPEG, or WebP image.`);
      size = match[2]!.length / 4 * 3 - (match[2]!.endsWith("==") ? 2 : match[2]!.endsWith("=") ? 1 : 0);
      if (size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error(`${name}: keep attachments under 1 MB in total.`);
      const prefix = atob(match[2]!.slice(0, 32));
      const valid = mimeType === "image/png" ? prefix.startsWith("\x89PNG\r\n\x1a\n")
        : mimeType === "image/jpeg" ? prefix.startsWith("\xff\xd8\xff")
        : prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
      if (!valid) throw new Error(`${name}: the image content does not match its format.`);
    } else if (kind === "text") {
      size = new TextEncoder().encode(data).length;
      if (data.includes("\0") || size > MAX_CHAT_TEXT_ATTACHMENT_BYTES) throw new Error(`${name}: attach a text file under 32 KB.`);
    } else throw new Error(`${name}: only images and text files are supported.`);
    total += size;
    if (total > MAX_CHAT_ATTACHMENT_BYTES) throw new Error("Attachments exceed 1 MB in total. Remove a file and try again.");
    return { id, name: name.trim(), kind, mimeType, data, size };
  });
}

export function prepareChatInput(text: string, attachments?: unknown): { text: string; attachments: ChatAttachment[] } {
  if (typeof text !== "string") throw new Error("The message is invalid. Write your message again.");
  const files = validateChatAttachments(attachments);
  const content = [text.trim(), ...files.filter((file) => file.kind === "text").map((file) => `<attached_file name=${JSON.stringify(file.name)} chars=${file.data.length}>\n${file.data}\n</attached_file>`)].filter(Boolean).join("\n\n");
  if (!content && !files.length) throw new Error("Write a message or attach a file before sending it to Codex.");
  if (content.length > 64_000) throw new Error("The message and attached text are too long. Keep them under 64,000 characters.");
  return { text: content || "Please review the attached image files.", attachments: files };
}
