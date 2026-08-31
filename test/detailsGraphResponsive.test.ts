import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("details usage graph responsiveness", () => {
  it("allows the full point range to fit the available card width", () => {
    const styles = readFileSync("media/webview/details.css", "utf8");

    expect(styles).toContain("grid-auto-columns: minmax(4px, 1fr);");
    expect(styles).toContain("gap: clamp(2px, 1.5vw, 6px);");
    expect(styles).toContain("min-width: 4px;");
    expect(styles).toContain("overflow-x: auto;");
    expect(styles).not.toContain("grid-auto-columns: minmax(10px, 1fr)");
    expect(styles).not.toContain("grid-auto-columns: minmax(8px, 1fr)");
  });
});
