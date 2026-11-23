import { describe, expect, it } from "vitest";
import { appendDictationText, dictationErrorMessage } from "../webview-src/dashboard/voiceDictation";

describe("voice dictation text handling", () => {
  it("joins final transcript chunks without introducing duplicate whitespace", () => {
    expect(appendDictationText("Build the", " dashboard ")).toBe("Build the dashboard");
    expect(appendDictationText("", "  Start with a plan  ")).toBe("Start with a plan");
  });

  it("keeps the composer limit when speech returns a long final chunk", () => {
    expect(appendDictationText("12345", "67890", 8)).toBe("12345 67");
  });

  it("turns browser microphone failures into actionable notices", () => {
    expect(dictationErrorMessage("not-allowed")).toContain("Microphone access was denied");
    expect(dictationErrorMessage("audio-capture")).toContain("No microphone is available");
    expect(dictationErrorMessage("unknown")).toContain("Captured text is kept");
  });
});
