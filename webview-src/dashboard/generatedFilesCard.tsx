import { useRef, useState } from 'preact/hooks';
import { DownloadIcon, FileIcon } from './icons';

export function GeneratedFilesCard({ files, connected, onOpen, onDownload }: {
  files: Array<{ path: string; name: string }>;
  connected: boolean;
  onOpen?: (path: string) => void;
  onDownload: (path: string) => Promise<boolean>;
}) {
  const pending = useRef(new Set<string>());
  const [downloading, setDownloading] = useState(new Set<string>());
  const [notice, setNotice] = useState<{ message: string; failed?: boolean }>();
  const download = async (file: { path: string; name: string }) => {
    if (pending.current.has(file.path) || !connected) return;
    pending.current.add(file.path);
    setDownloading(new Set(pending.current));
    setNotice({ message: `Preparing ${file.name}…` });
    try {
      const confirmed = await onDownload(file.path);
      setNotice({ message: confirmed ? `Download started: ${file.name}` : `Download failed: ${file.name}. Check the warning and try again.`, failed: !confirmed });
    } catch {
      setNotice({ message: `Download could not be confirmed: ${file.name}. Try again.`, failed: true });
    } finally {
      pending.current.delete(file.path);
      setDownloading(new Set(pending.current));
    }
  };
  return <section class="generated-files-card" aria-label="Generated files">
    <header>Generated files <span>{files.length}</span></header>
    <ul>{files.map(file => {
      const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toUpperCase();
      return <li key={file.path} aria-busy={downloading.has(file.path)}>
        <span class="generated-file-icon" aria-hidden="true"><FileIcon /></span>
        <button type="button" class="generated-file-open" title={file.path} aria-label={`Open ${file.name}`} disabled={!connected || !onOpen} onClick={() => onOpen?.(file.path)}>
          <strong>{file.name}</strong><small>{[extension, folder].filter(Boolean).join(' · ') || 'Workspace file'}</small>
        </button>
        <button type="button" class="generated-file-download" aria-label={`Download ${file.name}`} title={`Download ${file.name}`} disabled={!connected || downloading.has(file.path)} onClick={() => void download(file)}><DownloadIcon /><span>{downloading.has(file.path) ? 'Preparing…' : 'Download'}</span></button>
      </li>;
    })}</ul>
    {!connected ? <p role="status">Reconnect to open or download these files.</p> : null}
    {notice ? <p role={notice.failed ? 'alert' : 'status'}>{notice.message}</p> : null}
  </section>;
}
