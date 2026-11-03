import { describe, expect, it } from "vitest";
import { chatUploadTimeoutMs, chatAttachmentPreviews, MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENTS, prepareChatInput, validateChatAttachments } from "../src/domain/chatAttachments";
import { appServerChatInput, withCliImageAttachments } from "../src/services/codexChatAttachments";
import { access, readFile } from "node:fs/promises";

const image = { id: "image", name: "sample.png", kind: "image" as const, mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=", size: 999 };
const text = { id: "text", name: "sample.ts", kind: "text" as const, mimeType: "text/plain", data: "const answer = 42;", size: 0 };

describe("chat attachments", () => {
  it("derives size, embeds text once, and sends images through the app-server protocol", () => {
    const prepared = prepareChatInput("Review", [text, image]);
    expect(prepared.text).toContain(`<attached_file name="sample.ts" chars=${text.data.length}>`);
    expect(prepared.attachments[1]?.size).toBe(8);
    expect(appServerChatInput(prepared.text, prepared.attachments)[1]).toEqual({ type: "image", url: image.data });
    expect(prepareChatInput("", [image]).text).toContain("attached image");
  });
  it("canonicalizes text media metadata before drafts, task storage or session delivery", () => {
    const [file] = validateChatAttachments([{ ...text, mimeType: "text/html;" + "x".repeat(100_000) }]);
    expect(file).toEqual({ ...text, mimeType: "text/plain", size: text.data.length });
  });
  it("rejects forged types, duplicate identities, oversized inputs, and invalid names", () => {
    expect(() => validateChatAttachments([{ ...image, data: "data:image/png;base64,YmFk" }])).toThrow(/format/);
    expect(() => validateChatAttachments([text, text])).toThrow(/invalid/);
    expect(() => validateChatAttachments([{ ...text, name: "../file" }])).toThrow(/invalid/);
    expect(validateChatAttachments([{ ...text, data: "x".repeat(32769) }])[0]?.size).toBe(32769);
    expect(() => validateChatAttachments(Array.from({ length: 33 }, (_, id) => ({ ...text, id: String(id) })))).toThrow(/32 files/);
    expect(() => prepareChatInput("x".repeat(64000), [text])).toThrow(/too long/);
    expect(() => prepareChatInput("", [])).toThrow(/Write a message/);
  });
  it("removes CLI image files after success and failure", async () => {
    let filename = "";
    await withCliImageAttachments([image], async (paths) => {
      filename = paths[0]!;
      expect(await readFile(filename)).toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
    });
    await expect(access(filename)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(withCliImageAttachments([image], async (paths) => {
      filename = paths[0]!;
      throw new Error("turn failed");
    })).rejects.toThrow("turn failed");
    await expect(access(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it('accepts 32 files and 50 MB but rejects total bytes above the boundary, with compact large-text previews', () => {
  expect(MAX_CHAT_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024); expect(MAX_CHAT_ATTACHMENTS).toBe(32);
  const data = 'x'.repeat(MAX_CHAT_ATTACHMENT_BYTES);
  const files = validateChatAttachments([{ ...text, data }]);
  const prepared = prepareChatInput('Review', files);
  expect(prepared.text.length).toBeLessThan(300);
  expect(chatAttachmentPreviews(files)[0]?.text).toContain(`${MAX_CHAT_ATTACHMENT_BYTES} bytes`);
  expect(() => validateChatAttachments([...files, { ...text, id: 'extra', data: 'x' }])).toThrow(/50 MB/);
  expect(validateChatAttachments(Array.from({ length: 32 }, (_, id) => ({ ...text, id: String(id) })))).toHaveLength(32);
});

it.each(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/zip','application/octet-stream'])('accepts %s documents and keeps their binary body out of the prompt', mimeType => {
  const file = { id: 'document', name: 'document.bin', kind: 'file' as const, mimeType, data: `data:${mimeType};base64,UEsDBA==`, size: 999 };
  const prepared = prepareChatInput('', [file]);
  expect(prepared.attachments[0]?.size).toBe(4); expect(prepared.text).toContain('4 bytes'); expect(prepared.text).not.toContain('UEsDBA==');
  expect(() => validateChatAttachments([{ ...file, data: `data:${mimeType};base64,invalid!` }])).toThrow(/invalid/);
  const oversizedType = "application/" + "a".repeat(201);
  expect(() => validateChatAttachments([{ ...file, mimeType: oversizedType, data: `data:${oversizedType};base64,UEsDBA==` }])).toThrow(/invalid/);
});

it('gives large file transfers a bounded five-minute confirmation window', () => {
  expect(chatUploadTimeoutMs()).toBe(0);
  expect(chatUploadTimeoutMs([{ ...text, size: 2 * 1024 * 1024 }])).toBe(300000);
});
