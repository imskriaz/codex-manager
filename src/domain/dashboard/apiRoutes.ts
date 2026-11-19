export const API_VIEW_PATHS = { keys: '/api/keys', explorer: '/api/explorer', proxy: '/api/proxy' } as const;
export type ApiView = keyof typeof API_VIEW_PATHS;

export function apiViewFromPath(path: string): ApiView | undefined {
  if (path === '/api') return 'keys';
  return (Object.keys(API_VIEW_PATHS) as ApiView[]).find(view => API_VIEW_PATHS[view] === path);
}
