export const WEBVIEW_ZOOM_MIN = 0.8;
export const WEBVIEW_ZOOM_MAX = 1.4;
export const WEBVIEW_ZOOM_STEP = 0.1;

export function clampWebviewZoom(value: number): number {
  return Math.min(WEBVIEW_ZOOM_MAX, Math.max(WEBVIEW_ZOOM_MIN, Number(value.toFixed(2))));
}

export function nextWebviewZoom(current: number, deltaY: number): number {
  return clampWebviewZoom(current + (deltaY < 0 ? WEBVIEW_ZOOM_STEP : -WEBVIEW_ZOOM_STEP));
}
