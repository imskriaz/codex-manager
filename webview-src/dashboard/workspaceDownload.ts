import type { DashboardActionPayload, DashboardActionResultPayload } from '../../src/domain/dashboard/types';

export async function downloadWorkspaceFile(filePath: string, request: (payload: DashboardActionPayload) => Promise<DashboardActionResultPayload>, save: (blob: Blob, name: string) => void): Promise<void> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0, revision: string | undefined, size: number | undefined;
  do {
    const result = (await request({ filePath, fileDownloadOffset: offset, fileDownloadRevision: revision })).workspaceFileDownload;
    if (!result || result.offset !== offset || !Number.isSafeInteger(result.size) || result.size < offset || revision && result.revision !== revision || size !== undefined && result.size !== size) throw new Error('The file download was not confirmed. Start the download again.');
    const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
    if (bytes.length > 512 * 1024 || offset + bytes.length > result.size || !bytes.length && offset < result.size) throw new Error('The file download was incomplete. Start the download again.');
    parts.push(bytes);
    offset += bytes.length;
    revision = result.revision;
    size = result.size;
  } while (offset < size);
  save(new Blob(parts, { type: 'application/octet-stream' }), filePath.split(/[\\/]/).pop() || 'download');
}
