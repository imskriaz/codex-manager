import { describe, expect, it } from "vitest";
import { prepareChatInput, validateChatAttachments } from "../src/domain/chatAttachments";
import { appServerChatInput, withCliImageAttachments } from "../src/services/codexChatAttachments";
import { access, readFile } from "node:fs/promises";

const image = { id: "image", name: "sample.png", kind: "image" as const, mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=", size: 999 };
const text = { id: "text", name: "sample.ts", kind: "text" as const, mimeType: "text/plain", data: "const answer = 42;", size: 0 };

describe("chat attachments", () => {
  it("derives size, embeds text once, and sends images through the app-server protocol", () => {
    const prepared = prepareChatInput("Review", [text, image]);
    expect(prepared.text).toContain('<attached_file name="sample.ts">');
    expect(prepared.attachments[1]?.size).toBe(8);
    expect(appServerChatInput(prepared.text, prepared.attachments)[1]).toEqual({ type: "image", url: image.data });
    expect(prepareChatInput("", [image]).text).toContain("attached image");
  });
  it("rejects forged types, duplicate identities, oversized inputs, and invalid names", () => {
    expect(() => validateChatAttachments([{ ...image, data: "data:image/png;base64,YmFk" }])).toThrow(/format/);
    expect(() => validateChatAttachments([text, text])).toThrow(/invalid/);
    expect(() => validateChatAttachments([{ ...text, name: "../file" }])).toThrow(/invalid/);
    expect(() => validateChatAttachments([{ ...text, data: "x".repeat(32769) }])).toThrow(/32 KB/);
    expect(() => validateChatAttachments(Array.from({ length: 9 }, (_, id) => ({ ...text, id: String(id) })))).toThrow(/8 files/);
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
