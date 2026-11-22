export const WORKSPACE_TOOL_KINDS = ['env', 'browser', 'terminal', 'files', 'git', 'reviews', 'agents', 'accounts'] as const;
export type WorkspaceToolKind = typeof WORKSPACE_TOOL_KINDS[number];

export interface WorkspaceSurfaceState {
  surfaceId: string;
  host: 'browser' | 'webview';
  viewport: { width: number; height: number };
  projectPath: string;
  sessionId?: string;
  targetDeviceId?: string;
  visible: boolean;
  panelOpen: boolean;
  activeTab: string;
  tabs: Array<{ id: string; kind: WorkspaceToolKind; title: string }>;
  browserPages: Array<{ id: string; title: string; url: string; revision: string }>;
  terminals: Array<{ id: string; name: string }>;
}

export interface WorkspaceSurfaceRequest {
  operation: 'list' | 'read' | 'open' | 'select' | 'hide' | 'download';
  surfaceId?: string;
  /** The context returned by discovery; never silently follow a user to another session. */
  sessionId?: string;
  tab?: string;
  url?: string;
  previewPath?: string;
  includeContent?: boolean;
  fileDownload?: { filename: string; mimeType: string; data: string };
}

export interface WorkspaceSurfaceResult {
  surfaces: WorkspaceSurfaceState[];
  content?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const optional = (value: unknown, max = 1024) => value === undefined || text(value, max);

export function isWorkspaceSurfaceState(value: unknown): value is WorkspaceSurfaceState {
  if (!record(value) || !text(value['surfaceId'], 128) || !['browser', 'webview'].includes(String(value['host'])) ||
    !text(value['projectPath'], 4096) || !optional(value['sessionId'], 256) || !optional(value['targetDeviceId'], 256) ||
    typeof value['visible'] !== 'boolean' || typeof value['panelOpen'] !== 'boolean' || !text(value['activeTab'], 4096)) return false;
  const viewport = value['viewport'];
  if (!record(viewport) || !Number.isFinite(viewport['width']) || !Number.isFinite(viewport['height']) ||
    Number(viewport['width']) < 1 || Number(viewport['width']) > 20000 || Number(viewport['height']) < 1 || Number(viewport['height']) > 20000) return false;
  const tabs = value['tabs'], pages = value['browserPages'], terminals = value['terminals'];
  return Array.isArray(tabs) && tabs.length <= 128 && tabs.every(tab => record(tab) && text(tab['id'], 4096) && text(tab['title'], 512) && WORKSPACE_TOOL_KINDS.includes(tab['kind'] as WorkspaceToolKind)) &&
    Array.isArray(pages) && pages.length <= 32 && pages.every(page => record(page) && text(page['id'], 128) && typeof page['title'] === 'string' && page['title'].length <= 512 && text(page['url'], 8192) && text(page['revision'], 256)) &&
    Array.isArray(terminals) && terminals.length <= 128 && terminals.every(terminal => record(terminal) && text(terminal['id'], 256) && text(terminal['name'], 512));
}

export function isWorkspaceSurfaceRequest(value: unknown): value is WorkspaceSurfaceRequest {
  return record(value) && ['list', 'read', 'open', 'select', 'hide', 'download'].includes(String(value['operation'])) &&
    optional(value['surfaceId'], 128) && optional(value['sessionId'], 256) && optional(value['tab'], 4096) && optional(value['url'], 8192) && optional(value['previewPath'],4096) &&
    (value['previewPath']===undefined||value['operation']==='open'&&value['tab']==='browser'&&/\.html?$/i.test(String(value['previewPath']))) &&
    (value['includeContent'] === undefined || typeof value['includeContent'] === 'boolean') &&
    (value['operation'] !== 'download' || record(value['fileDownload']) && text(value['fileDownload']['filename'], 180) &&
      !/[\\/:*?"<>|\u0000-\u001f]/.test(value['fileDownload']['filename']) && text(value['fileDownload']['mimeType'], 128) &&
      typeof value['fileDownload']['data'] === 'string' && value['fileDownload']['data'].length <= 22369624 && /^[A-Za-z0-9+/]*={0,2}$/.test(value['fileDownload']['data']));
}
