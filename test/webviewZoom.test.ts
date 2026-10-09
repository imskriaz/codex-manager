import { describe, expect, it } from "vitest";
import { clampWebviewZoom, nextWebviewZoom } from "../webview-src/dashboard/webviewZoom";

describe("webview zoom", () => {
  it("clamps zoom and changes one step per modifier-wheel event", () => {
    expect(clampWebviewZoom(0.1)).toBe(0.8);
    expect(clampWebviewZoom(2)).toBe(1.4);
    expect(nextWebviewZoom(1, -1)).toBe(1.1);
    expect(nextWebviewZoom(1, 1)).toBe(0.9);
    expect(nextWebviewZoom(1.4, -1)).toBe(1.4);
    expect(nextWebviewZoom(0.8, 1)).toBe(0.8);
  });
});
