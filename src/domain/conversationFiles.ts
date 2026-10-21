import type { DashboardCliSessionMessage, DashboardWorkspaceFile } from './dashboard/types';
import type { ProjectTaskFile } from './projectTasks';
import { readChatTextAttachments } from './chatAttachments';

/** Public previews accept raster data or web URLs, never native/local file paths. */
export function safeConversationImage(src: string): boolean {
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
    const data = src.slice(src.indexOf(',') + 1);
    return data.length > 0 && data.length <= Math.ceil(8 * 1024 * 1024 / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
  }
  if (src.length > 8192) return false;
  try { const url = new URL(src); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

function* attachments(messages: DashboardCliSessionMessage[]) {
  for (const message of messages) {
    const prefix = `@attachment/${encodeURIComponent(message.id)}/`;
    if (message.role === 'user') {
      const files = message.textAttachments ?? readChatTextAttachments(message.text);
      for (const [index, file] of files.entries()) yield { path: `${prefix}text/${index}`, name: file.name, text: file.text };
    }
    for (const [index, image] of (message.images ?? []).entries()) {
      yield { path: `${prefix}image/${index}`, name: image.alt || `Image ${index + 1}`, image: image.src };
    }
  }
}

export function listConversationFiles(messages: DashboardCliSessionMessage[]): ProjectTaskFile[] {
  const files = new Map<string, ProjectTaskFile>();
  for (const item of attachments(messages)) files.set(item.path, { path: item.path, name: item.name, type: 'file', depth: 0, attachment: true });
  for (const message of messages) for (const change of message.changes ?? []) {
    if (!files.has(change.path)) files.set(change.path, { path: change.path, name: change.path.split(/[\\/]/).pop() ?? change.path, type: 'file', depth: change.path.split(/[\\/]/).length - 1 });
  }
  return [...files.values()];
}

/** Resolve only a snapshot on this bounded history page; upload names never become filesystem paths. */
export function readConversationAttachment(messages: DashboardCliSessionMessage[], key: string): DashboardWorkspaceFile | undefined {
  for (const item of attachments(messages)) if (item.path === key) {
    if (item.image && !safeConversationImage(item.image)) return;
    return { path: item.name, content: item.text ?? '', kind: item.image ? 'image' : 'text', language: 'plaintext',
      mimeType: item.image?.match(/^data:([^;]+);/)?.[1] ?? (item.image ? 'image/*' : 'text/plain'),
      size: item.image ? 0 : new TextEncoder().encode(item.text ?? '').length, revision: key, ...(item.image ? { dataUrl: item.image } : {}) };
  }
  return undefined;
}
