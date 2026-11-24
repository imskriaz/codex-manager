import { useState } from 'preact/hooks';
import type { DashboardNotice, DashboardWorkspaceFile } from '../../src/domain/dashboard/types';

export function WorkspaceMediaPreview(props: { file: DashboardWorkspaceFile; onFeedback: (notice: DashboardNotice) => void }) {
  const [error, setError] = useState('');
  const failed = () => {
    const message = 'This media could not be played. The file may use an unsupported codec or be incomplete. Download the original to open it in another player.';
    setError(message); props.onFeedback({ level: 'error', message });
  };
  return <div class={`cli-file-media-preview${props.file.kind === 'video' ? ' is-video' : ''}`}>
    {props.file.kind === 'video' ? <video controls preload="metadata" src={props.file.dataUrl} onError={failed}>Video playback is not supported by this browser.</video> : <audio controls preload="metadata" src={props.file.dataUrl} onError={failed}>Audio playback is not supported by this browser.</audio>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
