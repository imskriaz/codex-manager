import { describe, expect, it, vi } from "vitest";
import { clampWebviewZoom, nextWebviewZoom, readWebviewZoom } from "../webview-src/dashboard/webviewZoom";

describe("webview zoom", () => {
  it('defaults missing or invalid preferences to 100% and preserves saved zoom', () => {
    try {
      for (const [stored, expected] of [[null, 1], ['', 1], ['bad', 1], ['1.2', 1.2]] as const) {
        vi.stubGlobal('window', { localStorage: { getItem: () => stored } });
        expect(readWebviewZoom()).toBe(expected);
      }
      expect(clampWebviewZoom(NaN)).toBe(1);
      expect(clampWebviewZoom(Infinity)).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it("clamps zoom and changes one step per modifier-wheel event", () => {
    expect(clampWebviewZoom(0.1)).toBe(0.8);
    expect(clampWebviewZoom(2)).toBe(1.4);
    expect(nextWebviewZoom(1, -1)).toBe(1.1);
    expect(nextWebviewZoom(1, 1)).toBe(0.9);
    expect(nextWebviewZoom(1.4, -1)).toBe(1.4);
    expect(nextWebviewZoom(0.8, 1)).toBe(0.8);
  });
});
